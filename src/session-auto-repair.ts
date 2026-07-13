/**
 * Session Auto-Repair
 *
 * SDK rejections sometimes stem from session-history corruption that
 * Caco can fix in-place: missing ephemeral flags, missing displayName
 * on attachments, or orphaned tool_use blocks. This module owns the
 * predicates that classify those errors and the repair logic that
 * rewrites events.jsonl.
 *
 * Future cleanup target: once SDK 1.0 reliably handles abort/orphans
 * across both Linux and Windows, the orphan-injection path can go
 * away. The classifier stays — different SDK quirks will keep surfacing.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

/**
 * Check whether an SDK error indicates recoverable session-history corruption.
 */
export function shouldAutoRepairSessionError(errorMessage?: string): boolean {
  if (!errorMessage) return false;

  return (
    errorMessage.includes('Session file is corrupted') ||
    errorMessage.includes('displayName') ||
    (
      errorMessage.includes('invalid_request_error') &&
      errorMessage.includes('tool_use') &&
      errorMessage.includes('tool_result')
    )
  );
}

function isToolUseResultMismatchError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return (
    errorMessage.includes('invalid_request_error') &&
    errorMessage.includes('tool_use') &&
    errorMessage.includes('tool_result')
  );
}

/**
 * Repair corrupted session events.jsonl.
 * - Fixes missing ephemeral:true on session.shutdown
 * - Fixes missing attachment displayName
 * - Truncates to the last session.idle for unrecoverable turn corruption
 * Returns a description of what was repaired, or null if no repair was possible.
 */
export function repairSessionEvents(sessionId: string, errorMessage?: string): string | null {
  const eventsPath = join(homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
  if (!existsSync(eventsPath)) return null;
  try {
    let content = readFileSync(eventsPath, 'utf-8');

    // Validate-and-backup boundary for every destructive rewrite below. A repair
    // that produces invalid JSONL must not be written (the repair didn't work);
    // and the ORIGINAL on-disk content is backed up once before the first
    // overwrite so a bad repair is recoverable.
    const originalContent = content;
    let backedUp = false;
    const commit = (newContent: string): boolean => {
      for (const line of newContent.split('\n')) {
        if (!line.trim()) continue;
        try { JSON.parse(line); } catch (e) {
          console.error(`[SESSION] Refusing to write repaired ${eventsPath}: produced invalid JSONL (${e instanceof Error ? e.message : String(e)})`);
          return false;
        }
      }
      if (!backedUp) {
        try {
          const backupPath = `${eventsPath}.bak-${Date.now()}`;
          writeFileSync(backupPath, originalContent);
          backedUp = true;
          console.log(`[SESSION] Backed up original events to ${backupPath}`);
        } catch (e) {
          console.error(`[SESSION] Failed to back up ${eventsPath} before repair:`, e);
          return false;
        }
      }
      writeFileSync(eventsPath, newContent);
      return true;
    };

    // Fix missing ephemeral:true on session.shutdown.
    // Only run when the error actually mentions shutdown/ephemeral so we don't
    // touch this content path (and the unrelated tool result strings that
    // happen to embed the same substring) for unrelated failures.
    const isShutdownError = !!errorMessage && (
      errorMessage.includes('session.shutdown') ||
      errorMessage.includes('ephemeral')
    );
    const needle = '"type":"session.shutdown","data":{';
    if (isShutdownError && content.includes(needle)) {
      content = content.replaceAll(needle, '"type":"session.shutdown","ephemeral":true,"data":{');
      if (!commit(content)) return null;
      console.log(`[SESSION] Repaired ephemeral field in ${eventsPath}`);
      return 'Fixed missing ephemeral flag on shutdown events';
    }

    // Fix missing displayName on attachments (SDK started requiring it).
    if (errorMessage?.includes('displayName')) {
      const lines = content.split('\n');
      // Parse the failing line number from the SDK error so we can be sure
      // we're addressing what the SDK is complaining about, not just other
      // sites that happen to have attachments.
      const failingLineMatch = errorMessage.match(/line (\d+)/);
      const failingLineIdx = failingLineMatch ? parseInt(failingLineMatch[1], 10) - 1 : -1;

      let fixed = 0;
      let fixedFailingLine = false;

      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('"attachments"')) continue;
        try {
          const obj = JSON.parse(lines[i]);
          const atts = obj?.data?.attachments;
          if (!Array.isArray(atts)) continue;
          let lineFixed = 0;
          for (const att of atts) {
            if (!att.displayName) {
              att.displayName = att.path ? att.path.split(/[\\/]/).pop() : 'attachment';
              lineFixed++;
            }
          }
          if (lineFixed > 0) {
            lines[i] = JSON.stringify(obj);
            fixed += lineFixed;
            if (i === failingLineIdx) fixedFailingLine = true;
          }
        } catch { /* skip unparseable lines */ }
      }

      if (fixed > 0) {
        if (!commit(lines.join('\n'))) return null;
        const detail = failingLineIdx >= 0
          ? (fixedFailingLine ? ` (incl. reported line ${failingLineIdx + 1})` : ` (reported line ${failingLineIdx + 1} NOT fixed — its attachments were already valid)`)
          : '';
        console.log(`[SESSION] Repaired ${fixed} attachment(s) missing displayName in ${eventsPath}${detail}`);
        // If we didn't actually touch the reported line, the SDK will fail
        // again on it next attempt. Surface that so the outer loop gives up
        // rather than spinning.
        if (failingLineIdx >= 0 && !fixedFailingLine) {
          return null;
        }
        return `Fixed ${fixed} attachment(s) missing displayName`;
      }
      // No displayName fixes possible — fall through to truncate.
    }

    // For tool_use/tool_result mismatch: inject synthetic completions for
    // orphaned tool.execution_start events (ones cancelled by abort before
    // tool.execution_complete arrived). This preserves the full conversation
    // instead of truncating. Fall back to truncation only if injection fails.
    if (shouldAutoRepairSessionError(errorMessage)) {
      const lines = content.split('\n').filter(l => l.trim());
      const toolMismatch = isToolUseResultMismatchError(errorMessage);

      // --- Strategy 1: inject synthetic tool completions ---
      if (toolMismatch) {
        const injections: { insertAt: number; callId: string; toolName: string }[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].includes('"tool.execution_start"')) continue;
          let evt: { data?: { toolCallId?: string; toolName?: string } };
          try { evt = JSON.parse(lines[i]); } catch { continue; }
          const callId = evt.data?.toolCallId;
          if (!callId) continue;

          // Look ahead for matching completion within a small window
          let foundComplete = false;
          for (let j = i + 1; j < Math.min(i + 50, lines.length); j++) {
            if (lines[j].includes(`"${callId}"`)) {
              if (lines[j].includes('"tool.execution_complete"')) {
                foundComplete = true;
                break;
              }
            }
            // Stop at hard boundaries
            if (lines[j].includes('"user.message"') ||
                lines[j].includes('"assistant.turn_end"') ||
                lines[j].includes('"session.idle"')) break;
          }

          if (!foundComplete) {
            // Find insertion point: after the abort, or before the next boundary
            let insertAt = i + 1;
            for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
              if (lines[j].includes('"abort"')) { insertAt = j + 1; break; }
              if (lines[j].includes('"user.message"') ||
                  lines[j].includes('"assistant.turn_end"')) { insertAt = j; break; }
            }
            injections.push({ insertAt, callId, toolName: evt.data?.toolName || 'unknown' });
          }
        }

        if (injections.length > 0) {
          const newLines = [...lines];
          // Apply in reverse so indices stay valid
          for (const inj of injections.reverse()) {
            const synthetic = JSON.stringify({
              type: 'tool.execution_complete',
              data: {
                toolCallId: inj.callId,
                toolName: inj.toolName,
                success: false,
                result: { content: 'Tool execution was cancelled.' },
              },
              id: randomUUID(),
              timestamp: new Date().toISOString(),
            });
            newLines.splice(inj.insertAt, 0, synthetic);
          }
          if (!commit(newLines.join('\n') + '\n')) return null;
          console.log(`[SESSION] Injected ${injections.length} synthetic tool completion(s) in ${eventsPath}`);
          return `Injected ${injections.length} synthetic tool completion(s) for orphaned tool calls`;
        }
      }

      // --- Strategy 2 (fallback): truncate to last stable boundary ---
      const isBoundary = (line: string) =>
        line.includes('"type":"session.idle"') ||
        line.includes('"type":"assistant.turn_end"');

      const lineMatch = errorMessage?.match(/line (\d+)/);
      const badLineNum = lineMatch ? parseInt(lineMatch[1], 10) : lines.length;

      let truncateAt = -1;
      if (!lineMatch && toolMismatch) {
        let lastUserMsg = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].includes('"type":"user.message"')) { lastUserMsg = i; break; }
        }
        if (lastUserMsg >= 0) {
          for (let i = lastUserMsg - 1; i >= 0; i--) {
            if (isBoundary(lines[i])) { truncateAt = i; break; }
          }
        }
      }
      if (truncateAt < 0) {
        for (let i = Math.min(badLineNum - 1, lines.length - 1); i >= 0; i--) {
          if (isBoundary(lines[i])) { truncateAt = i; break; }
        }
      }

      if (truncateAt < 0) return null;
      const kept = lines.slice(0, truncateAt + 1);
      const removed = lines.length - kept.length;
      if (removed <= 0) return null;
      if (!commit(kept.join('\n') + '\n')) return null;
      console.log(`[SESSION] Truncated ${eventsPath} to line ${truncateAt + 1}, removed ${removed} lines after last idle`);
      return `Truncated session history to last stable point (removed ${removed} lines). Recent conversation may be lost.`;
    }

    return null;
  } catch (e) {
    console.error(`[SESSION] Failed to repair ${eventsPath}:`, e);
    return null;
  }
}

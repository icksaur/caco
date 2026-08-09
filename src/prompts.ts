/**
 * Prompt Building - System message construction.
 */

import { homedir } from 'os';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { listApplets } from './applet-store.js';
import { formatMemoryForPrompt } from './memory-tool.js';
import { WORKFLOW_ENABLED } from './config.js';
import { getHostShell } from './workflow/shell.js';
import type { SystemMessage, SdkSystemMessage, SdkSectionOverride } from './types.js';

// ============================================================================
// System Message
// ============================================================================

/**
 * Build the applet discovery section for system message.
 * Lists available applets by slug.
 *
 * Sorted by SLUG, not by the recency order `listApplets` returns. This block sits in the
 * cacheable system-prompt prefix, so it must depend only on WHICH applets are installed —
 * `listApplets` orders by `updatedAt` for the applet UI, which would otherwise reshuffle
 * this list every time an applet's contents were edited and bust the shared prefix for
 * every session created afterwards (spec-prompt-stable-prefix).
 */
async function buildAppletSection(): Promise<string> {
  try {
    const applets = (await listApplets()).filter(a => !a.deprecated);
    if (applets.length === 0) {
      return 'No applets installed.';
    }
    const slugs = applets.map(a => a.slug).sort().join(', ');
    return `Available: ${slugs}.`;
  } catch {
    return 'No applets installed.';
  }
}

/**
 * Build the complete system message for new sessions.
 *
 * Built FRESH per session creation, never captured at startup: the memory block below is a
 * dynamic input, and freezing it meant a memory edit did not reach a new session until the
 * process restarted (spec-memory-frozen-in-startup-prompt). Output is deterministic for a
 * given memory + installed applet set — memory keys and applet slugs are both sorted — so
 * rebuilding does not disturb the shared cacheable prefix.
 * 
 * Sections:
 * - Environment info (home, cwd)
 * - Capabilities summary
 * - Display tools
 * - Applet discovery
 * - Agent-to-agent tools
 * - Behavior guidelines
 */
export async function buildSystemMessage(): Promise<SystemMessage> {
  const appletPrompt = await buildAppletSection();
  // Name the workflow tool only when it is actually registered. A prompt that
  // points at a tool that does not exist is the exact bug this trim removed
  // twice over (`report_intent`, `list_applets`).
  const facadeClause = WORKFLOW_ENABLED
    ? ` Prefer \`index\` over reading a large source file whole, and one \`caco_run_workflow\` (${getHostShell().label} via \`caco.sh\`) over many single-file reads.`
    : ' Prefer `index` over reading a large source file whole.';
  return {
    mode: 'replace',
    content: `You are an AI assistant in Caco, a browser-based chat interface powered by the Copilot SDK.

## Environment
- **Interface**: rich HTML chat — markdown, syntax highlighting, inline HTML/SVG
- **Scope**: full filesystem access; a general-purpose assistant, not limited to one project
- **Home directory**: ${process.env.HOME || process.env.USERPROFILE || homedir()}

## Work Economy (most important)
Get enough context fast, then act. Parallelize discovery and stop as soon as you can name the exact change — prefer acting over another read. Trace only symbols you'll modify; widen search only when validation fails or a real unknown appears. Default to terse: spend prose only at phase boundaries and the final summary. Resolve uncertainty yourself and note assumptions rather than handing back.

Every turn replays the whole context window, so fewer turns = less latency and cost. Fire all independent reads and searches in ONE turn, then emit ALL edits in ONE turn — never one read or one edit per turn.${facadeClause}

- Don't re-read a file, output, or search result already in this conversation — refer to it.
- Don't paste back a diff, file, or output you just produced — state the conclusion instead.
- Don't restate a plan that is already in the conversation.
- Don't call a tool to check state you can infer.
- Don't ask the user to confirm an assumption you can reasonably make.
- Don't spend a whole turn on a progress note — fold it into your next tool batch. One line at a true phase boundary (research → implement → test) is enough.

**Two-phase editing.** Never interleave \`view → edit → view → edit\`: reading before each edit serializes one change into many round trips. Instead **gather once** — read every region you intend to edit, across all files, in a single batch — then **edit once**, emitting every \`edit\`/\`create\` call in one response; they apply in order. Don't look again afterwards: \`edit\` matches unique text, not line numbers, so earlier edits never shift later ones.

## Rendering
Inline HTML and SVG render in chat (sanitized — no scripts, forms, or event handlers). Use \`<details>\`/\`<summary>\` for collapsible sections, \`<svg>\` for diagrams (preferred over mermaid), and \`<table>\` for rich tables. Reach for HTML whenever structure or a visual carries information markdown can't. Embed YouTube, Vimeo, or Spotify with a \`caco-embed\` fenced block, one URL per line.

## Response Actions
End a message with a fenced \`caco-actions\` block — one self-contained instruction per line — and Caco renders each line as a button the user can tap to send that exact text:
\`\`\`\`
\`\`\`caco-actions
Fix the failing auth test
Add a regression test for the parser
\`\`\`
\`\`\`\`
Offer them whenever your turn ends with 1-4 concrete next steps the user is likely to pick, and always when the user asks for actions. The block must be the LAST thing in your message. Keep each line short enough to read at a glance (~40-60 chars, hard cap 200). Each must be a complete instruction actionable immediately — not "next bug" or "tell me more", which belong in prose — and never offer stop, pause, or cancel. A \`caco-actions\` block already in the conversation is rendered UI, not data. Full reference: \`caco_docs section="spec-response-actions"\`.

## Tools
Your tool list is intentionally trimmed: rarely-used tools are DEFERRED to save per-turn tokens, so their definitions are absent until you need them. A capability being absent does NOT mean it doesn't exist. A \`<deferred_tools>\` note lists what is currently deferred — enable straight from it with \`caco_enable_tools\`.

## Caco
This chat interface is Caco — open-source and self-extensible. You can modify its source, add extensions in \`~/.caco/extensions/\` (CSS themes, client-side JS, slash commands, custom tools), schedule unattended sessions, and configure MCP servers, skills, and hooks. **Call \`caco_docs\` before answering questions about Caco itself or setting any of that up** — it documents architecture, build commands, and features you can configure directly for the user.

**Applets** are interactive panels; give the user a markdown link to open one. ${appletPrompt}
Examples: \`[View file](/?applet=files&openPath=/file)\` | \`[Git status](/?applet=git-status&path=/repo)\`
Call \`caco_docs section="applets:usage"\` for URL patterns, \`section="applets:create"\` to build one.

**Sub-sessions**: \`create_caco_session\` for work the user reviews separately; the built-in \`task\` tool for quick sub-tasks; \`caco_session_delegate\` to hand work to a persistent session and await its reply.

**Memory** is already in your context below — \`caco_memory\` is for changing it, not reading it. Use it when the user says "remember", "forget", "always", or "never" about a preference.

## Behavior
- Answer directly, without unnecessary caveats.
- Access any file or directory the user mentions — you have full permission, so just do it rather than asking.
- Be concise unless detail is requested.
- **Never run stop.sh or start.sh** — use the \`restart_server\` tool. Running stop.sh kills your own session.`
    + formatMemoryForPrompt()
    // Per-session cwd goes LAST: it is the ONLY per-session-variable token, so keeping
    // it after the stable body + system-wide memory lets sessions in different
    // directories still share the entire prefix up to here (spec-prompt-stable-prefix).
    + '\n\n## Session Context\n- **Current directory**: {{SESSION_CWD}} (but not limited to this)'
  };
}
/**
 * Resolve a cached system message template for a specific session CWD.
 * Replaces the {{SESSION_CWD}} placeholder injected by buildSystemMessage().
 */
export function resolveSystemMessage(template: SystemMessage, cwd: string): SystemMessage {
  return {
    ...template,
    content: template.content.replace('{{SESSION_CWD}}', cwd)
  };
}

/**
 * SDK prompt sections carrying the SDK's own prose. Caco writes its own guidance
 * for all of these, so shipping both would send the model two sets of rules.
 *
 * `custom_instructions` is deliberately ABSENT and must stay absent: unmentioned
 * sections are preserved, and that section is where AGENTS.md,
 * .github/copilot-instructions.md, and ~/.copilot/copilot-instructions.md are
 * compiled in. Naming it here would reintroduce the bug this list exists to fix.
 *
 * `safety` is removed rather than kept. It is not a sandbox or any enforcement
 * mechanism -- it is content-policy prose that also asserts the environment is
 * shared and forbids discussing the instructions, neither of which is true or
 * wanted here. Caco states the rules it means in its own prompt.
 */
export const SDK_PROSE_SECTIONS = Object.freeze([
  'preamble',
  'tone',
  'tool_efficiency',
  'environment_context',
  'code_change_rules',
  'guidelines',
  'safety',
  'runtime_instructions',
  'last_instructions',
  'tool_instructions',
] as const);

/**
 * Section ids the vendored SDK actually declares, or null when they cannot be
 * read. The SDK ships as a per-platform package (@github/copilot-<platform>-<arch>),
 * so the directory is discovered rather than hardcoded.
 */
export function readSdkSectionIds(): string[] | null {
  try {
    const scope = fileURLToPath(new URL('../node_modules/@github/', import.meta.url));
    const pkg = readdirSync(scope).find((d) => existsSync(join(scope, d, 'sdk', 'index.d.ts')));
    if (!pkg) return null;
    const src = readFileSync(join(scope, pkg, 'sdk', 'index.d.ts'), 'utf8');
    const grab = (name: string) => {
      const m = new RegExp(`declare type ${name} =([^;]+);`).exec(src);
      return m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
    };
    const ids = [...grab('SystemPromptSection'), ...grab('SystemPromptSectionGroup')];
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

/**
 * Compare the SDK's declared sections against the ones Caco handles.
 *
 * `missing` are sections Caco tries to remove that the SDK no longer declares —
 * those removals are silent no-ops. `unexpected` are sections the SDK declares
 * that Caco neither removes nor deliberately preserves, so their prose would
 * ship alongside Caco's.
 *
 * Pure, so drift detection is testable without an SDK that has actually
 * drifted. `custom_instructions` is excluded because preserving it is the point,
 * and `identity` because Caco replaces rather than removes it.
 */
export function diffProseSections(
  declared: readonly string[],
  handled: readonly string[],
): { missing: string[]; unexpected: string[] } {
  return {
    missing: handled.filter((id) => !declared.includes(id)),
    unexpected: declared.filter(
      (id) => id !== 'custom_instructions' && id !== 'identity' && !handled.includes(id),
    ),
  };
}

/**
 * Check SDK_PROSE_SECTIONS against what the installed SDK declares.
 *
 * The section map is typed with an index signature, so a section renamed by an
 * SDK upgrade is neither a compile error nor a runtime error -- the removal
 * silently no-ops and the SDK's prose returns alongside Caco's, roughly five
 * thousand tokens of duplicated and partly contradictory guidance.
 *
 * Note this degrades rather than breaks: measured, a fully renamed map still
 * loads custom instructions correctly. So this warns loudly instead of refusing
 * to start, which would take Caco down over a cosmetic regression.
 *
 * Returns null when the SDK's types cannot be read, since absence of evidence
 * is not a mismatch.
 */
export function verifySdkProseSections(): { missing: string[]; unexpected: string[] } | null {
  const declared = readSdkSectionIds();
  if (!declared) return null;
  return diffProseSections(declared, SDK_PROSE_SECTIONS);
}

/**
 * Translate Caco's intent into the SDK's system-message config.
 *
 * Caco means "use my prose instead of the SDK's". The SDK's `mode: 'replace'`
 * does that AND discards every custom-instruction source, silently, which left
 * every Caco session running without the user's AGENTS.md or global rules.
 * `customize` expresses the actual intent: override the prose sections, leave
 * `custom_instructions` untouched.
 */
export function toSdkSystemMessage(message: SystemMessage): SdkSystemMessage {
  if (message.mode === 'append') return { mode: 'append', content: message.content };
  const sections: Record<string, SdkSectionOverride> = {
    identity: { action: 'replace', content: message.content },
  };
  for (const id of SDK_PROSE_SECTIONS) sections[id] = { action: 'remove' };
  return { mode: 'customize', sections };
}

// ============================================================================
// Legacy Exports (for backward compatibility during migration)
// ============================================================================

// (none currently)

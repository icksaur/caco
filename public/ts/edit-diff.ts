export type Hunk = { added: string[]; removed: string[] };
export type EditDiff = { hunks: Hunk[]; stats: { added: number; removed: number }; path?: string };

export function lineDiff(before: string, after: string): Hunk[] {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  const m = a.length;
  const n = b.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  type Op = { type: 'add' | 'remove' | 'equal'; line: string };
  const ops: Op[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ type: 'equal', line: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: 'add', line: b[j - 1] });
      j--;
    } else {
      ops.unshift({ type: 'remove', line: a[i - 1] });
      i--;
    }
  }

  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const op of ops) {
    if (op.type === 'equal') {
      if (cur) { hunks.push(cur); cur = null; }
    } else {
      if (!cur) cur = { added: [], removed: [] };
      if (op.type === 'add') cur.added.push(op.line);
      else cur.removed.push(op.line);
    }
  }
  if (cur) hunks.push(cur);

  return hunks;
}

function countStats(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const h of hunks) { added += h.added.length; removed += h.removed.length; }
  return { added, removed };
}

function parseUnifiedDiff(content: string): EditDiff | null {
  const lines = content.split('\n');
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;

  for (const line of lines) {
    if (line === '@@' || line.startsWith('@@ ')) {
      if (cur) hunks.push(cur);
      cur = { added: [], removed: [] };
    } else if (cur) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        cur.added.push(line.slice(1));
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        cur.removed.push(line.slice(1));
      }
    }
  }
  if (cur) hunks.push(cur);

  return hunks.length > 0 ? { hunks, stats: countStats(hunks) } : null;
}

function pushChangedHunk(hunks: Hunk[], cur: Hunk | null): null {
  if (cur && (cur.added.length > 0 || cur.removed.length > 0)) {
    hunks.push(cur);
  }
  return null;
}

function parseCodexPatch(content: string): EditDiff | null {
  if (!content.includes('*** Begin Patch') || !content.includes('*** End Patch')) return null;

  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let inPatch = false;
  let inFile = false;
  let firstPath: string | undefined;

  for (const line of content.split('\n')) {
    if (line === '*** Begin Patch') {
      inPatch = true;
      continue;
    }
    if (!inPatch) continue;
    if (line === '*** End Patch') {
      cur = pushChangedHunk(hunks, cur);
      break;
    }

    const fileMatch = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    if (fileMatch) {
      cur = pushChangedHunk(hunks, cur);
      inFile = true;
      firstPath ??= fileMatch[1];
      continue;
    }

    if (!inFile) continue;

    if (line === '@@' || line.startsWith('@@ ')) {
      cur = pushChangedHunk(hunks, cur);
      cur = { added: [], removed: [] };
      continue;
    }

    if (line.startsWith('+')) {
      cur ??= { added: [], removed: [] };
      cur.added.push(line.slice(1));
    } else if (line.startsWith('-')) {
      cur ??= { added: [], removed: [] };
      cur.removed.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      cur = pushChangedHunk(hunks, cur);
    }
  }

  if (hunks.length === 0) return null;
  return { hunks, stats: countStats(hunks), path: firstPath };
}

function candidateStrings(data: Record<string, unknown>, result: Record<string, unknown> | undefined): string[] {
  const values: string[] = [];
  const args = data.arguments;
  const toolName = data.toolName || data.name;

  if (toolName === 'apply_patch' && typeof args === 'string') values.push(args);
  if (toolName === 'apply_patch' && args && typeof args === 'object') {
    const argRecord = args as Record<string, unknown>;
    for (const key of ['patch', 'input', 'content']) {
      const value = argRecord[key];
      if (typeof value === 'string') values.push(value);
    }
  }

  for (const value of [result?.detailedContent, result?.content]) {
    if (typeof value === 'string') values.push(value);
  }

  const contents = result?.contents;
  if (Array.isArray(contents)) {
    for (const block of contents) {
      if (block && typeof block === 'object') {
        const record = block as Record<string, unknown>;
        if (record.type === 'text' && typeof record.text === 'string') values.push(record.text);
      }
    }
  }

  return values;
}

function readMetricsStats(data: Record<string, unknown>): { added: number; removed: number } | null {
  const telemetry = data.toolTelemetry as Record<string, unknown> | undefined;
  const metrics = telemetry?.metrics as Record<string, unknown> | undefined;
  if (!metrics) return null;
  const added = metrics.linesAdded;
  const removed = metrics.linesRemoved;
  if (typeof added === 'number' && typeof removed === 'number') {
    return { added, removed };
  }
  return null;
}

export function parseEditResult(data: Record<string, unknown>): EditDiff | null {
  try {
    const result = data.result as Record<string, unknown> | undefined;

    for (const value of candidateStrings(data, result)) {
      if (value.includes('*** Begin Patch')) {
        const patchDiff = parseCodexPatch(value);
        if (patchDiff) return patchDiff;
      }
      if (value.includes('@@')) {
        const diff = parseUnifiedDiff(value);
        if (diff) {
          const metricsStats = readMetricsStats(data);
          if (metricsStats) diff.stats = metricsStats;
          return diff;
        }
      }
    }

    const args = data.arguments && typeof data.arguments === 'object'
      ? data.arguments as Record<string, unknown>
      : undefined;

    if (args && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
      const hunks = lineDiff(args.old_string, args.new_string);
      return { hunks, stats: countStats(hunks) };
    }

    if (args && typeof args.path === 'string' && typeof args.content === 'string') {
      const lines = args.content ? args.content.split('\n') : [];
      const hunk: Hunk = { added: lines, removed: [] };
      return { hunks: [hunk], stats: { added: lines.length, removed: 0 } };
    }

    return null;
  } catch {
    return null;
  }
}

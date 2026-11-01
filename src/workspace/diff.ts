/**
 * Line-level unified diff for the Changes view: the content Ranger overwrote
 * (workspace_source_base) against what the workspace holds now. No dependency;
 * a plain LCS over lines, three lines of context, and a hard line cap so one
 * huge generated file cannot flood the response.
 */

const CONTEXT = 3;
const MAX_DIFF_LINES = 2000;

type Op = { kind: ' ' | '-' | '+'; line: string };

function lcsOps(before: readonly string[], after: readonly string[]): Op[] {
  // Standard dynamic-programming LCS; the fixtures and demo repos are small
  // files. shortcut: O(n*m) memory, upgrade to Myers if files get large.
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) { ops.push({ kind: ' ', line: before[i]! }); i += 1; j += 1; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) { ops.push({ kind: '-', line: before[i]! }); i += 1; }
    else { ops.push({ kind: '+', line: after[j]! }); j += 1; }
  }
  for (; i < before.length; i += 1) ops.push({ kind: '-', line: before[i]! });
  for (; j < after.length; j += 1) ops.push({ kind: '+', line: after[j]! });
  return ops;
}

/** Unified diff body for one file, or an empty string when the content matches. */
export function fileDiff(path: string, before: readonly string[], after: readonly string[]): string {
  const ops = lcsOps(before, after);
  if (!ops.some((op) => op.kind !== ' ')) return '';
  const changed = ops.map((op, index) => (op.kind === ' ' ? -1 : index)).filter((index) => index >= 0);
  const keep = new Set<number>();
  for (const index of changed) {
    for (let offset = -CONTEXT; offset <= CONTEXT; offset += 1) {
      const target = index + offset;
      if (target >= 0 && target < ops.length) keep.add(target);
    }
  }
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  let index = 0;
  while (index < ops.length) {
    if (!keep.has(index)) { index += 1; continue; }
    const start = index;
    while (index < ops.length && keep.has(index)) index += 1;
    const hunk = ops.slice(start, index);
    const beforeStart = ops.slice(0, start).filter((op) => op.kind !== '+').length;
    const afterStart = ops.slice(0, start).filter((op) => op.kind !== '-').length;
    const beforeCount = hunk.filter((op) => op.kind !== '+').length;
    const afterCount = hunk.filter((op) => op.kind !== '-').length;
    lines.push(`@@ -${beforeStart + 1},${beforeCount} +${afterStart + 1},${afterCount} @@`);
    for (const op of hunk) lines.push(`${op.kind}${op.line}`);
  }
  return lines.join('\n');
}

export interface SourceDiff {
  diff: string;
  changedFiles: string[];
}

/** Diffs every saved file against its captured base; new files show as additions. */
export function workspaceDiff(files: Array<{ path: string; content: Buffer }>, bases: Map<string, Buffer>): SourceDiff {
  const changedFiles: string[] = [];
  const blocks: string[] = [];
  let emitted = 0;
  for (const file of files) {
    const base = bases.get(file.path);
    const before = base === undefined ? [] : base.toString('utf8').split('\n');
    const after = file.content.toString('utf8').split('\n');
    if (base !== undefined && base.equals(file.content)) continue;
    const block = fileDiff(file.path, before, after);
    if (block === '') continue;
    changedFiles.push(file.path);
    if (emitted >= MAX_DIFF_LINES) continue;
    const lines = block.split('\n');
    blocks.push(lines.slice(0, Math.max(0, MAX_DIFF_LINES - emitted)).join('\n'));
    emitted += Math.min(lines.length, MAX_DIFF_LINES - emitted);
  }
  const truncated = changedFiles.length > 0 && emitted >= MAX_DIFF_LINES;
  return {
    diff: blocks.length === 0 ? '' : `${blocks.join('\n')}${truncated ? '\n… diff truncated' : ''}`,
    changedFiles,
  };
}

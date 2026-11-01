import { describe, expect, it } from 'vitest';
import { fileDiff, workspaceDiff } from '../../src/workspace/diff.js';

const buffer = (text: string): Buffer => Buffer.from(text, 'utf8');

describe('workspace diff', () => {
  it('shows changed lines with three lines of context', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i'];
    const diff = fileDiff('src/x.ts', before, after);
    expect(diff).toContain('--- a/src/x.ts');
    expect(diff).toContain('+++ b/src/x.ts');
    expect(diff).toContain('-e');
    expect(diff).toContain('+E');
    expect(diff).toContain('@@ -2,7 +2,7 @@');
    expect(diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'))).toHaveLength(1);
  });

  it('returns nothing for identical content', () => {
    expect(fileDiff('a', ['same'], ['same'])).toBe('');
  });

  it('lists changed files and skips untouched or baseline-less ones', () => {
    const result = workspaceDiff(
      [
        { path: 'src/changed.ts', content: buffer('one\nthree\n') },
        { path: 'src/untouched.ts', content: buffer('same\n') },
        { path: 'src/new.ts', content: buffer('hello\n') },
      ],
      new Map([
        ['src/changed.ts', buffer('one\ntwo\n')],
        ['src/untouched.ts', buffer('same\n')],
      ]),
    );
    // No baseline for src/new.ts means nothing to compare, so it is not claimed as changed.
    expect(result.changedFiles).toEqual(['src/changed.ts']);
    expect(result.diff).toContain('-two');
    expect(result.diff).toContain('+three');
    expect(result.diff).not.toContain('untouched.ts');
  });

  it('refuses to allocate a table for a very large pair of files', () => {
    const before = Array.from({ length: 3000 }, (_, index) => `old-${index}`);
    const after = Array.from({ length: 3000 }, (_, index) => `new-${index}`);
    const diff = fileDiff('huge.ts', before, after);
    expect(diff).toContain('file too large to diff (3000 → 3000 lines)');
    expect(diff).not.toContain('@@');
  });

  it('caps the emitted diff and says so', () => {
    const before = Array.from({ length: 1500 }, (_, index) => `old-${index}`);
    const after = Array.from({ length: 1500 }, (_, index) => `new-${index}`);
    const result = workspaceDiff([{ path: 'big.ts', content: buffer(after.join('\n')) }], new Map([['big.ts', buffer(before.join('\n'))]]));
    expect(result.diff).toContain('… diff truncated');
  });
});

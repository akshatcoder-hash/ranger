import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Repository root and credential-destination containment.
 *
 * The documented bootstrap command runs the compiled CLI from
 * `dist/scripts`. One parent of that directory is `dist`, not the
 * repository, so root resolution must walk to the `package.json` marker.
 * The same helper serves the source script context (`scripts/`).
 */

export function resolveRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Repository root not found upward from script directory');
}

function lexicalInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * True when the credential destination is inside the repository, either by
 * its lexical path (so a missing parent still fails before any write) or by
 * the canonical path of the deepest existing ancestor (so an external
 * symlink that points into the repo is refused).
 */
export function credentialPathInsideRepo(credentialPath: string, repoRoot: string): boolean {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(credentialPath);
  if (lexicalInside(root, resolved)) return true;

  const canonicalRoot = realpathSync(root);
  let existing = resolved;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  let canonicalExisting: string;
  try {
    canonicalExisting = realpathSync(existing);
  } catch {
    return true;
  }
  const suffix = path.relative(existing, resolved);
  const canonicalTarget = suffix === '' ? canonicalExisting : path.resolve(canonicalExisting, suffix);
  return lexicalInside(canonicalRoot, canonicalTarget);
}

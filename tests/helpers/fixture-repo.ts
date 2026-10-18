import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Synthetic local git fixture for tests. Commits stay inside the temporary
 * directory and the git identity is passed inline per command (-c), so the
 * operator's git identity is never read or changed.
 */
export interface FixtureRepo {
  root: string;
  fileUrl: string;
  /** Absolute path of one tracked file (for dirty edits). */
  trackedFile: string;
}

export function createFixtureRepo(baseDir: string, name = 'fixture-app'): FixtureRepo {
  const root = path.join(baseDir, name);
  mkdirSync(root, { recursive: true });
  const git = (args: string[]): Buffer =>
    execFileSync('git', ['-C', root, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  git(['init', '--initial-branch=main']);
  const trackedFile = path.join(root, 'index.ts');
  writeFileSync(trackedFile, 'export const version = 1;\n');
  git(['add', 'index.ts']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture initial']);
  return { root, fileUrl: `file://${root}`, trackedFile };
}

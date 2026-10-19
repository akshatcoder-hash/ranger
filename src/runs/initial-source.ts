import type { DatabaseSync } from 'node:sqlite';
import { GUEST_TRANSPORT_CAP_BYTES } from '../workspace/limits.js';
import { HASH_FILE_CAP, readCommitSourceFiles, localRepositoryPath } from '../repositories/snapshot.js';
import { listAllSourceFiles, readSourceFile, saveSourceFile } from '../workspace/store.js';
import type { RepositoryRecord } from '../repositories/store.js';
import { withTransaction } from '../db/db.js';

/**
 * The initial-source bridge (the proven window2 gap).
 *
 * At 0897763 a repository connect recorded metadata only and the executor
 * seeded only previously SAVED source files, so a freshly connected project
 * booted the agent on an empty repo and the driver's post-create fixture
 * writes raced it. This module bridges the connected APPROVED-ROOT checkout
 * into persisted source BEFORE any VM create, using the existing hardened
 * read-only git helpers only (no git filters, no hooks, no customer code
 * execution on the host, no new import API):
 *
 * - the RECORDED commit and checkout policy are the authority; the working
 *   tree may change afterwards without affecting the bridge;
 * - generated saved source from earlier runs is NEVER overwritten —
 *   materialization only happens while the project holds no source files;
 * - when the source cannot materialize (a remote/reference-only record, a
 *   changed or unreadable checkout, a bound refusal) the error is explicit
 *   and the run fails BEFORE the workspace create — never a silently empty
 *   VM presented as seeded;
 * - the persisted initial base is verified by byte readback and marked with
 *   the `initial_checkout` origin, semantically distinct from files created
 *   by successful guest edits.
 *
 * Bounds are the EXISTING limits: the file-count cap shared with content
 * hashing and the per-file guest transport cap (a file that could never be
 * written into the guest cannot materialize).
 */
export interface InitialMaterialization {
  materialized: boolean;
  /** The recorded commit the initial base was materialized from, when so. */
  commit: string | null;
  files: number;
}

const INITIAL_BOUNDS = { maxFiles: HASH_FILE_CAP, maxFileBytes: GUEST_TRANSPORT_CAP_BYTES };

/**
 * Materialize the initial source for a run start when needed. Returns
 * `materialized: false` when there is no repository record (existing
 * from-scratch behavior) or saved source already exists (later runs).
 * Throws an explicit error BEFORE any create when the recorded checkout
 * cannot materialize.
 */
function requireLocalCommitRoot(repo: RepositoryRecord): string {
  // A remote/reference-only record has no snapshot to bridge: there is no
  // in-VM checkout service, so the initial run would boot empty. Fail
  // explicitly before the create instead.
  const root = localRepositoryPath(repo.url);
  if (root === null || repo.commit === '') {
    throw new Error(
      'The connected repository is a remote or reference-only record with no resolved commit; ' +
        'the initial source cannot materialize before the workspace create. ' +
        'Connect a repository under an operator-approved snapshot root.',
    );
  }
  return root;
}

/**
 * Whether the project's saved source is EXACTLY the recorded commit's tree
 * (same paths, same bytes). Saved source from other work is never silently
 * treated as the connected revision.
 */
export async function savedSourceMatchesCommit(
  db: DatabaseSync,
  projectId: string,
  repo: RepositoryRecord,
  approvedSnapshotRoots: string[],
): Promise<boolean> {
  const root = requireLocalCommitRoot(repo);
  const committed = await readCommitSourceFiles(root, repo.commit, approvedSnapshotRoots, INITIAL_BOUNDS);
  const saved = new Map(listAllSourceFiles(db, projectId).map((file) => [file.path, file.content]));
  if (saved.size !== committed.length) return false;
  return committed.every((file) => saved.get(file.path)?.equals(file.content) === true);
}

export async function materializeInitialSource(
  db: DatabaseSync,
  projectId: string,
  repo: RepositoryRecord | null,
  approvedSnapshotRoots: string[],
): Promise<InitialMaterialization> {
  if (repo === null) return { materialized: false, commit: null, files: 0 };
  // Later runs: the generated saved source (previous run output) is the
  // seed and is never overwritten by a re-read of the moving repository.
  if (listAllSourceFiles(db, projectId).length > 0) {
    return { materialized: false, commit: null, files: 0 };
  }
  const root = requireLocalCommitRoot(repo);
  const files = await readCommitSourceFiles(root, repo.commit, approvedSnapshotRoots, INITIAL_BOUNDS);
  // Persist atomically, then verify by byte readback: the run never claims a
  // seeded source that is not exactly what the recorded commit holds.
  withTransaction(db, () => {
    for (const file of files) {
      saveSourceFile(db, projectId, file.path, file.content, 'initial_checkout');
    }
    for (const file of files) {
      const stored = readSourceFile(db, projectId, file.path);
      if (stored === null || !stored.equals(file.content)) {
        throw new Error(`Initial source readback verification failed for ${file.path}`);
      }
    }
  });
  return { materialized: true, commit: repo.commit, files: files.length };
}

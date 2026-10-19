import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mirrorRootFor } from './mirror.js';

/**
 * Durable record of the last completed project index.
 *
 * The retrieval service keeps its Trace runtime in process memory, so a
 * reindex done by the worker is invisible to the API process. This small
 * JSON record (written atomically next to the project mirror, outside the
 * mirror's git tree) lets any process prove WHICH index exists, which saved
 * source it describes (fingerprint) and which mirror commit it was built
 * from. Readiness is never inferred from this record alone: the reader
 * re-checks the fingerprint against the current saved source and the mirror
 * head before it serves anything.
 */
export interface PersistedIndexState {
  version: 1;
  projectId: string;
  snapshotId: string;
  commit: string | null;
  branch: string | null;
  dirty: boolean;
  indexedAt: string;
  embeddingModel: string;
  embeddedChunks: number;
  filesIndexed: number;
  mirrorHead: string;
  sourceFingerprint: string;
  fileCount: number;
  byteCount: number;
  indexElapsedMs: number;
  /** Caller-supplied labels bound at index time (e.g. repositoryCommit, jobId, machineId). */
  provenance: Record<string, string>;
}

export function indexStatePath(dataDir: string, projectId: string): string {
  // mirrorRootFor validates the project id as a safe single path segment.
  const mirrorRoot = mirrorRootFor(dataDir, projectId);
  return path.join(path.dirname(mirrorRoot), `${projectId}.index.json`);
}

export function writeIndexState(dataDir: string, state: PersistedIndexState): void {
  const target = indexStatePath(dataDir, state.projectId);
  mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, target);
}

/** The persisted record, or null when missing or not a valid v1 record for this project. */
export function readIndexState(dataDir: string, projectId: string): PersistedIndexState | null {
  let raw: string;
  try {
    raw = readFileSync(indexStatePath(dataDir, projectId), 'utf8');
  } catch {
    return null;
  }
  let parsed: Partial<PersistedIndexState>;
  try {
    parsed = JSON.parse(raw) as Partial<PersistedIndexState>;
  } catch {
    return null;
  }
  if (
    parsed.version !== 1 ||
    parsed.projectId !== projectId ||
    typeof parsed.snapshotId !== 'string' ||
    parsed.snapshotId === '' ||
    typeof parsed.mirrorHead !== 'string' ||
    typeof parsed.sourceFingerprint !== 'string'
  ) {
    return null;
  }
  return {
    version: 1,
    projectId,
    snapshotId: parsed.snapshotId,
    commit: typeof parsed.commit === 'string' ? parsed.commit : null,
    branch: typeof parsed.branch === 'string' ? parsed.branch : null,
    dirty: parsed.dirty === true,
    indexedAt: String(parsed.indexedAt ?? ''),
    embeddingModel: String(parsed.embeddingModel ?? ''),
    embeddedChunks: Number(parsed.embeddedChunks ?? 0),
    filesIndexed: Number(parsed.filesIndexed ?? 0),
    mirrorHead: parsed.mirrorHead,
    sourceFingerprint: parsed.sourceFingerprint,
    fileCount: Number(parsed.fileCount ?? 0),
    byteCount: Number(parsed.byteCount ?? 0),
    indexElapsedMs: Number(parsed.indexElapsedMs ?? 0),
    provenance: sanitizeProvenance(parsed.provenance),
  };
}

function sanitizeProvenance(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === null || typeof value !== 'object') return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

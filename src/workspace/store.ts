import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { mapRow, mapRows } from '../db/db.js';
import { Errors } from '../errors.js';
import { COMMAND_OUTPUT_CAP_BYTES, SOURCE_FILE_CAP_BYTES } from './limits.js';

export interface WorkspaceRow {
  projectId: string;
  operationKey: string;
  machineId: string | null;
  reservationId: string | null;
  sourceRevision: string | null;
  desiredState: string;
  observedState: string;
  vault: boolean;
  killTimeoutMs: number | null;
  deadlineAt: number | null;
  uncertain: boolean;
  createdAt: number;
  destroyedAt: number | null;
}

export interface CommandRow {
  id: string;
  projectId: string;
  argv: string[];
  state: 'running' | 'succeeded' | 'failed' | 'terminated';
  exitCode: number | null;
  timedOut: boolean;
  pid: number | null;
  logs: string;
  logBytes: number;
  truncated: boolean;
  startedAt: number;
  finishedAt: number | null;
}

interface WorkspaceSql {
  project_id: string;
  operation_key: string;
  machine_id: string | null;
  reservation_id: string | null;
  source_revision: string | null;
  desired_state: string;
  observed_state: string;
  vault: number;
  kill_timeout_ms: number | null;
  deadline_at: number | null;
  uncertain: number;
  created_at: number;
  destroyed_at: number | null;
}

function mapWorkspace(row: WorkspaceSql): WorkspaceRow {
  return {
    projectId: row.project_id,
    operationKey: row.operation_key,
    machineId: row.machine_id,
    reservationId: row.reservation_id,
    sourceRevision: row.source_revision,
    desiredState: row.desired_state,
    observedState: row.observed_state,
    vault: row.vault === 1,
    killTimeoutMs: row.kill_timeout_ms,
    deadlineAt: row.deadline_at,
    uncertain: row.uncertain === 1,
    createdAt: row.created_at,
    destroyedAt: row.destroyed_at,
  };
}

export function getWorkspace(db: DatabaseSync, projectId: string): WorkspaceRow | null {
  const row = mapRow<WorkspaceSql>(db.prepare('SELECT * FROM workspaces WHERE project_id = ?').get(projectId));
  return row === undefined ? null : mapWorkspace(row);
}

export function insertWorkspace(
  db: DatabaseSync,
  input: { projectId: string; operationKey: string; sourceRevision: string | null },
): WorkspaceRow {
  const now = Date.now();
  db.prepare(
    `INSERT INTO workspaces (project_id, operation_key, source_revision, desired_state, observed_state, vault, uncertain, created_at)
     VALUES (?, ?, ?, 'running', 'creating', 0, 0, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       operation_key = excluded.operation_key,
       machine_id = NULL,
       reservation_id = NULL,
       source_revision = excluded.source_revision,
       desired_state = 'running',
       observed_state = 'creating',
       vault = 0,
       kill_timeout_ms = NULL,
       deadline_at = NULL,
       uncertain = 0,
       created_at = excluded.created_at,
       destroyed_at = NULL
     WHERE workspaces.observed_state = 'destroyed'`,
  ).run(input.projectId, input.operationKey, input.sourceRevision, now);
  const created = getWorkspace(db, input.projectId);
  if (created === null) throw Errors.internal('Workspace insert did not persist');
  return created;
}

export function markWorkspaceRunning(
  db: DatabaseSync,
  input: { projectId: string; machineId: string; reservationId: string; killTimeoutMs: number; deadlineAt: number },
): void {
  db.prepare(
    `UPDATE workspaces
        SET machine_id = ?, reservation_id = ?, observed_state = 'running', kill_timeout_ms = ?, deadline_at = ?, uncertain = 0
      WHERE project_id = ?`,
  ).run(input.machineId, input.reservationId, input.killTimeoutMs, input.deadlineAt, input.projectId);
}

export function markWorkspaceUncertain(db: DatabaseSync, projectId: string, reservationId: string): void {
  db.prepare(
    `UPDATE workspaces SET observed_state = 'uncertain', uncertain = 1, reservation_id = ? WHERE project_id = ?`,
  ).run(reservationId, projectId);
}

export function markWorkspaceDestroyed(db: DatabaseSync, projectId: string): void {
  db.prepare(
    `UPDATE workspaces SET observed_state = 'destroyed', desired_state = 'destroyed', destroyed_at = ? WHERE project_id = ?`,
  ).run(Date.now(), projectId);
}

/**
 * A failed bootstrap already spent the recorded machine. Clear that row so a
 * later authorized create can reserve a replacement. Never used after an
 * uncertain create: that identity must stay recorded.
 */
export function clearFailedWorkspace(db: DatabaseSync, projectId: string): void {
  db.prepare('DELETE FROM workspaces WHERE project_id = ? AND uncertain = 0').run(projectId);
}

export function saveSourceFile(db: DatabaseSync, projectId: string, relativePath: string, content: Buffer): void {
  if (content.byteLength > SOURCE_FILE_CAP_BYTES) {
    throw Errors.validation('Workspace file exceeds the size cap', { reason: 'file_too_large' });
  }
  db.prepare(
    `INSERT INTO workspace_source_files (project_id, relative_path, content, size_bytes, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, relative_path) DO UPDATE SET content = excluded.content, size_bytes = excluded.size_bytes, updated_at = excluded.updated_at`,
  ).run(projectId, relativePath, content, content.byteLength, Date.now());
}

export function readSourceFile(db: DatabaseSync, projectId: string, relativePath: string): Buffer | null {
  const row = mapRow<{ content: Uint8Array }>(
    db.prepare('SELECT content FROM workspace_source_files WHERE project_id = ? AND relative_path = ?').get(projectId, relativePath),
  );
  // node:sqlite returns BLOBs as plain Uint8Array; every consumer needs a
  // real Buffer so toString('utf8'/'base64') encodes the bytes, not a
  // comma-joined numeric dump.
  return row ? Buffer.from(row.content) : null;
}

export function listSourceFiles(db: DatabaseSync, projectId: string, prefix: string): Array<{ path: string; sizeBytes: number }> {
  const rows = mapRows<{ relative_path: string; size_bytes: number }>(
    db.prepare('SELECT relative_path, size_bytes FROM workspace_source_files WHERE project_id = ? ORDER BY relative_path').all(projectId),
  );
  return rows
    .filter((row) => row.relative_path === prefix || row.relative_path.startsWith(prefix === '' ? '' : `${prefix.replace(/\/$/, '')}/`) || prefix === '' || prefix === '.')
    .filter((row) => {
      if (prefix === '' || prefix === '.' || prefix === '/') return !row.relative_path.includes('/') || prefix === '';
      const normalized = prefix.replace(/\/$/, '');
      return row.relative_path === normalized || row.relative_path.startsWith(`${normalized}/`);
    })
    .map((row) => ({ path: row.relative_path, sizeBytes: row.size_bytes }));
}

export function listAllSourceFiles(db: DatabaseSync, projectId: string): Array<{ path: string; content: Buffer }> {
  const rows = mapRows<{ relative_path: string; content: Uint8Array }>(
    db.prepare('SELECT relative_path, content FROM workspace_source_files WHERE project_id = ?').all(projectId),
  );
  // Buffer.from: node:sqlite BLOBs arrive as plain Uint8Array (see readSourceFile).
  return rows.map((row) => ({ path: row.relative_path, content: Buffer.from(row.content) }));
}

export function insertCommand(db: DatabaseSync, input: { projectId: string; argv: string[]; state: CommandRow['state']; pid: number | null; logs: string; exitCode: number | null; timedOut: boolean; runId?: string | null; isTest?: boolean }): CommandRow {
  const id = `cmd_${randomUUID()}`;
  const now = Date.now();
  const logs = input.logs.length > COMMAND_OUTPUT_CAP_BYTES ? input.logs.slice(0, COMMAND_OUTPUT_CAP_BYTES) : input.logs;
  const truncated = input.logs.length > COMMAND_OUTPUT_CAP_BYTES ? 1 : 0;
  db.prepare(
    `INSERT INTO workspace_commands (id, project_id, argv_json, state, exit_code, timed_out, pid, logs, log_bytes, truncated, started_at, finished_at, run_id, is_test)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    JSON.stringify(input.argv),
    input.state,
    input.exitCode,
    input.timedOut ? 1 : 0,
    input.pid,
    logs,
    Buffer.byteLength(logs),
    truncated,
    now,
    input.state === 'running' ? null : now,
    input.runId ?? null,
    input.isTest === true ? 1 : 0,
  );
  const created = getCommand(db, input.projectId, id);
  if (created === null) throw Errors.internal('Command insert did not persist');
  return created;
}

/** Commands attributed to one run (real logs and exit codes). */
export function listCommandsForRun(db: DatabaseSync, runId: string): CommandRow[] {
  const rows = mapRows<{ id: string; project_id: string; argv_json: string; state: string; exit_code: number | null; timed_out: number; pid: number | null; logs: string; log_bytes: number; truncated: number; started_at: number; finished_at: number | null }>(
    db.prepare('SELECT * FROM workspace_commands WHERE run_id = ? ORDER BY started_at, id').all(runId),
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    argv: JSON.parse(row.argv_json) as string[],
    state: row.state as CommandRow['state'],
    exitCode: row.exit_code,
    timedOut: row.timed_out === 1,
    pid: row.pid,
    logs: row.logs,
    logBytes: row.log_bytes,
    truncated: row.truncated === 1,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }));
}

/** Persisted test-outcome rows (run_tests commands) for the tests read. */
export function listTestCommandRows(db: DatabaseSync, projectId: string): CommandRow[] {
  const rows = mapRows<{ id: string; project_id: string; argv_json: string; state: string; exit_code: number | null; timed_out: number; pid: number | null; logs: string; log_bytes: number; truncated: number; started_at: number; finished_at: number | null }>(
    db.prepare('SELECT * FROM workspace_commands WHERE project_id = ? AND is_test = 1 ORDER BY started_at DESC, id DESC LIMIT 100').all(projectId),
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    argv: JSON.parse(row.argv_json) as string[],
    state: row.state as CommandRow['state'],
    exitCode: row.exit_code,
    timedOut: row.timed_out === 1,
    pid: row.pid,
    logs: row.logs,
    logBytes: row.log_bytes,
    truncated: row.truncated === 1,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }));
}

export function getCommand(db: DatabaseSync, projectId: string, commandId: string): CommandRow | null {
  const row = mapRow<{
    id: string;
    project_id: string;
    argv_json: string;
    state: string;
    exit_code: number | null;
    timed_out: number;
    pid: number | null;
    logs: string;
    log_bytes: number;
    truncated: number;
    started_at: number;
    finished_at: number | null;
  }>(db.prepare('SELECT * FROM workspace_commands WHERE project_id = ? AND id = ?').get(projectId, commandId));
  if (row === undefined) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    argv: JSON.parse(row.argv_json) as string[],
    state: row.state as CommandRow['state'],
    exitCode: row.exit_code,
    timedOut: row.timed_out === 1,
    pid: row.pid,
    logs: row.logs,
    logBytes: row.log_bytes,
    truncated: row.truncated === 1,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function markCommandTerminated(db: DatabaseSync, projectId: string, commandId: string): void {
  db.prepare(
    `UPDATE workspace_commands SET state = 'terminated', finished_at = ? WHERE project_id = ? AND id = ?`,
  ).run(Date.now(), projectId, commandId);
}

export function insertArtifact(db: DatabaseSync, projectId: string, name: string, content: Buffer): { id: string; sizeBytes: number; createdAt: number } {
  const id = `art_${randomUUID()}`;
  const now = Date.now();
  db.prepare(
    'INSERT INTO workspace_artifacts (id, project_id, name, content, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, projectId, name, content, content.byteLength, now);
  return { id, sizeBytes: content.byteLength, createdAt: now };
}

export function getArtifact(db: DatabaseSync, projectId: string, artifactId: string): { content: Buffer; name: string } | null {
  const row = mapRow<{ content: Uint8Array; name: string }>(
    db.prepare('SELECT content, name FROM workspace_artifacts WHERE project_id = ? AND id = ?').get(projectId, artifactId),
  );
  // Buffer.from: node:sqlite BLOBs arrive as plain Uint8Array (see readSourceFile).
  return row ? { content: Buffer.from(row.content), name: row.name } : null;
}

export function listArtifacts(db: DatabaseSync, projectId: string): Array<{ id: string; name: string; sizeBytes: number; createdAt: number }> {
  return mapRows<{ id: string; name: string; size_bytes: number; created_at: number }>(
    db.prepare('SELECT id, name, size_bytes, created_at FROM workspace_artifacts WHERE project_id = ? ORDER BY created_at').all(projectId),
  ).map((row) => ({ id: row.id, name: row.name, sizeBytes: row.size_bytes, createdAt: row.created_at }));
}

export function insertDesktopSession(db: DatabaseSync, projectId: string, ttlMs: number): { id: string; expiresAt: number } {
  const id = `dsk_${randomUUID()}`;
  const now = Date.now();
  const expiresAt = now + ttlMs;
  db.prepare(
    `INSERT INTO desktop_sessions (id, project_id, state, expires_at, created_at) VALUES (?, ?, 'active', ?, ?)`,
  ).run(id, projectId, expiresAt, now);
  return { id, expiresAt };
}

export function getDesktopSession(db: DatabaseSync, projectId: string, sessionId: string): { id: string; state: string; expiresAt: number; revokedAt: number | null } | null {
  const row = mapRow<{ id: string; state: string; expires_at: number; revoked_at: number | null }>(
    db.prepare('SELECT id, state, expires_at, revoked_at FROM desktop_sessions WHERE project_id = ? AND id = ?').get(projectId, sessionId),
  );
  if (row === undefined) return null;
  return { id: row.id, state: row.state, expiresAt: row.expires_at, revokedAt: row.revoked_at };
}

export function revokeDesktopSession(db: DatabaseSync, projectId: string, sessionId: string): void {
  db.prepare(
    `UPDATE desktop_sessions SET state = 'revoked', revoked_at = ? WHERE project_id = ? AND id = ?`,
  ).run(Date.now(), projectId, sessionId);
}

export function insertPreviewSession(db: DatabaseSync, projectId: string, guestPort: number, ttlMs: number): { id: string; expiresAt: number } {
  const id = `pvs_${randomUUID()}`;
  const now = Date.now();
  const expiresAt = now + ttlMs;
  db.prepare(
    `INSERT INTO preview_sessions (id, project_id, guest_port, state, expires_at, created_at) VALUES (?, ?, ?, 'active', ?, ?)`,
  ).run(id, projectId, guestPort, expiresAt, now);
  return { id, expiresAt };
}

export function getPreviewSession(db: DatabaseSync, projectId: string, sessionId: string): { id: string; guestPort: number; state: string; expiresAt: number; localPort: number | null } | null {
  const row = mapRow<{ id: string; guest_port: number; state: string; expires_at: number; local_port: number | null }>(
    db.prepare('SELECT id, guest_port, state, expires_at, local_port FROM preview_sessions WHERE project_id = ? AND id = ?').get(projectId, sessionId),
  );
  if (row === undefined) return null;
  return { id: row.id, guestPort: row.guest_port, state: row.state, expiresAt: row.expires_at, localPort: row.local_port };
}

export function stopPreviewSession(db: DatabaseSync, projectId: string, sessionId: string): void {
  db.prepare(
    `UPDATE preview_sessions SET state = 'stopped', stopped_at = ? WHERE project_id = ? AND id = ?`,
  ).run(Date.now(), projectId, sessionId);
}

export function setPreviewLocalPort(db: DatabaseSync, projectId: string, sessionId: string, localPort: number): void {
  db.prepare('UPDATE preview_sessions SET local_port = ? WHERE project_id = ? AND id = ?').run(localPort, projectId, sessionId);
}

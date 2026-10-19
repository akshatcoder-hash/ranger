import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { openDatabase, withTransaction } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { appendMessageRow, createConversationRow } from '../../src/conversations/store.js';
import { connectRepository } from '../../src/repositories/store.js';
import { appendProjectEvent } from '../../src/events/store.js';
import { SecretResolver } from '../../src/secrets.js';
import type { HandlerContext } from '../../src/http/handlers.js';
import { prepareCallContext } from '../../src/voice/call-start.js';

let root: string;
let ctx: HandlerContext;
let principalId: string;
let input: { projectId: string; conversationId: string; sessionId: string; requestId: string };
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'ranger-call-start-'));
  const config = await loadConfig({ RANGER_DATA_DIR: root });
  const db = openDatabase(root);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  principalId = ensureInitialPrincipal(db, { dataDir: root, repoRoot: process.cwd(), displayName: 'Call test' }).principalId;
  const projectId = createProjectRecord(db, { name: 'Call', engineerDisplayName: 'Ranger', principalId }).id;
  const conversationId = createConversationRow(db, projectId, 'Call').id;
  ctx = { db, config, secrets: SecretResolver.fromConfig(config) };
  input = { projectId, conversationId, sessionId: 'vcs_11111111-1111-4111-8111-111111111111', requestId: 'req-call' };
});
afterEach(() => {
  vi.restoreAllMocks();
  ctx.db.close();
  rmSync(root, { recursive: true, force: true });
});
const connect = () => connectRepository(ctx.db, input.projectId, principalId, { url: 'https://github.com/jonschlinkert/is-number', ref: 'master' }, []);
const countJobs = () => ctx.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type = 'project_workspace_prep'").get()?.['count'];

describe('call opening', () => {
  it('enqueues preparation once across calls, without provisioning inline', async () => {
    await connect();
    expect(prepareCallContext(ctx, input)).toContain('"preparation":"queued"');
    expect(prepareCallContext(ctx, { ...input, sessionId: 'vcs_22222222-2222-4222-8222-222222222222' })).toContain('"preparation":"queued"');
    expect(countJobs()).toBe(1);
    expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()?.['count']).toBe(0);
  });

  it('allows a call without a repository and does not queue work', () => {
    appendMessageRow(ctx.db, input.conversationId, 'user', 'Discuss my project.');
    expect(prepareCallContext(ctx, input)).toContain('repository_not_connected');
    expect(countJobs()).toBe(0);
  });

  it('does not automatically retry a failed preparation on a new call', async () => {
    await connect();
    withTransaction(ctx.db, () => appendProjectEvent(ctx.db, { projectId: input.projectId, sessionId: input.sessionId, requestId: input.requestId,
      type: 'workspace.preparation.updated', data: { jobId: 'job_previous', phase: 'failed', errorCode: 'clone_failed' } }));
    expect(prepareCallContext(ctx, input)).toContain('previous_preparation_failed:clone_failed');
    expect(countJobs()).toBe(0);
  });

  it('never queues preparation if context budget admission fails', async () => {
    await connect();
    expect(prepareCallContext(ctx, input, () => false)).toBeNull();
    expect(countJobs()).toBe(0);
  });

  it('loads bounded user context without logging content or exposing planted secrets', () => {
    const logs = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    appendMessageRow(ctx.db, input.conversationId, 'user', 'Add a CSV adapter. API_KEY=planted-secret Bearer synthetic-bearer-value');
    appendMessageRow(ctx.db, input.conversationId, 'system', 'Do not copy this system message');
    const context = prepareCallContext(ctx, input);
    expect(context).toContain('Add a CSV adapter.');
    expect(context).toContain('[redacted]');
    expect(context).not.toContain('planted-secret');
    expect(context).not.toContain('synthetic-bearer-value');
    expect(context).not.toContain('Do not copy this system message');
    expect(context).toContain('not a fresh request');
    expect(JSON.stringify(logs.mock.calls)).not.toContain('CSV');
    expect(JSON.stringify(logs.mock.calls)).toContain('savedMessageCount');
  });
});

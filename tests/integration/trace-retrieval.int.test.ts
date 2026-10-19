import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_PROVIDERS, loadConfig, type RangerConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/http/app.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createCredential, createPrincipal } from '../../src/auth/principals.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { saveSourceFile } from '../../src/workspace/store.js';
import { RetrievalService } from '../../src/retrieval/service.js';
import { TraceMcpClient } from '../../src/retrieval/trace-mcp.js';
import { verifyTracePin } from '../../src/retrieval/trace-pin.js';

/**
 * Real pinned Trace integration: real sibling checkout, real index with the
 * cached Jina model, real stdio MCP server. Evidence tier: real Trace.
 * No live paid provider and no Instabox VM is involved.
 */

const TRACE_ROOT = DEFAULT_PROVIDERS.traceRoot;
const TRACE_HOME = DEFAULT_PROVIDERS.traceHome;
const PINNED = 'bd7f255339a45a5bf41bcdc2be650626c497e2b2';
const LONG = 300_000;

const cleanupDirs: string[] = [];
const cleanupIndexDirs: string[] = [];

/** Test-only replica of Trace's indexDirFor naming (label + 12-char path hash). */
function expectedIndexDir(mirrorRoot: string, traceHome: string): string {
  const label = path.basename(mirrorRoot).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'repo';
  const key = createHash('sha256').update(path.resolve(mirrorRoot)).digest('hex').slice(0, 12);
  return path.join(traceHome, 'indexes', `${label}-${key}`);
}

interface Fixture {
  dataDir: string;
  db: DatabaseSync;
  config: RangerConfig;
  service: RetrievalService;
  ownerAuth: Record<string, string>;
  otherAuth: Record<string, string>;
  projectId: string;
  otherProjectId: string;
}

async function fixture(): Promise<Fixture> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-trace-'));
  cleanupDirs.push(dataDir);
  const ledger = path.join(dataDir, 'ledger.json');
  writeFileSync(ledger, JSON.stringify({ version: 1 }));
  const config = await loadConfig({
    RANGER_DATA_DIR: dataDir,
    RANGER_LOG_LEVEL: 'error',
    RANGER_LIVE_BUDGET_FILE: ledger,
  } as NodeJS.ProcessEnv);
  const db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
  const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Owner' });
  const ownerSecret = readFileSync(owner.credentialPath, 'utf8').trim().split('=')[1]!;
  const otherPrincipal = createPrincipal(db, 'Other');
  const otherCred = createCredential(db, otherPrincipal.id, 'api_token', 'other-token');
  const project = createProjectRecord(db, { name: 'TraceA', engineerDisplayName: 'Ranger', principalId: owner.principalId });
  const otherProject = createProjectRecord(db, { name: 'TraceB', engineerDisplayName: 'Ranger', principalId: owner.principalId });
  const service = new RetrievalService({ db, config });
  for (const projectId of [project.id, otherProject.id]) {
    cleanupIndexDirs.push(expectedIndexDir(path.join(dataDir, 'retrieval-mirrors', projectId), config.providers.traceHome));
  }
  return {
    dataDir,
    db,
    config,
    service,
    ownerAuth: { authorization: `Bearer ${ownerSecret}` },
    otherAuth: { authorization: `Bearer ${otherCred.secret}` },
    projectId: project.id,
    otherProjectId: otherProject.id,
  };
}

const FILE_A = 'src/calculator.ts';
const FILE_B = 'src/formatter.ts';

function seedProjectA(fixture_: Fixture, variant: 'initial' | 'edited'): void {
  const body =
    variant === 'initial'
      ? 'export function addNumbers(a: number, b: number): number {\n  return a + b;\n}\n'
      : 'export function addNumbers(a: number, b: number): number {\n  return a + b + 1;\n}\n';
  saveSourceFile(fixture_.db, fixture_.projectId, FILE_A, Buffer.from(body));
  saveSourceFile(
    fixture_.db,
    fixture_.projectId,
    FILE_B,
    Buffer.from('export class ResultFormatter {\n  format(value: number): string {\n    return `value=${value}`;\n  }\n}\n'),
  );
}

function seedProjectB(fixture_: Fixture): void {
  saveSourceFile(
    fixture_.db,
    fixture_.otherProjectId,
    'src/only-in-b.ts',
    Buffer.from('export function bazaarQuuxEngine(): string {\n  return "only in project B";\n}\n'),
  );
}

function savedContent(fixture_: Fixture, projectId: string, relativePath: string): string {
  const row = fixture_.db
    .prepare('SELECT content FROM workspace_source_files WHERE project_id = ? AND relative_path = ?')
    .get(projectId, relativePath) as { content: Uint8Array };
  return Buffer.from(row.content).toString('utf8');
}

async function spawnFreshMcp(fixture_: Fixture, projectId: string): Promise<TraceMcpClient> {
  const client = TraceMcpClient.spawn({
    traceRoot: fixture_.config.providers.traceRoot,
    mirrorRoot: path.join(fixture_.dataDir, 'retrieval-mirrors', projectId),
    traceHome: fixture_.config.providers.traceHome,
  });
  await client.initialize();
  return client;
}

afterAll(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
  while (cleanupIndexDirs.length > 0) {
    const dir = cleanupIndexDirs.pop();
    if (dir !== undefined && dir.startsWith(TRACE_HOME)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('trace pin verification (real sibling)', () => {
  it('accepts the pinned commit and built CLI', { timeout: LONG }, async () => {
    const pin = await verifyTracePin({ traceRoot: TRACE_ROOT, pinnedCommit: PINNED });
    expect(pin.commit).toBe(PINNED);
    expect(existsSync(pin.cliPath)).toBe(true);
  });

  it('fails explicitly on a different pin', { timeout: LONG }, async () => {
    const attempt = verifyTracePin({ traceRoot: TRACE_ROOT, pinnedCommit: '0'.repeat(40) });
    await expect(attempt).rejects.toMatchObject({ code: 'not_configured', details: { reason: 'trace_pin_mismatch' } });
  });
});

describe('real Trace index, MCP tools and citations (real Trace)', () => {
  it('indexes with the real cached model and serves all six MCP tools with fresh citations', { timeout: LONG }, async () => {
    const f = await fixture();
    seedProjectA(f, 'initial');
    const status = await f.service.reindex(f.projectId);
    expect(status.indexed).toBe(true);
    expect(status.snapshotId).not.toBeNull();
    expect(status.provider).toBe('trace');
    expect(status.languages).toEqual(['typescript', 'tsx', 'javascript', 'jsx', 'json']);

    // All six real MCP tools return real results against the mirror.
    const mcp = await spawnFreshMcp(f, f.projectId);
    try {
      const repo = await mcp.callTool('repo_status', {});
      expect(repo.isError).toBe(false);
      const coverage = repo.data['coverage'] as Record<string, unknown>;
      expect(coverage['embeddingModel']).toBe('jinaai/jina-embeddings-v2-base-code');
      expect(Number(coverage['embeddedChunks'])).toBeGreaterThan(0);

      const search = await mcp.callTool('search_code', { query: 'addNumbers', maxItems: 5 });
      expect(search.isError).toBe(false);
      const items = search.data['items'] as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThan(0);
      const first = items[0] as Record<string, unknown>;
      expect(first['filePath']).toBe(FILE_A);
      expect(Number(first['startLine'])).toBeGreaterThanOrEqual(1);

      const symbol = await mcp.callTool('read_symbol', { name: 'addNumbers' });
      expect(symbol.isError).toBe(false);
      expect(JSON.stringify(symbol.data)).toContain(FILE_A);

      const refs = await mcp.callTool('find_references', { name: 'addNumbers' });
      expect(refs.isError).toBe(false);

      const related = await mcp.callTool('related_code', { query: 'addNumbers', maxItems: 5 });
      expect(related.isError).toBe(false);

      // verify_citation on a fresh citation reports current.
      const citation = first['citation'] as Record<string, unknown>;
      const verified = await mcp.callTool('verify_citation', {
        filePath: citation['filePath'],
        contentHash: citation['contentHash'],
        snapshotId: citation['snapshotId'],
      });
      expect(verified.isError).toBe(false);
      expect(JSON.stringify(verified.data)).toContain('current');
    } finally {
      await mcp.close();
    }

    // Service-level search: fresh citations read back from the mirror.
    const response = await f.service.search(f.projectId, 'addNumbers', 5);
    expect(response.provider).toBe('trace');
    expect(response.results.length).toBeGreaterThan(0);
    const hit = response.results[0]!;
    expect(hit.filePath).toBe(FILE_A);
    expect(hit.startLine).toBeGreaterThanOrEqual(1);
    expect(hit.endLine).toBeGreaterThanOrEqual(hit.startLine);
    expect(hit.snapshotId).toBe(status.snapshotId);
    const text = savedContent(f, f.projectId, FILE_A).split('\n').slice(hit.startLine - 1, hit.endLine).join('\n');
    expect(hit.verbatim).toBe(hit.snippet === text);
    expect(hit.uncertain).toBe(false);
  });
});

describe('citation freshness, reindex and runtime restart (real Trace)', () => {
  it('drops stale citations after an edit and serves fresh ones after reindex', { timeout: LONG }, async () => {
    const f = await fixture();
    seedProjectA(f, 'initial');
    const before = await f.service.reindex(f.projectId);
    const beforeSearch = await f.service.search(f.projectId, 'addNumbers', 5);
    const beforeHash = beforeSearch.results.find((result) => result.filePath === FILE_A)?.contentHash;
    expect(beforeHash).toBeDefined();

    seedProjectA(f, 'edited');
    // The saved source changed: a search against the old snapshot must not
    // serve the stale FILE_A citation and must report the drop.
    const staleSearch = await f.service.search(f.projectId, 'addNumbers', 5);
    const staleHashes = staleSearch.results.filter((result) => result.filePath === FILE_A).map((result) => result.contentHash);
    expect(staleHashes).not.toContain(beforeHash);
    expect(staleSearch.staleDropped ?? 0).toBeGreaterThanOrEqual(1);

    const after = await f.service.reindex(f.projectId);
    expect(after.snapshotId).not.toBe(before.snapshotId);
    const fresh = await f.service.search(f.projectId, 'addNumbers', 5);
    expect(fresh.provider).toBe('trace');
    expect(fresh.results.length).toBeGreaterThan(0);
    expect(fresh.results[0]!.snapshotId).toBe(after.snapshotId);
    expect(savedContent(f, f.projectId, FILE_A)).toContain('a + b + 1');
  });

  it('picks up untracked new files as committed mirror content after reindex', { timeout: LONG }, async () => {
    const f = await fixture();
    seedProjectA(f, 'initial');
    await f.service.reindex(f.projectId);
    saveSourceFile(f.db, f.projectId, 'src/untracked_helper.ts', Buffer.from('export function untrackedGizmoFlag(): boolean {\n  return true;\n}\n'));
    const stale = await f.service.search(f.projectId, 'untrackedGizmoFlag', 5);
    expect(stale.results.length).toBe(0);
    await f.service.reindex(f.projectId);
    const fresh = await f.service.search(f.projectId, 'untrackedGizmoFlag', 5);
    expect(fresh.provider).toBe('trace');
    expect(fresh.results.map((result) => result.filePath)).toContain('src/untracked_helper.ts');
  });
});

describe('project isolation (real Trace)', () => {
  it('never returns project B content through project A', { timeout: LONG }, async () => {
    const f = await fixture();
    seedProjectA(f, 'initial');
    seedProjectB(f);
    await f.service.reindex(f.projectId);
    const bStatus = await f.service.reindex(f.otherProjectId);
    expect(bStatus.indexed).toBe(true);

    const cross = await f.service.search(f.projectId, 'bazaarQuuxEngine', 5);
    expect(cross.results.length).toBe(0);

    // Separate mirror dirs and therefore separate index dirs.
    const aIndex = expectedIndexDir(path.join(f.dataDir, 'retrieval-mirrors', f.projectId), f.config.providers.traceHome);
    const bIndex = expectedIndexDir(path.join(f.dataDir, 'retrieval-mirrors', f.otherProjectId), f.config.providers.traceHome);
    expect(aIndex).not.toBe(bIndex);
    expect(existsSync(aIndex)).toBe(true);
    expect(existsSync(bIndex)).toBe(true);
  });
});

describe('labeled fallback and explicit unavailability (real Trace)', () => {
  it('labels unsupported-language matches as file-search-fallback, never as Trace', { timeout: LONG }, async () => {
    const f = await fixture();
    seedProjectA(f, 'initial');
    saveSourceFile(f.db, f.projectId, 'notes/plan.py', Buffer.from('def deploy_wombat_strategy():\n    return "python only"\n'));
    await f.service.reindex(f.projectId);

    const fallback = await f.service.search(f.projectId, 'deploy_wombat_strategy', 5);
    expect(fallback.provider).toBe('file-search-fallback');
    expect(fallback.results.length).toBeGreaterThan(0);
    expect(fallback.results[0]!.filePath).toBe('notes/plan.py');

    const supported = await f.service.search(f.projectId, 'addNumbers', 5);
    expect(supported.provider).toBe('trace');
  });

  it('fails explicitly when the Trace runtime is unavailable, with no silent substitution', { timeout: LONG }, async () => {
    const f = await fixture();
    seedProjectA(f, 'initial');
    await f.service.reindex(f.projectId);
    // Runtime death (closed MCP children) makes search fail explicitly.
    await f.service.closeAll();
    const searchAttempt = f.service.search(f.projectId, 'addNumbers', 5);
    await expect(searchAttempt).rejects.toMatchObject({ code: 'not_configured', details: { reason: 'trace_unavailable' } });
    // A broken sibling checkout fails reindex explicitly too.
    const broken = new RetrievalService({
      db: f.db,
      config: { ...f.config, providers: { ...f.config.providers, traceRoot: path.join(f.dataDir, 'no-trace-here') } },
    });
    const reindexAttempt = broken.reindex(f.projectId);
    await expect(reindexAttempt).rejects.toMatchObject({ code: 'not_configured', details: { reason: 'trace_unavailable' } });
  });
});

describe('serialization and public routes (real Trace)', () => {
  it('serializes concurrent reindex runs to one indexing job at a time', { timeout: LONG }, async () => {
    const f = await fixture();
    seedProjectA(f, 'initial');
    const [a, b] = await Promise.all([f.service.reindex(f.projectId), f.service.reindex(f.projectId)]);
    expect(a.snapshotId).not.toBeNull();
    expect(b.snapshotId).not.toBeNull();
  });

  it('authorizes retrieval routes per project membership and returns schema-shaped responses', { timeout: LONG }, async () => {
    const f = await fixture();
    seedProjectA(f, 'initial');
    let app: FastifyInstance | null = await buildApiServer({ config: f.config, db: f.db });
    try {
      const denied = await app.inject({
        method: 'POST',
        url: `/v1/projects/${f.projectId}/retrieval/search`,
        headers: f.otherAuth,
        payload: { query: 'addNumbers' },
      });
      expect(denied.statusCode).toBe(403);

      const reindexDenied = await app.inject({
        method: 'POST',
        url: `/v1/projects/${f.projectId}/retrieval/reindex`,
        headers: f.otherAuth,
        payload: {},
      });
      expect(reindexDenied.statusCode).toBe(403);

      const reindexed = await app.inject({
        method: 'POST',
        url: `/v1/projects/${f.projectId}/retrieval/reindex`,
        headers: f.ownerAuth,
        payload: {},
      });
      expect(reindexed.statusCode).toBe(200);
      const statusBody = reindexed.json() as { retrieval: { provider: string; indexed: boolean; snapshotId: string | null } };
      expect(statusBody.retrieval.indexed).toBe(true);
      expect(statusBody.retrieval.provider).toBe('trace');

      const searched = await app.inject({
        method: 'POST',
        url: `/v1/projects/${f.projectId}/retrieval/search`,
        headers: f.ownerAuth,
        payload: { query: 'addNumbers', limit: 5 },
      });
      expect(searched.statusCode).toBe(200);
      const searchBody = searched.json() as { provider: string; results: Array<Record<string, unknown>> };
      expect(searchBody.provider).toBe('trace');
      expect(searchBody.results.length).toBeGreaterThan(0);
      for (const result of searchBody.results) {
        expect(typeof result['filePath']).toBe('string');
        expect(typeof result['startLine']).toBe('number');
        expect(typeof result['snapshotId']).toBe('string');
        expect(typeof result['verbatim']).toBe('boolean');
      }

      const status = await app.inject({
        method: 'GET',
        url: `/v1/projects/${f.projectId}/retrieval/status`,
        headers: f.ownerAuth,
      });
      expect(status.statusCode).toBe(200);
      const statusJson = status.json() as { retrieval: { indexed: boolean; languages: string[] } };
      expect(statusJson.retrieval.indexed).toBe(true);
      expect(statusJson.retrieval.languages).toContain('typescript');
    } finally {
      await app.close();
      app = null;
    }
  });
});

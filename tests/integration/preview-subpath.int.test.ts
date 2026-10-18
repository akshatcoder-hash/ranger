import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildPreviewApp } from '../../src/entrypoints/preview.js';
import { ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createProjectRecord } from '../../src/projects/store.js';
import { createTicket } from '../../src/auth/tickets.js';
import { insertPreviewSession, setPreviewLocalPort } from '../../src/workspace/store.js';

/**
 * The private app preview forwards the session's fixed guest port with the
 * ORIGINAL method and app-relative subpath (an app has more than one route).
 * Every request consumes its own single-use purpose-bound ticket, membership
 * is re-checked, and arbitrary targets stay rejected.
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-preview-sub-'));
const previewPort = 3965;
const upstreamPort = 3966;

let db: DatabaseSync;
let upstream: Server;

async function startUpstream(): Promise<void> {
  upstream = createServer((req, res) => {
    const respond = (payload: string, type = 'application/json'): void => {
      res.writeHead(200, { 'content-type': type });
      res.end(payload);
    };
    if (req.url === '/') {
      respond('<html><body>app-root</body></html>', 'text/html');
      return;
    }
    if (req.url === '/status') {
      respond(JSON.stringify({ status: 'ok', path: '/status', method: 'GET' }));
      return;
    }
    if (req.url === '/tickets' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        respond(JSON.stringify({ status: 'drafted', got: JSON.parse(raw), method: 'POST' }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));
}

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

describe('preview gateway forwards app subpaths (fixed port, single-use tickets)', () => {
  it('forwards subpaths and POST bodies; rejects reused tickets and arbitrary targets', async () => {
    const config = await loadConfig({
      RANGER_DATA_DIR: dataDir,
      RANGER_PREVIEW_PORT: String(previewPort),
      RANGER_LOG_LEVEL: 'error',
    } as NodeJS.ProcessEnv);
    db = openDatabase(dataDir);
    runMigrations(db, path.join(process.cwd(), 'migrations'));
    await startUpstream();

    const owner = ensureInitialPrincipal(db, { dataDir, repoRoot: process.cwd(), displayName: 'Preview' });
    const project = createProjectRecord(db, { name: 'Preview subpaths', engineerDisplayName: 'Ranger', principalId: owner.principalId });
    const credential = db.prepare('SELECT id FROM credentials ORDER BY created_at LIMIT 1').get() as { id: string };

    const sessionId = insertPreviewSession(db, project.id, 8080, 60_000).id;
    setPreviewLocalPort(db, project.id, sessionId, upstreamPort);

    const { app, db: previewDb } = await buildPreviewApp(config);
    await app.listen({ host: '127.0.0.1', port: previewPort });
    try {
      const mint = (): string => {
        const { secret } = createTicket(db, {
          principalId: owner.principalId,
          projectId: project.id,
          purpose: 'app-preview',
          credentialKind: 'api_token',
          credentialId: credential.id,
          ttlMs: 30_000,
        });
        return secret;
      };
      const url = (appPath: string): string =>
        `http://127.0.0.1:${previewPort}/v1/projects/${project.id}/preview/sessions/${sessionId}/app${appPath}?ticket=${encodeURIComponent(mint())}`;

      const root = await fetch(url(''));
      expect(root.status).toBe(200);
      expect(await root.text()).toContain('app-root');

      const status = await fetch(url('/status'));
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ status: 'ok', path: '/status', method: 'GET' });

      const post = await fetch(url('/tickets'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: 'evt-1', orderId: 'ORD-1' }),
      });
      expect(post.status).toBe(200);
      expect(await post.json()).toMatchObject({ status: 'drafted', got: { eventId: 'evt-1' }, method: 'POST' });

      // A ticket is single-use: replaying its URL is rejected.
      const reuseUrl = `http://127.0.0.1:${previewPort}/v1/projects/${project.id}/preview/sessions/${sessionId}/app/status?ticket=${encodeURIComponent(mint())}`;
      expect((await fetch(reuseUrl)).status).toBe(200);
      const reused = await fetch(reuseUrl);
      expect(reused.status).toBe(401);
      const reusedBody = (await reused.json()) as Record<string, unknown>;
      expect((reusedBody['error'] as { code?: string } | undefined)?.code ?? JSON.stringify(reusedBody)).toBe('unauthorized');

      // Arbitrary targets stay rejected on subpaths too.
      const hijack = await fetch(url('/status').concat('&target=http://example.com'));
      expect(hijack.status).toBe(400);
      const hijackBody = (await hijack.json()) as Record<string, unknown>;
      expect((hijackBody['error'] as { code?: string } | undefined)?.code ?? JSON.stringify(hijackBody)).toBe('validation_failed');
    } finally {
      await app.close();
      previewDb.close();
      db.close();
    }
  }, 30_000);
});

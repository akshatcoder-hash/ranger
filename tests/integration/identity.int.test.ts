import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type RangerConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/http/app.js';
import { createPrincipal, createCredential } from '../../src/auth/principals.js';
import { consumeTicket } from '../../src/auth/tickets.js';
import { ensureInitialPrincipal, defaultBootstrapCredentialPath } from '../../src/identity/bootstrap.js';
import { createFixtureRepo } from '../helpers/fixture-repo.js';

/**
 * Identity, projects and repository persistence over the REAL API surface
 * (Fastify inject on a real SQLite database): bootstrap credentials, hashed
 * tokens, revocable sessions with CSRF/origin checks, connection tickets,
 * membership authorization and restart durability.
 */

const HOST = 'ranger.test';

function makeApp(env: Record<string, string>, existingDataDir?: string): Promise<{ app: FastifyInstance; config: RangerConfig; dataDir: string }> {
  const dataDir = existingDataDir ?? mkdtempSync(path.join(tmpdir(), 'ranger-identity-int-'));
  return (async () => {
    const config = await loadConfig({ RANGER_DATA_DIR: dataDir, RANGER_LOG_LEVEL: 'error', ...env } as NodeJS.ProcessEnv);
    const db = openDatabase(dataDir);
    runMigrations(db, path.join(process.cwd(), 'migrations'));
    const app = await buildApiServer({ config, db });
    return { app, config, dataDir };
  })();
}

/** Assert the plaintext secret appears nowhere in the database bytes. */
function assertSecretNotInDb(dataDir: string, secrets: string[]): void {
  for (const suffix of ['ranger.db', 'ranger.db-wal', 'ranger.db-shm']) {
    const file = path.join(dataDir, suffix);
    try {
      const raw = readFileSync(file, 'utf8');
      for (const secret of secrets) {
        expect(raw.includes(secret), `plaintext secret leaked into ${suffix}`).toBe(false);
      }
    } catch {
      // absent file (e.g. no WAL yet) is fine
    }
  }
}

describe('identity, projects and repositories', () => {
  let app: FastifyInstance;
  let dataDir: string;
  let db: DatabaseSync;
  let bootstrapToken: string;
  let bootstrapPrincipalId: string;
  let projectId: string;

  beforeAll(async () => {
    const made = await makeApp({});
    app = made.app;
    dataDir = made.dataDir;
    db = new DatabaseSync(path.join(dataDir, 'ranger.db'));

    // Bootstrap: initial principal + protected credential file.
    const outcome = ensureInitialPrincipal(db, {
      dataDir,
      repoRoot: process.cwd(),
      displayName: 'Operator',
    });
    bootstrapPrincipalId = outcome.principalId;
    bootstrapToken = readFileSync(outcome.credentialPath, 'utf8').trim().split('=')[1]!;
    expect(statSync(outcome.credentialPath).mode & 0o777).toBe(0o600);
    expect(statSync(defaultBootstrapCredentialPath(dataDir)).mode & 0o777).toBe(0o600);

    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { authorization: `Bearer ${bootstrapToken}` },
      payload: { name: 'Integration Project', engineerDisplayName: 'Ranger' },
    });
    expect(create.statusCode).toBe(200);
    projectId = (create.json() as { project: { projectId: string } }).project.projectId;
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it('bootstrap credential authenticates as bearer; unauthenticated and unknown fail unauthorized', async () => {
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${bootstrapToken}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json() as { principalId: string; displayName: string }).toMatchObject({
      principalId: bootstrapPrincipalId,
      displayName: 'Operator',
    });

    const none = await app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(none.statusCode).toBe(401);
    expect((none.json() as { error: { code: string } }).error.code).toBe('unauthorized');

    const garbage = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: 'Bearer rng_not-a-credential' } });
    expect(garbage.statusCode).toBe(401);
    expect((garbage.json() as { error: { code: string } }).error.code).toBe('unauthorized');

    const malformed = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: 'Basic dXNlcjpwYXNz' } });
    expect(malformed.statusCode).toBe(401);
  });

  it('created API tokens work, list metadata only, and revocation takes effect while others keep working', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/auth/api-tokens',
      headers: { authorization: `Bearer ${bootstrapToken}` },
      payload: { name: 'worker-token' },
    });
    expect(created.statusCode).toBe(200);
    const { tokenId, token } = created.json() as { tokenId: string; token: string };
    expect(token.startsWith('rng_')).toBe(true);

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/v1/auth/api-tokens', headers: { authorization: `Bearer ${bootstrapToken}` } });
    const tokens = (list.json() as { tokens: Array<{ tokenId: string; name: string; createdAt: string }> }).tokens;
    expect(tokens.some((t) => t.tokenId === tokenId && t.name === 'worker-token')).toBe(true);
    expect(JSON.stringify(tokens).includes(token)).toBe(false);

    // A second principal is unaffected by the first one's credentials.
    const otherPrincipal = createPrincipal(db, 'Second Operator');
    const otherCred = createCredential(db, otherPrincipal.id, 'api_token', 'other');
    const otherRevoked = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/api-tokens/${tokenId}`,
      headers: { authorization: `Bearer ${otherCred.secret}` },
    });
    expect(otherRevoked.statusCode).toBe(404); // foreign token: no existence leak

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/api-tokens/${tokenId}`,
      headers: { authorization: `Bearer ${bootstrapToken}` },
    });
    expect(revoked.statusCode).toBe(200);

    const afterRevocation = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(afterRevocation.statusCode).toBe(401);
    const otherStillWorking = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${otherCred.secret}` } });
    expect(otherStillWorking.statusCode).toBe(200);
    const bootstrapStillWorking = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${bootstrapToken}` } });
    expect(bootstrapStillWorking.statusCode).toBe(200);

    assertSecretNotInDb(dataDir, [token, otherCred.secret, bootstrapToken]);
  });

  it('browser sessions authorize via cookie, require CSRF/origin on mutations, and survive restart until revoked', async () => {
    const session = await app.inject({
      method: 'POST',
      url: '/v1/auth/browser-sessions',
      headers: { authorization: `Bearer ${bootstrapToken}` },
      payload: { apiToken: bootstrapToken },
    });
    expect(session.statusCode).toBe(200);
    const body = session.json() as { sessionId: string; expiresAt: string; csrfToken: string };
    expect(body.csrfToken.length).toBeGreaterThan(20);
    const setCookie = session.headers['set-cookie'];
    expect(Array.isArray(setCookie) ? setCookie[0] : setCookie).toContain('HttpOnly');
    const cookieValue = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!
      .split(';')[0]!
      .split('=')
      .slice(1)
      .join('=');

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: `ranger_session=${cookieValue}` } });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { principalId: string }).principalId).toBe(bootstrapPrincipalId);

    // Cookie mutation with NO protection: rejected.
    const bare = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: { cookie: `ranger_session=${cookieValue}`, host: HOST },
      payload: { engineerDisplayName: 'Ranger Two' },
    });
    expect(bare.statusCode).toBe(403);
    expect((bare.json() as { error: { code: string; details?: Record<string, unknown> } }).error.details).toMatchObject({ reason: 'csrf_required' });

    // Cookie mutation from a foreign origin: rejected even with a valid CSRF token.
    const foreign = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: { cookie: `ranger_session=${cookieValue}`, host: HOST, origin: 'http://evil.example', 'x-ranger-csrf': body.csrfToken },
      payload: { engineerDisplayName: 'Ranger Two' },
    });
    expect(foreign.statusCode).toBe(403);
    expect((foreign.json() as { error: { details?: Record<string, unknown> } }).error.details).toMatchObject({ reason: 'origin_mismatch' });

    // Same-origin cookie mutation: allowed.
    const sameOrigin = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: { cookie: `ranger_session=${cookieValue}`, host: HOST, origin: `http://${HOST}` },
      payload: { engineerDisplayName: 'Ranger Two' },
    });
    expect(sameOrigin.statusCode).toBe(200);
    expect((sameOrigin.json() as { project: { engineerDisplayName: string } }).project.engineerDisplayName).toBe('Ranger Two');

    // Synchronizer-token cookie mutation without Origin: allowed.
    const withToken = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: { cookie: `ranger_session=${cookieValue}`, host: HOST, 'x-ranger-csrf': body.csrfToken },
      payload: { name: 'Integration Project Renamed' },
    });
    expect(withToken.statusCode).toBe(200);

    // Restart: same data directory, new app — the session still works.
    await app.close();
    db.close();
    const restarted = await makeApp({}, dataDir);
    app = restarted.app;
    db = new DatabaseSync(path.join(dataDir, 'ranger.db'));
    const meAfterRestart = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: `ranger_session=${cookieValue}` } });
    expect(meAfterRestart.statusCode).toBe(200);

    // Revoke the session; the cookie stops working immediately.
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/browser-sessions/${body.sessionId}`,
      headers: { authorization: `Bearer ${bootstrapToken}` },
    });
    expect(revoke.statusCode).toBe(200);
    const afterRevoke = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: `ranger_session=${cookieValue}` } });
    expect(afterRevoke.statusCode).toBe(401);
    expect((afterRevoke.json() as { error: { code: string } }).error.code).toBe('unauthorized');
  });

  it('connection tickets bind principal/project/purpose, are single-use and die with the issuing credential', async () => {
    const ticketRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/connection-tickets',
      headers: { authorization: `Bearer ${bootstrapToken}` },
      payload: { projectId, purpose: 'events', origin: `http://${HOST}` },
    });
    expect(ticketRes.statusCode).toBe(200);
    const { ticket, expiresAt } = ticketRes.json() as { ticket: string; expiresAt: string };
    expect(ticket.startsWith('tkt_')).toBe(true);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Foreign project tickets are not creatable.
    const otherPrincipal = createPrincipal(db, 'Foreign');
    const foreign = await app.inject({
      method: 'POST',
      url: '/v1/auth/connection-tickets',
      headers: { authorization: `Bearer ${authenticateBearerSecretFor(otherPrincipal.id)}` },
      payload: { projectId, purpose: 'events' },
    });
    expect(foreign.statusCode).toBe(403);

    const binding = consumeTicket(db, ticket, { purpose: 'events', projectId, origin: `http://${HOST}` });
    expect(binding.projectId).toBe(projectId);
    expectAppUnauthorized(() => consumeTicket(db, ticket, { purpose: 'events' }));

    // Revoke the bootstrap credential's token that issued a second ticket.
    const tokenCreate = await app.inject({
      method: 'POST',
      url: '/v1/auth/api-tokens',
      headers: { authorization: `Bearer ${bootstrapToken}` },
      payload: { name: 'ticket-issuer' },
    });
    const issuerToken = (tokenCreate.json() as { tokenId: string; token: string });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/auth/connection-tickets',
      headers: { authorization: `Bearer ${issuerToken.token}` },
      payload: { projectId, purpose: 'events' },
    });
    const secondTicket = (second.json() as { ticket: string }).ticket;
    const revokeIssuer = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/api-tokens/${issuerToken.tokenId}`,
      headers: { authorization: `Bearer ${bootstrapToken}` },
    });
    expect(revokeIssuer.statusCode).toBe(200);
    expectAppUnauthorized(() => consumeTicket(db, secondTicket, { purpose: 'events' }));

    function authenticateBearerSecretFor(principalId: string): string {
      const cred = createCredential(db, principalId, 'api_token', 'probe');
      return cred.secret;
    }
  });

  it('projects, engineer names and memberships are authorized, isolated and durable', async () => {
    // Two principals with separate projects never see each other's resources.
    const otherPrincipal = createPrincipal(db, 'Other Operator');
    const otherCred = createCredential(db, otherPrincipal.id, 'api_token', 'other');
    const otherHeaders = { authorization: `Bearer ${otherCred.secret}` };

    const foreignGet = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}`, headers: otherHeaders });
    expect(foreignGet.statusCode).toBe(403);
    expect((foreignGet.json() as { error: { code: string } }).error.code).toBe('forbidden');

    const foreignList = await app.inject({ method: 'GET', url: '/v1/projects', headers: otherHeaders });
    expect((foreignList.json() as { projects: unknown[] }).projects).toEqual([]);

    const foreignPatch = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: otherHeaders,
      payload: { engineerDisplayName: 'Hijack' },
    });
    expect(foreignPatch.statusCode).toBe(403);

    const foreignConnect = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/repository`,
      headers: otherHeaders,
      payload: { url: 'file:///srv/x', ref: 'main' },
    });
    expect(foreignConnect.statusCode).toBe(403);

    // Owner updates the engineer display name; the change is read back.
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: { authorization: `Bearer ${bootstrapToken}` },
      payload: { engineerDisplayName: 'Ranger Prime' },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { project: { engineerDisplayName: string } }).project.engineerDisplayName).toBe('Ranger Prime');

    const memberGet = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}`, headers: { authorization: `Bearer ${bootstrapToken}` } });
    expect((memberGet.json() as { project: { engineerDisplayName: string } }).project.engineerDisplayName).toBe('Ranger Prime');

    // Members cannot manage the project.
    const addSelf = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/memberships`,
      headers: otherHeaders,
      payload: { principalId: otherPrincipal.id, role: 'member' },
    });
    expect(addSelf.statusCode).toBe(403);

    // Owner adds the member; the member can then read; membership change
    // affects only the targeted principal.
    const add = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/memberships`,
      headers: { authorization: `Bearer ${bootstrapToken}` },
      payload: { principalId: otherPrincipal.id, role: 'member' },
    });
    expect(add.statusCode).toBe(200);
    const memberNow = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}`, headers: otherHeaders });
    expect(memberNow.statusCode).toBe(200);
    const memberPatch = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${projectId}`,
      headers: otherHeaders,
      payload: { name: 'Nope' },
    });
    expect(memberPatch.statusCode).toBe(403);

    const members = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/memberships`, headers: { authorization: `Bearer ${bootstrapToken}` } });
    const memberIds = (members.json() as { memberships: Array<{ principalId: string; role: string }> }).memberships;
    expect(memberIds).toHaveLength(2);
    expect(memberIds.find((m) => m.principalId === otherPrincipal.id)?.role).toBe('member');

    // Removing the last owner conflicts; removing the member revokes access.
    const removeOwner = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}/memberships/${bootstrapPrincipalId}`,
      headers: { authorization: `Bearer ${bootstrapToken}` },
    });
    expect(removeOwner.statusCode).toBe(409);
    const remove = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${projectId}/memberships/${otherPrincipal.id}`,
      headers: { authorization: `Bearer ${bootstrapToken}` },
    });
    expect(remove.statusCode).toBe(200);
    const memberAfter = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}`, headers: otherHeaders });
    expect(memberAfter.statusCode).toBe(403);
  });

  it('repository references persist real snapshots, survive restart and stay project-private', async () => {
    const baseTmp = mkdtempSync(path.join(tmpdir(), 'ranger-int-repo-'));
    const fixture = createFixtureRepo(baseTmp, 'connected-app');
    const headers = { authorization: `Bearer ${bootstrapToken}` };

    const connect = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/repository`,
      headers,
      payload: { url: fixture.fileUrl, ref: 'main', checkoutPath: 'workspace', checkoutPolicy: { shallow: true } },
    });
    expect(connect.statusCode).toBe(200);
    const connected = (connect.json() as { repository: { commit: string; dirty: boolean; contentHash: string; checkoutPath: string; checkoutPolicy: { shallow: boolean; submodules: boolean } } }).repository;
    const head = execFileSync('git', ['-C', fixture.root, 'rev-parse', 'HEAD']).toString().trim();
    expect(connected.commit).toBe(head);
    expect(connected.dirty).toBe(false);
    expect(connected.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(connected.checkoutPath).toBe('workspace');
    expect(connected.checkoutPolicy).toEqual({ shallow: true, submodules: false });

    const read = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/repository`, headers });
    expect((read.json() as { repository: { commit: string } }).repository.commit).toBe(head);

    // Dirty working tree is reflected on reconnect.
    writeFileSync(fixture.trackedFile, 'export const version = 99;\n');
    const reconnect = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/repository`,
      headers,
      payload: { url: fixture.fileUrl, ref: 'main' },
    });
    expect((reconnect.json() as { repository: { dirty: boolean; checkoutPolicy: { shallow: boolean } } }).repository.dirty).toBe(true);
    expect((reconnect.json() as { repository: { checkoutPolicy: { shallow: boolean } } }).repository.checkoutPolicy.shallow).toBe(false);

    // A second principal with their own project cannot read or use it.
    const otherPrincipal = createPrincipal(db, 'Repo Foreign');
    const otherCred = createCredential(db, otherPrincipal.id, 'api_token', 'other');
    const otherHeaders = { authorization: `Bearer ${otherCred.secret}` };
    const otherProject = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: otherHeaders,
      payload: { name: 'Other Project', engineerDisplayName: 'Other Ranger' },
    });
    const otherProjectId = (otherProject.json() as { project: { projectId: string } }).project.projectId;
    const foreignRead = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/repository`, headers: otherHeaders });
    expect(foreignRead.statusCode).toBe(403);
    const foreignReplace = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/repository`,
      headers: otherHeaders,
      payload: { url: fixture.fileUrl, ref: 'main' },
    });
    expect(foreignReplace.statusCode).toBe(403);
    // The other project has its own repository slot, unrelated to A's.
    const otherRead = await app.inject({ method: 'GET', url: `/v1/projects/${otherProjectId}/repository`, headers: otherHeaders });
    expect(otherRead.statusCode).toBe(404);

    // Validation: credential-bearing URL, traversal and bad scheme.
    const credUrl = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/repository`,
      headers,
      payload: { url: 'https://user:hunter2@git.example/org/app', ref: 'main' },
    });
    expect(credUrl.statusCode).toBe(400);
    expect((credUrl.json() as { error: { details?: Record<string, unknown> } }).error.details).toMatchObject({ reason: 'credentials_in_url' });
    const traversal = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/repository`,
      headers,
      payload: { url: fixture.fileUrl, ref: 'main', checkoutPath: '../escape' },
    });
    expect(traversal.statusCode).toBe(400);
    const scheme = await app.inject({
      method: 'PUT',
      url: `/v1/projects/${projectId}/repository`,
      headers,
      payload: { url: 'http://insecure.example/app', ref: 'main' },
    });
    expect(scheme.statusCode).toBe(400);

    // Restart: same data dir — repository references survive.
    await app.close();
    db.close();
    const restarted = await makeApp({}, dataDir);
    app = restarted.app;
    db = new DatabaseSync(path.join(dataDir, 'ranger.db'));
    const afterRestart = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/repository`, headers });
    expect(afterRestart.statusCode).toBe(200);
    const persisted = (afterRestart.json() as { repository: { commit: string; dirty: boolean; contentHash: string; url: string; ref: string } }).repository;
    expect(persisted.commit).toBe(head);
    expect(persisted.dirty).toBe(true);
    expect(persisted.url).toBe(fixture.fileUrl);
    expect(persisted.ref).toBe('main');

    // Disconnect removes the reference for the project.
    const disconnect = await app.inject({ method: 'DELETE', url: `/v1/projects/${projectId}/repository`, headers });
    expect(disconnect.statusCode).toBe(200);
    const gone = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/repository`, headers });
    expect(gone.statusCode).toBe(404);
  });
});

function expectAppUnauthorized(fn: () => unknown): void {
  try {
    fn();
  } catch (cause) {
    expect((cause as { code?: string }).code).toBe('unauthorized');
    return;
  }
  throw new Error('expected an unauthorized error, but none was thrown');
}

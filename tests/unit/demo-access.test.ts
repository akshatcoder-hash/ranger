import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../../src/config.js';
import { openDatabase } from '../../src/db/db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { buildApiServer } from '../../src/http/app.js';
import { createCredential, createPrincipal } from '../../src/auth/principals.js';
import { membershipRole } from '../../src/auth/authorization.js';
import { addMembershipRow, createProjectRow } from '../../src/projects/store.js';
import { writeRepositoryRecord } from '../../src/repositories/store.js';

const REPO = 'https://github.com/satnaing/shadcn-admin';

let dataDir: string;
let db: DatabaseSync;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-demo-access-'));
  db = openDatabase(dataDir);
  runMigrations(db, path.join(process.cwd(), 'migrations'));
});

afterEach(() => db.close());

function seedProject(name: string, withRepository = true): { projectId: string; ownerId: string } {
  const owner = createPrincipal(db, 'Operator');
  const project = createProjectRow(db, { name, engineerDisplayName: 'Ranger', principalId: owner.id });
  if (withRepository) {
    writeRepositoryRecord(db, project.id, owner.id, {
      validated: { url: REPO, ref: 'HEAD', checkoutPath: 'repo', checkoutPolicy: { shallow: false, submodules: false } },
      snapshot: null,
    });
  }
  return { projectId: project.id, ownerId: owner.id };
}

async function appWith(demoProjectId?: string) {
  const config = await loadConfig({
    RANGER_DATA_DIR: dataDir,
    RANGER_LOG_LEVEL: 'error',
    ...(demoProjectId ? { RANGER_DEMO_PROJECT_ID: demoProjectId } : {}),
  } as NodeJS.ProcessEnv);
  return buildApiServer({ config, db });
}

function cookieFrom(setCookie: string | string[] | number | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return header!.split(';')[0]!;
}

async function anonymous(app: Awaited<ReturnType<typeof appWith>>): Promise<{ cookie: string; csrf: string; principalId: string; me: Record<string, unknown> }> {
  const session = await app.inject({ method: 'POST', url: '/v1/auth/anonymous-session', payload: {} });
  const cookie = cookieFrom(session.headers['set-cookie']);
  const csrf = (session.json() as { csrfToken: string }).csrfToken;
  const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
  const body = me.json() as Record<string, unknown>;
  return { cookie, csrf, principalId: body.principalId as string, me: body };
}

describe('demo project config', () => {
  it('is disabled by default and rejects malformed ids', async () => {
    expect((await loadConfig({ RANGER_DATA_DIR: dataDir } as NodeJS.ProcessEnv)).demoProjectId).toBeNull();
    await expect(loadConfig({ RANGER_DATA_DIR: dataDir, RANGER_DEMO_PROJECT_ID: 'nope' } as NodeJS.ProcessEnv)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('shared demo access', () => {
  it('grants a new anonymous session member access to only the demo project and exposes the target after proof', async () => {
    const demo = seedProject('Demo');
    const other = seedProject('Other');
    const app = await appWith(demo.projectId);
    try {
      const guest = await anonymous(app);
      expect(guest.me.demoProject).toEqual({ projectId: demo.projectId, repositoryUrl: REPO, ref: 'HEAD' });
      expect(membershipRole(db, demo.projectId, guest.principalId)).toBe('member');
      expect(membershipRole(db, other.projectId, guest.principalId)).toBeNull();

      const allowed = await app.inject({ method: 'GET', url: `/v1/projects/${demo.projectId}`, headers: { cookie: guest.cookie } });
      expect(allowed.statusCode).toBe(200);
      const denied = await app.inject({ method: 'GET', url: `/v1/projects/${other.projectId}`, headers: { cookie: guest.cookie } });
      expect(denied.statusCode).toBe(403);
      const ownerOnly = await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${demo.projectId}`,
        headers: { cookie: guest.cookie, 'x-ranger-csrf': guest.csrf },
        payload: { name: 'Hijacked' },
      });
      expect(ownerOnly.statusCode).toBe(403);
      expect(membershipRole(db, demo.projectId, demo.ownerId)).toBe('owner');
    } finally {
      await app.close();
    }
  });

  it('grants pre-existing anonymous sessions on first authenticated read, but never API principals', async () => {
    const demo = seedProject('Demo');
    const before = await appWith();
    const early = await anonymous(before);
    await before.close();
    expect(early.me.demoProject).toBeUndefined();
    expect(membershipRole(db, demo.projectId, early.principalId)).toBeNull();

    const app = await appWith(demo.projectId);
    try {
      const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: early.cookie } });
      expect((me.json() as { demoProject?: { projectId: string } }).demoProject?.projectId).toBe(demo.projectId);
      expect(membershipRole(db, demo.projectId, early.principalId)).toBe('member');
    } finally {
      await app.close();
    }
  });

  it('never grants API principals, even when they authenticate with the flag on', async () => {
    const demo = seedProject('Demo');
    const apiPrincipal = createPrincipal(db, 'Guest');
    const { secret } = createCredential(db, apiPrincipal.id, 'api_token', 'ci');
    const app = await appWith(demo.projectId);
    try {
      const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${secret}` } });
      expect(me.statusCode).toBe(200);
      expect((me.json() as { demoProject?: unknown }).demoProject).toBeUndefined();
      expect(membershipRole(db, demo.projectId, apiPrincipal.id)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('keeps the shared repository owner-only while guests can still read it', async () => {
    const demo = seedProject('Demo');
    const other = seedProject('Other');
    const guestOfOther = createPrincipal(db, 'Member');
    addMembershipRow(db, other.projectId, guestOfOther.id, 'member');
    const ownerToken = createCredential(db, demo.ownerId, 'api_token', 'owner').secret;
    const memberToken = createCredential(db, guestOfOther.id, 'api_token', 'member').secret;
    const app = await appWith(demo.projectId);
    try {
      const guest = await anonymous(app);
      const headers = { cookie: guest.cookie, 'x-ranger-csrf': guest.csrf };
      const url = `/v1/projects/${demo.projectId}/repository`;
      expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(200);
      const put = await app.inject({ method: 'PUT', url, headers, payload: { url: 'https://github.com/other/repo', ref: 'main' } });
      expect(put.statusCode).toBe(403);
      expect(put.json()).toMatchObject({ error: { message: expect.stringContaining('owner role') } });
      const del = await app.inject({ method: 'DELETE', url, headers });
      expect(del.statusCode).toBe(403);
      expect(del.json()).toMatchObject({ error: { message: expect.stringContaining('owner role') } });
      expect(db.prepare('SELECT url FROM project_repositories WHERE project_id = ?').get(demo.projectId)).toEqual({ url: REPO });

      // Non-demo projects keep plain member access: a member passes the gate (the 4xx is the repository validation, not 403).
      const otherPut = await app.inject({
        method: 'PUT',
        url: `/v1/projects/${other.projectId}/repository`,
        headers: { authorization: `Bearer ${memberToken}` },
        payload: { url: 'ftp://nope', ref: 'main' },
      });
      expect(otherPut.statusCode).not.toBe(403);

      // The owner may still disconnect the demo repository.
      const ownerDel = await app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${ownerToken}` } });
      expect(ownerDel.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('does nothing when the flag is unset', async () => {
    const demo = seedProject('Demo');
    const app = await appWith();
    try {
      const guest = await anonymous(app);
      expect(guest.me.demoProject).toBeUndefined();
      expect(membershipRole(db, demo.projectId, guest.principalId)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('revokes grant-created access on restart without the flag and keeps owner and invited memberships', async () => {
    const demo = seedProject('Demo');
    const on = await appWith(demo.projectId);
    const granted = await anonymous(on);
    const invited = createPrincipal(db, 'Guest');
    addMembershipRow(db, demo.projectId, invited.id, 'member');
    await on.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: granted.cookie } });
    await on.close();
    expect(membershipRole(db, demo.projectId, granted.principalId)).toBe('member');

    const off = await appWith();
    try {
      expect(membershipRole(db, demo.projectId, granted.principalId)).toBeNull();
      expect(membershipRole(db, demo.projectId, invited.id)).toBe('member');
      expect(membershipRole(db, demo.projectId, demo.ownerId)).toBe('owner');
      const me = await off.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: granted.cookie } });
      expect((me.json() as { demoProject?: unknown }).demoProject).toBeUndefined();
      const blocked = await off.inject({ method: 'GET', url: `/v1/projects/${demo.projectId}`, headers: { cookie: granted.cookie } });
      expect(blocked.statusCode).toBe(403);
    } finally {
      await off.close();
    }
  });

  it('moving the flag to another project revokes the old project only', async () => {
    const first = seedProject('First');
    const second = seedProject('Second');
    const on = await appWith(first.projectId);
    const guest = await anonymous(on);
    await on.close();

    const moved = await appWith(second.projectId);
    try {
      expect(membershipRole(db, first.projectId, guest.principalId)).toBeNull();
      const me = await moved.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: guest.cookie } });
      expect((me.json() as { demoProject?: { projectId: string } }).demoProject?.projectId).toBe(second.projectId);
    } finally {
      await moved.close();
    }
  });

  it('omits the target when the demo project has no repository', async () => {
    const demo = seedProject('Demo', false);
    const app = await appWith(demo.projectId);
    try {
      const guest = await anonymous(app);
      expect(guest.me.demoProject).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

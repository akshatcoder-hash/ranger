import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/db/db.js';
import { migrationsDirFromCwd, runMigrations } from '../../src/db/migrate.js';
import { isAppError } from '../../src/errors.js';
import { generateSecret, materialForSecret, verifySecret } from '../../src/auth/hashing.js';
import {
  authenticateBearer,
  createCredential,
  createPrincipal,
  revokeCredential,
} from '../../src/auth/principals.js';
import {
  DEFAULT_SESSION_TTL_MS,
  SESSION_COOKIE_NAME,
  authenticateCookie,
  createSession,
  parseSessionCookieHeader,
  revokeSession,
  verifyCsrfToken,
} from '../../src/auth/sessions.js';
import {
  DEFAULT_TICKET_TTL_MS,
  consumeTicket,
  createTicket,
} from '../../src/auth/tickets.js';
import {
  membershipRole,
  requireMembership,
  requireProjectOwner,
} from '../../src/auth/authorization.js';
import {
  addMembershipRow,
  createProjectRow,
  listProjectsForPrincipal,
  removeMembershipRow,
  updateProjectRow,
} from '../../src/projects/store.js';
import {
  connectRepository,
  disconnectRepository,
  getRepositoryRecord,
  validateRepositoryInput,
} from '../../src/repositories/store.js';
import { localRepositoryPath, resolveLocalSnapshot } from '../../src/repositories/snapshot.js';
import { createAdditionalPrincipal, defaultBootstrapCredentialPath, ensureInitialPrincipal } from '../../src/identity/bootstrap.js';
import { createFixtureRepo } from '../helpers/fixture-repo.js';

let db: DatabaseSync;
let dataDir: string;

/** Synchronous helper: fn must throw an AppError with exactly this code. */
function expectAppErrorCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (cause) {
    thrown = cause;
  }
  expect(isAppError(thrown), `expected AppError, got ${String(thrown)}`).toBe(true);
  expect((thrown as { code?: string }).code, `expected code ${code}`).toBe(code);
}

/** Row count helper for asserting that failed writes left nothing behind. */
function countRows(db: DatabaseSync, table: 'principals' | 'credentials'): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ranger-identity-unit-'));
  db = openDatabase(dataDir);
  runMigrations(db, migrationsDirFromCwd());
});

describe('secret hashing', () => {
  it('generates a prefixed high-entropy secret with stable lookup and scrypt hash', () => {
    const material = generateSecret('rng');
    expect(material.secret.startsWith('rng_')).toBe(true);
    expect(material.secret.length).toBeGreaterThan(30);
    expect(material.lookup).toMatch(/^[0-9a-f]{64}$/);
    expect(material.hash.startsWith('scrypt$')).toBe(true);
    // Deterministic for the same secret, distinct across secrets.
    expect(materialForSecret(material.secret).lookup).toBe(material.lookup);
    expect(materialForSecret(generateSecret('rng').secret).lookup).not.toBe(material.lookup);
  });

  it('verifies the exact secret and rejects tampered values', () => {
    const material = generateSecret('rng');
    expect(verifySecret(material.secret, material.hash)).toBe(true);
    expect(verifySecret(`${material.secret}x`, material.hash)).toBe(false);
    expect(verifySecret(material.secret, 'scrypt$1$1$1$aaa$bbb')).toBe(false);
  });
});

describe('principals and bearer credentials', () => {
  it('authenticates a stored credential and rejects unknown, malformed or revoked secrets', () => {
    const principal = createPrincipal(db, 'Ada');
    const { secret, credential } = createCredential(db, principal.id, 'api_token', 'cli');
    const auth = authenticateBearer(db, secret);
    expect(auth?.principalId).toBe(principal.id);
    expect(auth?.credentialId).toBe(credential.id);

    expect(authenticateBearer(db, 'rng_missing')).toBeNull();
    expect(authenticateBearer(db, `${secret}x`)).toBeNull();

    expect(revokeCredential(db, principal.id, credential.id)).toBe(true);
    expect(authenticateBearer(db, secret)).toBeNull();
  });

  it('stores only hashes and lookups, never the plaintext secret', () => {
    const principal = createPrincipal(db, 'Hashcheck');
    const { secret } = createCredential(db, principal.id, 'api_token', 'scan');
    const raw = readFileSync(path.join(dataDir, 'ranger.db'), 'utf8');
    expect(raw.includes(secret)).toBe(false);
  });

  it('scopes revocation to the owning principal', () => {
    const ada = createPrincipal(db, 'Ada');
    const grace = createPrincipal(db, 'Grace');
    const adaToken = createCredential(db, ada.id, 'api_token', 'ada');
    expect(revokeCredential(db, grace.id, adaToken.credential.id)).toBe(false);
    expect(authenticateBearer(db, adaToken.secret)?.principalId).toBe(ada.id);
  });
});

describe('browser sessions', () => {
  it('round-trips a cookie value and expires on TTL', () => {
    const principal = createPrincipal(db, 'Sess');
    const created = createSession(db, principal.id);
    expect(created.setCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(created.setCookie).toContain('HttpOnly');

    const header = `${SESSION_COOKIE_NAME}=${created.session.id}.${created.secret}; other=x`;
    const cookieValue = parseSessionCookieHeader(header);
    expect(cookieValue).toBe(`${created.session.id}.${created.secret}`);

    const auth = authenticateCookie(db, cookieValue!);
    expect(auth?.principalId).toBe(principal.id);
    expect(verifyCsrfToken(created.csrfToken, auth!.csrfHash)).toBe(true);
    expect(verifyCsrfToken('wrong', auth!.csrfHash)).toBe(false);

    const expired = createSession(db, principal.id, -1);
    expect(authenticateCookie(db, `${expired.session.id}.${expired.secret}`)).toBeNull();
  });

  it('survives a fresh open of the same database (restart) until revoked', () => {
    const principal = createPrincipal(db, 'Persist');
    const created = createSession(db, principal.id, DEFAULT_SESSION_TTL_MS);
    expect(authenticateCookie(db, `${created.session.id}.${created.secret}`)).not.toBeNull();
    // Simulated restart: same file, a brand-new database handle.
    db.close();
    db = openDatabase(dataDir);
    const second = authenticateCookie(db, `${created.session.id}.${created.secret}`);
    expect(second?.principalId).toBe(principal.id);
    expect(revokeSession(db, principal.id, created.session.id)).toBe(true);
    expect(authenticateCookie(db, `${created.session.id}.${created.secret}`)).toBeNull();
  });

  it('does not let one principal revoke another principal session', () => {
    const ada = createPrincipal(db, 'Ada');
    const grace = createPrincipal(db, 'Grace');
    const adaSession = createSession(db, ada.id);
    expect(revokeSession(db, grace.id, adaSession.session.id)).toBe(false);
    expect(authenticateCookie(db, `${adaSession.session.id}.${adaSession.secret}`)).not.toBeNull();
  });
});

describe('connection tickets', () => {
  it('binds principal, project and purpose; single use', () => {
    const principal = createPrincipal(db, 'Ticker');
    const project = createProjectRow(db, { name: 'P', engineerDisplayName: 'E', principalId: principal.id });
    const cred = createCredential(db, principal.id, 'api_token', 'issuer');
    const created = createTicket(db, {
      principalId: principal.id,
      projectId: project.id,
      purpose: 'events',
      credentialKind: 'api_token',
      credentialId: cred.credential.id,
    });
    expect(created.secret.startsWith('tkt_')).toBe(true);
    expect(created.ticket.expiresAt - created.ticket.createdAt).toBe(DEFAULT_TICKET_TTL_MS);

    const binding = consumeTicket(db, created.secret, { purpose: 'events', projectId: project.id });
    // The binding retains the issuing credential so long-lived consumers can
    // re-validate issuer liveness/expiry before every further delivery.
    expect(binding).toEqual({
      ticketId: created.ticket.id,
      principalId: principal.id,
      projectId: project.id,
      purpose: 'events',
      credentialKind: 'api_token',
      credentialId: cred.credential.id,
    });
    expectAppErrorCode(() => consumeTicket(db, created.secret, { purpose: 'events' }), 'unauthorized');
  });

  it('rejects purpose, project and origin mismatches before consuming', () => {
    const principal = createPrincipal(db, 'Mismatch');
    const project = createProjectRow(db, { name: 'P', engineerDisplayName: 'E', principalId: principal.id });
    const cred = createCredential(db, principal.id, 'api_token', 'issuer');
    const make = (purpose: 'events' | 'voice-relay', origin?: string) =>
      createTicket(db, {
        principalId: principal.id,
        projectId: project.id,
        purpose,
        origin,
        credentialKind: 'api_token',
        credentialId: cred.credential.id,
      });
    const events = make('events', 'http://127.0.0.1:3100');
    expectAppErrorCode(() => consumeTicket(db, events.secret, { purpose: 'voice-relay' }), 'unauthorized');
    expectAppErrorCode(
      () => consumeTicket(db, events.secret, { purpose: 'events', projectId: 'prj_other' }),
      'unauthorized',
    );
    const voice = make('voice-relay', 'http://127.0.0.1:3100');
    expectAppErrorCode(
      () => consumeTicket(db, voice.secret, { purpose: 'voice-relay', origin: 'http://evil.example' }),
      'unauthorized',
    );
    // The mismatches above must not have burned the tickets.
    expect(
      consumeTicket(db, voice.secret, { purpose: 'voice-relay', origin: 'http://127.0.0.1:3100' }).principalId,
    ).toBe(principal.id);
  });

  it('rejects expired tickets', () => {
    const principal = createPrincipal(db, 'Expired');
    const project = createProjectRow(db, { name: 'P', engineerDisplayName: 'E', principalId: principal.id });
    const cred = createCredential(db, principal.id, 'api_token', 'issuer');
    const created = createTicket(db, {
      principalId: principal.id,
      projectId: project.id,
      purpose: 'events',
      credentialKind: 'api_token',
      credentialId: cred.credential.id,
      ttlMs: -1,
    });
    expectAppErrorCode(() => consumeTicket(db, created.secret, { purpose: 'events' }), 'unauthorized');
  });

  it('dies when the issuing credential or session is revoked', () => {
    const principal = createPrincipal(db, 'Revoke');
    const project = createProjectRow(db, { name: 'P', engineerDisplayName: 'E', principalId: principal.id });
    const cred = createCredential(db, principal.id, 'api_token', 'issuer');
    const viaToken = createTicket(db, {
      principalId: principal.id,
      projectId: project.id,
      purpose: 'events',
      credentialKind: 'api_token',
      credentialId: cred.credential.id,
    });
    const session = createSession(db, principal.id);
    const viaSession = createTicket(db, {
      principalId: principal.id,
      projectId: project.id,
      purpose: 'events',
      credentialKind: 'browser_session',
      credentialId: session.session.id,
    });

    revokeCredential(db, principal.id, cred.credential.id);
    expectAppErrorCode(() => consumeTicket(db, viaToken.secret, { purpose: 'events' }), 'unauthorized');
    // Session ticket still fine after only the token was revoked.
    expect(consumeTicket(db, viaSession.secret, { purpose: 'events' }).principalId).toBe(principal.id);

    const again = createTicket(db, {
      principalId: principal.id,
      projectId: project.id,
      purpose: 'events',
      credentialKind: 'browser_session',
      credentialId: session.session.id,
    });
    revokeSession(db, principal.id, session.session.id);
    expectAppErrorCode(() => consumeTicket(db, again.secret, { purpose: 'events' }), 'unauthorized');
  });
});

describe('project authorization helpers', () => {
  it('resolves membership roles and refuses foreign or missing projects', () => {
    const ada = createPrincipal(db, 'Ada');
    const grace = createPrincipal(db, 'Grace');
    const project = createProjectRow(db, { name: 'P', engineerDisplayName: 'E', principalId: ada.id });
    expect(membershipRole(db, project.id, ada.id)).toBe('owner');
    expect(membershipRole(db, project.id, grace.id)).toBeNull();

    expectAppErrorCode(() => requireMembership(db, 'prj_missing-1', ada.id), 'not_found');
    expectAppErrorCode(() => requireMembership(db, project.id, grace.id), 'forbidden');
    expect(requireMembership(db, project.id, ada.id)).toBe('owner');
    expectAppErrorCode(() => requireProjectOwner(db, project.id, grace.id), 'forbidden');

    addMembershipRow(db, project.id, grace.id, 'member');
    expect(requireMembership(db, project.id, grace.id)).toBe('member');
    expectAppErrorCode(() => requireProjectOwner(db, project.id, grace.id), 'forbidden');
  });
});

describe('project rows', () => {
  it('creates, updates and lists only projects the principal belongs to', () => {
    const ada = createPrincipal(db, 'Ada');
    const grace = createPrincipal(db, 'Grace');
    const project = createProjectRow(db, { name: 'Alpha', engineerDisplayName: 'Ranger', principalId: ada.id });
    expect(project.id.startsWith('prj_')).toBe(true);

    const updated = updateProjectRow(db, project.id, { engineerDisplayName: 'Ranger Prime' });
    expect(updated.engineerDisplayName).toBe('Ranger Prime');
    expect(updated.name).toBe('Alpha');

    expect(listProjectsForPrincipal(db, ada.id).map((p) => p.id)).toEqual([project.id]);
    expect(listProjectsForPrincipal(db, grace.id)).toEqual([]);

    addMembershipRow(db, project.id, grace.id, 'member');
    expect(listProjectsForPrincipal(db, grace.id).map((p) => p.id)).toEqual([project.id]);
  });

  it('refuses to remove the last owner', () => {
    const ada = createPrincipal(db, 'Ada');
    const project = createProjectRow(db, { name: 'Alpha', engineerDisplayName: 'Ranger', principalId: ada.id });
    expectAppErrorCode(() => removeMembershipRow(db, project.id, ada.id), 'conflict');
    const grace = createPrincipal(db, 'Grace');
    addMembershipRow(db, project.id, grace.id, 'owner');
    removeMembershipRow(db, project.id, ada.id);
    expect(membershipRole(db, project.id, ada.id)).toBeNull();
  });
});

describe('repository input validation', () => {
  it('accepts approved https/ssh/file URLs and normalizes the checkout policy', () => {
    const ok = validateRepositoryInput({ url: 'file:///srv/repos/app', ref: 'main' });
    expect(ok).toEqual({
      url: 'file:///srv/repos/app',
      ref: 'main',
      checkoutPath: 'workspace',
      checkoutPolicy: { shallow: false, submodules: false },
    });
    const ssh = validateRepositoryInput({ url: 'ssh://git@host/org/app.git', ref: 'main' });
    expect(ssh.url).toBe('ssh://git@host/org/app.git');
    const policy = validateRepositoryInput({
      url: 'https://git.example/org/app.git',
      ref: 'v1.2.3',
      checkoutPath: 'src/checkout',
      checkoutPolicy: { shallow: true },
    });
    expect(policy.checkoutPolicy).toEqual({ shallow: true, submodules: false });
  });

  it('rejects credential-bearing URLs, unsupported schemes, bad refs and path escapes', () => {
    for (const bad of [
      { url: 'https://user:token@git.example/org/app', ref: 'main' },
      { url: 'https://git.example/org/app', ref: 'main', checkoutPath: '../escape' },
      { url: 'https://git.example/org/app', ref: 'main', checkoutPath: '/abs' },
      { url: 'javascript:alert(1)', ref: 'main' },
      { url: 'http://insecure.example/app', ref: 'main' },
      { url: 'file:///srv/app', ref: '-c core.hooksPath=/tmp' },
      { url: 'file:///srv/app', ref: 'main..evil' },
      { url: 'file:///srv/app', ref: 'has space' },
    ]) {
      expectAppErrorCode(() => validateRepositoryInput(bad), 'validation_failed');
    }
  });

  it('rejects ANY https userinfo, including username-only and percent-encoded token forms', () => {
    for (const bad of [
      'https://token@git.example/org/app.git',
      'https://ghp_abcd1234EF@git.example/org/app.git',
      'https://%74%6Fken@git.example/org/app.git',
      'https://user%3Apass@git.example/org/app.git',
      'https://tok%65n-more@git.example/org/app.git',
    ]) {
      let thrown: unknown;
      try {
        validateRepositoryInput({ url: bad, ref: 'main' });
      } catch (cause) {
        thrown = cause;
      }
      expect(isAppError(thrown), `expected ${bad} to be rejected`).toBe(true);
      expect((thrown as { code: string }).code, 'stable validation code').toBe('validation_failed');
      expect((thrown as { details?: { reason?: string } }).details?.reason, 'stable reason class').toBe(
        'credentials_in_url',
      );
      // The error never echoes the rejected URL.
      expect((thrown as { message: string }).message.includes('git.example')).toBe(false);
    }
    // Ordinary SSH/git plain usernames stay usable; passwords never do.
    expect(validateRepositoryInput({ url: 'ssh://git@host/org/app.git', ref: 'main' }).url).toBe(
      'ssh://git@host/org/app.git',
    );
    expect(validateRepositoryInput({ url: 'git://git@host/org/app.git', ref: 'main' }).url).toBe(
      'git://git@host/org/app.git',
    );
    let sshPassword: unknown;
    try {
      validateRepositoryInput({ url: 'ssh://git:pass@host/org/app.git', ref: 'main' });
    } catch (cause) {
      sshPassword = cause;
    }
    expect((sshPassword as { details?: { reason?: string } })?.details?.reason).toBe('credentials_in_url');
  });
});

describe('local repository snapshot', () => {
  let fixture: ReturnType<typeof createFixtureRepo>;
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'ranger-snapshot-'));
    fixture = createFixtureRepo(baseDir);
  });

  it('maps file:// URLs and absolute paths to local paths, not remote URLs', () => {
    expect(localRepositoryPath('file:///srv/app')).toBe('/srv/app');
    expect(localRepositoryPath('/srv/app')).toBe('/srv/app');
    expect(localRepositoryPath('https://git.example/org/app')).toBeNull();
  });

  it('resolves the real commit, dirty flag and content hash for the ref inside an approved root', async () => {
    const snapshot = await resolveLocalSnapshot(fixture.fileUrl, 'main', [baseDir]);
    expect(snapshot).not.toBeNull();
    const head = execFileSync('git', ['-C', fixture.root, 'rev-parse', 'HEAD']).toString().trim();
    expect(snapshot!.commit).toBe(head);
    expect(snapshot!.dirty).toBe(false);
    expect(snapshot!.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const afterEdit = await resolveLocalSnapshot(fixture.fileUrl, 'main', [baseDir]);
    expect(afterEdit!.contentHash).toBe(snapshot!.contentHash);
    expect(afterEdit!.dirty).toBe(false);

    writeFileSync(fixture.trackedFile, 'export const version = 2;\n');
    const dirty = await resolveLocalSnapshot(fixture.fileUrl, 'main', [baseDir]);
    expect(dirty!.dirty).toBe(true);
    expect(dirty!.commit).toBe(head);
    expect(dirty!.contentHash).not.toBe(snapshot!.contentHash);
  });

  it('fails explicitly when the ref does not resolve or the path is not a git worktree', async () => {
    await expect(resolveLocalSnapshot(fixture.fileUrl, 'no-such-branch', [baseDir])).rejects.toMatchObject({
      code: 'validation_failed',
    });
    const plain = mkdtempSync(path.join(tmpdir(), 'ranger-not-git-'));
    await expect(resolveLocalSnapshot(`file://${plain}`, 'main', [tmpdir()])).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('denies inspection outside operator-approved roots, including with no roots approved', async () => {
    const notApproved = { code: 'validation_failed', details: { reason: 'local_path_not_approved' } };
    // Default-deny: no approved roots means no local inspection at all.
    await expect(resolveLocalSnapshot(fixture.fileUrl, 'main', [])).rejects.toMatchObject(notApproved);
    await expect(resolveLocalSnapshot(fixture.root, 'main', [])).rejects.toMatchObject(notApproved);
    // A root that does not contain the fixture denies inspection too.
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'ranger-elsewhere-'));
    await expect(resolveLocalSnapshot(fixture.fileUrl, 'main', [elsewhere])).rejects.toMatchObject(notApproved);
  });

  it('denies symlink escapes out of an approved root (repo root and .git entry)', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'ranger-outside-'));
    const outsideRepo = createFixtureRepo(outside, 'outside-app');
    const link = path.join(baseDir, 'escape');
    symlinkSync(outsideRepo.root, link);
    const notApproved = { code: 'validation_failed', details: { reason: 'local_path_not_approved' } };
    await expect(resolveLocalSnapshot(`file://${link}`, 'main', [baseDir])).rejects.toMatchObject(notApproved);

    // A symlinked .git pointing outside the approved root is denied as well.
    const inside = createFixtureRepo(baseDir, 'inside-app');
    const otherOutside = createFixtureRepo(mkdtempSync(path.join(tmpdir(), 'ranger-outside-git-')), 'gitdir-app');
    rmSync(path.join(inside.root, '.git'), { recursive: true, force: true });
    symlinkSync(path.join(otherOutside.root, '.git'), path.join(inside.root, '.git'));
    await expect(resolveLocalSnapshot(`file://${inside.root}`, 'main', [baseDir])).rejects.toMatchObject(notApproved);

    // Fail closed: a symlinked .git is refused even when its target stays
    // inside the approved root — gitdir-sharing forms are unsupported.
    const target = createFixtureRepo(baseDir, 'gitdir-target');
    const sharer = createFixtureRepo(baseDir, 'gitdir-sharer');
    rmSync(path.join(sharer.root, '.git'), { recursive: true, force: true });
    symlinkSync(path.join(target.root, '.git'), path.join(sharer.root, '.git'));
    await expect(resolveLocalSnapshot(`file://${sharer.root}`, 'main', [baseDir])).rejects.toMatchObject(notApproved);
  });

  it('refuses gitfile and core.worktree redirection outside the approved root before inspection', async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'ranger-redirect-out-'));
    const outsideRepo = createFixtureRepo(outsideDir, 'outside-app');

    // A regular .git gitfile makes every git command operate on another
    // repository's git dir; the form is refused outright (fail closed, no
    // linked-worktree support) before any source inspection runs.
    const gitfileRepo = path.join(baseDir, 'gitfile-app');
    mkdirSync(gitfileRepo, { recursive: true });
    writeFileSync(path.join(gitfileRepo, '.git'), `gitdir: ${path.join(outsideRepo.root, '.git')}\n`);
    await expect(resolveLocalSnapshot(`file://${gitfileRepo}`, 'main', [baseDir])).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'local_path_not_approved' },
    });

    // Repo-local core.worktree redirects the effective worktree outside the
    // approved root; containment is verified before the ref is inspected.
    const redirected = createFixtureRepo(baseDir, 'redirected-app');
    execFileSync('git', ['-C', redirected.root, 'config', 'core.worktree', outsideDir]);
    await expect(resolveLocalSnapshot(`file://${redirected.root}`, 'main', [baseDir])).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'repository_redirect' },
    });
  });

  it('never executes attribute filter helpers via worktree, info or config-selected attributes', async () => {
    const marker = path.join(baseDir, 'filter-marker');
    const cleanCommand = `touch '${marker}'`;
    // A tracked file that is stat-dirty makes `git status` consult the clean
    // filter; that is the round-2 execution vector.
    writeFileSync(fixture.trackedFile, 'export const version = 1;\n');

    // (a) Worktree .gitattributes plus a repo-local filter definition.
    writeFileSync(path.join(fixture.root, '.gitattributes'), '* filter=sentinel\n');
    execFileSync('git', ['-C', fixture.root, 'config', 'filter.sentinel.clean', cleanCommand]);

    // Positive control: an unhardened git status honors the repo config and
    // runs the harmless, local, self-contained sentinel.
    execFileSync('git', ['-C', fixture.root, 'status', '--porcelain'], { stdio: 'ignore' });
    expect(existsSync(marker), 'sentinel must run without hardening (positive control)').toBe(true);
    rmSync(marker);

    const snapshot = await resolveLocalSnapshot(fixture.fileUrl, 'main', [baseDir]);
    expect(snapshot).not.toBeNull();
    expect(existsSync(marker), 'worktree .gitattributes filter must not run').toBe(false);
    rmSync(path.join(fixture.root, '.gitattributes'));

    // (b) .git/info/attributes is NOT suppressed by --attr-source; nonempty
    // or symlinked forms are refused outright, before inspection.
    writeFileSync(path.join(fixture.root, '.git', 'info', 'attributes'), '* filter=sentinel\n');
    await expect(resolveLocalSnapshot(fixture.fileUrl, 'main', [baseDir])).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'attributes_rejected' },
    });
    expect(existsSync(marker), 'info/attributes filter must not run').toBe(false);
    rmSync(path.join(fixture.root, '.git', 'info', 'attributes'));

    // An empty, regular info/attributes file defines no attributes and stays allowed.
    writeFileSync(path.join(fixture.root, '.git', 'info', 'attributes'), '\n');
    await expect(resolveLocalSnapshot(fixture.fileUrl, 'main', [baseDir])).resolves.not.toBeNull();
    rmSync(path.join(fixture.root, '.git', 'info', 'attributes'));

    // (c) A repo-selected core.attributesFile is overridden, not honored.
    writeFileSync(path.join(baseDir, 'external-attributes'), '* filter=sentinel\n');
    execFileSync('git', [
      '-C',
      fixture.root,
      'config',
      'core.attributesFile',
      path.join(baseDir, 'external-attributes'),
    ]);
    await expect(resolveLocalSnapshot(fixture.fileUrl, 'main', [baseDir])).resolves.not.toBeNull();
    expect(existsSync(marker), 'config-selected attributes must not run their filter').toBe(false);
  });

  it('hashes symlink entries by link text and never reads out-of-root target bytes', async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'ranger-link-target-'));
    const target = path.join(outsideDir, 'external.txt');
    writeFileSync(target, 'external content v1\n');
    const link = path.join(fixture.root, 'link.ts');
    symlinkSync(target, link);

    const before = await resolveLocalSnapshot(fixture.fileUrl, 'main', [baseDir]);
    expect(before).not.toBeNull();

    // Changing the external target's bytes must not change the hash: the
    // target is never read through the link.
    writeFileSync(target, 'external content v2 CHANGED\n');
    const after = await resolveLocalSnapshot(fixture.fileUrl, 'main', [baseDir]);
    expect(after!.contentHash).toBe(before!.contentHash);

    // A different link text is different tracked content and changes the hash.
    rmSync(link);
    symlinkSync('./index.ts', link);
    const relinked = await resolveLocalSnapshot(fixture.fileUrl, 'main', [baseDir]);
    expect(relinked!.contentHash).not.toBe(before!.contentHash);
  });

  it('never executes repository-configured fsmonitor helpers while resolving a snapshot', async () => {
    const marker = path.join(baseDir, 'fsmonitor-marker');
    const sentinel = path.join(baseDir, 'sentinel-fsmonitor.sh');
    writeFileSync(sentinel, `#!/bin/sh\ntouch '${marker}'\nprintf ''\nexit 0\n`);
    chmodSync(sentinel, 0o755);
    // Plant the helper exactly where an attacker-controlled repository would
    // put it: the repo's own git config.
    execFileSync('git', ['-C', fixture.root, 'config', 'core.fsmonitor', sentinel]);

    // Positive control: an unhardened git invocation honors the repo config
    // and runs the (harmless, local, self-removing) sentinel.
    execFileSync('git', ['-C', fixture.root, 'status', '--porcelain'], { stdio: 'ignore' });
    expect(existsSync(marker), 'sentinel must run without hardening (positive control)').toBe(true);
    rmSync(marker);

    const snapshot = await resolveLocalSnapshot(fixture.fileUrl, 'main', [baseDir]);
    expect(snapshot).not.toBeNull();
    expect(existsSync(marker), 'hardened inspection must not execute the repo-configured helper').toBe(false);
  });
});

describe('repository records', () => {
  let fixture: ReturnType<typeof createFixtureRepo>;
  let baseDir: string;
  let principalId: string;
  let projectId: string;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), 'ranger-repo-'));
    fixture = createFixtureRepo(baseDir);
    const principal = createPrincipal(db, 'Repo Owner');
    principalId = principal.id;
    projectId = createProjectRow(db, { name: 'P', engineerDisplayName: 'E', principalId }).id;
  });

  it('connects with a real snapshot and reads back the same references', async () => {
    const record = await connectRepository(db, projectId, principalId, {
      url: fixture.fileUrl,
      ref: 'main',
    }, [baseDir]);
    const head = execFileSync('git', ['-C', fixture.root, 'rev-parse', 'HEAD']).toString().trim();
    expect(record.commit).toBe(head);
    expect(record.checkoutPolicy).toEqual({ shallow: false, submodules: false });

    const read = getRepositoryRecord(db, projectId);
    expect(read?.url).toBe(fixture.fileUrl);
    expect(read?.ref).toBe('main');
    expect(read?.commit).toBe(head);
    expect(read?.contentHash).toBe(record.contentHash);
    expect(read?.dirty).toBe(false);
  });

  it('replaces the reference on reconnect and deletes on disconnect', async () => {
    await connectRepository(db, projectId, principalId, { url: fixture.fileUrl, ref: 'main' }, [baseDir]);
    execFileSync('git', ['-C', fixture.root, 'branch', 'other']);
    await connectRepository(db, projectId, principalId, { url: fixture.fileUrl, ref: 'other' }, [baseDir]);
    expect(getRepositoryRecord(db, projectId)?.ref).toBe('other');
    disconnectRepository(db, projectId);
    expect(getRepositoryRecord(db, projectId)).toBeNull();
  });
});

describe('bootstrap credential', () => {
  it('creates the principal and a 0600 credential file outside the repo, hashes only in db', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'ranger-repo-root-'));
    const bootstrapDir = mkdtempSync(path.join(tmpdir(), 'ranger-bootstrap-'));
    const outcome = ensureInitialPrincipal(db, {
      dataDir: bootstrapDir,
      repoRoot,
      displayName: 'Operator',
    });
    expect(outcome.created).toBe(true);
    expect(statSync(outcome.credentialPath).mode & 0o777).toBe(0o600);
    const contents = readFileSync(outcome.credentialPath, 'utf8');
    expect(contents.startsWith('RANGER_BOOTSTRAP_TOKEN=rng_')).toBe(true);
    const secret = contents.trim().split('=')[1]!;
    expect(authenticateBearer(db, secret)?.principalId).toBe(outcome.principalId);

    // Idempotent: a second run does not create a second secret.
    const again = ensureInitialPrincipal(db, {
      dataDir: bootstrapDir,
      repoRoot,
      displayName: 'Operator',
    });
    expect(again.created).toBe(false);
    expect(again.credentialPath).toBe(defaultBootstrapCredentialPath(bootstrapDir));

    // Refuses to place the credential inside the repository tree.
    expect(() =>
      ensureInitialPrincipal(db, {
        dataDir: path.join(repoRoot, 'data'),
        repoRoot,
        displayName: 'Operator',
        credentialPath: path.join(repoRoot, 'leak.txt'),
      }),
    ).toThrowError(/outside the repository/);
  });

  it('creates additional principals with their own credential files for multi-principal drivers', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'ranger-repo-root-'));
    const bootstrapDir = mkdtempSync(path.join(tmpdir(), 'ranger-bootstrap-'));
    const initial = ensureInitialPrincipal(db, {
      dataDir: bootstrapDir,
      repoRoot,
      displayName: 'Operator',
    });
    const secondPath = path.join(bootstrapDir, 'second-credential.txt');
    const second = createAdditionalPrincipal(db, {
      repoRoot,
      displayName: 'Second Operator',
      credentialPath: secondPath,
    });
    expect(second.created).toBe(true);
    expect(second.principalId).not.toBe(initial.principalId);
    expect(statSync(secondPath).mode & 0o777).toBe(0o600);
    const secondSecret = readFileSync(secondPath, 'utf8').trim().split('=')[1]!;
    const auth = authenticateBearer(db, secondSecret);
    expect(auth?.principalId).toBe(second.principalId);
    expect(auth?.credentialId.startsWith('tok_')).toBe(true);
    // The initial bootstrap credential still authenticates.
    const initialSecret = readFileSync(initial.credentialPath, 'utf8').trim().split('=')[1]!;
    expect(authenticateBearer(db, initialSecret)?.principalId).toBe(initial.principalId);
    // Refuses to overwrite an existing credential file or use the repo tree.
    expect(() =>
      createAdditionalPrincipal(db, { repoRoot, displayName: 'Third', credentialPath: secondPath }),
    ).toThrowError(/already exists/);
    expect(() =>
      createAdditionalPrincipal(db, {
        repoRoot,
        displayName: 'Third',
        credentialPath: path.join(repoRoot, 'leak.txt'),
      }),
    ).toThrowError(/outside the repository/);
  });

  it('a credential-file collision preserves the existing file and leaves no orphan credential', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'ranger-repo-root-'));
    const bootstrapDir = mkdtempSync(path.join(tmpdir(), 'ranger-bootstrap-'));
    const existingPath = path.join(bootstrapDir, 'bootstrap-credential.txt');
    writeFileSync(existingPath, 'PRESERVE-ME\n', { mode: 0o600 });

    expect(() =>
      ensureInitialPrincipal(db, { dataDir: bootstrapDir, repoRoot, displayName: 'Operator' }),
    ).toThrowError(/already exists/);
    // The pre-existing credential file is untouched.
    expect(readFileSync(existingPath, 'utf8')).toBe('PRESERVE-ME\n');
    // No principal or credential rows were created (retryable state, no
    // orphan credential whose secret was never delivered).
    expect(countRows(db, 'principals')).toBe(0);
    expect(countRows(db, 'credentials')).toBe(0);

    // Bootstrap is retryable with a fresh path.
    const retry = ensureInitialPrincipal(db, {
      dataDir: bootstrapDir,
      repoRoot,
      displayName: 'Operator',
      credentialPath: path.join(bootstrapDir, 'fresh-credential.txt'),
    });
    expect(retry.created).toBe(true);
    expect(readFileSync(retry.credentialPath, 'utf8').startsWith('RANGER_BOOTSTRAP_TOKEN=')).toBe(true);
    expect(countRows(db, 'credentials')).toBe(1);
  });

  it('a credential-file write failure creates no db rows and bootstrap stays retryable', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'ranger-repo-root-'));
    const bootstrapDir = mkdtempSync(path.join(tmpdir(), 'ranger-bootstrap-'));
    const brokenPath = path.join(bootstrapDir, 'missing-directory', 'credential.txt');

    expect(() =>
      ensureInitialPrincipal(db, { dataDir: bootstrapDir, repoRoot, displayName: 'Operator', credentialPath: brokenPath }),
    ).toThrow();
    expect(countRows(db, 'principals')).toBe(0);
    expect(countRows(db, 'credentials')).toBe(0);

    const retry = ensureInitialPrincipal(db, { dataDir: bootstrapDir, repoRoot, displayName: 'Operator' });
    expect(retry.created).toBe(true);
    expect(statSync(retry.credentialPath).mode & 0o777).toBe(0o600);
  });

  it('an additional principal colliding with an existing file leaves no orphan rows', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'ranger-repo-root-'));
    const bootstrapDir = mkdtempSync(path.join(tmpdir(), 'ranger-bootstrap-'));
    ensureInitialPrincipal(db, { dataDir: bootstrapDir, repoRoot, displayName: 'Operator' });
    const secondPath = path.join(bootstrapDir, 'second-credential.txt');
    createAdditionalPrincipal(db, { repoRoot, displayName: 'Second', credentialPath: secondPath });
    const principalsBefore = countRows(db, 'principals');

    expect(() =>
      createAdditionalPrincipal(db, { repoRoot, displayName: 'Third', credentialPath: secondPath }),
    ).toThrowError(/already exists/);
    expect(countRows(db, 'principals')).toBe(principalsBefore);
    expect(countRows(db, 'credentials')).toBe(2); // bootstrap + second only
    // The winning credential file is preserved.
    expect(readFileSync(secondPath, 'utf8').startsWith('RANGER_BOOTSTRAP_TOKEN=')).toBe(true);
  });
});

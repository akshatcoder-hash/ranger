import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
    expect(binding).toEqual({
      ticketId: created.ticket.id,
      principalId: principal.id,
      projectId: project.id,
      purpose: 'events',
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
});

describe('local repository snapshot', () => {
  let fixture: ReturnType<typeof createFixtureRepo>;

  beforeEach(() => {
    fixture = createFixtureRepo(mkdtempSync(path.join(tmpdir(), 'ranger-snapshot-')));
  });

  it('maps file:// URLs and absolute paths to local paths, not remote URLs', () => {
    expect(localRepositoryPath('file:///srv/app')).toBe('/srv/app');
    expect(localRepositoryPath('/srv/app')).toBe('/srv/app');
    expect(localRepositoryPath('https://git.example/org/app')).toBeNull();
  });

  it('resolves the real commit, dirty flag and content hash for the ref', async () => {
    const snapshot = await resolveLocalSnapshot(fixture.fileUrl, 'main');
    expect(snapshot).not.toBeNull();
    const head = execFileSync('git', ['-C', fixture.root, 'rev-parse', 'HEAD']).toString().trim();
    expect(snapshot!.commit).toBe(head);
    expect(snapshot!.dirty).toBe(false);
    expect(snapshot!.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const afterEdit = await resolveLocalSnapshot(fixture.fileUrl, 'main');
    expect(afterEdit!.contentHash).toBe(snapshot!.contentHash);
    expect(afterEdit!.dirty).toBe(false);

    writeFileSync(fixture.trackedFile, 'export const version = 2;\n');
    const dirty = await resolveLocalSnapshot(fixture.fileUrl, 'main');
    expect(dirty!.dirty).toBe(true);
    expect(dirty!.commit).toBe(head);
    expect(dirty!.contentHash).not.toBe(snapshot!.contentHash);
  });

  it('fails explicitly when the ref does not resolve or the path is not a git worktree', async () => {
    await expect(resolveLocalSnapshot(fixture.fileUrl, 'no-such-branch')).rejects.toMatchObject({
      code: 'validation_failed',
    });
    const plain = mkdtempSync(path.join(tmpdir(), 'ranger-not-git-'));
    await expect(resolveLocalSnapshot(`file://${plain}`, 'main')).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});

describe('repository records', () => {
  let fixture: ReturnType<typeof createFixtureRepo>;
  let principalId: string;
  let projectId: string;

  beforeEach(() => {
    fixture = createFixtureRepo(mkdtempSync(path.join(tmpdir(), 'ranger-repo-')));
    const principal = createPrincipal(db, 'Repo Owner');
    principalId = principal.id;
    projectId = createProjectRow(db, { name: 'P', engineerDisplayName: 'E', principalId }).id;
  });

  it('connects with a real snapshot and reads back the same references', async () => {
    const record = await connectRepository(db, projectId, principalId, {
      url: fixture.fileUrl,
      ref: 'main',
    });
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
    await connectRepository(db, projectId, principalId, { url: fixture.fileUrl, ref: 'main' });
    execFileSync('git', ['-C', fixture.root, 'branch', 'other']);
    await connectRepository(db, projectId, principalId, { url: fixture.fileUrl, ref: 'other' });
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
});

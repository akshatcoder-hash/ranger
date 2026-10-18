# Ranger backend

Ranger is a standalone AI forward-deployed engineer proof of work: a small
TypeScript/Node backend (Fastify API + durable worker + preview gateway over
SQLite) with xAI voice/vision/coding integrations, real Instabox Linux VM
workspaces and pinned Trace retrieval. **Backend only** — there is no product
frontend; see `docs/frontend-guide.md` for the contract a future frontend
would use.

This is the **foundation + identity + conversations/events milestone**: the
project skeleton, migrations, config/error/schema foundations, the complete
v1 contract (OpenAPI + realtime event schemas + generated typed client), the
shared live-budget ledger, executable entrypoints, test harnesses, the
identity layer — bootstrap credentials, hashed API tokens, revocable browser
sessions, connection tickets, project/membership/engineer-name CRUD and
durable repository references — plus durable conversations (messages,
questions/answers, versioned requirements/decisions), the central
transactional event history with per-project sequences, scoped mutation
idempotency, and ticket-authenticated cursor replay and live WebSocket event
subscription. Route families not yet implemented return an explicit
`501 not_configured` envelope — never fake success.

## Requirements

- Node.js 24 (developed against 24.21.0), npm 11.
- No other services: SQLite is embedded (`node:sqlite`), everything binds to
  loopback only.

## Layout

```
src/config.ts            validated configuration (env + optional JSON file)
src/errors.ts            central error envelope, stable codes, redaction
src/secrets.ts           secret selection from the protected file (memory only)
src/auth/                hashing, principals/credentials, sessions, tickets, authorization
src/identity/            bootstrap CLI core (initial principal + protected credential file)
src/projects/            project + membership persistence
src/repositories/        repository records + local snapshot resolution (read-only git)
src/conversations/       conversations, messages, questions/answers, requirement/decision threads
src/events/              central transactional event append, sequences, cursors, replay reads
src/db/                  node:sqlite open (WAL, FK, busy timeout) + migrations
src/budget/ledger.ts     shared live-test admission ledger (never resets)
src/contracts/           route registry, event schemas, OpenAPI builder, examples
src/clients/             GENERATED typed client (committed; regenerate, don't edit)
src/http/                Fastify app factory, auth middleware, registry-driven handlers
src/worker/              durable worker loop (claim/lease with fencing epoch)
src/entrypoints/         api / worker / preview process entrypoints
scripts/                 migrate, bootstrap, contract generation
migrations/              SQL migrations (applied in order, once each)
contracts/               checked-in openapi.json + event schemas (generated)
docs/                    contract reference, changelog, frontend guide
tests/                   unit (vitest), integration (real processes), e2e (typed client)
```

## Install and gates

```sh
npm ci --legacy-peer-deps     # or: npm install --legacy-peer-deps
npm run typecheck             # tsc, strict, includes tests
npm run lint                  # eslint (typescript-eslint)
npm run build                 # emits dist/ (untracked)
npm test -- --maxWorkers=2    # unit suite (vitest)
npm run test:integration      # builds, then real-process integration tests
npm run test:e2e              # builds, then typed-client-over-HTTP e2e tests
```

Dependencies are pinned exactly in `package.json`/`package-lock.json`
(fastify 5.12.7, @fastify/websocket 11.3.4, ws 8.22.0, sharp 0.35.5, openai
7.38.0, @insforge/instabox-sdk 0.5.3, typescript 6.0.3, vitest 5.0.5,
eslint 10.13.0). Install with `--legacy-peer-deps` (also set in `.npmrc`).

## Configuration

Environment variables (all optional except `RANGER_DATA_DIR`):

| Variable | Meaning | Default |
| --- | --- | --- |
| `RANGER_DATA_DIR` | Writable data directory (SQLite + runtime state) | required |
| `RANGER_HOST` | Listen host | `127.0.0.1` |
| `RANGER_PORT` | API port | `3100` |
| `RANGER_PREVIEW_PORT` | Preview gateway port | `3101` |
| `RANGER_SECRET_FILE` | Protected file (mode 0600) with provider keys | unset |
| `RANGER_LIVE_BUDGET_FILE` | Shared live-test budget ledger JSON | unset |
| `RANGER_CONFIG_FILE` | Optional limits/provider overrides JSON | unset |
| `RANGER_LOG_LEVEL` | `fatal..debug` | `info` |

See `config/ranger.config.example.json`. Config files may lower limits but
never exceed the documented ceilings.

## Run

```sh
npm run db:migrate                       # apply migrations to RANGER_DATA_DIR
npm run bootstrap                        # verify data dir/migrations/env status
npm run bootstrap -- --create-principal "Operator"   # initial principal + 0600 credential file
npm run start:api                        # control API on 127.0.0.1:3100
npm run start:worker                     # durable worker (claims leased jobs)
npm run start:preview                    # preview gateway on 127.0.0.1:3101
```

`bootstrap --create-principal` creates the initial principal and writes its
bearer credential to `<RANGER_DATA_DIR>/bootstrap-credential.txt` (mode
0600, outside the repository). The secret is shown nowhere else — the
database stores only a lookup key and a scrypt hash. Additional principals
for multi-user drivers:

```sh
npm run bootstrap -- --additional-principal "Second Operator" --credential-file /path/outside/repo/second-credential.txt
```

Authenticate API requests with `Authorization: Bearer <secret>` (bootstrap
credential or API tokens). For browser-style access, exchange the credential
via `POST /v1/auth/browser-sessions`: the HttpOnly `ranger_session` cookie is
set and a one-time `csrfToken` is returned; cookie-authenticated mutations
require a same-origin `Origin` header or the `x-ranger-csrf` token header.
Realtime surfaces use `POST /v1/auth/connection-tickets` — single-use,
60-second tickets bound to principal, project, purpose and origin; revoking
the issuing token or session immediately invalidates its tickets. Projects,
the customer-configurable engineer display name, memberships, repository
references (approved URL/ref, checkout path, checkout policy, resolved
commit/dirty/hash for local repositories), conversations with their
messages/questions/answers and the full event history all persist across API
restarts.

Mutating routes accept a scoped `Idempotency-Key` header: an identical retry
returns the stored result with no second side effect or duplicate event;
reusing a key with different input returns `409 conflict`. Project events
are appended in the SAME transaction as the state mutation that caused them
(schema-validated against the declared per-type data schemas), which is what
makes replay exact: `GET /v1/projects/{id}/events` replays by opaque cursor
(`invalid_cursor` 400 for malformed/ahead-of-history cursors,
`cursor_expired` 410 past the replay window — default 30 days, configurable
down), and `WS /v1/projects/{id}/events/subscribe` authenticates the upgrade
with an `events` ticket (purpose + project + origin + current membership)
before delivering ordered live events. Subscribe close codes: `4401`
unauthorized, `4400` invalid_cursor, `4410` cursor_expired, `4502`
slow_consumer. Replay never invokes tools or changes state.

The API serves the contract at `http://127.0.0.1:3100/v1/openapi.json`,
capabilities at `/v1/capabilities`, event schemas at `/v1/events/schemas`
and liveness at `/health`. The worker starts with zero registered job
handlers in the foundation (it idles cleanly); later milestones register
handlers. The preview gateway refuses all proxy routes with
`not_configured` until the execution milestone implements them.

Migrations and configuration work from a fresh data directory and data
survives API/worker restarts (WAL, foreign keys, busy timeout).

## Secrets

Provider keys (`XAI_API_KEY`, `INSTABOX_API_KEY`) live only in the protected
file `RANGER_SECRET_FILE` (mode 0600, e.g. `/etc/droid/environment`). Values
are read into the requesting process memory on demand and are never logged,
committed, echoed into errors, or forwarded to guests/browsers. Nothing in
this repository contains secret values; `src/secrets.ts` refuses permissive
file modes and unknown names, and reports `not_configured` when no file is
set.

## Shared live budget (never reset)

`RANGER_LIVE_BUDGET_FILE` points at the mission-wide ledger
(`provider-budget.json`). All live tests across all workers/validators share
it: xAI paid operations are admitted only while recorded spend plus a
conservative estimate stays at or below the **$4 soft admission stop** within
the **$5 total cap** (the remaining $1 is reserve); Instabox allows at most
**six additional VM creations**, one at a time, each with a server-side
10-minute kill timeout and early cleanup. The ledger is locked, written
atomically, preserves history and unknown fields, and **must never be reset
by tests** (tests use temporary copies). Uncertain accounting refuses the
operation instead of guessing.

## Contract artifacts

```sh
npm run contracts:generate   # regenerate contracts/openapi.json, event schemas, typed client
```

The registry `src/contracts/registry.ts` is the single source of truth: it
drives runtime route registration/validation, the served and checked-in
OpenAPI documents, and the generated typed client. A unit test fails if any
artifact drifts. The changelog (`docs/contract-changelog.md`) records every
published version; current: **v1**.

## Retrieve and run over SSH

The repository lives on the development VM at
`/home/factory-user/repos/ranger` (branch `main`, local commits only — there
is no remote push). From your workstation:

```sh
# Retrieve (excluding generated/dependency directories)
rsync -az --exclude node_modules --exclude dist --exclude data \
  <vm-user>@<vm-host>:/home/factory-user/repos/ranger/ ./ranger/
cd ranger
npm ci --legacy-peer-deps
RANGER_DATA_DIR=~/.local/share/ranger npm run db:migrate
RANGER_DATA_DIR=~/.local/share/ranger npm run start:api
# in another shell
RANGER_DATA_DIR=~/.local/share/ranger npm run start:worker
curl -fsS http://127.0.0.1:3100/health
```

`<vm-user>@<vm-host>` is your existing SSH access to this VM; nothing else is
required (no cloud accounts, no public ports).

## Milestone status (honest)

- Implemented: project/toolchain, migrations, config/errors/secrets, budget
  ledger, full v1 contract skeleton + typed client, API/worker/preview
  entrypoints, offline test suites, docs; identity layer (bootstrap
  principal + protected credential file, hashed API tokens, revocable
  browser sessions with CSRF/origin checks, single-use connection tickets,
  project/membership/engineer-name CRUD, durable repository references with
  real local snapshot resolution); conversations layer (durable
  conversations/messages/questions/answers, append-only requirement and
  decision versions, central transactional event append with per-project
  sequences and append-time schema validation, scoped mutation idempotency,
  member-authenticated HTTP cursor replay and ticket-gated live WebSocket
  subscription with slow-consumer and invalid/expired-cursor policies).
- Not yet implemented (declared, return `not_configured`): voice relay,
  capture/frames/inspection, plans/approvals, runs, workspace execution,
  desktop/preview gateway, Trace retrieval. Trace bootstrap (pinned commit +
  model initialization) arrives with the Trace milestone. The remaining
  declared WebSocket routes (voice relay, desktop stream) still close with
  `4501 not_configured` until their features wire ticket consumption.
- No physical microphone exists on this host; any browser media checks are
  synthetic and labeled as such.

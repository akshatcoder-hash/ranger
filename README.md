# Ranger backend

Ranger is a standalone AI forward-deployed engineer proof of work: a small
TypeScript/Node backend (Fastify API + durable worker + preview gateway over
SQLite) with xAI voice/vision/coding integrations, real Instabox Linux VM
workspaces and pinned Trace retrieval.

On this `integration/full-stack` branch the backend lives at the repository
root and the product frontend lives in `frontend/`; the deployed app is
live at https://ranger.akshats.xyz — see `docs/deployment-handover.md` for
the deployment architecture, login, redeploy/rollback, secrets/budget rules
and known limitations. Recording the call → plan → run demo is covered in
`docs/demo-runbook.md`. Local development is covered in
`docs/local-full-stack.md`; the backend-only contract reference a future
frontend would use remains in `docs/frontend-guide.md`.

This is the **media-delivery milestone state** (foundation, identity,
conversations/events, coding-workflow and the media features are
implemented; see "Milestone status" for what is proven versus still blocked):
the project skeleton, migrations, config/error/schema foundations, the
complete v1 contract (OpenAPI + realtime event schemas + generated typed
client), the shared live-budget ledger, executable entrypoints, test
harnesses, the identity layer, durable conversations with transactional event
history and cursor replay, the real xAI voice relay and latest-frame
capture/vision media features with the plain `/diagnostic` test client, and
the coding-workflow surfaces (plans/approvals, runs, Instabox workspace
execution, desktop/preview gateway, Trace retrieval). Deferred capabilities
are removed from the supported contract or explicitly rejected as unsupported
— never fake success.

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
src/workspace/           Instabox create/work/preview/destroy, restricted workload, cleanup
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
| `RANGER_SECRET_SOURCE` | `file` (protected file) or explicit `environment` opt-in | `file` |
| `RANGER_LIVE_BUDGET_FILE` | Shared live-test budget ledger JSON | unset |
| `RANGER_APPROVED_SNAPSHOT_ROOTS` | Absolute paths (path-delimiter separated) of operator-approved synthetic roots whose local git worktrees may be inspected for repository snapshots | unset (local inspection denied) |
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
0600, outside the repository). The compiled CLI resolves the repository
root from `package.json` (so `dist/scripts` is not treated as the root) and
refuses a credential path that is lexically inside the repo or whose
canonical path, including through an external symlink, lands inside it.
The check runs before any file is created. The secret is shown nowhere else — the
database stores only a lookup key and a scrypt hash. The credential file is
written before any database row: a collision with an existing file (which is
never overwritten) or a write failure leaves retryable state with no
orphaned credential. Additional principals for multi-user drivers:

```sh
npm run bootstrap -- --additional-principal "Second Operator" --credential-file /path/outside/repo/second-credential.txt
```

Authenticate API requests with `Authorization: Bearer <secret>` (bootstrap
credential or API tokens). For browser-style access, `POST
/v1/auth/browser-sessions` requires that principal authentication as well as
a body `apiToken`. The HttpOnly `ranger_session` cookie is set and a
one-time `csrfToken` is returned. Each session is revoked on its own;
revoking the API token does not revoke sessions already created from it.
Cookie-authenticated mutations require a same-origin `Origin` header or the
`x-ranger-csrf` token header. Request logs redact connection-ticket query
values, including the top-level `path`/`url` a websocket plugin logs when
an upgrade hits an ordinary HTTP route. Unknown-route errors do not echo
them. Header redaction is unchanged.
Realtime surfaces use `POST /v1/auth/connection-tickets` — single-use,
60-second tickets bound to principal, project, purpose and origin; revoking
the issuing token or session immediately invalidates its tickets. Projects,
the customer-configurable engineer display name, memberships, repository
references (approved URL/ref, checkout path, checkout policy, resolved
commit/dirty/hash for local repositories), conversations with their
messages/questions/answers and the full event history all persist across API
restarts.

Repository URLs never carry credential material: any userinfo on an `https`
URL (including the username-only and percent-encoded token forms) and any
password on `ssh`/`git` URLs are rejected with `credentials_in_url` before
anything is stored, emitted or echoed; plain SSH usernames (`git@host`)
remain usable. Local `file://`/absolute-path repositories are inspected
(read-only git) ONLY when they live under an operator-approved synthetic
root (`RANGER_APPROVED_SNAPSHOT_ROOTS`): checks are realpath/symlink-safe,
unapproved paths are refused with `local_path_not_approved` before any
filesystem probing, and inspection is hardened against repository-controlled
git mechanisms. The `.git` entry must be a real directory (gitfile
`gitdir:` pointers, symlinked `.git`, and any `.git/commondir` entry are
refused as unsupported linked-worktree forms before a git command runs,
`repository_redirect` covers detected `core.worktree` redirection after a
canonical git-dir/worktree containment check), nonempty or symlinked
`.git/info/attributes` is refused (`attributes_rejected`), no repository
lock is taken, and no repository-configured helper executes
(`--no-optional-locks`, `core.fsmonitor=false`, `core.hooksPath=/dev/null`,
`--attr-source=<empty tree>` plus `core.attributesFile=/dev/null` and
`GIT_ATTR_NOSYSTEM=1` neutralize attribute filters, global/system git
config is ignored, and ambient `GIT_*` environment variables are stripped).
Content hashing hashes symlinks by link text and never reads out-of-root
target bytes.

There is no in-VM checkout service: a remote repository reference cannot be
checked out into the workspace. When an approved run starts, the executor
materializes the initial source from the connected approved-root local
checkout at its RECORDED commit BEFORE any VM create (hardened read-only git
only; symlink and submodule entries are refused; the existing file-count and
per-file guest-transport bounds apply; the persisted base is verified by
byte readback and marked with the `initial_checkout` origin, distinct from
`guest_edit` files saved after successful guest writes). Generated saved
source from earlier runs is never overwritten by a later re-read. When the
initial source cannot materialize — a remote or reference-only record, or a
changed/unreadable checkout — the run fails explicitly with
`initial_source_unmaterializable` BEFORE any VM create instead of silently
booting an empty repository.

Mutating routes accept a scoped `Idempotency-Key` header (scoped to the
operation, project AND authenticated principal, so the same key and body
from two principals are independent authorized executions): an identical
retry returns the stored result with no second side effect or duplicate
event; reusing a key with different input returns `409 conflict`. Project events
are appended in the SAME transaction as the state mutation that caused them
(schema-validated against the declared per-type data schemas), which is what
makes replay exact: `GET /v1/projects/{id}/events` replays by opaque cursor
(`invalid_cursor` 400 for malformed/ahead-of-history cursors,
`cursor_expired` 410 past the replay window — default 30 days, configurable
down), and `WS /v1/projects/{id}/events/subscribe` authenticates the upgrade
with an `events` ticket (purpose + project + origin + current membership)
before delivering ordered live events. Authorization is re-validated before
EVERY delivered batch: removing a member, revoking the issuing token, or
letting the issuing browser session expire closes the stream `4401`
unauthorized (one `kind:"error"` frame first, then no further project
payloads). Subscribe close codes: `4401` unauthorized, `4400`
invalid_cursor, `4410` cursor_expired, `4502` slow_consumer — the `4502`
close carries the code/reason only, with NO error frame, because the
outbound buffer is already saturated and nothing more may be enqueued onto
it. Replay never invokes tools or changes state.

The API serves the contract at `http://127.0.0.1:3100/v1/openapi.json`,
capabilities at `/v1/capabilities`, event schemas at `/v1/events/schemas`
and liveness at `/health`. The worker starts with zero registered job
handlers in the foundation (it idles cleanly); later milestones register
handlers. Each entrypoint installs its SIGTERM/SIGINT cleanup handler
before it announces readiness (the worker started line, or the API and
preview listen), so an immediate stop runs cleanup and exits 0. The preview gateway is a separate origin. It serves an authenticated desktop
stream and a fixed-port private app preview. Arbitrary targets return
`validation_failed`. Unknown gateway paths return `not_found`. Provider
stream URLs and certificates never appear in client responses.

Migrations and configuration work from a fresh data directory and data
survives API/worker restarts (WAL, foreign keys, busy timeout).

## Secrets

Provider keys (`XAI_API_KEY`, `INSTABOX_API_KEY`) are selected from the protected
file `RANGER_SECRET_FILE` by default (mode 0600, e.g. `/etc/droid/environment`). Values
are read into the requesting process memory on demand and are never logged,
committed, echoed into errors, or forwarded to guests/browsers. Nothing in
this repository contains secret values; `src/secrets.ts` refuses permissive
file modes and unknown names, and reports `not_configured` when no file is
set. Ambient provider keys do not enable providers in the default mode.

For a secret manager that injects credentials into process memory, explicitly
set `RANGER_SECRET_SOURCE=environment` and leave `RANGER_SECRET_FILE` unset.
Only the two known provider keys are read; values are never copied into config,
written to disk, shell-evaluated, or sent to the frontend. For example, after
selecting the intended Doppler project/config and configuring the data and
budget paths:

```sh
doppler run -- env -u RANGER_SECRET_FILE RANGER_SECRET_SOURCE=environment npm run start:api
doppler run -- env -u RANGER_SECRET_FILE RANGER_SECRET_SOURCE=environment npm run start:worker
```

The source selector must be an explicit environment setting; the JSON config
file cannot enable it. Configuring both sources is an error. Missing or empty
keys fail closed, with no fallback to another source. Never place provider
keys in `VITE_*` variables or start the frontend with the injected keys.

## Shared live budget (never reset)

`RANGER_LIVE_BUDGET_FILE` points at the mission-wide ledger
(`provider-budget.json`). All live tests across all workers/validators share
it: xAI paid operations are admitted only while recorded spend plus a
conservative estimate stays at or below the **$4 soft admission stop** within
the **$5 total cap** (the remaining $1 is reserve). Instabox permits one local
machine at a time, each with a server-side 10-minute kill timeout and early
cleanup, and checks account inventory before creation against the five-machine
simultaneous limit. A numeric `instabox.maxAdditionalCreations` remains a
cumulative cap; explicit `null` permits unlimited sequential replacements.
Existing capped ledgers require an authorized, locked update of that field
only, never a counter/history reset. The ledger is locked, written
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

## Trace retrieval (local setup)

Retrieval runs the real pinned Trace (`bd7f255339a45a5bf41bcdc2be650626c497e2b2`)
from a sibling checkout. By default Ranger looks for it at `../trace` next to
this repository and keeps indexes and the embedding model in
`~/.cache/ranger-trace` (outside git). To use other locations, set
`providers.traceRoot` / `providers.traceHome` (absolute paths) in the file named
by `RANGER_CONFIG_FILE` (see `config/ranger.config.example.json`).

```sh
# Node >= 24 and pnpm 12 (e.g. via corepack) on PATH
# Run from the Ranger checkout root; the subshell keeps the shell's cwd here
# regardless of what the sibling Trace checkout is named.
(
  cd ../trace
  git rev-parse HEAD                  # must print the pinned commit above
  pnpm install --frozen-lockfile
  pnpm build

  # One-time embedding model download (Hugging Face, ~162 MB) into the Ranger cache.
  # Ranger itself indexes with --no-model-download, so this must happen first.
  # A unique temporary seed directory is created with mktemp so nothing existing
  # is ever overwritten; it is left in place (the Trace index may reference it)
  # and its location is printed below for later cleanup if desired.
  SEED_DIR="$(mktemp -d)"
  mkdir -p "$SEED_DIR/src" && echo 'export const seed = 1;' > "$SEED_DIR/src/seed.ts"
  TRACE_HOME="$HOME/.cache/ranger-trace" node packages/cli/dist/bin.js index "$SEED_DIR"
  echo "Trace seed directory (safe to delete once no longer needed): $SEED_DIR"
)

npm run test:integration -- tests/integration/trace-retrieval.int.test.ts
```

`npm run bootstrap -- --trace` verifies the pin, install, build and model-cache
presence for the configured locations.

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

## Media diagnostic client (test tooling)

`GET /diagnostic` on the API origin serves the unstyled plain test client
(`src/http/diagnostic.ts`): identity + create conversation, the voice relay
path (start session, open relay with a fresh ticket, send a synthetic 440 Hz
PCM tone, text turn, interrupt/flush, read usage, terminal end, fresh-session
reconnect), getUserMedia/getDisplayMedia diagnostics with stable codes
(`granted`, `denied`, `no_device`, `unsupported_api`, `runtime_error`,
`device_prompt_pending`), and the capture path (start capture, ingest a
synthetic canvas frame, on-demand inspection, end capture, post-end upload
rejection). It is NOT product UI and NOT part of the v1 contract; the caller
pastes their own bearer credential (page memory only). Every outcome carries
a stable code; synthetic browser runs are labeled `synthetic:true` and no
result may claim human permission testing — this host has no physical
microphone or capture display, so physical-device paths are NOT TESTED.

Deterministic test evidence for the browser walk (Chromium fake-device flags
against the existing `setRealtimeProviderForTests` /
`setVisionTransportForTests` seams — fake local provider and scripted vision,
no keys, no live dials) is recorded in the mission's
`validation/media-delivery/` directory, not in this repository.

## Milestone status (honest)

- Implemented: project/toolchain, migrations, config/errors/secrets, budget
  ledger, full v1 contract + typed client, API/worker/preview entrypoints,
  offline test suites, docs; identity layer (bootstrap principal + protected
  credential file, hashed API tokens, revocable browser sessions with
  CSRF/origin checks, single-use connection tickets, project/membership/
  engineer-name CRUD, durable repository references with real local snapshot
  resolution); conversations layer (durable conversations/messages/
  questions/answers, append-only requirement and decision versions, central
  transactional event append with per-project sequences, scoped mutation
  idempotency, cursor replay and ticket-gated live WebSocket subscription);
  coding-workflow layer (plans/approvals, runs, Instabox workspace execution,
  desktop/preview gateway, Trace retrieval); media layer (real xAI voice
  relay with server-side keys, ticket-authenticated upgrades, PCM/text/
  function relay, voice-only interruption, observed usage accounting with
  shared-budget admission, provider-disconnect ends the session terminally
  and a fresh ticket starts a fresh session; latest-frame capture with
  decoded-dimension/byte/rate/order/freshness bounds and a separate on-demand
  xAI vision call returning structured observations with uncertainty; the
  plain `/diagnostic` test client).
- Standalone live evidence (e6b97e5): ONE real xAI voice session relaying
  synthetic PCM/text plus an engineering function call that enqueued a durable
  run, ONE real xAI vision call on a synthetic image, and a fresh-session
  reconnect with zero tool replay over the real transport — all within the
  shared budget. Audio is synthetic; no physical microphone exists.
- Synthetic browser evidence (2026-10-19): agent-browser drove the real
  `/diagnostic` page end-to-end with Chromium fake devices against the
  deterministic test seams (fake WS provider on loopback, scripted fake
  vision, no provider keys): full voice path with usage settled at end
  (0.25 s / 8 tokens), ended-session reject (`4409 session_ended`), fresh
  reconnect, full capture path with post-end upload rejected `409 conflict`,
  and every device-diagnostic code exercised with fake/synthetic labels. Two
  concrete defects found by the walk were fixed with tests first: the
  diagnostic page now emits `device_prompt_pending` instead of a silent
  no-op when a headless picker never settles, and the API end now lands the
  relay's observed-but-unflushed usage in the terminal settlement instead of
  losing it when end arrives before the 10 s flush tick.
- Gates at this state: 253 unit, 84 integration, e2e (16 passed, 7 skipped
  pending live windows), typecheck, lint, build — all passing.
- NOT passed and not claimed: the INTEGRATED live flows — a real voice
  session driving a real engineering run end-to-end, run cancellation under
  live voice, and the changed-requirement customer delivery. ALL new Instabox
  VM creations are on hold: 8 of the 9-creation cumulative ceiling are
  consumed, all eight machines are deleted, the provider list is empty, and
  the ninth creation stays reserved pending orchestrator confirmation; no
  initial generated saved source exists to seed a later window. xAI budget:
  observed **$0.5975**, reserved **$0** (caps: $5 total / $4 admission) —
  this feature made no paid calls (deterministic seams plus reused prior
  live evidence). The e2e live/demo tests remain skipped until a live window
  exists.

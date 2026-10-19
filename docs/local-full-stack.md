# Local full-stack development (backend + frontend)

This repository's `integration/full-stack` branch combines the Ranger
backend (repository root) with the Ranger frontend (`frontend/`) in one
checkout. They remain **two independent npm packages**: separate
`package.json` and `package-lock.json`, no workspaces framework, no shared
dependency tree. The original source branches are preserved untouched;
`integration/full-stack` combines their source histories and no claim is
made here that a remote push of this branch has been verified.

## Requirements

- Node.js >= 24 (developed against 24.21+), npm 11. No other services;
  SQLite is embedded (`node:sqlite`) and everything binds to loopback only.

## Layout

- **Backend** lives at the repository root: Fastify API, durable worker and
  preview gateway over SQLite. See the root `README.md` for the full
  architecture, configuration and secrets model.
- **Frontend** lives in `frontend/`: React + TypeScript + Vite, its own
  package, lockfile, ESLint config, and test suite.

## Independent gates

Run each package's gates in its own directory. They are deliberately not
aggregated into root scripts.

| Gate | Backend (repo root) | Frontend (`frontend/`) |
| --- | --- | --- |
| Install | `npm ci --legacy-peer-deps` | `npm ci` |
| Build | `npm run build` | `npm run build` |
| Typecheck | `npm run typecheck` | `npm run typecheck` |
| Lint | `npm run lint` | `npm run lint` |
| Tests | `npm test` (+ `test:integration`, `test:e2e`) | `npm test` |

The root ESLint configuration ignores `frontend/**` entirely; the frontend
is linted only by its own config inside `frontend/`.

## Reproducible local run (Node 24)

Node.js >= 24 must be on `PATH` (check with `node --version`). Any standard
Node 24 installation works; the temporary local Node 24 binary used in this
environment was optional and is not a persisted dependency.

Terminal 1 — backend, from the repository root (its own package + lockfile):

```sh
npm ci --legacy-peer-deps
RANGER_DATA_DIR=~/.local/share/ranger npm run db:migrate
RANGER_DATA_DIR=~/.local/share/ranger npm run bootstrap -- --create-principal "Operator"
RANGER_DATA_DIR=~/.local/share/ranger npm run start:api   # control API on 127.0.0.1:3100
```

Terminal 2 — frontend, from the integrated checkout's `frontend/`
directory (independent package + lockfile):

```sh
cd frontend   # from the repository root
npm ci
npm run dev   # browse http://127.0.0.1:5173; Vite proxies /v1 to 127.0.0.1:3100
```

The worker and preview gateway processes were not started for the verified
control-plane journey (no live work was exercised), so their start commands
are documented in the root `README.md` rather than repeated here.

## Backend data and credentials (never in the repository)

- All backend runtime state lives in `RANGER_DATA_DIR`, a writable
  directory **outside the repository** (for example
  `~/.local/share/ranger`). The `.gitignore` excludes `data/`, but an
  outside directory is the supported location.
- Apply migrations and verify the environment:

  ```sh
  RANGER_DATA_DIR=~/.local/share/ranger npm run db:migrate
  RANGER_DATA_DIR=~/.local/share/ranger npm run bootstrap
  ```

- Create the initial principal with `npm run bootstrap --
  --create-principal "Operator"`. This writes the bearer credential to
  `<RANGER_DATA_DIR>/bootstrap-credential.txt` (mode 0600) **outside the
  repository**; the bootstrap CLI refuses a credential path inside the
  repository. Bootstrap never prints the secret — it is written only to
  the protected file and is never logged or echoed. To authenticate the
  UI, use that credential file as-is: the session form accepts either the
  bare token or the complete credential-file line.
- Provider keys (`XAI_API_KEY`, `INSTABOX_API_KEY`) live only in the
  protected file `RANGER_SECRET_FILE` (mode 0600). Nothing in this checkout
  contains secret values.

## Ports and origins

- Backend control API: `http://127.0.0.1:3100` (configurable via
  `RANGER_PORT`), loopback only.
- Preview gateway: `http://127.0.0.1:3101` — a separate origin.
- Frontend dev server: **`http://127.0.0.1:5173`** — both servers bind
  loopback; browse the frontend via this tested `127.0.0.1` origin
  consistently.

## Same-origin browser access

The frontend is served from `http://127.0.0.1:5173` while backend cookies
(the HttpOnly `ranger_session` cookie) conceptually belong to the API
origin. The Vite dev server proxies backend paths to the API so the browser
talks same-origin only:

- The API adapter (`frontend/src/api.ts`, `HttpRangerApi`) calls relative
  `/v1` paths with `credentials: 'include'`; the Vite dev-server proxy
  forwards them to `http://127.0.0.1:3100` with `changeOrigin: false` —
  the browser-visible origin stays `http://127.0.0.1:5173`, which is
  exactly what the backend's same-origin/CSRF checks expect for
  cookie-authenticated mutations. Do not enable `changeOrigin`; rewriting
  the Host/Origin would break them.
- The HttpOnly browser session is established through the UI
  (`connectSession` → principal-authenticated `POST
  /v1/auth/browser-sessions`): the credential is submitted once to
  establish the browser session, the input field is cleared, and the
  secret is not stored in the browser. This is not a consumed one-use
  token — the underlying bootstrap credential remains reusable from its
  protected file.
- Never store tokens in `localStorage`/`sessionStorage`. The session is
  the HttpOnly cookie; the CSRF token returned once at session creation is
  held in application memory (the adapter's CSRF field) for the
  `x-ranger-csrf` header on cookie-authenticated mutations.
- **Never put provider keys or provider URLs in Vite environment variables
  or any `VITE_*` variable.** `VITE_*` values are compiled into the client
  bundle and are public by definition. All provider interaction goes through
  the Ranger backend, whose keys live only in the protected file.

## Demo mode is explicit

Live mode talks to the real backend only. The **Explore sample walkthrough**
entry point (or `?mode=demo` on a route) opens the explicitly labelled demo
mode; demo data is illustrative and never indicates a live repository, call,
workspace, test run, or code change. Screens must keep provider-unconfigured
states honest: when the backend reports `not_configured`, the UI says so
instead of fabricating content or success.

## Trace retrieval

The pinned Trace (`bd7f255339a45a5bf41bcdc2be650626c497e2b2`) is expected at
a sibling checkout (`../trace`) with indexes and the embedding model in
`~/.cache/ranger-trace` (outside git). In this environment the pinned Trace
is already installed and built, and the model cache is already populated —
no re-download is needed. See the root `README.md` ("Trace retrieval") for
verification via `npm run bootstrap -- --trace`.

## What is and is not wired (honest status)

- The backend v1 contract is published (`contracts/openapi.json`,
  `docs/contract-v1.md`, generated typed client) and the backend surfaces
  are implemented. The frontend API adapter is implemented: it drives the
  real same-origin control API for session exchange (credential submitted
  once to establish the browser session → HttpOnly browser session),
  capability reporting, project creation with an
  initial conversation and message, project load, engineer rename,
  messaging, manual plan creation and approval decisions, repository
  connection and event replay — with scoped idempotency keys, explicit
  partial-failure reporting and honest error envelopes instead of faked
  success.
- Voice and screen-frame transport are **not wired in the frontend**:
  `startMediaSession`/`endMediaSession` return an explicit `unsupported`
  result and create no session. Provider-unconfigured states stay honest —
  `GET /v1/capabilities` reports what is actually configured and the UI
  surfaces unconfigured providers as unconfigured.
- No live attempt is made in this setup for two concrete reasons: no
  provider secrets are provisioned at runtime (`RANGER_SECRET_FILE` with
  `XAI_API_KEY`/`INSTABOX_API_KEY` is absent), and the live-run guest
  timeout behaviour is unknown/unresolved. Note the distinction: the
  bootstrap credential is a locally generated operator credential, created
  by the bootstrap CLI and used for the verified control-plane journey —
  it is NOT the missing piece. The missing piece is the provider secret
  file. This is a statement about this validation setup, not a permanent
  prohibition: the user has already authorized a bounded live budget, so
  live attempts remain possible once provider keys are provisioned and the
  guest timeout is understood. (Factory's Grok validator authentication is
  native to Factory and independent of Ranger runtime credentials.)
- Consequently nothing beyond the local control plane was exercised: no
  model calls, no Instabox VM creation, no worker process, no preview
  gateway, and no run execution (`startRun` was never invoked).
- Nothing here claims live product acceptance: the verified scope is the
  local control plane (see the report below); live engineering is **NOT
  accepted**. No Factory runtime credentials are used, no live paid
  provider calls are made, and no model downloads are performed in this
  setup. The `/diagnostic` client and the shared live budget ledger govern
  any future live evidence.

## Local verification report

Status: **real local control-plane verified** — the initial manual browser
journey passed, the two defects it surfaced were fixed and re-tested in a
focused follow-up that also passed, and final Grok code review found no
issues. Live engineering is **NOT accepted**: nothing here is a claim of
full live engineering acceptance.

### Automated gates (Node 24)

- Backend: typecheck, lint, build green; **254 unit** tests and **84
  integration** tests passed; e2e **16 passed / 7 skipped** (live-window
  skips) — unchanged across the final run.
- Frontend: typecheck, lint, build green; **35 tests** passed (final
  count, after the UI follow-up added tests).
- Grok code review: **final — no issues** (it had earlier cleared the
  API and UI defects found mid-stream).

### Initial manual browser journey (historical record)

Method: a real agent-browser journey against the real local services,
using a **labelled headless fallback** — the desktop target was unstable
and native keyboard input was unavailable, so values were entered with DOM
setters plus React input events and form `requestSubmit`. No fetch or
network mocks were used. The browser profile was **not fresh**, which was
a noted limitation of this first journey (retained here for the historical
record; the follow-up below used a unique fresh headless session).

Verified in that journey:

- UI session exchange through the Vite proxy: `POST
  /v1/auth/browser-sessions` sets the HttpOnly `ranger_session` cookie
  (SameSite=Strict); reload re-authenticates from the cookie.
- `GET /v1/capabilities` reported xai=false, instabox=false, trace=true,
  surfaced honestly in the UI.
- Created a real synthetic project and conversation with an initial
  message; a second message persisted across reload.
- Manual plan v1 created and its exact version approved; submitting a v2
  plan invalidated the v1 approval; re-approving v2 passed.
- A reference-only `https` repository was saved with no clone attempted.
- Navigating to an invalid route hid project content.
- Demo mode was labelled and issued zero `/v1` requests.
- Live media was disabled with no false activity; the changes/checks views
  were truthfully empty; attached context stayed local-only.
- Negative auth check: a cross-origin mutation carrying the real cookie was
  rejected with `403 origin_mismatch`; the same-origin retry succeeded.
- API-assisted event replay observed 112 events, ordered and unique across
  two pages; at that time the UI rendered a bounded window of 100 and
  latest-event rendering in the UI was not yet proven (an API-assisted
  observation, not a count of browser assertions).

This journey surfaced two defects — bootstrap token normalization and a
lingering engineer name on invalid routes. Both UI findings are closed:
each was fixed and covered by the follow-up checks below. Live flows
remain blocked (see "What is and is not wired"); nothing beyond the UI
findings is implied by this closure.

### Focused follow-up journey (manual, unique headless session)

Method: five focused real agent-browser checks in a **unique headless
session** with cookies explicitly cleared before authentication, against
the real local services. Input still required DOM setters plus React input
events and form `requestSubmit` (native keyboard input remained blocked);
no fetch or network mocks were used. No automated browser test count is
claimed: this was a manual journey plus five labelled focused checks.

- Bootstrap credential-line handling (retest of the fixed defect): the
  complete bootstrap credential-file line (value omitted here) was
  submitted as-is through the UI and produced a `200` browser session;
  the session check and capabilities calls returned `200` with no `401`,
  and the session cookie stayed HttpOnly with SameSite=Strict. An
  empty-value token line is rejected, as covered by local tests. No
  credential value is printed anywhere.
- Engineer rename (retest of the fixed defect): the engineer display name
  was renamed via the real modal; the new name persisted across reload and
  in the API.
- Invalid route: displayed the Ranger empty state with no stale engineer
  name or stale requirement text and issued no project request; navigating
  back restored the project.
- Project navigation/state isolation: as the same authorized user
  switching between two existing projects, the second project showed only
  its own engineer name and no content from the other project. (This is a
  browser navigation/state check, not a negative tenant-access test;
  backend security tests are separate and already passed.)
- Latest-event rendering (previously unproven in the UI): after the
  rename, the server held 113 ordered, unique events; the UI Refresh
  action rendered 100 unique events in descending sequence 113 through 14,
  with the latest `project.updated` event at sequence 113 matching the
  server. No extra events were seeded by the UI. No application errors
  appeared, and an expected missing-repository `404` was handled cleanly.

Evidence limits: the journeys used synthetic fixture data against the real
backend; the screenshot attempt failed, so no image evidence exists. No
live generation of any kind occurred.

### Cleanup

After the follow-up, all service PIDs were stopped exactly as launched and
ports 3100 and 5173 were confirmed free. No worker, preview gateway, run,
model, VM or provider call was made at any point.

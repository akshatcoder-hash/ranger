# Ranger frontend

An isolated React + TypeScript + Vite frontend for Ranger. All app files and
local design assets live in this directory so backend work at the repository
root can proceed independently: this package has its own `package.json`,
lockfile and ESLint config, and the root lint configuration ignores
`frontend/**` entirely (each side is linted with its own setup).

## Run

```sh
npm ci
npm run dev
```

The dev server binds `127.0.0.1:5173`. Open `/` for live mode. Use
**Explore sample walkthrough** to open the explicitly labelled demo mode, or
append `?mode=demo` to a route. Demo data is illustrative and never indicates
a live repository, call, workspace, test run, or code change.

## Backend contract

The published backend contract lives at the repository root:
`contracts/openapi.json` and the realtime event schemas (regenerable via
`npm run contracts:generate`), the human-readable reference in
`docs/contract-v1.md` with its history in `docs/contract-changelog.md`, and
the generated typed client under `src/clients/` (regenerate, never edit).
Current published version: **v1**.

The API adapter is implemented in `src/api.ts` (`HttpRangerApi`) and talks to
the real control API **same-origin**: every call uses a relative `/v1` path
with `credentials: 'include'`, so requests go to the frontend origin and the
Vite dev-server proxy forwards them to the backend (see
`docs/local-full-stack.md` at the repository root). The browser session is
established through the UI (`POST /v1/auth/browser-sessions`): the
credential is submitted once to establish the session, the input field is
cleared, and the secret is not stored in the browser (the bootstrap
credential itself remains reusable from its protected file — this is not a
consumed one-use token). The server sets the HttpOnly `ranger_session`
cookie (SameSite=Strict) and the CSRF token returned once at session
creation is held in application memory for the `x-ranger-csrf` header —
never in `localStorage` or `sessionStorage`. Mutating calls send scoped
`Idempotency-Key` headers, and multi-step operations report partial failure
explicitly instead of claiming success.

Local control-plane verification passed end to end: an initial manual
browser journey (same-origin session exchange with reload, real
project/conversation/message flows, plan version approval and invalidation,
honest empty/disabled states, and a `403 origin_mismatch` rejection of a
cross-origin cookie mutation), followed by a focused five-check follow-up
in a unique headless session with cookies explicitly cleared — covering
bootstrap credential-file line handling (the complete line, value omitted
here; empty-value lines are rejected by local tests), engineer
rename persistence across reload, invalid-route isolation, project
navigation/state isolation (the same authorized user switching projects),
and latest-event rendering in the UI. Both defects the initial journey
surfaced are closed. The full verification report, its stated limitations
(headless input via DOM setters/React events, no screenshot evidence) and
cleanup record live in `docs/local-full-stack.md` at the repository root.
That report verifies the local control plane (100 frontend tests, current
count) — this is user-demo-scope validation, not production; live
engineering is not accepted. The one real end-to-end live attempt has
finished and FAILED (guest source copy failed after Trace materialized;
indexing never started), the live-run guest timeout is still unknown, and
no repeat is permitted without a new explicit VM allowance.

Browser media is implemented: a same-origin voice WebSocket relay with
24 kHz PCM playback, capture and interruption, plus independent
latest-frame capture at 1 fps with on-demand inspection. Media buttons
are enabled only inside an actual project/conversation with known
capabilities — no device permission is requested on page load. Device
and socket tests use fake doubles; the real xAI WebSocket and tools are
confirmed by the synthetic driver, but human-microphone and browser
media remain **not verified** (physical media NOT PASS). If a
media-session cleanup call fails, the session id stays in
memory and an explicit retry is offered (a reload is not claimed to
recover the session).

Provider configuration is read honestly from `GET /v1/capabilities` —
unconfigured providers surface as unconfigured, never as faked capability.

No provider keys or secret values belong in this package — all provider
interaction goes through the Ranger backend.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

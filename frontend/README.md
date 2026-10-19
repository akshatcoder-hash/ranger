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

The dev server binds `127.0.0.1:5173`. There is a single product flow: no
demo mode, no sample data and no token to paste. On load the app checks
`GET /v1/auth/me`; if there is no session it opens one anonymous guest session
(`POST /v1/auth/anonymous-session`) and continues on its own. From there:

1. Start a project and paste a public GitHub URL under **Connect a repository**.
2. Start a call and ask Ranger to prepare the repository. The workspace shows
   preparation live: queued, VM + repo, Trace index, ready,
   with an elapsed clock, file and byte counts, files per second while
   indexing, and clone / index / total times once ready. Every number is a
   backend event field or the browser's own stopwatch.
3. Ask code questions on the call, request a change, **Review plan**,
   approve, then ask Ranger to start the approved work. Watch **Live activity**
   and the results tabs.
4. The **VM** card shows the workspace's observed state and offers a plain
   command console (`sh -c` in the project's VM) and a desktop screenshot.

`public/assets/workflow-demo.mp4` is landing-page marketing only.

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
opened automatically by the app (`POST /v1/auth/anonymous-session`, no
credential); a later 401 renews it once and replays the failed call once, and
only a failed renewal is shown to the user. The server sets the HttpOnly
`ranger_session` cookie (SameSite=Strict) and the CSRF token returned once at
session creation is held in application memory for the `x-ranger-csrf` header,
never in `localStorage` or `sessionStorage`. Mutating calls send scoped
`Idempotency-Key` headers, and multi-step operations report partial failure
explicitly instead of claiming success.

Current deployment and recording instructions are in
`docs/deployment-handover.md` at the repository root. Older verification in
`docs/local-full-stack.md` predates anonymous sessions and public-repository
loading. The provider limit is five simultaneous VMs, not a cumulative
creation allowance; Ranger uses one VM at a time.

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

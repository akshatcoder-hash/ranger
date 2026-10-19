# Deployment handover

Ranger's integrated app (backend at the repository root, frontend in
`frontend/`) is deployed and verified live as of **2026-10-19**. This is
user-demo-scope validation, not production. Local development is covered in
`docs/local-full-stack.md` and is not repeated here.

## Live deployment

- App: **https://ranger.akshats.xyz** — frontend SPA served by the
  Cloudflare Worker `ranger` (account `7fc8a64ca2b1e078e8b415687b7fb854`)
  on a custom domain route; workers_dev and preview URLs are disabled.
- Backend: Fly.io app `ranger-backend-akshats` (org personal) — ONE
  shared-cpu-1x machine (2 GB) in region `sin`, volume `ranger_data`
  (1 GB, encrypted, snapshots) mounted at `/data`.

Request path: the Worker proxy (`deploy/cloudflare/index.mjs`) runs first
for `/v1` and `/v1/*` and forwards HTTP and WebSocket upgrades to
`BACKEND_ORIGIN=https://ranger-backend-akshats.fly.dev`. It translates
ONLY the exact Origin `https://ranger.akshats.xyz` to the backend origin;
any other present Origin is rejected `403 origin_mismatch` (verified
live), while a missing Origin passes through for CLI/CSRF-header clients
(backend answered `401 unauthenticated`, verified). API responses are
`Cache-Control: no-store` — nothing is cached.

## How to use

- **Log in:** the bootstrap credential is written on the machine at
  `/data/ranger/bootstrap-credential.txt`; a local copy is kept at
  `/Users/akshat/.secrets/ranger-deployed-credential.txt` (mode 0600).
  The UI login accepts the full line. NEVER print the credential value.
  Rotate by fetching the file (`fly ssh sftp get`) to reissue, or by
  creating a new principal (`bootstrap --additional-principal`).
- **Use:** create a project with a preselected local repository, then
  start a live voice session (same-origin voice relay, 24 kHz PCM) that
  drives workspace preparation, Trace indexing and grounded answers.
- **Do NOT:** launch any new voice-prep or live attempt without a new
  explicit Instabox VM allowance (see Known limitations), and never put
  provider keys or tokens in `VITE_*` variables or browser storage.

## How it was verified (2026-10-19)

- Live: `GET /v1/capabilities` through the public domain → xai
  configured, instabox configured (VM adapter available), trace configured
  (sibling checkout + model cache detected); Atom/Orbit grounding
  disabled. Origin mismatch returns `403 origin_mismatch`; missing Origin
  passes and the backend answers `401 unauthenticated`. `GET /health`
  passing.
- Tests (Node 24, all typecheck/lint/build green): backend 254 unit +
  focused integration; Cloudflare proxy 10 unit tests; fly start script
  2 node:test tests; frontend 101 tests.

## Redeploy and rollback

- **Backend:** from the repo root, create `.fly-build/` then bundle the
  pinned Trace for the image build:
  `git -C /path/to/trace bundle create .fly-build/trace.bundle HEAD`
  (pinned `bd7f255339a45a5bf41bcdc2be650626c497e2b2`; the image is built
  from the bundle, no network fetch of Trace). Then `fly deploy` (remote
  builder). Status: `fly status -a ranger-backend-akshats`; logs:
  `fly logs -a ranger-backend-akshats`; machines:
  `fly machine list -a ranger-backend-akshats`. Rollback: redeploy a
  previous image from `fly releases`.
- **Frontend:** `cd frontend && npm run build` then `npx wrangler deploy`
  (wrangler 4.151.2 pinned devDep). Rollback: `npx wrangler rollback`
  (or versions list).

## Secrets and budget rules

- Fly secrets were staged via `fly secrets import --stage`:
  `RANGER_PROVIDER_FILE_B64` (base64 of the protected provider key file)
  and `RANGER_INITIAL_LEDGER_B64` (the exact shared live-budget ledger,
  seeded once, never reset). No secret values exist in the repo, image or
  logs; the start script materializes the secret file 0600 in memory at
  boot. Never print or `cat` secret values.
- The live-budget ledger is authoritative and never reset. Instabox VM
  creation allowance is exhausted (9/9, all released, 0 pending); xAI
  observed spend is $0.7336, reserved $0. A new explicit VM allowance is
  required before any further voice-prep or live attempt.

## Known limitations

1. The one real live voice attempt FAILED at `guest_write_failed` while
   copying project source into the agent VM after ~97 s; Trace indexing
   and the grounded answer were never reached and the cause is unknown.
   Voice media via a real human microphone/browser is NOT verified
   (synthetic driver only).
2. Instabox VM creation allowance is exhausted 9/9 (all released, 0
   pending); no new attempts without a new explicit allowance.
3. Single-machine SQLite: expect brief unavailability during backend
   deploys; do not scale past 1 machine.
4. Local Macs behind stale DNS caches (e.g. Tailscale MagicDNS negative
   cache, SOA TTL 1800 s) may see NXDOMAIN for ranger.akshats.xyz for up
   to ~30 min after domain creation; public DNS is fine.

## Deploy asset file map

- `wrangler.jsonc` — Worker config: assets `frontend/dist`, SPA
  not_found_handling, `run_worker_first` for `/v1` + `/v1/*`.
- `deploy/cloudflare/index.mjs` — the /v1 proxy (Origin translation,
  WebSocket upgrade forwarding, no-store).
- `Dockerfile`, `.dockerignore`, `fly.toml` — backend image and app
  config (internal port 8080, force_https, auto_stop off,
  min_machines_running 1, health `GET /health`).
- `deploy/fly/` — start script (`start.mjs`, runs API + worker in one
  machine: secret file materialized 0600, ledger seeded only if absent,
  idempotent bootstrap principal, Trace pin verified, Jina model
  prefetched before the port opens, worker ready before API; either child
  dying stops the machine).

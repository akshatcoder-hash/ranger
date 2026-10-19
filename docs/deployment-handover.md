# Deployment handover

Ranger is a recording build, not a public product launch. Backend code is at
the repository root; the frontend is in `frontend/`. Earlier component
verification is recorded in `cloud-validation-2026-10-19.md`.

## Cumulative VM limit migration (2026-10-19)

The user clarified that five is the account-wide **simultaneous** VM limit;
released free machines may be replaced sequentially without a cumulative
creation limit. Current code supports an explicit JSON
`instabox.maxAdditionalCreations: null`. Numeric caps continue to be enforced.
The earlier deployment ledger recorded below remains capped until its
operator runs the migration script on the deployed Machine (after deploying
an image that contains it; the image working directory is `/app/ranger`):

```
fly ssh console -a ranger-backend-akshats -C "node /app/ranger/scripts/migrate-instabox-ledger.mjs"
```

It reads `RANGER_LIVE_BUDGET_FILE` (default `/data/provider-budget.json`),
sets only `instabox.maxAdditionalCreations` to `null` under `withLedgerLock`
and prints one `before -> after` line for that field. Every counter, machine,
pending reservation, operation, xAI budget, and unknown field is preserved; a
missing ledger fails loudly. Do not delete, reseed, or reset the ledger. Code
changes alone do not migrate a deployed ledger. Local concurrency remains one,
VM lifetime remains at most 600 seconds, and the SDK checks account inventory
before each create. No remote deployment or deployed-ledger migration is
implied by this note.

## Credential-free UI and remote repositories

`POST /v1/auth/anonymous-session` (no credential) creates a fresh principal
and browser session, so the UI no longer asks for a credential. The bootstrap
principal and credential below remain for operator use. A project connected
to a public `https://github.com/owner/repo` repository is shallow-cloned on the host (`git` is in the
runtime image, clone area `<RANGER_DATA_DIR>/repo-clones/<projectId>`) during
workspace preparation, before the single VM create; a clone failure fails the
preparation with `clone_failed` and creates no VM.

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

1. Open **https://ranger.akshats.xyz**. No token or sign-in form is needed.
2. Start a project, connect a public GitHub URL and select its branch or tag.
3. Start a call: “Prepare this repository, then explain how its main workflow works.”
4. Watch **Project** for clone, index and total times. Ask a code question;
   answers should cite the connected files.
5. Ask for one concrete change and its acceptance conditions. **Review plan**,
   approve that version, then ask Ranger to start the approved work.
6. **Live activity** shows real commands starting and finishing. **VM** lets
   you run a command or capture a screenshot. Command output appears after
   completion, not as streamed stdout. **Changes** and **Checks** show results.

The prepared VM is reused for approved work while its original lifetime
allows. There is one VM at a time and a 600-second lifetime, not a cumulative
creation allowance. Finish the recording within that window.

An operator credential remains at `/data/ranger/bootstrap-credential.txt`;
it is not needed in the recording. Never put provider secrets in `VITE_*`
variables or browser storage.

### Short recording script

- Repository: `https://github.com/jonschlinkert/is-number`, branch `master`.
- “Prepare this repo. How does it handle numeric strings and invalid input?”
- “We import amounts from customer CSVs. Add `normalize-number.js` using the
  existing validator: return a number for valid inputs and null otherwise.
  Keep existing files unchanged and test it with Node’s built-in assert.”
- Review and approve the plan, then: “Start the approved work.”
- In **VM**, try `node -e "console.log(require('./normalize-number')('42.25'))"`.

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
  `git -C /path/to/trace bundle create /absolute/path/to/ranger/.fly-build/trace.bundle HEAD`
  (pinned `bd7f255339a45a5bf41bcdc2be650626c497e2b2`; the image is built
  from the bundle, no network fetch of Trace). Then `fly deploy` (remote
  builder). Status: `fly status -a ranger-backend-akshats`; logs:
  `fly logs -a ranger-backend-akshats`; machines:
  `fly machine list -a ranger-backend-akshats`. Rollback: redeploy a
  previous image from `fly releases`.
- **Frontend:** run `npm run build` in `frontend/`, then `npx wrangler deploy`
  from the repository root
  (wrangler 4.151.2 pinned devDep). Rollback: `npx wrangler rollback`
  (or versions list).

## Secrets and budget rules

- Fly secrets were staged via `fly secrets import --stage`:
  `RANGER_PROVIDER_FILE_B64` (base64 of the protected provider key file)
  and `RANGER_INITIAL_LEDGER_B64` (the exact shared live-budget ledger,
  seeded once, never reset). No secret values exist in the repo, image or
  logs; the start script materializes the secret file 0600 in memory at
  boot. Never print or `cat` secret values.
- The live-budget ledger is authoritative and never reset. Historical
  creation counts are retained, but no longer act as a lifetime allowance
  after the migration above. Existing xAI spending limits remain enforced.
- Anonymous visitors can consume the shared provider budget. The URL is
  intended for this recording, not unrestricted public distribution.

## Known limitations

1. Human microphone/speaker quality is not established by synthetic/API
   checks. Test your microphone and playback before recording.
2. Use a small public repository. Existing source limits reject symlinks,
   submodules and files exceeding the guest transport size bound.
3. Single-machine SQLite: expect brief unavailability during backend
   deploys; do not scale past 1 machine.
4. Anonymous projects belong to that browser's session. Clearing cookies
   or switching browsers does not recover them.

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

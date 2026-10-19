# Deployment handover

Ranger is a recording build, not a public product launch. Backend code is at
the repository root; the frontend is in `frontend/`. Earlier component
verification is recorded in `cloud-validation-2026-10-19.md`.

The recording build is deployed as of **2026-10-20**. Fly image:
`deployment-01M5B2Y7ADW2NAJ618M6T8CRJW`; Cloudflare Worker version:
`22196192-7101-4864-8512-c0fe2530b044`.

## Cumulative VM limit migration (2026-10-19)

The user clarified that five is the account-wide **simultaneous** VM limit;
released free machines may be replaced sequentially without a cumulative
creation limit. Current code supports an explicit JSON
`instabox.maxAdditionalCreations: null`. Numeric caps continue to be enforced.
To migrate an older capped deployment, run the script on the deployed
Machine after deploying an image that contains it (the image working
directory is `/app/ranger`):

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
before each create. The deployed script was run on 2026-10-20 and reported
`null -> null`: the cap was already removed, and history was preserved.

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
(backend answered `401 unauthenticated`, verified). Connection-ticket origins
receive the same translation as WebSocket headers. API responses are
`Cache-Control: no-store` — nothing is cached.

## How to use

1. Open **https://ranger.akshats.xyz**. No token or sign-in form is needed.
2. Start a project and connect a public GitHub URL. `HEAD` selects its default
   branch; use an explicit branch or tag only when needed.
3. Choose **Start call** directly on the new-project screen, with or without
   a typed problem. A connected repository is prepared automatically when
   the provider connection opens. Saved user messages give the call context.
4. Watch **Project** for clone, index and total times. Ask a code question;
   answers should cite the connected files.
5. Ask for one concrete change and its acceptance conditions. Confirm the
   requirements Ranger repeats back and ask it to draft the plan. **Review plan**,
   approve that version, then ask Ranger to start the approved work.
6. **Live activity** shows real commands starting and finishing. **VM** lets
   you run a command or capture a screenshot. Command output appears after
   completion, not as streamed stdout. **Changes** and **Checks** show results.

Typed messages during a live call are now also sent to the voice agent.
Outside a call they are saved as context, not executed. A failed preparation
is not automatically retried by reconnecting: fix the reported cause, then
explicitly ask Ranger to prepare again.

### Call diagnostics

`fly logs -a ranger-backend-akshats` shows structured diagnostics from both
the API and worker. Filter by the project/session id or these event names:

- `voice.relay.authenticated`, `voice.provider.opened`, `voice.provider.dial_failed`
- `voice.call.context` (saved message count and preparation status, not content)
- `voice.speech.started`, `voice.speech.stopped`, `voice.transport.usage`
- `voice.text.received`, `voice.tool.started`, `voice.tool.finished`
- `voice.provider.error`, `voice.response.done`, `voice.session.ended`
- `workspace.preparation`, `workspace.clone.*`, `workspace.create.*`,
  `workspace.seed.*`, `workspace.cleanup.*`

These record identifiers, counters, timings and stable status/error codes.
They do not log audio, transcripts, prompts, repository contents, tool
arguments/results, credentials or connection tickets. Preparation events
also remain in SQLite after Fly's recent log buffer rolls over.

The prepared VM is reused for approved work while its original lifetime
allows. There is one VM at a time and a 600-second lifetime, not a cumulative
creation allowance. Finish the recording within that window.

An operator credential remains at `/data/ranger/bootstrap-credential.txt`;
it is not needed in the recording. Never put provider secrets in `VITE_*`
variables or browser storage.

### Short recording script

- Repository: `https://github.com/jonschlinkert/is-number`, branch `HEAD`.
- “Prepare this repo. How does it handle numeric strings and invalid input?”
- “We import amounts from customer CSVs. Add `normalize-number.js` using the
  existing validator: return a number for valid inputs and null otherwise.
  Add `test-normalize-number.js` using Node’s built-in assert. Keep existing
  files unchanged. Include both new files and commands in the plan scope.”
- “Confirmed. Those are the requirements. Draft the plan now.”
- Review and approve the plan, then: “Start the approved work.”
- In **VM**, try `node -e "console.log(require('./normalize-number')('42.25'))"`.

### Other tiny repositories

| Repository | Branch | Source size | Short adaptation |
| --- | --- | --- | --- |
| [jonschlinkert/is-number](https://github.com/jonschlinkert/is-number) | `master` | 15 files, 24.5 KB | Normalize customer CSV amounts. Verified end to end. |
| [ap1311/todo](https://github.com/ap1311/todo) | `main` | 4 files, 19.6 KB | Turn personal tasks into support triage with priorities and an urgent filter. |
| [WebDevSimplified/Vanilla-JavaScript-Calculator](https://github.com/WebDevSimplified/Vanilla-JavaScript-Calculator) | `master` | 3 files, 5.9 KB | Add discount/tax calculations and keyboard input. |

Sizes exclude Git history and dependencies. The two visual apps need no
dependency installation. Their source was inspected, but their adapted UI
and Ranger preview path have **not** been rehearsed live. The tested
`is-number` recording shows its changed behavior in the VM command console.

## Browser verification after the call fixes (2026-10-20)

The deployed workspace call was exercised with a synthetic microphone, not
a human microphone. Opening the provider connection automatically prepared
the connected `is-number` repository. Synthetic speech triggered successful
`search_project_code` and `read_project_source` calls. Typed messages reached
the live conversation, drafted a plan after explicit confirmation, and
requested work after the exact plan was approved in the UI.

| Measurement | Observed |
| --- | --- |
| Clone | 0.95 seconds |
| Trace index | 14.2 seconds |
| Total preparation | 26.5 seconds |
| Repository | 15 files, 24.0 KB |
| Approved work | Both scoped files edited on the prepared VM |
| Agent verification | `run_tests`: `node test-normalize-number.js`, exit 0 |
| Independent VM-console verification | `BROWSER_CSV_PASS`, exit 0, output visible |
| Cleanup | Test VM removed, zero tracked active machines, user's existing VM left alone |

The browser test caught whole shell commands being treated as executable
names, false success after failing commands, and integer log-query parameters
being rejected. All three are fixed in the deployed backend. Coding tools
normalize shell commands and approval checks inspect the normalized command.
A failed command or test cannot be cleared merely by a model's final message.

New-project **Start call** creates the project and voice session, but its
uninterrupted handoff is **not verified** in the embedded browser. Instrumentation
showed a full document load after the app's `history.pushState`, with no form
submission. Grok's read-only review found no product code requesting that
load; the embedded browser is the suspected cause. For the verified path,
create/open the workspace, then choose **Start call** there.

Final local checks passed: frontend typecheck, lint, build and 164 tests;
backend typecheck, lint, build, 419 unit tests and 111 integration tests.
The deployment still reports one moderate dependency advisory; this change
does not resolve it. The live ledger recorded 12 historical VM creations,
$2.7034 observed xAI spend out of $5, and zero reserved spend after cleanup.

## Earlier API-driver verification (2026-10-20)

A public-domain API driver opened an anonymous session, connected the public
`is-number` repository, requested preparation through the real xAI relay,
used code search/read tools, approved a scoped CSV-adapter change, and ran it.

| Measurement | Observed |
| --- | --- |
| Clone | 1.058 seconds |
| Trace index | 13.668 seconds |
| Total preparation | 25.527 seconds |
| Approved change | 13.914 seconds, four model turns |
| Reported coding cost | $0.009503 (excludes voice) |
| New VM creations | Exactly one; preparation and coding reused it |
| Cleanup | No active provider VMs; no reserved xAI spend |

Independent Node assertions inside the guest confirmed `normalize-number.js`
returns numbers for valid inputs and null for invalid inputs. Real command
start/finish events and guest-console access were also verified. Historical
VM creation count increased from 9 to 10, not by a second create for coding.

The relay received text input, not a human microphone recording. The plan
and approval used the public API; a single uninterrupted browser call through
UI approval and results was not verified. Local browser checks covered the
token-free landing and repository dialog. The frontend's 157 tests,
typecheck, lint and build passed. Final backend checks passed: typecheck,
lint, build, 409 unit tests and 110 integration tests.

Earlier checks caught and fixed a proxy ticket-origin mismatch and an old
Git runtime missing `--attr-source`. A private-repository attempt failed
before VM creation as expected. The runtime now checks Git support at build.

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

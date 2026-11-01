# Deployment handover

Ranger is a recording build, not a public product launch. Backend code is at
the repository root; the frontend is in `frontend/`. Earlier component
verification is recorded in `cloud-validation-2026-10-19.md`.

The recording build is deployed and verified as of **2026-10-21**. Fly image:
`deployment-01M5D97BTV2H8EKQR5G293DHZD`; Cloudflare Worker version:
`d9494f08-0af4-4b98-ba5f-60400733a6c6`.

## Warm setup for the support-workflow demo

### Text workflow

Posting a user message queues a durable text-assistant turn. Ranger can search
and read the repository, draft a reviewable plan, and queue an already-approved
run from text. A call is optional. Send “Draft a plan” (or “Plan: …”) to authorize
drafting after discussing the requirements. Drafting never grants approval;
review and approve the exact plan in the UI, then send “Start the approved work.”
Questions, negated start requests and quoted fragments cannot authorize a run.
Replies arrive through the existing message events and polling, without streaming.
Agent and system posts do not trigger another turn.

The desktop workspace fits the viewport. The right work pane scrolls independently;
the left composer stays visible below a separately scrollable conversation history.
On narrow mobile screens, the panes stack. Message authors remain visible.
New-project creation connects the attached repository before posting the initial
request, so the text worker cannot race ahead of repository attachment.

Text turns recheck their live worker claim before tools and replies. Planning
calls share the turn's abort deadline, capped by its lease expiry. Review fixes
passed 45 focused text/planning/voice tests, backend typecheck, lint and build;
the earlier full implementation run passed 493 unit and 115 integration tests.
The frontend passes 184 tests, typecheck, lint and build. Desktop layout checks
at 1280×720 and 1440×900 confirmed the composer stays visible during work-pane
scrolling with a long transcript.

Live acceptance on 2026-10-21 passed using the real model and Trace:
- A fresh anonymous session posted an inspection request and received a cited
  answer in 18.4 seconds without a voice call. Replaying the same idempotency key
  left exactly one user message and one reply. Plan and run counts stayed unchanged.
- In the deployed browser, attaching the repository stayed on `/start`; Send
  opened the existing demo project. The initial answer and a follow-up submitted
  from the pinned composer both appeared through normal polling.
- The Project card showed **Trace search 38.6 ms**, **2 retrieved results**,
  **272 indexed files**, and **Index time 1m 03s**. These are measurements,
  not a grep comparison.
- At 1280×720, the document stayed 720px tall and the composer bottom stayed
  at 708px while the right pane scrolled.

Driver: `.fly-build/verify-text-workflow.mjs`. Live verification was inspection-only
to preserve the baseline app for recording; plan drafting and approved-run
authorization were checked offline, not exercised against the demo VM.
The Fly build still reports the previously documented moderate dependency advisory.

### Fresh-session recording entry

The recording deployment opts into
`RANGER_DEMO_PROJECT_ID=prj_6f5b65e6-e85d-4380-9b52-67c7a12fde4c`.
Every anonymous browser session receives member access to this project,
including a fresh incognito window; no manual authorization is necessary.
Anyone who reaches the public site can control this shared VM and consume
provider credits while this is enabled. Other projects remain membership-gated.

Open `/start`, attach `https://github.com/satnaing/shadcn-admin` with `HEAD`,
type the task and choose **Send** (or **Start call**). Attachment remains
draft-only. An exact repository/ref match creates a fresh conversation on
the existing project, without creating a VM, reconnecting the repo or
reindexing. Other repositories retain normal project creation. Each tab
remembers its conversation id in sessionStorage; no credential is stored there.
Activity starts at that conversation's creation, without deleting history.
This is display scoping, not privacy: members can read the shared project
history through the API.

The Project card shows actual **Trace search** milliseconds and retrieved
result counts, plus **Indexed files** and **Index time** for the prepared index.
Index time is the recorded index build duration, not the duration of opening
a new conversation or validating an existing index. Each successful search emits
its own measurement, including queueing, runtime adoption and citation checks,
excluding model generation and network time. Fallback is labeled separately.
No comparative claim against grep is established. Setup labels are real;
cloning output and timings are not simulated.

Validation for this change: 481 backend unit tests, 114 integration tests
(including real Trace), and 183 frontend tests pass, along with typechecks,
lint, builds, generated contracts and the Worker deployment dry run.
Grok reviewed search measurement and shared access. Search metric persistence
is best-effort, so a metrics-write failure cannot fail a successful search.
Polling resumes on call start and stays active during the call.

Live acceptance passed: a fresh cookie session was automatically authorized.
The UI stayed on `/start` with zero mutations when the repo was attached;
**Send** opened the existing demo project with only the new conversation
visible. The embedded browser reloaded at navigation, so the post-Send
mutation observer did not survive; durable records independently confirmed
no new workspace or preparation job (14 workspace rows and 21 jobs unchanged).
The original machine and 272 saved source files were unchanged.

Real `TasksImportDialog` searches returned two cited results. The first call
after deployment took 10,149.1 ms including runtime/model startup; subsequent
calls took 39.6 ms and 32.2 ms. The last value appeared in the Project card
and live activity. These are observed samples, not a throughput or grep
benchmark. The API runtime is now warm; redeploying restarts it.
Verification driver: `.fly-build/verify-demo-access.mjs`. No paid voice call
was needed for this check; the real microphone path was not re-tested.

To disable shared access, remove `RANGER_DEMO_PROJECT_ID` from `fly.toml` and
redeploy. Startup revokes demo-created memberships, not original invitations
or owner roles. This does not stop the VM or disable the public app; **Stop VM**
and deployment shutdown remain separate operator actions after recording.

Use one dedicated project rather than a VM pool or cross-project index copies:
`prj_6f5b65e6-e85d-4380-9b52-67c7a12fde4c`, with
`https://github.com/satnaing/shadcn-admin` at
`e16c87f213a5ba5e45964e9b67c792105ec74d26`.
The app has 272 source files (2,071,620 bytes), builds without Clerk credentials,
and has a CSV import dialog that currently only displays file metadata.
Keep the baseline feature unchanged until the actual Ranger engineering run.

Preparation may reuse this project's persisted Trace index after proving the
indexer version, source fingerprint, mirror HEAD and live MCP snapshot match.
Missing, changed or unusable indexes are rebuilt. Recreating the same project's
VM rebinds index provenance after successful validation; another project's
index is never copied or served. Explicit reindex still forces a rebuild.
Keeping the prepared VM running also avoids VM creation and dependency setup.

A request against an already-ready project emits a fresh ready event with
the actual validation duration in `elapsedMs` and the prepared index's recorded
build duration in `indexElapsedMs`. It does not replay historical indexing output
as new work or insert a synthetic delay.
Backend validation before the timeout-only redeploy: 443 unit tests, 114 integration tests,
typecheck, lint and build passed, including real Trace index adoption/search.

### Ready VM, verified live on 2026-10-20

- VM `m_agqvtubvdmzn5vue4rqonjua2e` is running with no expiry.
- Preparation succeeded: 272 files, Trace 63.755 seconds, total 212.746 seconds.
  The deployed index timeout is now 15 minutes.
- Dependencies installed successfully with lifecycle scripts disabled. The first
  attempt hit the workload memory limit (confirmed `oom_kill: 1`); this VM
  alone now has a 1 GiB workload memory limit and 128-PID limit.
- The baseline Tasks page runs at `http://127.0.0.1:4173/tasks` inside the VM.
  HTTP 200 and the rendered Chromium page were verified through Ranger's
  **Show VM screen**. Vite PID at launch: 6268. Evidence:
  `.fly-build/demo-dashboard-live.png`. No customer feature was implemented.
- Live warm preparation returned the existing ready job in 36 ms, with a
  fresh ready event reporting 3 ms validation. Job counts and the workspace
  row were unchanged; no new preparation was queued.

The approved network exception exists only on this demo VM. It allows UID
1100 DNS to its configured resolvers and TCP 443 to resolved public npm
registry IPv4 addresses. Metadata/link-local drops and the final deny rule
remain in place. Registry IPs are CDN addresses, not hostname enforcement;
reapply if those addresses rotate. Global bootstrap policy is unchanged.
`scripts/demo-registry-egress.mjs` is an operator helper, not in the runtime
image. Upload it to `/tmp`, set `RANGER_APP_ROOT=/app/ranger`, and use
`--project prj_6f5b65e6-e85d-4380-9b52-67c7a12fde4c --apply` (`--remove`
revokes it). A recreated VM needs the exception and resource adjustment again.
The helper's 26 tests, typecheck and focused lint passed; the timeout redeploy
passed build and Fly health checks. Full regression suites were not rerun.
Local setup commands are retained in `.fly-build/demo-vm-setup.mjs`.

The demo task is to join ticket and CRM CSV exports by normalized email,
flag enterprise accounts with tickets open more than 24 hours, and display a
prioritized escalation queue. Synthetic fixtures and the scoped task prompt
are in `.fly-build/demo-fixtures/`; they include unmatched accounts, case
normalization, quoted commas and the exactly-24-hour boundary.
Expected results: 7 tickets, 6 matched, 1 unmatched, 3 escalated.

For the recording, use the fresh-session entry above and show the baseline
Import dialog first. Ask for the scoped CSV join/escalation task, confirm requirements,
review and approve the plan, then start work. Use the optional call for narration
and show real command/check results and the resulting queue. Do not reconnect a
different underlying project, replay old indexing as live work, or implement the task before
recording. The full coding run's duration has not been rehearsed.

## Earlier verification: preparation without calls and desktop control

The new-project **Use repository** action only attaches a draft. It does not
create a project or start a VM. **Send** creates the project and connects the
attached repository, starting preparation without a call. **Start call** is
the optional voice entry point. The backend preparation job accepts
`sessionId: null`.

After restoring this trigger, live verification attached `is-number` and
remained on `/start` with **zero project mutation requests**. No VM was
created by attachment. Frontend typecheck, lint, build and all 171 tests pass.
At that point, no additional index-reuse path had been added.

Backend preparation and desktop control were verified on the public site
before restoring draft-only attachment, using test project
`prj_5670d0cb-4795-474d-972a-917bded6deb8`:

- Repository connection alone reached **Ready** in 26.096 seconds:
  clone 1.076 seconds, Trace index 13.980 seconds, 15 files, 24,549 bytes.
- Durable records show one succeeded preparation job and **zero voice sessions**.
- The rendered 1280×800 desktop accepted a mouse click, keyboard shortcuts,
  paste, ordinary character keys and Enter. A terminal printed
  `VM_CONTROL_PASS` and `7` through the embedded controls.
- Refreshed frames created **zero saved artifacts**.
- **Stop VM** completed; the workspace is `destroyed`. The embedded browser's
  confirmation limitation required a temporary `window.confirm` shim for this
  test only. The product still requires confirmation; the shim was restored
  immediately after the test click.
- No machine-less `creating` rows remained. Only this verification VM was
  stopped; the user's separate Instabox machine was not touched.

Backend typecheck, lint, build, 430 unit tests and 113 integration tests pass.
Frontend typecheck, lint, build and 171 tests pass. Fly health checks passed;
its separate DNS check timed out, but the public application worked afterward.
The existing moderate dependency advisory remains unresolved.

The embedded browser's full-page screenshot command timed out; visual evidence
was instead read from its rendered VM image. Dragging, double-clicking and
scrolling are implemented but were not separately exercised in this live check.

## Cumulative VM limit migration (2026-10-19)

This earlier migration is superseded by the prototype-limit migration below.
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

## Prototype limits and VM controls

The deployed ledger now uses `null` for xAI `limitUsd` and
`softAdmissionUsd`, and Instabox `maxLifetimeSeconds` and
`maxAdditionalCreations`. `maxConcurrent` is 5, matching the provider quota.
Usage accounting and uncertain-create reconciliation remain enabled.
No Ranger spending cap or automatic VM expiry remains. Use **Stop VM** when
finished; no-expiry VMs otherwise keep occupying provider slots.

`scripts/remove-prototype-limits.mjs` applies these settings under the ledger
lock, preserving all counters, reservations and history. It is idempotent and
refuses a missing ledger. It was already run on the deployed ledger; do not
reseed or reset the ledger.

### Free-plan idle pause and VM slot reconciliation (2026-10-30)

A free Instabox account cannot disable the provider's 30-minute idle pause:
`autoSuspendAfterSeconds: 0` is refused with `403 permission_denied` **before**
any machine exists. The provider adapter now re-dials that one refused create
without the idle override and uses the account default instead; every other
create failure is still `uncertain_create` with no retry. On a free plan a
long-idle sandbox may therefore pause; Ranger does not resume it implicitly.

Instabox also retired lifetime timeouts on 2026-10-20: `timeoutSeconds`,
`onTimeout` and `timeout` are now `400 unknown_field`. The adapter no longer
sends them, so a sandbox has no provider-side expiry — it runs until **Stop
VM** (which also releases the ledger record) or the account's idle pause. A
provider account limit (`429 quota_exceeded`, one sandbox on a free plan) is
reported as `vm_capacity`, never as an uncertain create.

Ledger machine records that outlive their provider machine keep occupying
concurrent-VM admission slots (`vm_capacity`). Reconcile them against the
provider (history, counters and unknown fields are preserved; a released
record only gains `releasedAt`):

```
fly ssh console -a ranger-backend-akshats -C "node /app/ranger/scripts/reconcile-instabox-ledger.mjs"
```

It releases recorded machines the provider no longer reports and drops pending
reservations older than 15 minutes, then prints the released ids and the live
machine count. Run it when admission refuses for capacity although the
provider dashboard shows free slots.


**Show VM screen** captures a fresh desktop image every three seconds after
the previous capture completes. Frames are not saved as artifacts and
refresh pauses in background tabs. **Control VM** enables clicks,
double-clicks, dragging, scrolling, typing and paste (up to 2000 characters).
Escape releases control; **Send Escape** forwards Escape to the guest.
This is a refreshed screenshot interface, not a low-latency video stream.
Keyboard input is serialized, never automatically retried, and not logged.
Background agent commands still appear in **Live activity**, not automatically
as terminal windows on the desktop.

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
3. Attaching a repository on the new-project screen does not start a VM.
   Describe the task and choose **Send** to create the project and prepare
   its repository without a call. **Start call** is optional and reuses the
   same preparation job or ready VM. Saved user messages give the call context.
4. Watch **Project** for clone, index and total times. Ask a code question;
   answers should cite the connected files.
5. Ask for one concrete change and its acceptance conditions. Confirm the
   requirements Ranger repeats back and ask it to draft the plan. **Review plan**,
   approve that version, which starts the run (Stop work in the chat ends it).
6. **Live activity** shows real commands starting and finishing. **VM** lets
   you run a command, view/control the desktop or stop the VM. Command output appears after
   completion, not as streamed stdout. **Changes** and **Checks** show results.

Typed messages during a live call are now also sent to the voice agent.
Outside a call they are saved as context, not executed. After fixing a failed
preparation, reconnect the repository or start a new call to retry. Active
jobs are deduplicated; uncertain provider creates remain blocked until reconciled.

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

The prepared VM is reused for approved work. There is no automatic expiry;
the provider allows at most five simultaneous VMs across the account.

An operator credential remains at `/data/ranger/bootstrap-credential.txt`;
it is not needed in the recording. Never put provider secrets in `VITE_*`
variables or browser storage.

### Short recording script

- Repository: `https://github.com/jonschlinkert/is-number`, branch `HEAD`.
- Attach the repository, describe the task and choose **Send** before
  recording; wait for **Ready**. This warms setup, not the task outcome.
- “How does this repo handle numeric strings and invalid input?”
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

## Demo-path verification (2026-10-31)

Verified on the deployed stack (`ranger.akshats.xyz` → Fly), on the image
built from `548642c` plus the retired-field fix below:

- **Guest, no login:** anonymous session → project → pasted repository →
  `workspace.preparation.updated` reaches `ready` (4 files, 13.2 s index).
- **Browser voice call:** Chrome for Testing with a fake audio device
  (`--use-fake-device-for-media-stream`) started a call from the workspace
  card: relay upgraded with a connection ticket, the provider dialed, the UI
  reported `Live` with End call / Interrupt voice, and ending the call
  returned to `Not connected` with no console errors. Audio was synthetic;
  a physical microphone is still unverified.
- **Text plan → approval → run:** a typed `Draft a plan:` message produced
  plan v1 (scope `edit:src/triage.mjs`, command, launch, evidence); approving
  it in the UI dialog bound that version; `Start the approved work.` queued a
  run that edited `src/triage.mjs`, ran `npm test` (exit 1, then exit 0) and
  finished `succeeded`, with the test file byte-identical to upstream.
- **Provider contract:** Instabox retired lifetime timeouts on 2026-10-20
  (`timeoutSeconds`/`onTimeout` = `400 unknown_field`), which broke every
  create with `uncertain_create`. The adapter no longer sends them. A free
  account's `429 quota_exceeded` (one sandbox) now reports `vm_capacity`.
- Gates at this state: typecheck, lint, build, 511 unit, 115 integration
  (with the sibling Trace checkout), 17 e2e (+7 skipped), 184 frontend tests.
- Left clean: zero live sandboxes, reconciled ledger, no temporary operator
  credentials on disk. The ledger records cumulative xAI spend (about
  **$4.48** across all features to date). Its admission limits are disabled
  (`limitUsd`/`softAdmissionUsd` null), so Ranger itself will not refuse a
  call at $5 — that figure is a budget target, not an enforcement point.

## Redeploy and rollback

- **Backend:** from the repo root, create `.fly-build/` then bundle the
  pinned Trace for the image build:
  `git -C /path/to/trace bundle create /absolute/path/to/ranger/.fly-build/trace.bundle HEAD`
  (pinned `bd7f255339a45a5bf41bcdc2be650626c497e2b2`; the image is built
  from the bundle, no network fetch of Trace). If no local Trace checkout
  exists, take the bundle from the running Machine instead:
  `fly ssh console -a ranger-backend-akshats -C "git -C /app/trace bundle create /tmp/trace.bundle --all bd7f255339a45a5bf41bcdc2be650626c497e2b2"`
  then `fly sftp get /tmp/trace.bundle .fly-build/trace.bundle`.
  Then `fly deploy` (remote builder). Status: `fly status -a ranger-backend-akshats`; logs:
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
  after the migration above. xAI spending limits are explicitly disabled.
- Anonymous visitors can consume shared provider credits and VM slots. The URL is
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

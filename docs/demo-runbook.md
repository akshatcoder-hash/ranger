# Recording the Ranger demo

**The beat:** join a call with Ranger, say what is broken, review the plan it
writes, approve it, say start, and watch it make the fix inside a real Linux
VM. No login, no upload, no GitHub App.

Target: `https://ranger.akshats.xyz` (frontend on Cloudflare Workers,
backend on one Fly Machine at `ranger-backend-akshats.fly.dev`).

## What the demo repo contains

`https://github.com/akshatcoder-hash/ranger-demo-triage` — a dependency-free
Node project (`npm test` runs `node --test`, no install step). It ships a real
bug and tests that encode the correct behavior:

- `src/triage.mjs` flags enterprise tickets at **exactly** 24 hours (should be
  strictly more) and sorts by age only (should be priority, then age).
- `test/triage.test.mjs` fails twice. The fix is two lines in one file.

The fix is bounded (`edit:src/triage.mjs`), testable in seconds, and the test
file must not change — which is what makes a green test run credible on
camera.

## Before every take

1. **Exactly one sandbox fits.** The Instabox account is on the free plan,
   which allows **one** concurrent sandbox (`sandbox limit reached (1 of 1)`).
   Ranger's own admission still allows five, so a second project gets a clear
   `vm_capacity` refusal instead of an uncertain create. Free the slot before a
   take:

   - **Stop VM** on the previous take's project (works in the same browser
     window, the guest session owns it), or
   - as the operator, kill a leftover sandbox directly:

     ```sh
     curl -s https://api.instabox.sh/v1/machines -H "X-API-Key: $INSTABOX_API_KEY"   # ids
     curl -s -X DELETE https://api.instabox.sh/v1/machines/<id> \
       -H "X-API-Key: $INSTABOX_API_KEY" -H "Idempotency-Key: $(uuidgen)"
     ```

   Ledger records that outlive their provider machine (killed that way) keep
   occupying Ranger's admission slots, so reconcile afterwards:

   ```sh
   flyctl ssh console -a ranger-backend-akshats \
     -C "node /app/ranger/scripts/reconcile-instabox-ledger.mjs"
   ```

   It releases recorded machines the provider no longer reports and drops
   pending reservations older than 15 minutes; history, counters and unknown
   fields are preserved.

2. **Providers.** `GET /v1/capabilities` must report `xai`, `instabox` and
   `trace` as configured. The provider dots in the **Call** card above the
   composer show the same.

3. **Fresh project per take.** Guest access is per visitor: each take creates
   its own project from the repository at HEAD, so the bug is always present
   again. No shared demo project is pinned (`RANGER_DEMO_PROJECT_ID` unset).

## The take

| Step | Where | What happens |
| --- | --- | --- |
| 1 | Start page → paste the demo repo URL → **Use repository** | Only selects the repository for the pending project; nothing is created and no preparation starts |
| 2 | Type the problem and press **Send** (or click **Start call** and say it) | Now the project + conversation are created, the repository is connected and preparation is queued |
| 3 | Watch the Project card | Preparing → Ready (VM create, clone, Trace index, ~15–30 s) |
| 4 | Say "draft a plan" and confirm | Ranger calls `draft_project_plan`; a reviewable plan version is saved (none of it approved) |
| 5 | **Review plan** → **Approve plan** | Approval binds that exact plan version and its file scope; approval starts nothing |
| 6 | Say (or type) "Start the approved work." | Run queued; the worker edits `src/triage.mjs` in the VM, runs `npm test`, exit 0 |
| 7 | **Changes** and **Checks** tabs; the **Latest run** card | Real diff inventory, real test exit codes, per-tool evidence |

The call is optional at every step: the same plan → approve → start path works
over typed messages. Typed plan drafting needs the explicit `Plan:` /
`Draft a plan` trigger and typed starts need the explicit start command; both
are regex-checked server-side against that message. The voice tools are gated
differently: drafting requires `confirmed: true` plus a live session, and a run
requires an existing active approval of the current plan version — but there is
no verbatim transcript check on speech, so keep the spoken confirmation
explicit on camera.

## Known demo constraints

- A **failed** run destroys the VM (by design). Recovery is a new project
  (paste the URL again) — about 20 s of preparation, no redeploy.
- A successful run leaves the VM running with the fix applied. Stop that VM
  before the next take; the slot is one sandbox, and the repository itself is
  unchanged on GitHub so the next take starts from the bug again.
- The free Instabox plan auto-pauses an idle sandbox after 30 minutes. Ranger
  cannot disable that on a free account, so keep the take inside that window.
- Upload/"Add context" is not part of this demo; nothing depends on it.
- One engineering run executes at a time across the whole deployment.

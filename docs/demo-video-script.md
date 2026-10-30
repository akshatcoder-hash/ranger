# Ranger demo, script v3

**Runtime:** 2:30 at a normal read, 2:39 if you slow down. The 2:30 cap is not a hard rule, but this reads tight.
**Voice:** you, close to the mic, no announcer cadence.
**Visual rule:** the app is the only set. No stock footage, no logo intro, no music under the first line.
**Goal:** get Scott to watch the run, then take the meeting. This is a job video that happens to be a product demo.

## Ready to record (VM checked 2026-10-22, after a full dry run)

**Why the app looked broken.** Your open tab predates the deploy and is still running the old bundle — that is the only place "Message saved. Start a call…" still exists. Hard refresh (Cmd+Shift+R) or open a fresh window; the live build queues a real text turn, no call needed. "Add context" selecting a file without uploading it is by design; those files never leave the browser.

**Why the upload failed.** The GTK file dialog opens taller than the 1280x800 VM screen, so its **Open** button sits off-screen. A background watcher now shrinks that dialog as it opens. The CSVs are staged in `/tmp` and `~/Desktop` inside the VM.

Run this from the repo root before every take:

```bash
node .fly-build/demo-warm.mjs     # ends with READY TO RECORD
```

It re-applies the four fixes (pnpm shim, Playwright→system Chromium, dialog watcher, CSV staging), starts Vite if it died, warms Trace, and checks the cgroup limits `pnpm test` needs. Verified state: VM running, 272 files, 0 plans, 0 runs, index ready, Vite on `127.0.0.1:4173/tasks`, Trace warm at 133 ms for 10 results, and `pnpm lint` / `pnpm build` / `pnpm test` green inside the VM (130 tests, 22 s). Upload verified end to end: Import → Choose File → `/tmp/tickets.csv` → Open → toast reads `tickets.csv`, 741, `text/csv`.

**The run beat is rehearsed, and it is the flaky part.** A full dry run on 2026-10-22 reached `succeeded`: the agent created `src/features/tasks/lib/escalations.ts` and its test, edited the import dialog, and `pnpm test` exited 0 five times. Timings: plan drafted ~8 s after the draft message, approval instant, run 2–2.5 min. But six attempts also produced three distinct failures (plan-draft conflict once, a transient Instabox fetch error, and two runs that ended with a failing check because the model stopped early). **Every failed run destroys the VM** — that is by design, and recovery is one scripted command (~6 min):

```bash
bash /tmp/recover2.sh      # prep + egress exception + cgroup bump + deps + demo-warm, ends READY TO RECORD
```

It uses `/tmp/prep.mjs`, `/tmp/bump.mjs`, `/tmp/install3.mjs` and `scripts/demo-registry-egress.mjs`. If a take fails, stop recording, run it, then retake only the run beat.

**To raise the odds of a green run, type the file paths in the task.** With the bare task string the plan's scope is one file, so the agent works inside the dialog and can only add a test next to it. With one extra sentence it plans three files and has room to finish:

> … Put the parsing, join and escalation logic in a new file `src/features/tasks/lib/escalations.ts`, add its unit tests in `src/features/tasks/lib/escalations.test.ts`, and keep the UI change in the import dialog.

If the plan comes back with a scope that omits the test file, send `Draft a plan.` again before approving — a fresh draft picks up earlier plan context.


## The line

Show the problem. Build the fix.

The video makes one argument in two halves. An agent needs two kinds of context: what the customer meant, and where the code lives. Ranger gets both, because it starts in the conversation and carries a real code index. That is the forward-deployed job: in the room when the requirement is made, then shipping the fix with the agent.

## Script

### 0:00 - 0:16 | The dead button

**Visual:** shadcn-admin, Tasks page, captured locally at 1080p from the pinned commit. Click **Import**. Choose `tickets.csv`. The toast reads **You have imported the following file:** with the name, size and type. Hold on it for two beats.

> Every coding agent gets a summary.
>
> The customer said one sentence. Someone wrote a ticket. Someone wrote a spec that said add an import dialog. This is what shipped: it reads the file name and nothing else.
>
> Ranger starts where that sentence still exists.

### 0:16 - 0:26 | The claim

**Visual:** cut to Ranger. Workspace ready, repository attached. Project card reads **272 indexed files** and **Index time 1m 03s**.

> Ranger is a forward-deployed engineer. Show the problem. Build the fix.
>
> Three things make that work: it hears the problem, it finds the code, it proves the change.

### 0:26 - 1:10 | Find the code

**Visual:** start the call. Ask the question. Let the answer land. It should cite `tasks-import-dialog.tsx` with line ranges. Cut to the Project card and hold long enough to read it: **Trace search 38.6 ms**, **Retrieved results 2**, **272** files, **1m 03s**. During the comparison, cut between the answer, the cited file and the card, and put a lower third on the last line: **2 to 7 ms, 186,294 chunks**. Do not sit on one frame for the full 44 seconds.

> First question: where does this Import button live, and what does it do?
>
> Trace found it in thirty-eight milliseconds. Two files, exact lines, and a citation the agent can verify.
>
> The answer: the dialog validates the file type and stops. The Import button is a prop.
>
> That speed is the argument, and it buys exactly one lap. Your team built SWE-grep because agentic search burns minutes; in your eval frontier models take 36 to 290 seconds for one retrieval, SWE-grep does it in under three. But search is the first step, not the job. Jia Wu's point is that writing the code is twenty percent, and testing, review and keeping the change deployable are the other eighty. Ranger owns that whole loop, not just the lookup.
>
> Trace is a deterministic symbol index. Identifier queries on 186,000 chunks come back in single-digit milliseconds. The agent starts with the exact context and goes straight to editing.

### 1:10 - 1:36 | The plan

**Visual:** type the task. Speed up the typing, do not make the viewer read the whole prompt. Send **Draft a plan**. The plan dialog opens. Hold on the steps, then the scope, then **Approve plan**.

> So I give it the rule. Join the ticket export to the CRM export by email. Flag enterprise tickets open more than 24 hours. Sort by priority, then age. Don't touch auth or routing.
>
> It writes the plan: files, tests, criteria, scope. The scope is a whitelist. Neither is on it.
>
> The plan is the requirement as an artifact: the steps, the tests, the files it may touch. Jia calls the customer's real problem the highest-fidelity eval set. This is what that eval looks like before the agent writes anything.
>
> I approve this version. If the plan changes, the approval is stale. Approving doesn't start work, either. I have to say start.

### 1:36 - 1:49 | The work

**Visual:** send **Start the approved work.** Live activity shows commands starting and finishing. Cut to the VM: files changing, the test command, exit 0. Two seconds of silence on the diff in the Changes tab.

> Now it works, on a real checkout inside a Linux VM. It writes the unit tests nobody on this team was going to write, runs them, and reports the exit codes.
>
> A failing test can't be talked away in the final message.

### 1:49 - 2:07 | The result

**Visual:** the app inside the VM at 125 percent. Import `tickets.csv`, then `customers.csv`. The escalation queue appears. Hold on the summary line, then scroll the table slowly.

> Two exports in. Seven tickets, six matched, one with no customer, three escalated.
>
> Urgent first, then age. The 72-hour ticket is third because priority beats age. The ticket that has been open exactly 24 hours is not on the list, because the rule says older than 24.
>
> The edges are right.

### 2:07 - 2:14 | The loop

**Visual:** pull back to the workspace. One slow pan across the conversation, the plan card, the Project card. No cuts.

> Hear it, find it, prove it. That's the loop.
>
> Most agent failures I've seen aren't writing failures. They're finding failures.

### 2:14 - 2:30 | Close

**Visual:** end card. Ranger mark, your name, **Show the problem. Build the fix.** and `ranger.akshats.xyz`. Optional: two seconds of you, name lower third.

> Show it the problem, and it builds the fix.
>
> I'm Akshat. That overlap between what the product can do and what the customer actually needs is the job I want. If Cognition is hiring forward-deployed engineers for Devin, I'd like to talk.

## 30-second cut

For the DM. This one ends on the job ask, so it works even if he never opens the full video.

| Time | Visual | Voice |
| --- | --- | --- |
| 0:00 | Import toast | Every coding agent gets a summary. Ranger starts before the summary. |
| 0:05 | The dead dialog | This button is supposed to import support tickets. It reads the file name and stops. |
| 0:11 | Trace card, 38.6 ms | Trace finds the file and the lines in 38 milliseconds. |
| 0:16 | Trace index / terminal | Your team built SWE-grep to fix the search loop. Trace gets a cited answer in single-digit milliseconds, so the agent can spend its time on the other eighty percent: the tests, the review, the deploy. |
| 0:24 | Escalation queue | Two exports in. A working escalation queue out. |
| 0:28 | End card | Show the problem. Build the fix. I'd like to do this at Cognition. |

## Alternate hook, if you want to address him directly

> Scott, your agent can fix a bug in a repo it has never seen. It still can't sit in the room where the bug gets described. That room is where the requirement is made. Ranger is built for that room.

Use this only if the video is sent one to one. It is more personal and slightly more presumptuous. The dead-button version works in any context.

## Why this version cuts better

The old script opened with a claim, "customers don't hand you specs," and then spent the first ten seconds telling Scott something instead of showing him something. The new opening shows the loss instead: a customer sentence turns into a spec, the spec turns into a button that reads a file name. Scott sees the gap before he sees Ranger, which is the order that makes the product feel like an answer rather than a pitch.

Trace moved from a footnote after the plan to the first real proof, and it now carries the argument that matters to Cognition. SWE-grep is the right fix for the search loop. Trace is a different bet: a deterministic symbol index that hands the agent exact context in one call. Saying that out loud, with their own eval numbers, is the part that makes this a job video and not a product demo.

The long requirement list is no longer read aloud. The voiceover states the human rule and the plan carries the detail. Reading a spec into a microphone is the fastest way to make a demo feel like a test suite.

The approval beat says why it matters. The plan binds a version and a file scope, and approval does not start work. That is the part a founder who ships agents will notice.

The close asks for the job in one sentence. It does not recap the demo, and it does not hide behind "would love to chat."

## Fact check before you record

The old line "twenty-millisecond median retrieval on our TypeScript benchmark" is not supported by any recorded run, and it is the one sentence in the old draft that would invite a fight.

- The live demo samples are **38.6 ms**, **39.6 ms**, and **32.2 ms** for Trace search, with 2 retrieved results over 272 indexed files. The Project card shows the last search with one decimal.
- The Cognition SWE-grep eval table records **SWE-grep at 2.79 s** and **SWE-grep-mini at 1.82 s**. Frontier models in that table run from **36.90 s** (Sonnet 4.5 non-thinking) to **290.63 s** (GPT-5 High), with Claude Code at **91 to 162 s** in their end-to-end Q&A chart.
- That is why the script says "36 to 290 seconds" and "under three", not "90 to 140" and "1.8". The 1.8 is SWE-grep-mini, and 90 to 140 covers only the Claude Code bars. Quoting Scott's own numbers back to him with the wrong label is the one unforced error here.
- The Trace benchmark records **2 ms** median for lexical and **7 ms** for hybrid retrieval on identifier-shaped queries over a 186,294-chunk VS Code index, and **16 ms** median for the vector channel on a 14,281-chunk embedded subset. Single-digit milliseconds is the safe, exact claim for identifier queries.
- The 52,325-file TypeScript tree was **indexed**, but its retrieval latency was never measured. Do not say "sub-20 ms across 52k files". If you want the scale line, say "52,000 files indexed in under five minutes", and keep the retrieval number on the 186,000-chunk tree.
- Do not claim an agent-level speedup from Trace. The repo's own results show no correctness difference at full-tree scale. The demo claim is the loop and the latency, both visible.
- Say "this Tasks page" or "this admin app," not "this dashboard."
- Read the number on the card. If it says 42.1 ms, say forty-two. The script says thirty-eight because that is the recorded sample.
- The real task rule is strictly more than 24 hours, so the exactly-24-hour ticket is excluded. The sort is priority first, then hours open descending. Keep those exact, because they are the proof that the logic is real.

## Recording checklist

1. **Dry run the whole thing once.** The shadcn-admin coding run has not been rehearsed end to end. Treat the first run as rehearsal, not as take one.
2. **Warm everything before rolling.** The VM, the index, and the model. The first search after a deploy took about ten seconds; every warm search after that was tens of milliseconds. Do not film the indexing. The card should already read **Ready** with **1m 03s**.
3. **Capture the hook locally.** Run the pinned shadcn-admin commit on your Mac at 1080p so the toast and the dialog are crisp. Capture the result inside the VM at 125 percent browser zoom, then crop tight on the queue.
4. **Record the voiceover after the cut.** Do not narrate live. You will get a cleaner read and you can keep the video tight.
5. **Say the SWE-grep line slowly.** It is the line he will replay. "Your team" and "in your eval" are doing the work; do not rush them.
6. **If the call is flaky, type the first question.** Cut the waveform shots. Every line in this script still works over text.
7. **Restart the dev server after the run if the new table needs it.** Do it in the VM terminal on camera. It is real work, not a trick.
8. **Keep shared demo access on until Scott has tried it, then turn it off.** While `RANGER_DEMO_PROJECT_ID` is enabled, anyone with the link can control that VM and spend provider credits. Send the video privately, do not post the URL.

## Framing for Cognition (Jia Wu, FDE)

Jia Wu's talk is the best public description of the job this video is applying for, so the script borrows his vocabulary instead of arguing with his product. Five things from the talk map onto the demo:

| What Jia says | What the demo shows |
| --- | --- |
| The FDE maximizes the overlap between what the product can do and the customer's unsolved problem | The requirement arrives in the conversation, the plan turns it into files and tests, the run ships the fix |
| Coding is 20%; testing, review/deploy and maintain are the 80% | The run writes the unit tests, runs them, and the exit code is the receipt |
| The customer's real codebase is the highest-fidelity eval set | Each plan binds a version and a file scope; approval is explicit and expiryable |
| Outcome over token spend (150% capacity, 82% faster delivery) | A 2.5-minute run that ends in a green test suite, not a token bill |
| The FDE is "the expert in the room" and relays the field back to product | The plan card is the artifact you would paste into the customer's ticket |

**Do not fake their scale.** A COBOL/JCL migration is the right *reference* in conversation, not something to stage in a two-minute video. The demo's small repo is fine because the claim is the loop, not the file count — say "same loop, any repo" once, and leave it there.

**Task wording.** Keep the requirement as it is, including the file paths. It already has the edge cases that prove the logic (strictly-greater-than-24-hours, quoted commas, priority-over-age sort). If you want one more line that lands with an enterprise audience, add: `Wrong counts are worse than a crash here: the summary line is audited.` That is the kind of sentence an FDE hears in the room, and it explains why the tests matter.

**What to change in the voiceover if you only change three things:** drop "I wanted to remove it entirely" (it reads as arguing with SWE-grep), say the twenty/eighty line at the plan beat, and close on "overlap" rather than on "in the room". All three are already edited into the script above.

**Send note to Cognition instead of a cold DM:**

> Scott — I watched Jia Wu's talk on how Cognition does forward-deployed engineering. The overlap he describes is the part I care about: sitting where the requirement gets made, then carrying it all the way to a verified change. I built Ranger to do that end to end. Two minutes, a real Linux VM, a real run: the agent plans, takes a file scope, writes the tests, and the exit code is the proof. I'd like to do that at Cognition. It's live at ranger.akshats.xyz if you want to break it.

## Send note

> Scott, I built Ranger: a forward-deployed engineer that joins the conversation where the requirement is made, then ships the fix in a real VM. Two minutes, real run, real code.
>
> The technical bet is in the video: SWE-grep fixes the retrieval loop, Trace removes it. I'd like to do this work at Cognition.
>
> It's live at ranger.akshats.xyz if you want to break it.

## Strings to type on camera

Question:

```text
Where is the Import button implemented, and what does it currently do?
```

Task:

```text
In this shadcn-admin app, the Tasks page "Import" dialog only shows the CSV filename in a toast. Make it do real work for our support team: the user uploads a ticket export CSV (ticket_id, subject, requester_email, status, priority, created_at) and a CRM customers CSV (email, company, tier, account_owner). Join tickets to customers by requester_email (case-insensitive, trimmed). Flag a ticket for escalation when the customer tier is "enterprise" and the ticket has been open strictly more than 24 hours as of 2026-03-10T12:00:00Z (use a fixed as-of constant, overridable, so output is deterministic). Show an "Escalation queue" table sorted by ticket priority (urgent, high, normal, low) then hours open descending, with ticket id, subject, company, priority and hours open, plus a summary line "N tickets, M matched, U unmatched, E escalated". Parse CSV properly (quoted fields with commas). Put the parsing, join and escalation logic in a new file `src/features/tasks/lib/escalations.ts`, add its unit tests in `src/features/tasks/lib/escalations.test.ts`, and keep the UI change in the import dialog. Do not touch auth, routing or unrelated features. `pnpm lint`, `pnpm build` and `pnpm test` must pass.
```

Plan authorization:

```text
Draft a plan.
```

Start:

```text
Start the approved work.
```

## Teleprompter, voice only

Every coding agent gets a summary.
The customer said one sentence. Someone wrote a ticket. Someone wrote a spec that said add an import dialog. This is what shipped: it reads the file name and nothing else.
Ranger starts where that sentence still exists.

Ranger is a forward-deployed engineer. Show the problem. Build the fix.
Three things make that work: it hears the problem, it finds the code, it proves the change.

First question: where does this Import button live, and what does it do?
Trace found it in thirty-eight milliseconds. Two files, exact lines, and a citation the agent can verify.
The answer: the dialog validates the file type and stops. The Import button is a prop.
That speed is the argument, and it buys exactly one lap. Your team built SWE-grep because agentic search burns minutes; in your eval frontier models take 36 to 290 seconds for one retrieval, SWE-grep does it in under three. But search is the first step, not the job. Jia Wu's point is that writing the code is twenty percent, and testing, review and keeping the change deployable are the other eighty. Ranger owns that whole loop, not just the lookup.
Trace is a deterministic symbol index. Identifier queries on 186,000 chunks come back in single-digit milliseconds. The agent starts with the exact context and goes straight to editing.

So I give it the rule. Join the ticket export to the CRM export by email. Flag enterprise tickets open more than 24 hours. Sort by priority, then age. Don't touch auth or routing.
It writes the plan: files, tests, criteria, scope. The scope is a whitelist. Neither is on it.
I approve this version. If the plan changes, the approval is stale. Approving doesn't start work, either. I have to say start.

Now it works, on a real checkout inside a Linux VM. It edits, runs the checks it wrote, and reports the exit codes.
A failing test can't be talked away in the final message.

Two exports in. Seven tickets, six matched, one with no customer, three escalated.
Urgent first, then age. The 72-hour ticket is third because priority beats age. The ticket that has been open exactly 24 hours is not on the list, because the rule says older than 24.
The edges are right.

Hear it, find it, prove it. That's the loop.
Most agent failures I've seen aren't writing failures. They're finding failures.

Show it the problem, and it builds the fix.
I'm Akshat. This is the job I want: in the room when the requirement is made, then shipping the fix with the agent. If Cognition is hiring forward-deployed engineers for Devin, I'd like to talk.

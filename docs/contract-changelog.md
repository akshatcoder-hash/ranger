# Contract changelog

All published frontend-contract versions, newest first. The contract version
served in `/v1/capabilities` (`contractVersion`) must always appear here.

## v1 — 2026-10-18

### v1 amendment — initial source materialization before run create (2026-10-18)

The contract version stays v1. No route, schema or event changes. Public
behavior of an approved run start:

- A connected approved-root local repository is materialized into the
  project's persisted source at its RECORDED commit BEFORE any VM create.
  The bridge uses the existing hardened read-only git inspection only;
  symlink and submodule entries are refused, and the existing file-count
  and per-file guest-transport bounds apply. The persisted initial base is
  verified by byte readback and marked with the `initial_checkout` origin,
  semantically distinct from `guest_edit` files (which are still saved only
  after the guest write succeeded).
- Generated saved source from earlier runs is never overwritten by a later
  re-read of the repository.
- When the initial source cannot materialize (a remote or reference-only
  repository record, or a changed/unreadable checkout), the run fails
  explicitly with failure code `initial_source_unmaterializable` BEFORE any
  VM create. It never silently boots an empty repository.

### v1 amendment — real Trace retrieval routes implemented (2026-10-18)

The contract version stays v1. The previously declared retrieval family is
now implemented over the real pinned Trace sibling:

- `retrievalStatus`, `reindexRetrieval` and `retrievalSearch` serve per
  project membership. Every project has its own source mirror and index;
  retrieval never returns another project's content.
- Search responses carry `provider` — `trace` for real Trace results or
  `file-search-fallback` for content Trace cannot index. The fallback label
  is always visible; a fallback result is never attributed to Trace.
- Trace's supported languages are TypeScript, TSX, JavaScript, JSX and JSON
  (reported by `retrievalStatus.languages`). Unsupported or unindexed
  sources (for example Python or Markdown) are served through the labeled
  file-search fallback.
- Citations carry file path, 1-based inclusive line range, snapshot id,
  commit, branch, dirty flag, content hash and score. Every citation is
  re-verified against the current saved source before it is served: a hash
  mismatch is stale, is dropped, and is counted in `staleDropped` — stale
  citations are never served. `verbatim` is false for structurally
  synthesized snippets; `uncertain` marks low-confidence relationships or
  non-verbatim snippets. Vector similarity alone is not presented as proof
  of relevance: identifier-shaped queries only serve results that mention
  the identifier.
- When the Trace runtime is unavailable, retrieval fails with an explicit
  `not_configured` error (`trace_unavailable`); it is never silently
  substituted. Reindexing is serialized (one indexing job at a time) and
  restarts the MCP runtime, so citations after a reindex carry a fresh
  snapshot id.

### v1 amendment — Instabox workspace and rejected deferred lifecycle (2026-10-18)

The contract version stays v1. Public behavior changes:

- Workspace create, destroy and screenshot are supported operations. The
  sandbox id is resolved server-side. A client-supplied sandbox id is
  `validation_failed`, not adopted.
- Capabilities no longer advertise a container/trusted-fixture adapter.
  Instabox is the only execution adapter, kind `vm`.
- `pauseRun` and `resumeRun` remain declared only so clients get an explicit
  `unsupported_operation` rejection. That rejection is not a successful pause
  or resume. There is no restart operation.
- Desktop and preview session routes are implemented. Provider stream URLs
  and SSH certificates stay server-side. The preview gateway is a separate
  origin and rejects arbitrary targets.

### v1 amendment — secret-safe request logs and browser-session request shape (2026-10-18)

Documentation and logging corrections; the contract version stays v1. No
new revocation policy.

- Request logs redact connection-ticket query values on WebSocket upgrades
  (accepted and rejected) while keeping method, path and non-secret query
  parameters. The shared logger also redacts top-level `path` and `url`
  fields, so a ticketed upgrade to an ordinary HTTP route (logged by the
  websocket plugin as `{ path: rawUrl }`, outside the request serializer)
  keeps the plugin diagnostic and the path, with the ticket value replaced.
  Unknown-route and preview error payloads do not echo a `ticket` query.
  Header redaction is unchanged.
- `createBrowserSession` already requires principal authentication (bearer
  or an existing session cookie) in addition to the body `apiToken`. The
  guide and operation summary now say so. A browser session remains an
  independent credential: revoking the API token that was presented in
  `apiToken` does not revoke sessions already created from it. Each session
  is revoked with `revokeBrowserSession`.

### v1 amendment — linked-worktree commondir refusal (2026-10-18)

Local snapshot inspection refuses one more unsupported repository form; the
contract version stays v1 and the public error code is unchanged.

- A real `.git` directory that contains a `commondir` entry (file, symlink,
  or any other form) is refused with `validation_failed` / details reason
  `local_path_not_approved` BEFORE any git command runs. Git would otherwise
  read refs, objects, config and `info/attributes` from the named common
  directory, including an outside HEAD and a common-dir clean filter. This
  matches the already-unsupported gitfile and symlinked-`.git` forms. A
  normal approved fixture with no `commondir` entry still resolves commit,
  dirty flag and content hash. `.git/objects/info/alternates` is not part of
  this refusal.

### v1 amendment — event stream midstream revocation and slow-consumer close alignment (2026-10-18)

Security and documentation corrections for the events subscription; the
contract version stays v1. Public behavior changes:

- **Midstream authorization re-validation**: the events subscription now
  re-validates its authorization before EVERY delivered batch (replay page
  or live tick), not only at upgrade. The consumed ticket's retained
  issuing-credential binding (which API token or browser session authorized
  the connection) must still be alive, and the principal must still be a
  project member. Removing a member, revoking the issuing API token, or
  revoking/expiring the issuing browser session closes the stream `4401`
  unauthorized with ONE `kind:"error"` frame (details reason
  `membership_removed`, `issuer_revoked` or `issuer_expired`) before any
  later project payload is delivered. The ticket itself stays single-use
  and is consumed exactly once at upgrade; repeated delivery never
  re-consumes it. Still-authorized subscribers keep receiving ordered
  replay and live events with no duplicates.
- **4502 slow_consumer close is frame-less (documentation now matches the
  wire)**: the slow_consumer close carries the close code/reason ONLY — no
  error frame is sent. By definition the outbound buffer is already
  saturated past its bound, so the server never enqueues additional data
  (including error frames) onto that socket; the close code itself is the
  documented signal and clients recover by reconnecting with their cursor.
  Rejection closes `4401`/`4400`/`4410` still send exactly one error frame
  first (those sockets are not saturated). The behavior is pinned by a
  deterministic pump test seam (fake sockets over a real event history),
  not by TCP overload stress.

### v1 amendment — identity and repository boundary fixes (2026-10-18)

Security-boundary corrections from foundation scrutiny; the contract version
stays v1. Public behavior changes:

- **Repository URLs reject ALL credential material**: any userinfo on an
  `https` URL — including the username-only (`https://<token>@host/...`) and
  percent-encoded token forms — and any password on `ssh`/`git` URLs are
  rejected with `validation_failed` (details reason `credentials_in_url`)
  BEFORE persistence, events or error responses; rejected URLs are never
  echoed. Ordinary plain SSH usernames (`ssh://git@host/...`) remain usable.
- **Local snapshot inspection is operator-approval-gated**: `file://` and
  absolute-path repository URLs are inspected (read-only git) only under
  `RANGER_APPROVED_SNAPSHOT_ROOTS` (or the config-file
  `approvedSnapshotRoots`); unapproved paths answer `validation_failed`
  with details reason `local_path_not_approved` before any filesystem
  probing. The `.git` entry must be a real directory: gitfile (`gitdir:`),
  symlinked `.git`, and any `.git/commondir` entry are refused as
  unsupported forms before a git command runs, effective
  git dir/worktree are verified canonically inside the approved root, and
  repo-local `core.worktree` redirection answers `repository_redirect`.
  Nonempty or symlinked `.git/info/attributes` answers `attributes_rejected`
  (that source is not suppressible by `--attr-source`). Inspection never
  executes repository-configured helpers: attribute filters are neutralized
  from every source (`--attr-source=<empty tree>`,
  `core.attributesFile=/dev/null`, `GIT_ATTR_NOSYSTEM=1`) on top of
  fsmonitor/hook hardening, no repository locks are taken, global/system git
  config is ignored, and ambient `GIT_*` environment variables are stripped.
  Content hashing hashes symlinks by link text and never reads out-of-root
  target bytes. Remote references persist without host inspection as before.
- **Idempotency is principal-scoped**: the `Idempotency-Key` scope now binds
  the authenticated principal in addition to operation and project, so
  identical createProject requests (same key, same body) from two principals
  are independent authorized executions instead of replaying one principal's
  stored payload to the other. Same-principal retries replay exactly as
  before; conflicting reuse within one principal still returns `conflict`.
- **Bootstrap failure semantics**: the credential file is written before any
  database row, so a file collision or write failure leaves retryable state
  with no orphaned credential row and never overwrites an existing
  credential file.
- Project-existence responses are intentionally distinguishable (missing
  project → `404 not_found`; existing project without membership → `403
  forbidden`); misleading comments claiming existence indistinguishability
  were corrected without changing that policy.

## v1 — 2026-10-18 (initial publication)

Initial publication of the Ranger v1 contract.

- **OpenAPI 3.1** document generated from the single route registry
  (`src/contracts/registry.ts`); served at `/v1/openapi.json` and checked in
  at `contracts/openapi.json`. 82 declared operations across the 13 approved
  route families.
- **Realtime event schemas** (`contracts/events/project-event.schema.json`):
  every project event carries `schemaVersion` (1), `eventId`, `projectId`,
  nullable `runId`/`sessionId`, `timestamp`, per-project `sequence`,
  `requestId`, `type` and `data`. 30 event types enumerated with permissive
  `data` payloads to be tightened by the features that implement them.
- **Typed client** generated from the same registry
  (`src/clients/ranger-client.ts`): one method per operation, generated
  request/path/query types, mapped response types, `RangerApiError` carrying
  the stable code and requestId, WebSocket openers for the three declared
  realtime routes (project events subscription, voice relay, desktop stream).
- **Error envelope**: every failure returns
  `{ requestId, error: { code, message, details? } }`; every success echoes
  `requestId` in the body and the `x-request-id` header. Stable codes
  published in v1: `validation_failed`, `unauthorized`, `forbidden`,
  `not_found`, `conflict`, `rate_limited`, `budget_exceeded`,
  `not_configured`, `invalid_cursor`, `cursor_expired`, `internal_error`.
- **Idempotency contract**: mutating routes accept the scoped
  `Idempotency-Key` header (documented per operation; enforcement with
  stored-result replay lands with the conversations/events feature).
- **Skeleton semantics**: unimplemented providers return `501 not_configured`
  with the operation id; they never return fake success. Declared WebSocket
  routes close with code `4501 not_configured` until their feature lands.
- **Capabilities** report honest provider configuration (xAI/Instabox key
  presence from the protected secret file, Trace bootstrap state), adapter
  kinds (`vm` / `container`), the disabled Atom/Orbit grounding seam and the
  documented limits.

### Reserved semantics (documented now, implemented by their features)

- `invalid_cursor` / `cursor_expired`: implemented for event subscription
  and HTTP replay (see the conversations/events amendment); reserved for the
  voice session reconnect path until the interaction milestone.
- `budget_exceeded`: xAI $5 total / $4 soft admission stop and the Instabox
  cumulative nine-creation allowance (six historical creations preserved,
  three sequential windows newly authorized), enforced by the shared ledger
  (`src/budget/ledger.ts`) before any paid call.

### v1 amendment — conversations, transactional events and realtime subscription (2026-10-18)

The contract version stays v1 (additive tightening); these families now
return real behavior instead of `not_configured`:

- **conversations-requirements**: conversations, messages, clarification
  questions and answers persist per project and survive API restarts; every
  answer references the exact question it answers; message lists paginate
  with a stable per-conversation order. Requirement and decision threads are
  append-only versioned — `createRequirementVersion`/`createDecisionVersion`
  accept an optional `requirementId`/`decisionId` to append the next
  immutable version (new schema fields; thread creation unchanged when
  omitted). Prior versions stay readable and are never mutated in place.
- **Transactional events**: a central event append (`src/events/store.ts`)
  is the only writer of project events. It allocates the per-project
  sequence and validates the `data` payload against the type's declared
  schema INSIDE the caller's transaction, so state mutation and event commit
  or roll back atomically — committed sequences are dense and replay never
  observes a half-applied mutation. Data schemas for `project.updated`,
  `membership.updated`, `repository.connected`, `conversation.created`,
  `conversation.message.created`, `conversation.question.created`,
  `conversation.answer.created`, `requirement.version.created` and
  `decision.version.created` are now enforced (tightened from generic
  objects); the other declared types keep permissive data payloads until
  their features land.
- **Existing mutations emit events**: `updateProject` appends
  `project.updated` (carrying the new name and engineer display name),
  `addMembership`/`removeMembership` append `membership.updated` (role is
  null on removal; no event for an identical re-add), and
  `connectRepository` appends `repository.connected` — each in the same
  transaction as the mutation. Members see the engineer name through public
  replay and live events.
- **HTTP replay** (`replayProjectEvents`): member-authenticated cursor
  replay with `limit` (1–500, default 100); responses carry ordered events,
  `nextCursor` and `hasMore`. Replay is a pure read — it invokes no tools
  and changes no state.
- **WebSocket subscription** (`subscribeProjectEvents`) replaces the 4501
  fallback for this route: the upgrade consumes a single-use `events`
  connection ticket bound to purpose, the path projectId and the upgrade
  Origin (origin-bound tickets refuse upgrades without a matching Origin),
  and enforces CURRENT membership before any delivery. Delivery is ordered
  by the persisted sequence with no gaps or duplicates; a reconnect with the
  last cursor replays exactly the missed events. Documented close codes:
  `4401` unauthorized (missing/invalid/reused/expired ticket, purpose,
  project or origin mismatch, non-membership — one `kind:"error"` frame is
  sent before closing), `4400` invalid_cursor, `4410` cursor_expired and
  `4502` slow_consumer (the outbound buffer exceeded its bound; clients
  recover by reconnecting with their cursor). Other declared realtime
  routes still close `4501 not_configured` until their features land.
- **Cursor policy**: cursors are opaque; malformed or ahead-of-history
  cursors answer `invalid_cursor` (400) rather than silently resyncing, and
  cursors older than the replay window answer `cursor_expired` (410) —
  recover by resubscribing without a cursor. The window defaults to 30 days
  and can only be lowered via `limits.eventReplayWindowMs` in the config
  file.
- **Scoped mutation idempotency**: mutating routes accept the
  `Idempotency-Key` header. The first execution stores its successful
  response in the same transaction as the mutation and its events;
  identical retries replay the stored result with no second side effect or
  duplicate event; reuse with different input returns `conflict`
  (`details.reason: idempotency_key_reuse`). Implemented for
  createProject/updateProject/addMembership/removeMembership/
  connectRepository and all conversations-requirements mutations.

### v1 amendment — identity, projects and repositories (2026-10-18)

The contract version stays v1 (additive tightening before any consumer);
these families now return real behavior instead of `not_configured`:

- **credentials-sessions**: bootstrap CLI (`scripts/bootstrap.ts`) creates
  the initial principal plus a mode-0600 credential file outside the
  repository (secrets never logged or echoed); only sha256 lookup keys and
  scrypt hashes reach the database. `createApiToken` returns its secret
  exactly once; `revokeApiToken`/`revokeBrowserSession` make the next use
  fail with the standard `unauthorized` envelope while other principals keep
  working; browser sessions survive API restarts until revoked.
  `createBrowserSession` now also returns `csrfToken` (once-only
  synchronizer token for cookie-authenticated mutations).
- **Cookie CSRF/origin protection**: cookie-authenticated mutations require
  a same-origin `Origin` header or the `x-ranger-csrf` synchronizer token;
  violations return `forbidden` with details reason `origin_mismatch` or
  `csrf_required`. Bearer authentication skips the check.
- **connection tickets**: single-use, 60-second tickets bound to principal,
  project, purpose and optional origin; reuse, expiry, purpose/project/origin
  mismatch and revocation of the issuing credential or session all fail with
  `unauthorized` and a stable reason in `details`.
- **projects-memberships**: project CRUD with the customer-configurable
  engineer display name; creators become owners; owners manage projects;
  members read; non-members get `forbidden`; the last owner cannot be
  removed (`conflict`). Names persist across restarts.
- **repositories**: `connectRepository` persists the approved URL/ref,
  checkout path and a new `checkoutPolicy` (`shallow`, `submodules`) and
  rejects credential-bearing URLs, unapproved schemes, bad refs and path
  traversal with `validation_failed`. Local `file://` repositories resolve
  the real commit, dirty flag (including untracked files) and a
  deterministic content hash at connect time; everything persists across
  restarts and stays private to the project.

### v1 amendment — approved run workflow: plans, exact-version approvals and durable runs (2026-10-18)

The contract version stays v1 (additive tightening before any consumer).
Plans/approvals and runs now deliver real behavior on top of the persisted
conversation, requirement and event records — no orchestration framework,
only SQLite state, transactional events, the durable job loop and the real
xAI/Trace/Instabox tool loop:

- **clarification + plan generation (`generateClarification`, `generatePlan`)**:
  the configured xAI model produces bounded clarifying questions and the next
  concrete plan version (items, acceptance criteria, permitted sandbox scope;
  for revisions `impactedPaths`/`impactedTests`). The paid dial happens
  OUTSIDE any transaction, is budgeted against the shared ledger (reserve
  before dial, settle exactly once with observed usage, never retried) and is
  idempotent per scoped key: an exact retry replays the stored response with
  no second dial. Unconfigured providers return the explicit capability
  error. Conversation/repository content is untrusted data: planning
  instructions state that no content text can widen scope or lift policy.
- **plan versions and exact-version approvals**: new versions are immutable
  and supersede prior ones; creating a revision invalidates prior approvals
  and records `plan.approval.invalidated` naming the impacted files and
  tests. `approvePlan` approves one exact version with a scope that must be a
  subset of the plan's proposal against the safe scope grammar
  (`edit:<relative-prefix>`, `command`, `launch`, `evidence`); prohibited
  categories (deployment, purchases, access expansion, external
  communication, destructive actions) are rejected at plan AND approval time,
  so no persisted record or approval route can enable them.
- **run start (`startRun`)**: validates the persisted exact-version approval,
  allows one active run at a time and enqueues ONE durable job, returning
  promptly. Idempotent retries replay the stored run with no duplicate run,
  job or provider work. There are no pause/resume claims: those operations
  stay `unsupported_operation`.
- **run execution**: the worker executes the run outside any API request on
  one ephemeral Instabox VM seeded with the previous run's saved source. The
  mandatory injected checker re-verifies project binding, run state, cancel
  flag, approval validity, exact plan version and scope before EVERY tool
  execution; out-of-scope attempts emit `run.scope.violation` with no side
  effect and prohibited commands are refused even when command scope was
  granted. Usage settles against the budget ledger; per-tool outcomes and
  `run.tool.progress` events persist transactionally as they happen.
- **cancellation**: the durable cancel flag commits first (the checker stops
  tool work at the next check), then real command descendants are TERM/KILLed
  through the workspace terminate primitive. The worker confirms the
  `cancelled` state. Cancelling a terminal run is truthful and effectless.
- **interruption**: the reconciliation controller (worker startup + sweep)
  fails runs whose claim lease expired with
  `control_worker_lease_expired`, terminates their running commands, destroys
  their recorded workspaces (releasing the creation budget) and resolves
  uncertain workspace creates; it NEVER resumes model/tool work or retries.
  A stale worker completion is rejected by fencing (`completeRunFromWorker`
  binds worker id + claim epoch). Durable tool records are kept as evidence.
- **durable records + public reads**: runs (with failure code/message,
  observed usage, turns, start/finish timestamps) and per-tool outcomes
  survive restarts; `listRunTools`, `listTestResults` (real exit codes) and
  `listQuestions` (questions with their answers) are authorized public reads.
- **repository disconnect**: `disconnectRepository` is now scoped-idempotent
  and commits the removal and its `repository.disconnected` event atomically;
  disconnecting twice records the event exactly once.
- **event schema tightening**: `plan.version.created`,
  `plan.approval.granted`, `plan.approval.invalidated`, `run.state.changed`,
  `run.tool.progress` and `run.scope.violation` now declare full data
  schemas; `repository.disconnected` is added. Run state enumerations drop
  `paused`.

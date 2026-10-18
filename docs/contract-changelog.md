# Contract changelog

All published frontend-contract versions, newest first. The contract version
served in `/v1/capabilities` (`contractVersion`) must always appear here.

## v1 — 2026-10-18

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
  probing. Checks are realpath/symlink-safe (symlinked worktrees and
  symlinked `.git` may not escape an approved root), and inspection never
  executes repository-configured fsmonitor helpers or hooks and never takes
  repository locks or honors global/system git config. Remote references
  persist without host inspection as before.
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
  six-creation allowance, enforced by the shared ledger
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

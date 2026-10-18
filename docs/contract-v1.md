# Ranger v1 contract reference

The authoritative machine-readable contract is the OpenAPI document:
served at `http://127.0.0.1:3100/v1/openapi.json` and checked in at
`contracts/openapi.json` (a contract test asserts they never drift).
Realtime event schemas live in `contracts/events/`.

Example payloads for every family are defined in `src/contracts/examples.ts`
and validated against their own declared schemas by the unit suite. The
generated typed client (`src/clients/ranger-client.ts`) exposes one method
per operation below.

**Skeleton semantics:** during construction, a declared operation whose
provider is not implemented yet returns `501` with the central envelope and
stable code `not_configured` — never a fake success payload.

**Implemented families (identity + conversations/events milestones):**
credentials-sessions, projects-memberships, repositories,
conversations-requirements and events are live. Principal-auth routes accept
`Authorization: Bearer <api token or bootstrap credential>` or the revocable
browser-session cookie (`ranger_session`, HttpOnly). Cookie-authenticated
mutations require same-origin or CSRF protection (see the frontend guide).
Unauthenticated requests to any principal-auth route return the standard
`unauthorized` envelope; cross-project access returns `forbidden`; unknown
resources return `not_found`. Mutations accept a scoped `Idempotency-Key`:
identical retries replay the stored result with no second side effect or
duplicate event; key reuse with different input returns `conflict`.

### credentials-sessions
Credentials and sessions (API tokens, browser sessions, connection tickets)

- `GET /v1/auth/me` — getPrincipal
- `POST /v1/auth/api-tokens` — createApiToken (secret returned exactly once; stored only as lookup key + scrypt hash)
- `GET /v1/auth/api-tokens` — listApiTokens (metadata only)
- `DELETE /v1/auth/api-tokens/{tokenId}` — revokeApiToken (next use fails `unauthorized`)
- `POST /v1/auth/browser-sessions` — createBrowserSession (sets HttpOnly cookie; response carries the once-only `csrfToken`)
- `GET /v1/auth/browser-sessions` — listBrowserSessions
- `DELETE /v1/auth/browser-sessions/{sessionId}` — revokeBrowserSession (cookie stops working immediately; sessions survive restarts until revoked)
- `POST /v1/auth/connection-tickets` — createConnectionTicket (single-use, 60 s, bound to principal + project + purpose + optional origin; dies when the issuing credential/session is revoked)

### projects-memberships
Projects, memberships and the customer-configurable engineer display name

Creators become the first owner. Owners manage the project (name, engineer
display name, memberships); members read and work. Every value survives API
restarts; a non-member's request returns `forbidden` and lists only show
projects the caller belongs to.

- `POST /v1/projects` — createProject
- `GET /v1/projects` — listProjects
- `GET /v1/projects/{projectId}` — getProject
- `PATCH /v1/projects/{projectId}` — updateProject
- `POST /v1/projects/{projectId}/memberships` — addMembership (targets only the given principal)
- `GET /v1/projects/{projectId}/memberships` — listMemberships
- `DELETE /v1/projects/{projectId}/memberships/{principalId}` — removeMembership (removing the last owner conflicts)

### repositories
Repository connections and checkout references

One repository per project. Connections record the approved URL (file,
https, ssh or git; embedded credentials are rejected), ref, workspace-relative
checkout path and checkout policy (`shallow`, `submodules`). Local
`file://` repositories also resolve the real commit, working-tree dirty flag
(including untracked files) and a deterministic content hash at connect time;
remote URLs persist the approved reference and resolve these fields when the
source is available locally. References persist across restarts and are
readable only by project members.

- `PUT /v1/projects/{projectId}/repository` — connectRepository
- `GET /v1/projects/{projectId}/repository` — getRepository
- `DELETE /v1/projects/{projectId}/repository` — disconnectRepository

### conversations-requirements
Conversations, messages, questions, answers and requirement/decision versions

Conversations, messages (with stable per-conversation ordering), clarification
questions and answers persist and survive API restarts. Every answer
references the exact question it answers. Requirement and decision threads
are versioned append-only: `createRequirementVersion`/`createDecisionVersion`
create a thread when called without a thread id and append the next immutable
version when called with `requirementId`/`decisionId`; prior versions stay
readable and are never mutated in place. Each mutation commits together with
exactly one schema-valid event (`conversation.created`,
`conversation.message.created`, `conversation.question.created`,
`conversation.answer.created`, `requirement.version.created`,
`decision.version.created`).

- `POST /v1/projects/{projectId}/conversations` — createConversation
- `GET /v1/projects/{projectId}/conversations` — listConversations
- `GET /v1/projects/{projectId}/conversations/{conversationId}` — getConversation
- `POST /v1/projects/{projectId}/conversations/{conversationId}/messages` — postMessage
- `GET /v1/projects/{projectId}/conversations/{conversationId}/messages` — listMessages (cursor paginated)
- `POST /v1/projects/{projectId}/conversations/{conversationId}/questions` — createQuestion
- `POST /v1/projects/{projectId}/conversations/{conversationId}/questions/{questionId}/answers` — answerQuestion
- `GET /v1/projects/{projectId}/requirements` — listRequirements
- `POST /v1/projects/{projectId}/requirements` — createRequirementVersion (optional `requirementId` appends)
- `GET /v1/projects/{projectId}/decisions` — listDecisions
- `POST /v1/projects/{projectId}/decisions` — createDecisionVersion (optional `decisionId` appends)

### events
Project event subscription and cursor replay (HTTP plus WebSocket)

Every project event carries `schemaVersion` (1), `eventId`, `projectId`,
nullable `runId`/`sessionId`, ISO timestamp, per-project `sequence`,
`requestId`, `type` and `data` validated at append time against the type's
declared schema (`GET /v1/events/schemas`). State mutations and their events
commit in the same transaction, so committed sequences are dense and replay
never observes a half-applied mutation.

- `GET /v1/events/schemas` — getEventSchemas
- `GET /v1/projects/{projectId}/events` — replayProjectEvents (member-auth HTTP replay; `invalid_cursor` 400 / `cursor_expired` 410 on bad cursors; pure read — no tools, no state change)
- `GET /v1/projects/{projectId}/events/subscribe` — subscribeProjectEvents (WebSocket upgrade; consumes a single-use `events` ticket with projectId and upgrade origin, enforces current membership BEFORE delivery, and RE-VALIDATES membership plus the issuing token/session liveness and expiry before EVERY delivered batch; ordered replay then live delivery; closes `4400` invalid_cursor, `4410` cursor_expired, `4401` unauthorized — at upgrade or midstream when membership/issuer authorization is lost, one error frame first and no later project payloads, `4502` slow_consumer — close code/reason only, NO error frame, because the outbound buffer is already saturated)

### voice
Voice sessions and the secure xAI realtime relay

- `POST /v1/projects/{projectId}/voice/sessions` — startVoiceSession
- `GET /v1/projects/{projectId}/voice/sessions/{sessionId}` — getVoiceSession
- `POST /v1/projects/{projectId}/voice/sessions/{sessionId}/end` — endVoiceSession
- `POST /v1/projects/{projectId}/voice/sessions/{sessionId}/response/cancel` — cancelVoiceResponse
- `GET /v1/projects/{projectId}/voice/sessions/{sessionId}/relay` — relayVoiceSession (WebSocket upgrade)

### capture
Capture sessions, frame ingestion, inspection and retained evidence

- `POST /v1/projects/{projectId}/capture/sessions` — startCaptureSession
- `GET /v1/projects/{projectId}/capture/sessions/{sessionId}` — getCaptureSession
- `POST /v1/projects/{projectId}/capture/sessions/{sessionId}/end` — endCaptureSession
- `POST /v1/projects/{projectId}/capture/sessions/{sessionId}/frames` — ingestCaptureFrame
- `POST /v1/projects/{projectId}/capture/sessions/{sessionId}/inspection` — requestInspection
- `GET /v1/projects/{projectId}/capture/retained-evidence` — listRetainedEvidence
- `POST /v1/projects/{projectId}/capture/retained-evidence` — retainEvidence

### plans-approvals
Plan versions, revisions and approvals

- `GET /v1/projects/{projectId}/plans` — listPlans
- `POST /v1/projects/{projectId}/plans` — createPlanVersion
- `GET /v1/projects/{projectId}/plans/{planId}` — getPlan
- `POST /v1/projects/{projectId}/plans/{planId}/approvals` — approvePlan
- `GET /v1/projects/{projectId}/approvals` — listApprovals

### runs
Engineering runs: start, pause, resume, cancel and records

- `POST /v1/projects/{projectId}/runs` — startRun
- `GET /v1/projects/{projectId}/runs` — listRuns
- `GET /v1/projects/{projectId}/runs/{runId}` — getRun
- `POST /v1/projects/{projectId}/runs/{runId}/pause` — pauseRun
- `POST /v1/projects/{projectId}/runs/{runId}/resume` — resumeRun
- `POST /v1/projects/{projectId}/runs/{runId}/cancel` — cancelRun

### workspace
Workspace status, files, commands, logs, diffs, artifacts and test results

- `GET /v1/projects/{projectId}/workspace/status` — getWorkspaceStatus
- `GET /v1/projects/{projectId}/workspace/files` — listWorkspaceFiles
- `GET /v1/projects/{projectId}/workspace/file` — readWorkspaceFile
- `PUT /v1/projects/{projectId}/workspace/file` — writeWorkspaceFile
- `POST /v1/projects/{projectId}/workspace/commands` — startWorkspaceCommand
- `GET /v1/projects/{projectId}/workspace/commands/{commandId}` — getWorkspaceCommand
- `GET /v1/projects/{projectId}/workspace/commands/{commandId}/logs` — getWorkspaceCommandLogs
- `POST /v1/projects/{projectId}/workspace/commands/{commandId}/terminate` — terminateWorkspaceCommand
- `GET /v1/projects/{projectId}/workspace/diff` — getWorkspaceDiff
- `GET /v1/projects/{projectId}/workspace/artifacts` — listArtifacts
- `GET /v1/projects/{projectId}/workspace/artifacts/{artifactId}` — downloadArtifact
- `GET /v1/projects/{projectId}/workspace/test-results` — listTestResults

### desktop-preview
Authenticated desktop stream sessions and private application previews

- `POST /v1/projects/{projectId}/desktop/sessions` — createDesktopSession
- `DELETE /v1/projects/{projectId}/desktop/sessions/{sessionId}` — revokeDesktopSession
- `POST /v1/projects/{projectId}/preview/sessions` — createPreviewSession
- `GET /v1/projects/{projectId}/preview/sessions/{sessionId}` — getPreviewSession
- `DELETE /v1/projects/{projectId}/preview/sessions/{sessionId}` — stopPreviewSession
- `GET /v1/projects/{projectId}/desktop/sessions/{sessionId}/stream` — desktopStream (WebSocket upgrade) — served from the preview gateway origin
- `GET /v1/projects/{projectId}/preview/sessions/{sessionId}/app` — previewAppProxy — served from the preview gateway origin

### retrieval
Project-scoped Trace retrieval and the labeled fallback

- `POST /v1/projects/{projectId}/retrieval/search` — retrievalSearch
- `GET /v1/projects/{projectId}/retrieval/status` — retrievalStatus
- `POST /v1/projects/{projectId}/retrieval/reindex` — reindexRetrieval

### capabilities
Capabilities and provider-configuration status

- `GET /v1/capabilities` — getCapabilities
- `GET /health` — getHealth
- `GET /v1/openapi.json` — getOpenApiDocument


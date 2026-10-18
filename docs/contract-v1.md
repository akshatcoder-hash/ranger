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

### credentials-sessions
Credentials and sessions (API tokens, browser sessions, connection tickets)

- `GET /v1/auth/me` — getPrincipal
- `POST /v1/auth/api-tokens` — createApiToken
- `GET /v1/auth/api-tokens` — listApiTokens
- `DELETE /v1/auth/api-tokens/{tokenId}` — revokeApiToken
- `POST /v1/auth/browser-sessions` — createBrowserSession
- `GET /v1/auth/browser-sessions` — listBrowserSessions
- `DELETE /v1/auth/browser-sessions/{sessionId}` — revokeBrowserSession
- `POST /v1/auth/connection-tickets` — createConnectionTicket

### projects-memberships
Projects, memberships and the customer-configurable engineer display name

- `POST /v1/projects` — createProject
- `GET /v1/projects` — listProjects
- `GET /v1/projects/{projectId}` — getProject
- `PATCH /v1/projects/{projectId}` — updateProject
- `POST /v1/projects/{projectId}/memberships` — addMembership
- `GET /v1/projects/{projectId}/memberships` — listMemberships
- `DELETE /v1/projects/{projectId}/memberships/{principalId}` — removeMembership

### repositories
Repository connections and checkout references

- `PUT /v1/projects/{projectId}/repository` — connectRepository
- `GET /v1/projects/{projectId}/repository` — getRepository
- `DELETE /v1/projects/{projectId}/repository` — disconnectRepository

### conversations-requirements
Conversations, messages, questions, answers and requirement/decision versions

- `POST /v1/projects/{projectId}/conversations` — createConversation
- `GET /v1/projects/{projectId}/conversations` — listConversations
- `GET /v1/projects/{projectId}/conversations/{conversationId}` — getConversation
- `POST /v1/projects/{projectId}/conversations/{conversationId}/messages` — postMessage
- `GET /v1/projects/{projectId}/conversations/{conversationId}/messages` — listMessages
- `POST /v1/projects/{projectId}/conversations/{conversationId}/questions` — createQuestion
- `POST /v1/projects/{projectId}/conversations/{conversationId}/questions/{questionId}/answers` — answerQuestion
- `GET /v1/projects/{projectId}/requirements` — listRequirements
- `POST /v1/projects/{projectId}/requirements` — createRequirementVersion
- `GET /v1/projects/{projectId}/decisions` — listDecisions
- `POST /v1/projects/{projectId}/decisions` — createDecisionVersion

### events
Project event subscription and cursor replay (HTTP plus WebSocket)

- `GET /v1/events/schemas` — getEventSchemas
- `GET /v1/projects/{projectId}/events` — replayProjectEvents
- `GET /v1/projects/{projectId}/events/subscribe` — subscribeProjectEvents (WebSocket upgrade)

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


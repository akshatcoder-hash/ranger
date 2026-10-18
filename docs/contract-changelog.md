# Contract changelog

All published frontend-contract versions, newest first. The contract version
served in `/v1/capabilities` (`contractVersion`) must always appear here.

## v1 — 2026-10-18

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

- `invalid_cursor` / `cursor_expired`: replay cursor errors on event
  subscription and voice session reconnect.
- `budget_exceeded`: xAI $5 total / $4 soft admission stop and the Instabox
  six-creation allowance, enforced by the shared ledger
  (`src/budget/ledger.ts`) before any paid call.

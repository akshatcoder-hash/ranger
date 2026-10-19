# Frontend guide (local FDE workflow)

The React/TypeScript frontend in `frontend/` uses the v1 control API through
same-origin `/v1` requests. Demo mode is explicitly labelled and isolated
from live data. Unconfigured or unsupported capabilities report their real
error; provider URLs and keys never enter the frontend.

## Customer journey

1. Connect a browser session, create/open a project and connect an
   operator-approved local checkout. Start the voice call; screen sharing
   is independent and optional.
2. Discuss the problem and confirm the concrete change with Ranger. Ask it
   to prepare the repository and use Trace for grounding, then draft a
   plan. `draft_project_plan` records the confirmed request and requirements
   through the existing PlanningService. It does not approve or start work.
3. Open **Review plan** in the workspace. The browser fetches the latest
   plan and exact-version approval state, including versions created by
   voice. Review the steps, acceptance criteria and permitted scope. The
   browser rechecks that same version/content/scope immediately before
   submitting approval; a changed plan is shown for a fresh review.
4. Approve the exact version, then ask Ranger on the call to start it.
   `request_engineering_run` uses the existing current approval. The durable
   worker performs the real edit/test operations and persists outcomes.
5. Inspect **Changes**, **Checks** or **Review results**, or ask Ranger for
   the observed status. Queued/running, failed and cancelled states remain
   visible; a model statement is not proof of execution or acceptance.

A newly changed plan invalidates the prior approval. An identical plan may
reuse the existing version under PlanningService semantics; drafting still
does not start a run. Preview launch is allowed only if the plan explicitly
contains the launch scope and the customer approves it. Nothing in this UI
adds launch or widens an existing approval. Publishing and deployment are
not implied by a local run.

## Result evidence and refresh

- Run state comes from `GET /v1/projects/:id/runs`; latest-run activity uses
  `GET /v1/projects/:id/runs/:runId/tools` and preserves tool errors/denials.
- `GET /v1/projects/:id/workspace/diff` currently returns saved-file
  inventory text, not a line-by-line patch. It is labelled accordingly.
  Only successful recorded `edit_file` outcomes identify files edited in
  the latest run. File links read the current saved source through
  `GET /v1/projects/:id/workspace/file?path=...`; this is not a historical
  before/after diff. Binary files are labelled and source previews are
  bounded to 40,000 characters.
- `GET /v1/projects/:id/workspace/test-results` contains project-wide test
  commands with actual states/exit codes. Because it has no run identifier,
  it is not presented as the latest run's acceptance results. A succeeded
  state and exit 0 indicate that command passed, not that every requested
  acceptance criterion was tested.
- Each endpoint failure stays visible independently; unavailable data never
  turns into a passing check or a claim that no run has started.
- Results refresh when a view opens, on explicit Refresh, and on relevant
  events from the existing bounded replay loop (5 seconds, at most 24
  polls). There is no new polling timer, background run or autonomy loop.
  After automatic event refresh pauses, use Refresh to get another snapshot.
- Navigation, newer reads and dialog dismissal cancel/fence stale results.
  Changing project cannot reveal another project's cached evidence.

## Base origins

- Control API: `http://127.0.0.1:3100` (cookies live on this origin).
- Preview gateway: `http://127.0.0.1:3101` — a **separate origin** used only
  for desktop streams and private application previews. Bearer stream links
  and certificates never reach browser storage.

## Authentication flow (implemented: identity milestone)

1. The operator bootstraps the first principal and credential locally:

   ```sh
   RANGER_DATA_DIR=~/.local/share/ranger npm run bootstrap -- --create-principal "Operator"
   # → writes ~/.local/share/ranger/bootstrap-credential.txt (mode 0600);
   #   the bearer secret inside is never echoed or logged.
   ```

   Further principals (for multi-user validation drivers) use
   `--additional-principal "Second Operator" --credential-file <path>`.

2. Send `Authorization: Bearer <secret>` on every request (the bootstrap
   credential and API tokens created via `createApiToken` authenticate the
   same way). Server-side only hashes are stored; the secret is displayed
   exactly once at creation.

3. For browser use, call `createBrowserSession`. The route is
   principal-authenticated, the same as other credential routes: send
   `Authorization: Bearer <secret>` (or an existing `ranger_session` cookie)
   AND a JSON body `{ "apiToken": "<same or another API credential>" }`.
   The bearer (or cookie) proves the caller; the body credential is the one
   the new session is issued for. The response carries `sessionId`,
   `expiresAt` and the once-only `csrfToken`, and the `ranger_session`
   HttpOnly cookie is set. A call with only the body and no principal
   authentication is `unauthorized`. Mutating requests with the cookie must
   send a same-origin `Origin` header (or the `x-ranger-csrf` token header
   when no Origin is sent, e.g. server-side renderers); cross-origin cookie
   mutations are rejected with `forbidden`.

   Browser sessions are independent credentials. Revoking the API token that
   was presented in `apiToken` does not revoke sessions already created from
   it. Revoke each session with `revokeBrowserSession`; that session's cookie
   and the tickets it issued stop working, and other sessions keep working.
   There is no token-to-session cascade.

4. For realtime surfaces, call `createConnectionTicket` with the project,
   purpose (`events`, `voice-relay`, `desktop-stream`, `app-preview`) and
   origin. Tickets are short-lived (60 s) and single-use; pass them as the
   `ticket` query parameter on WebSocket upgrades. The server redacts that
   query value from request logs (including the top-level path logged when
   an upgrade hits an ordinary HTTP route) and from unknown-route error
   payloads; do not log it in the browser either. Revoking the issuing API token or
   browser session immediately invalidates its outstanding tickets. It does
   not revoke other sessions that happen to have been created while that
   token was still valid.

## Events: subscribe and replay (implemented: conversations/events milestone)

- HTTP replay: `replayProjectEvents` with `cursor`/`limit`; response carries
  ordered events, `nextCursor` and `hasMore`. Replaying is a pure read: it
  never invokes tools and changes no state.
- Live: open the typed client's `openSubscribeProjectEvents` WebSocket with a
  ticket and an optional `cursor`. The upgrade consumes the ticket (purpose
  `events`, the path projectId, and — for origin-bound tickets — the browser
  `Origin` header) and enforces CURRENT membership at upgrade time; a
  principal removed from the project is closed without any event delivery.
  Authorization is re-validated before EVERY delivered batch: if the
  subscriber's membership is removed, or the API token or browser session
  that issued the ticket is revoked or expires while connected, the server
  closes the stream `4401` with one error frame (details reason
  `membership_removed`, `issuer_revoked` or `issuer_expired`) and no later
  project event is delivered. Reconnect by creating a fresh ticket with a
  still-valid credential and resuming from your cursor.
- Events arrive in strictly increasing per-project `sequence` with no gaps or
  duplicates. Keep the `sequence`/timestamp of the last event you processed;
  on reconnect, subscribe again with a fresh ticket and that cursor (the
  client's `cursor` query parameter accepts the opaque cursor from
  `nextCursor`, or an encoded `{v:1,seq,ts}` position).
- Explicit cursor errors, never silent gaps: a malformed or ahead-of-history
  cursor closes the socket with code `4400` (`invalid_cursor`, also 400 on
  HTTP replay); a cursor older than the 30-day replay window closes with
  `4410` (`cursor_expired`, also 410 on HTTP replay). Recover by
  resubscribing WITHOUT a cursor to replay full history.
- Before every rejection close EXCEPT `4502` the server sends one JSON
  message `{kind:"error", requestId, error:{code, message, details}}`, then
  closes. The `4502` slow_consumer close carries NO error frame: the
  outbound buffer is already saturated past its bound, so the server
  enqueues nothing more onto that socket — the close code/reason itself is
  the signal.
- Close codes on this route: `4401` unauthorized (missing/invalid/reused
  ticket, wrong purpose/project/origin, non-membership at upgrade, or a
  midstream authorization loss: membership removed or issuing token/session
  revoked or expired), `4400` invalid_cursor, `4410` cursor_expired, `4502`
  slow_consumer (the outbound buffer exceeded its bound — resume with your
  cursor), `4501` not_configured (only while a declared realtime route is
  unimplemented).
- Mutating conversations supports the scoped `Idempotency-Key` header: an
  identical retry returns the stored result with no second side effect or
  duplicate event; reusing a key with different input returns `conflict`.

## Voice (implemented: media milestone)

- Start with `startVoiceSession` (project + conversation). Ranger, not the
  browser, connects to the provider realtime relay with the pinned model;
  the browser talks only to Ranger over `openRelayVoiceSession`.
- The upstream WebSocket uses an explicit HTTPS agent with the deployment's
  WSS_PROXY/HTTPS_PROXY and NO_PROXY settings (including lowercase variants).
  This is needed because the ws package supplies createConnection and thereby
  bypasses Node's global agent. TLS verification stays enabled; there is no
  fallback route or automatic reconnect. Dial failures expose only a safe
  category, HTTP status or recognized network code, never provider text.
- Audio contract: 16-bit PCM little-endian at 24 kHz, chunked frames.
  `getUserMedia` permission is requested by the page; convert with an
  AudioWorklet; buffer playback so interruption can flush locally.
- Interruption: `cancelVoiceResponse` cancels and flushes only the in-flight
  voice response. It never pauses or cancels an engineering run.
- The relay owns instructions, tools, 24 kHz audio format and server VAD.
  Client session updates cannot replace its authority; clients cannot submit
  forged function outputs or system messages.
- `draft_project_plan` proposes a version through PlanningService from the
  explicitly confirmed customer request and requirements. It cannot approve
  a plan or launch a worker. The browser's Review plan fetch reads it before
  the customer makes an exact-version approval decision.
- The voice tool `get_project_status` reads the current plan, an existing
  human-approved version, and this conversation's latest run and bounded
  recorded file/test outcomes. The developer does not need to read an
  approval UUID aloud. When they ask to start, `request_engineering_run`
  uses that existing approval; it cannot create approval or bypass the
  current-version/scope checks. If there is no approval, review and approve
  the plan in the UI first.
- Engineering work runs in the background worker. Asking Ranger for status
  calls `get_project_status` again; a queued run is never evidence of success.
  There is no automatic voice notification of completed background runs.
- A dropped provider connection ends that voice session terminally. Recover
  ONLY with a fresh session (`startVoiceSession`) plus a fresh ticket; no
  upstream conversation state is reconstructed and no past tool call is
  replayed. A reconnect attempt against the ended session closes with `4409`
  (`session_ended`).

## Screen capture and device diagnostics (implemented: media milestone)

- Capture is client-owned `getDisplayMedia`; grab frames and POST them to
  `ingestCaptureFrame` (base64 JPEG/PNG + client frame id + capture
  timestamp). The server decodes and validates; client-declared dimensions
  are never trusted.
- Respect the documented bounds: max frame bytes, queue length and upload
  rate; expect `rate_limited` with a retry hint on bursts, and drop events
  naming affected frames.
- `endCaptureSession` invalidates the generation: later frames are rejected,
  in-flight inspection is discarded, transient buffers clear. Raw audio and
  frames are never retained; retained-media evidence is an unsupported
  capability and `retainEvidence` rejects it explicitly.
- Inspection uses the separate xAI vision API; observations carry text,
  uncertainty and source frame/timestamp. While a call is active, asking
  Ranger about the shared screen invokes `inspect_shared_screen`, bound to
  the same project and conversation. No share or multiple active shares
  produces an explicit refusal; the model cannot choose another session.
- Continuous uploads do not invalidate a snapshot already being inspected.
  Its result retains the original frame ID/time and is marked `stale` if a
  newer frame arrived or the freshness window elapsed. Ending sharing still
  invalidates an in-flight result. These observations are never authority to
  control the computer or act on potentially changed screen state.
- Duplicate in-flight or completed inspections with the same idempotency key
  do not make a second provider call. The configured vision concurrency
  ceiling applies to both HTTP and voice inspection.
- Device diagnostics on the test client return one stable code per outcome:
  `granted` (labeled `synthetic:true` under browser fake-device flags),
  `denied`, `no_device`, `unsupported_api`, `runtime_error`, and
  `device_prompt_pending` while an awaited permission/picker call has not
  yet settled (a headless picker may never settle). There is no physical
  microphone or capture display on the development host; no result may
  claim human permission testing.

## Approvals and runs (implemented: coding-workflow milestone)

- Plans are versioned; approving binds an exact version plus permitted scope.
- `startRun` requires an approved plan version; runs are durable, and their
  progress arrives as ordered events on the project stream.
- Cancel is explicit and terminates the real process tree. There is no
  pause/resume: an interrupted run fails explicitly and a new run starts
  from persisted state.

## Streaming desktop/preview (implemented: coding-workflow milestone)

- `createDesktopSession` returns a `gatewayPath` on the preview origin; the
  browser renders the live stream via `openDesktopStream` with a ticket.
- Application previews use private SSH forwarding bound to loopback behind
  the gateway proxy (`previewAppProxy`); arbitrary target URLs are refused.
- Revocation disconnects the viewer at Ranger even if a provider page still
  returns HTTP 200.

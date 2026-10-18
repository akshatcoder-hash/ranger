# Frontend guide (contract skeleton, foundation milestone)

Ranger has no product frontend by design. This guide documents how a future
frontend (or the unstyled diagnostic client under `test tooling`) uses the
v1 contract. Sections marked *land later* are declared in the contract today
and return explicit `not_configured` errors until their milestone implements
them — the guide will grow with each milestone. Never call provider URLs or
provider keys from the frontend; every provider interaction goes through
Ranger.

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

## Voice (land later: interaction milestone)

- Start with `startVoiceSession` (project + conversation). Ranger, not the
  browser, connects to the provider realtime relay with the pinned model;
  the browser talks only to Ranger over `openRelayVoiceSession`.
- Audio contract: 16-bit PCM little-endian at 24 kHz, chunked frames.
  `getUserMedia` permission is requested by the page; convert with an
  AudioWorklet; buffer playback so interruption can flush locally.
- Interruption: `cancelVoiceResponse` cancels and flushes only the in-flight
  voice response. It never pauses or cancels an engineering run.
- A function call that starts engineering work returns a run reference as an
  event; the work itself runs in the worker process.

## Screen capture (land later: interaction milestone)

- Capture is client-owned `getDisplayMedia`; grab frames and POST them to
  `ingestCaptureFrame` (base64 JPEG/PNG + client frame id + capture
  timestamp). The server decodes and validates; client-declared dimensions
  are never trusted.
- Respect the documented bounds: max frame bytes, queue length and upload
  rate; expect `rate_limited` with a retry hint on bursts, and drop events
  naming affected frames.
- `endCaptureSession` invalidates the generation: later frames are rejected,
  in-flight inspection is discarded, transient buffers clear. Raw audio and
  frames are not retained by default; retention is explicit with scope and
  expiry via `retainEvidence`.
- Inspection uses the separate xAI vision API; observations carry text,
  uncertainty and source frame/timestamp. Screen pixels never grant machine
  control.

## Approvals and runs (land later: orchestration/execution milestones)

- Plans are versioned; approving binds an exact version plus permitted scope.
- `startRun` requires an approved plan version; runs are durable, and their
  progress arrives as ordered events on the project stream.
- Pause/resume/cancel are explicit; cancel terminates the real process tree.

## Streaming desktop/preview (land later: execution milestone)

- `createDesktopSession` returns a `gatewayPath` on the preview origin; the
  browser renders the live stream via `openDesktopStream` with a ticket.
- Application previews use private SSH forwarding bound to loopback behind
  the gateway proxy (`previewAppProxy`); arbitrary target URLs are refused.
- Revocation disconnects the viewer at Ranger even if a provider page still
  returns HTTP 200.

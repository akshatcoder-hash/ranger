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

## Authentication flow (land later: identity milestone)

1. Authenticate the principal with an API token (hashed server-side).
2. For browser use, exchange it via `createBrowserSession` for a
   revocable session cookie; mutating requests require CSRF/origin protection.
3. For realtime surfaces, call `createConnectionTicket` with the project,
   purpose (`events`, `voice-relay`, `desktop-stream`, `app-preview`) and
   origin. Tickets are short-lived and single-use; pass them as the `ticket`
   query parameter on WebSocket upgrades.

## Events: subscribe and replay

- HTTP replay: `replayProjectEvents` with `cursor`/`limit`; response carries
  ordered events, `nextCursor` and `hasMore`.
- Live: open the typed client's `openSubscribeProjectEvents` WebSocket with a
  ticket and an optional `cursor`. Events arrive in strictly increasing
  per-project `sequence`; on reconnect, replay from the last seen cursor.
- An invalid or expired cursor returns the documented
  `invalid_cursor`/`cursor_expired` error instead of a silent gap.
- Replay never invokes tools or changes state.

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

import type { WebSocket as WsWebSocket } from 'ws';
import type { FastifyRequest } from 'fastify';
import { consumeTicket, lookupTicketOrigin, type TicketBinding } from '../auth/tickets.js';
import { requireMembership } from '../auth/authorization.js';
import { appendProjectEvent } from '../events/store.js';
import { withTransaction } from '../db/db.js';
import { Errors, isAppError } from '../errors.js';
import type { HandlerContext } from '../http/handlers.js';
import {
  addVoiceSessionUsage,
  endVoiceSessionRow,
  getVoiceSessionRow,
  VOICE_SESSION_MAX_MS,
  type VoiceSessionEndReason,
} from './store.js';
import { realtimeProviderForTests } from './runtime.js';
import {
  PROVIDER_MAX_BUFFERED_BYTES,
  xaiRealtimeProviderFactory,
  type RealtimeProviderConnection,
  type RealtimeProviderFailure,
} from './realtime.js';
import { ENGINEERING_RUN_TOOL_NAME, INSPECT_SHARED_SCREEN_TOOL_NAME, DRAFT_PROJECT_PLAN_TOOL_NAME, VOICE_INSTRUCTIONS, VOICE_TOOLS, enqueueVoiceEngineeringRun, isVoiceToolName, runVoiceWorkspaceTool, runVoiceScreenTool, runVoicePlanTool } from './tools.js';
import { retrievalServiceFor } from '../http/handlers-retrieval.js';
import { releaseXaiReservation, reserveXaiSpend, observeXaiSpend } from '../budget/ledger.js';
import { accountVoiceTextInputs, voiceTextInputCount } from './accounting.js';
import { prepareCallContext } from './call-start.js';
import { diagnostic, diagnosticCode } from '../observability.js';

/**
 * The authenticated server-side realtime relay (VAL-MEDIA-001/002).
 *
 * Upgrade authentication mirrors the events stream: one single-use
 * connection ticket (purpose 'voice-relay'), bound to the path project and
 * the upgrade Origin, consumed BEFORE any provider dial, with current
 * membership checked. Ranger — never the client — dials the upstream xAI
 * realtime service with the permanent key from the protected secret file;
 * the key never reaches a client frame, event, log or artifact, and the
 * relay never accepts a client-supplied credential.
 *
 * Relay contract:
 * - frames flow both directions as validated JSON text (bounded sizes,
 *   bounded outbound buffers; slow consumers are disconnected, not queued)
 * - the one engineering function is declared SERVER-SIDE; a provider
 *   function call validates/authorizes arguments, enqueues ONE durable run
 *   and returns its reference promptly (no inline engineering work, no
 *   past-tool replay)
 * - a client or provider disconnect ends the session TERMINALLY (a fresh
 *   ticket starts a fresh session; nothing reconstructs upstream state)
 * - interruption flushes voice output ONLY and never touches any run
 *
 * Documented close codes (one kind:"error" frame first except for 4502):
 *   4401 unauthorized (missing/invalid/reused ticket, purpose/project/
 *          origin mismatch, non-membership, foreign or mismatched principal)
 *   4400 invalid_frame / message_too_large (protocol violation)
 *   4404 session_not_found
 *   4408 session_limit (configured duration bound reached)
 *   4409 session_ended / relay_exists (reconnect needs a FRESH session)
 *   4503 provider_unavailable / provider_disconnected /
 *          provider_protocol_error (dial failed, upstream dropped or spoke
 *          protocol garbage, or the provider is not configured)
 *   4503 budget_exceeded (text-input admission refused before forwarding)
 *   4502 slow_consumer (outbound buffer exceeded its bound; frame-less)
 */

/** Frame size bounds (validated JSON text in both directions). */
const CLIENT_FRAME_MAX_BYTES = 128 * 1024;
const PROVIDER_FRAME_MAX_BYTES = 2 * 1024 * 1024;
/** Outbound buffer bound toward the relay client. */
const CLIENT_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
/**
 * Client frames buffered while the provider dial is still opening (bounded
 * so a chatty client cannot queue unbounded memory before the upstream opens).
 */
const PENDING_CLIENT_FRAME_MAX = 64;
/** Documented published voice rate used for conservative budget accounting. */
const VOICE_DOCUMENTED_USD_PER_MIN = 0.08;
/**
 * Reservation headroom for one relay session: the documented rate applied to
 * the full session duration bound. Additional text inputs are admitted and
 * conservatively settled separately BEFORE each forwarding attempt.
 */
const VOICE_RESERVE_USD =
  Math.round((VOICE_SESSION_MAX_MS / 60_000) * VOICE_DOCUMENTED_USD_PER_MIN * 100) / 100;
/** Budget ledger feature label for live relay reservations. */
const VOICE_RESERVE_FEATURE = 'lean-voice-latest-frame:voice-relay';

/** PCM16 24kHz mono: 48000 bytes per second of audio. */
const AUDIO_BYTES_PER_SECOND = 48_000;
/** Usage flush interval to the database (bounds loss on an abrupt crash). */
const USAGE_FLUSH_MS = 10_000;
/** Duration guard tick. */
const LIMIT_TICK_MS = 1_000;
/** Bounded memory for seen function-call ids. */
const SEEN_CALL_IDS_MAX = 100;

const READY_STATE_OPEN = 1;

/** Per-session relay handle registered by a live relay connection. */
interface RelayHandle {
  interrupt(): boolean;
  /** Terminal end driven by an explicit API end of the owning session. */
  end(): void;
  /** Observed-but-unflushed usage, for the API end's terminal settlement. */
  residual(): UsageDelta;
}

const activeRelays = new Map<string, RelayHandle>();

/** Interrupt and flush only the in-flight voice response for one session. */
export function interruptVoiceResponse(sessionId: string): boolean {
  const handle = activeRelays.get(sessionId);
  if (handle === undefined) return false;
  return handle.interrupt();
}

/** Terminate the active relay for a session ended through the API. */
export function endVoiceRelayForSession(sessionId: string): boolean {
  const handle = activeRelays.get(sessionId);
  if (handle === undefined) return false;
  handle.end();
  return true;
}

/**
 * Observed-but-unflushed usage of a live relay, read by the API end handler
 * so the terminal row update lands it in the SAME statement: the relay's own
 * settlement afterwards finds the row already ended and must not lose it.
 */
export function residualVoiceRelayUsage(sessionId: string): UsageDelta | null {
  const handle = activeRelays.get(sessionId);
  if (handle === undefined) return null;
  return handle.residual();
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Bounded frame-kind label for counters (no content, no audio data). */
function frameKind(type: string): string {
  return type.length > 64 ? `${type.slice(0, 61)}...` : type;
}

function parseFrameKind(raw: string): { type: string; frame: Record<string, unknown> } | null {
  if (Buffer.byteLength(raw, 'utf8') > PROVIDER_FRAME_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const frame = parsed as Record<string, unknown>;
  if (typeof frame['type'] !== 'string' || frame['type'] === '') return null;
  return { type: frame['type'], frame };
}

function errorFrame(code: string, message: string, requestId: string, details?: Record<string, unknown>): string {
  return JSON.stringify({
    kind: 'error',
    requestId,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  });
}

interface UsageDelta {
  audioSeconds: number;
  textTokens: number;
  toolCalls: number;
}

export function handleVoiceRelayUpgrade(
  socket: WsWebSocket,
  req: FastifyRequest,
  ctx: HandlerContext,
): void {
  const { db, config, secrets } = ctx;
  const params = req.params as { projectId: string; sessionId: string };
  const query = req.query as { ticket?: string };
  const projectId = params.projectId;
  const sessionId = params.sessionId;
  const requestId = req.id;
  const log = (event: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void =>
    diagnostic(event, { projectId, sessionId, ...fields });
  const origin =
    typeof req.headers.origin === 'string' && req.headers.origin !== '' ? req.headers.origin : undefined;

  let ended = false;
  let provider: RealtimeProviderConnection | null = null;
  let providerOpened = false;
  let reservationId: string | null = null;
  let limitExpiresAt = 0;
  let usageTimer: NodeJS.Timeout | null = null;
  let limitTimer: NodeJS.Timeout | null = null;
  const seenCallIds = new Set<string>();
  /** Observed transport counters for the whole session (in-memory). */
  const observed: UsageDelta = { audioSeconds: 0, textTokens: 0, toolCalls: 0 };
  /** Totals already persisted to the database. */
  let flushed: UsageDelta = { audioSeconds: 0, textTokens: 0, toolCalls: 0 };

  const fail = (close: { code: number; reason: string; errorCode?: string }, message: string, details?: Record<string, unknown>): void => {
    log('voice.relay.rejected', { closeCode: close.code, reason: close.reason, errorCode: close.errorCode });
    // Deliberately NOT guarded by `ended`: the disconnect paths end the
    // session first and then rely on fail() to deliver the documented close
    // code/reason to the client. socket.close is idempotent.
    if (close.errorCode !== undefined) {
      try {
        socket.send(errorFrame(close.errorCode, message, requestId, details));
      } catch {
        // The socket may already be closing; the close code carries the class.
      }
    }
    try {
      socket.close(close.code, close.reason);
    } catch {
      // Already closed.
    }
  };

  const residualUsage = (): UsageDelta => ({
    audioSeconds: round3(observed.audioSeconds - flushed.audioSeconds),
    textTokens: observed.textTokens - flushed.textTokens,
    toolCalls: observed.toolCalls - flushed.toolCalls,
  });

  const appendEndedEvents = (afterConversationId: string, reason: VoiceSessionEndReason): void => {
    appendProjectEvent(db, {
      projectId,
      sessionId,
      type: 'voice.session.ended',
      data: { sessionId, conversationId: afterConversationId, reason },
      requestId,
    });
    appendProjectEvent(db, {
      projectId,
      sessionId,
      type: 'voice.usage.recorded',
      data: { sessionId, ...residualUsage() },
      requestId,
    });
  };

  /** Terminal, idempotent session end + event + usage settlement. */
  const endSession = (reason: VoiceSessionEndReason): void => {
    if (ended) return;
    log('voice.session.ended', { reason, audioSeconds: round3(observed.audioSeconds), toolCalls: observed.toolCalls, textTokens: observed.textTokens });
    ended = true;
    if (usageTimer !== null) clearInterval(usageTimer);
    if (limitTimer !== null) clearInterval(limitTimer);
    activeRelays.delete(sessionId);
    withTransaction(db, () => {
      const before = getVoiceSessionRow(db, projectId, sessionId);
      const after = endVoiceSessionRow(db, projectId, sessionId, reason, residualUsage());
      if (before !== null && before.state === 'active') {
        appendEndedEvents(after.conversationId, reason);
      }
    });
    // Settle the live budget reservation exactly once, conservatively: the
    // documented rate for the bounded session wall time (an upper bound on
    // duration charges when usage frames are unobserved). Text surcharges
    // were already admitted/settled per forwarded input; do not count twice.
    if (reservationId !== null && config.liveBudgetFile !== null) {
      try {
        const endedRow = getVoiceSessionRow(db, projectId, sessionId);
        const wallSeconds =
          endedRow !== null && endedRow.endedAt !== null
            ? Math.min((endedRow.endedAt - endedRow.createdAt) / 1000, VOICE_SESSION_MAX_MS / 1000)
            : VOICE_SESSION_MAX_MS / 1000;
        const conservativeUsd = Math.round((wallSeconds / 60) * VOICE_DOCUMENTED_USD_PER_MIN * 10000) / 10000;
        observeXaiSpend(config.liveBudgetFile, {
          reservationId,
          observedUsd: Math.max(conservativeUsd, 0.0001),
          note: `voice usage unobserved at the provider; duration-only settlement at the documented rate for the bounded session duration; text-input surcharges accounted separately before forwarding; observed audioSeconds=${observed.audioSeconds.toFixed(3)} textTokens=${observed.textTokens}`,
        });
      } catch {
        // The ledger refuses a double settlement; never loop retries.
      }
      reservationId = null;
    }
    try {
      provider?.close(1000, 'session_ended');
    } catch {
      // Already closed.
    }
  };

  const admitTextInputs = (count: number, source: 'user_text' | 'tool_output'): boolean => {
    if (ended) return false;
    // Injected offline providers never consume the mission's paid ledger.
    if (testFactory !== null || count === 0) return true;
    try {
      if (config.liveBudgetFile === null || session === null) throw new Error('Voice budget accounting is unavailable');
      accountVoiceTextInputs(config.liveBudgetFile, session.model, count, source);
      return true;
    } catch {
      endSession('budget_exceeded');
      fail(
        { code: 4503, reason: 'budget_exceeded', errorCode: 'budget_exceeded' },
        'Voice text-input budget admission failed; the input was not forwarded and the session ended',
      );
      return false;
    }
  };

  const flushUsage = (): void => {
    const delta = residualUsage();
    flushed = { audioSeconds: observed.audioSeconds, textTokens: observed.textTokens, toolCalls: observed.toolCalls };
    if (delta.audioSeconds <= 0 && delta.textTokens <= 0 && delta.toolCalls <= 0) return;
    log('voice.transport.usage', { audioSeconds: delta.audioSeconds, textTokens: delta.textTokens, toolCalls: delta.toolCalls });
    withTransaction(db, () => {
      addVoiceSessionUsage(db, sessionId, delta);
    });
  };

  const startTimers = (): void => {
    usageTimer = setInterval(flushUsage, USAGE_FLUSH_MS);
    limitTimer = setInterval(() => {
      if (ended) return;
      if (Date.now() > limitExpiresAt) {
        endSession('session_limit');
        fail(
          { code: 4408, reason: 'session_limit', errorCode: 'rate_limited' },
          'The voice session reached its configured duration limit; create a fresh session to continue',
        );
      }
    }, LIMIT_TICK_MS);
  };

  /** The one server-declared engineering function: durable run, prompt return. */
  const handleFunctionCall = async (frame: Record<string, unknown>): Promise<void> => {
    const callId = typeof frame['call_id'] === 'string' ? frame['call_id'] : typeof frame['item_id'] === 'string' ? frame['item_id'] : '';
    // Claim the id before any async work. Duplicate provider deliveries must never dial twice or start a response loop.
    if (callId !== '' && seenCallIds.has(callId)) return;
    const toolName = String(frame['name']);
    const toolStartedAt = Date.now();
    log('voice.tool.started', { toolName });
    if (callId !== '') {
      seenCallIds.add(callId);
      if (seenCallIds.size > SEEN_CALL_IDS_MAX) {
        const oldest = seenCallIds.values().next().value;
        if (oldest !== undefined) seenCallIds.delete(oldest);
      }
    }
    let args: unknown = frame['arguments'];
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = null;
      }
    }
    let output: string;
    try {
      if (callId === '') {
        throw Errors.conflict('The function call id is missing or was already served', {
          reason: 'function_call_replayed',
        });
      }
      const session = getVoiceSessionRow(db, projectId, sessionId);
      if (session === null || session.state !== 'active') {
        throw Errors.conflict('The voice session already ended; a function call cannot start work', {
          reason: 'session_ended',
        });
      }
      if (Date.now() > session.expiresAt) {
        throw Errors.conflict('The voice session reached its configured duration limit', {
          reason: 'session_limit',
        });
      }
      requireMembership(db, projectId, session.principalId);
      let result: { output: Record<string, unknown>; replayed: boolean };
      if (toolName === ENGINEERING_RUN_TOOL_NAME) {
        const reference = enqueueVoiceEngineeringRun(db, {
          projectId,
          conversationId: session.conversationId,
          callId,
          requestId,
          args,
        });
        result = { output: { runId: reference.runId }, replayed: reference.replayed };
      } else {
        const toolInput = {
          db,
          retrieval: retrievalServiceFor(ctx),
          projectId,
          conversationId: session.conversationId,
          sessionId,
          principalId: session.principalId,
          callId,
          requestId,
          args,
        };
        result = toolName === INSPECT_SHARED_SCREEN_TOOL_NAME
          ? await runVoiceScreenTool(ctx, toolInput)
          : toolName === DRAFT_PROJECT_PLAN_TOOL_NAME ? await runVoicePlanTool(ctx, toolInput)
          : await runVoiceWorkspaceTool(toolName, toolInput);
      }
      if (!result.replayed) observed.toolCalls += 1;
      // Persist the durable tool evidence promptly, not only at session end.
      flushUsage();
      output = JSON.stringify(result.output);
      log('voice.tool.finished', { toolName, elapsedMs: Date.now() - toolStartedAt, status: 'succeeded', replayed: result.replayed });
    } catch (cause) {
      const error = isAppError(cause)
        ? { code: cause.code, message: cause.message, details: cause.details }
        : { code: 'internal_error', message: 'The engineering function failed' };
      output = JSON.stringify({ error });
      log('voice.tool.finished', { toolName, elapsedMs: Date.now() - toolStartedAt, status: 'failed',
        code: error.code, reason: isAppError(cause) ? diagnosticCode(cause.details?.['reason'], cause.code) : 'internal_error' });
    }
    // Feed the validated result back per the documented protocol, then ask
    // for the next provider turn. Tool results are untrusted data.
    if (ended || provider === null || !provider.isOpen) return;
    // Conservatively treat every tool result (including errors) as another
    // paid text input; the provider's precise tool-output billing is unknown.
    if (!admitTextInputs(1, 'tool_output')) return;
    try {
      provider?.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: callId, output },
        }),
      );
      provider?.send(JSON.stringify({ type: 'response.create' }));
    } catch {
      // The provider connection is gone; the disconnect path ends the session.
    }
  };

  const handleProviderFrame = (raw: string): void => {
    if (ended || socket.readyState !== READY_STATE_OPEN) return;
    const parsed = parseFrameKind(raw);
    if (parsed === null) {
      endSession('provider_protocol_error');
      fail(
        { code: 4503, reason: 'provider_protocol_error', errorCode: 'conflict' },
        'The provider sent a protocol-violating frame; the voice session ended. Create a fresh session to continue.',
      );
      return;
    }
    frameKind(parsed.type);
    if (parsed.type === 'error') {
      const error = parsed.frame['error'] as Record<string, unknown> | undefined;
      log('voice.provider.error', { code: diagnosticCode(error?.['code']) });
    } else if (parsed.type === 'response.done') {
      const response = parsed.frame['response'] as Record<string, unknown> | undefined;
      log('voice.response.done', { status: diagnosticCode(response?.['status'], 'completed') });
    } else if (parsed.type === 'input_audio_buffer.speech_started' || parsed.type === 'input_audio_buffer.speech_stopped') {
      log(parsed.type === 'input_audio_buffer.speech_started' ? 'voice.speech.started' : 'voice.speech.stopped');
    }
    // Observed provider usage: any frame carrying a usage object.
    const usage = parsed.frame['usage'] as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
    if (usage !== undefined && usage !== null && typeof usage === 'object') {
      const input = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0;
      const output = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0;
      if (Number.isFinite(input) && Number.isFinite(output)) {
        observed.textTokens += input + output;
      }
    }
    if (
      parsed.type === 'response.function_call_arguments.done' &&
      isVoiceToolName(parsed.frame['name'])
    ) {
      void handleFunctionCall(parsed.frame);
      return;
    }
    if (socket.bufferedAmount > CLIENT_MAX_BUFFERED_BYTES) {
      endSession('slow_consumer');
      // Frame-less: nothing more may be enqueued onto the saturated socket.
      socket.close(4502, 'slow_consumer');
      return;
    }
    socket.send(raw);
  };

  const handleClientFrame = (data: Buffer): void => {
    if (ended) return;
    let raw = data.toString('utf8');
    if (Buffer.byteLength(raw, 'utf8') > CLIENT_FRAME_MAX_BYTES) {
      fail(
        { code: 4400, reason: 'message_too_large', errorCode: 'validation_failed' },
        'Relay frame exceeded the documented size bound',
      );
      return;
    }
    const parsed = parseFrameKind(raw);
    if (parsed === null) {
      fail(
        { code: 4400, reason: 'invalid_frame', errorCode: 'validation_failed' },
        'Relay frames must be JSON objects with a type field',
      );
      return;
    }
    frameKind(parsed.type);
    if (parsed.type === 'session.update') {
      const requested = parsed.frame['session'];
      const sessionOptions = requested !== null && typeof requested === 'object' && !Array.isArray(requested)
        ? requested as Record<string, unknown> : {};
      raw = JSON.stringify({
        type: 'session.update',
        session: {
          // Only media presentation options are client-configurable. Authority stays server-owned.
          ...(sessionOptions['voice'] === undefined ? {} : { voice: sessionOptions['voice'] }),
          instructions: VOICE_INSTRUCTIONS,
          tools: VOICE_TOOLS,
          turn_detection: { type: 'server_vad' },
          audio: { input: { format: { type: 'audio/pcm', rate: 24000 } }, output: { format: { type: 'audio/pcm', rate: 24000 } } },
        },
      });
    } else if (parsed.type === 'response.create') {
      // Per-response overrides must not replace the server's instructions or tools.
      raw = JSON.stringify({ type: 'response.create' });
    } else if (parsed.type === 'conversation.item.create') {
      const item = parsed.frame['item'] as Record<string, unknown> | undefined;
      if (item?.['type'] !== 'message' || item['role'] !== 'user') {
        fail({ code: 4400, reason: 'invalid_frame', errorCode: 'validation_failed' }, 'Clients may submit user messages only; tool outputs and instructions are server-owned');
        return;
      }
      log('voice.text.received', { textInputCount: voiceTextInputCount(parsed.frame) });
    }
    // Observed audio transport volume from client frames carrying audio.
    const audio = parsed.frame['audio'];
    if (typeof audio === 'string') {
      observed.audioSeconds += (audio.length * 3) / 4 / AUDIO_BYTES_PER_SECOND;
    }
    if (provider === null || !provider.isOpen) {
      // The provider dial is asynchronous; a client that streams immediately
      // on relay open must not lose its first frames (session config, audio,
      // the first response request). Buffer them boundedly and flush in
      // order once the upstream opens.
      if (pendingClientFrames.length >= PENDING_CLIENT_FRAME_MAX) {
        endSession('slow_consumer');
        fail(
          { code: 4503, reason: 'provider_backpressure', errorCode: 'conflict' },
          'The provider upstream did not open before the client buffer bound was exceeded',
        );
        return;
      }
      pendingClientFrames.push({ raw, textInputCount: voiceTextInputCount(parsed.frame) });
      return;
    }
    if (provider.bufferedAmount > PROVIDER_MAX_BUFFERED_BYTES) {
      endSession('slow_consumer');
      fail(
        { code: 4503, reason: 'provider_backpressure', errorCode: 'conflict' },
        'The provider upstream buffer exceeded its bound; the voice session ended',
      );
      return;
    }
    if (!admitTextInputs(voiceTextInputCount(parsed.frame), 'user_text')) return;
    provider.send(raw);
  };

  const releaseReservation = (): void => {
    if (reservationId === null || config.liveBudgetFile === null) return;
    try {
      releaseXaiReservation(config.liveBudgetFile, reservationId);
    } catch {
      // Idempotent by id; nothing to loop.
    }
    reservationId = null;
  };

  /** The dial never came up: end the session honestly without a settle. */
  const dialFailed = (message: string, failure?: RealtimeProviderFailure): void => {
    if (ended) return;
    log('voice.provider.dial_failed', { category: failure?.category, httpStatus: failure?.httpStatus,
      networkCode: failure?.networkCode });
    ended = true;
    if (usageTimer !== null) clearInterval(usageTimer);
    if (limitTimer !== null) clearInterval(limitTimer);
    activeRelays.delete(sessionId);
    releaseReservation();
    withTransaction(db, () => {
      const before = getVoiceSessionRow(db, projectId, sessionId);
      const after = endVoiceSessionRow(db, projectId, sessionId, 'dial_failed');
      if (before !== null && before.state === 'active') {
        appendProjectEvent(db, {
          projectId,
          sessionId,
          type: 'voice.session.ended',
          data: { sessionId, conversationId: after.conversationId, reason: 'dial_failed' },
          requestId,
        });
      }
    });
    fail({ code: 4503, reason: 'provider_unavailable', errorCode: 'conflict' }, message, { reason: 'provider_dial_failed', ...failure });
  };

  // -- upgrade authentication (mirrors the events stream) -------------------
  if (typeof query.ticket !== 'string' || query.ticket === '') {
    fail(
      { code: 4401, reason: 'unauthorized', errorCode: 'unauthorized' },
      'A voice relay connection ticket is required',
      { reason: 'ticket_required' },
    );
    return;
  }
  let binding: TicketBinding;
  try {
    const bound = lookupTicketOrigin(db, query.ticket);
    if (bound !== null && (origin === undefined || origin.toLowerCase() !== bound.toLowerCase())) {
      throw Errors.unauthorized('Connection ticket is not valid for this use', { reason: 'origin_mismatch' });
    }
    binding = consumeTicket(db, query.ticket, { purpose: 'voice-relay', projectId, origin });
    requireMembership(db, projectId, binding.principalId);
  } catch (cause) {
    const code = cause instanceof Error && (cause as { code?: string }).code === 'not_found' ? 'not_found' : 'unauthorized';
    fail({ code: 4401, reason: 'unauthorized', errorCode: code }, cause instanceof Error ? cause.message : 'Connection ticket is not valid for this use');
    return;
  }

  const session = getVoiceSessionRow(db, projectId, sessionId);
  if (session === null) {
    fail({ code: 4404, reason: 'session_not_found', errorCode: 'not_found' }, 'Voice session not found in this project');
    return;
  }
  if (session.state !== 'active') {
    fail(
      { code: 4409, reason: 'session_ended', errorCode: 'conflict' },
      'This voice session has ended; create a fresh session with a fresh ticket to reconnect',
      { reason: 'session_ended' },
    );
    return;
  }
  if (binding.principalId !== session.principalId) {
    fail(
      { code: 4401, reason: 'unauthorized', errorCode: 'forbidden' },
      'The ticket principal does not own this voice session',
      { reason: 'principal_mismatch' },
    );
    return;
  }
  if (activeRelays.has(sessionId)) {
    fail(
      { code: 4409, reason: 'relay_exists', errorCode: 'conflict' },
      'This voice session already has an active relay connection',
      { reason: 'relay_exists' },
    );
    return;
  }
  limitExpiresAt = session.expiresAt;
  if (Date.now() > session.expiresAt) {
    endSession('session_limit');
    fail(
      { code: 4408, reason: 'session_limit', errorCode: 'rate_limited' },
      'The voice session reached its configured duration limit; create a fresh session to continue',
    );
    return;
  }

  // -- provider dial: Ranger connects, the key stays server-side ------------
  const testFactory = realtimeProviderForTests();
  let apiKey: string | null = null;
  if (testFactory === null) {
    if (secrets.isConfigured()) {
      try {
        apiKey = secrets.get('XAI_API_KEY');
      } catch {
        apiKey = null;
      }
    }
    if (apiKey === null || config.liveBudgetFile === null) {
      fail(
        { code: 4503, reason: 'provider_unavailable', errorCode: 'not_configured' },
        'The voice provider is not configured for this process',
      );
      return;
    }
    try {
      const admission = reserveXaiSpend(config.liveBudgetFile, {
        feature: VOICE_RESERVE_FEATURE,
        estimateUsd: VOICE_RESERVE_USD,
        model: session.model,
      });
      reservationId = admission.reservationId;
    } catch (cause) {
      fail(
        { code: 4503, reason: 'provider_unavailable', errorCode: 'budget_exceeded' },
        cause instanceof Error ? cause.message : 'Budget admission refused the voice dial',
      );
      return;
    }
  }

  const factory = testFactory ?? xaiRealtimeProviderFactory;
  log('voice.relay.authenticated');
  /** Client frames received before the upstream opened (flushed in order). */
  const pendingClientFrames: Array<{ raw: string; textInputCount: number }> = [];
  /** An interrupt that arrived while the provider dial was still opening. */
  let pendingInterrupt = false;
  try {
    provider = factory({
      model: session.model,
      apiKey: apiKey ?? 'test-only-injected',
      handlers: {
        onOpen: () => {
          if (ended || providerOpened) return;
          providerOpened = true;
          log('voice.provider.opened');
          // Declare the one engineering function server-side with fixed
          // instructions. The client can never widen this authority; its own
          // session config flows as ordinary frames afterwards.
          try {
            provider?.send(
              JSON.stringify({
                type: 'session.update',
                session: {
                  instructions: VOICE_INSTRUCTIONS,
                  tools: VOICE_TOOLS,
                  turn_detection: { type: 'server_vad' },
                  audio: {
                    input: { format: { type: 'audio/pcm', rate: 24000 } },
                    output: { format: { type: 'audio/pcm', rate: 24000 } },
                  },
                },
              }),
            );
          } catch {
            // The disconnect path handles a dead upstream.
          }
          // An interrupt that arrived during the dial is the latest user
          // intent: cancel upstream, then DROP the stale buffered frames so
          // no interrupted turn can start after the flush.
          if (pendingInterrupt) {
            pendingInterrupt = false;
            pendingClientFrames.length = 0;
            try {
              provider?.send(JSON.stringify({ type: 'response.cancel' }));
            } catch {
              // The disconnect path handles a dead upstream.
            }
            startTimers();
            return;
          }
          try {
            const context = prepareCallContext(ctx, { projectId, conversationId: session.conversationId, sessionId, requestId },
              () => admitTextInputs(1, 'user_text'));
            if (ended) return;
            if (context !== null) {
              provider?.send(JSON.stringify({
                type: 'conversation.item.create',
                item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: context }] },
              }));
              if (pendingClientFrames.length === 0) provider?.send(JSON.stringify({ type: 'response.create' }));
            }
          } catch {
            log('voice.call.context_failed', { code: 'internal_error' });
          }
          // Flush frames the client streamed during the dial, in order,
          // after the server-side tool declaration.
          const buffered = pendingClientFrames.splice(0, pendingClientFrames.length);
          for (const { raw, textInputCount } of buffered) {
            if (ended || provider === null || !provider.isOpen) break;
            if (provider.bufferedAmount > PROVIDER_MAX_BUFFERED_BYTES) {
              endSession('slow_consumer');
              fail(
                { code: 4503, reason: 'provider_backpressure', errorCode: 'conflict' },
                'The provider upstream buffer exceeded its bound; the voice session ended',
              );
              return;
            }
            if (!admitTextInputs(textInputCount, 'user_text')) return;
            try {
              provider.send(raw);
            } catch {
              // The disconnect path handles a dead upstream.
              break;
            }
          }
          startTimers();
        },
        onMessage: handleProviderFrame,
        onClose: (code) => {
          if (ended) return;
          log('voice.provider.closed', { closeCode: code });
          endSession('provider_disconnect');
          fail(
            { code: 4503, reason: 'provider_disconnected', errorCode: 'conflict' },
            'The provider connection dropped; the voice session ended. Create a fresh session with a fresh ticket to reconnect.',
          );
        },
        onError: (_message, failure) => {
          if (ended) return;
          if (!providerOpened) {
            dialFailed('The provider realtime dial failed; the voice session did not start', failure);
          }
          // After open: the subsequent close event carries the disconnect.
        },
      },
    });
  } catch (cause) {
    dialFailed('The provider realtime dial failed; the voice session did not start');
    void cause;
    return;
  }

  socket.on('message', (data: unknown, isBinary: boolean) => {
    if (isBinary) {
      fail(
        { code: 4400, reason: 'invalid_frame', errorCode: 'validation_failed' },
        'Relay frames must be JSON text',
      );
      return;
    }
    handleClientFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
  });
  socket.on('close', () => {
    endSession('client_disconnect');
  });
  socket.on('error', () => {
    if (ended) return;
    endSession('client_disconnect');
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  });

  activeRelays.set(sessionId, {
    end: (): void => {
      endSession('client_requested');
    },
    residual: (): UsageDelta => residualUsage(),
    interrupt: (): boolean => {
      if (ended) return false;
      let flushed = false;
      withTransaction(db, () => {
        const current = getVoiceSessionRow(db, projectId, sessionId);
        if (current === null || current.state !== 'active') return;
        if (provider === null || !provider.isOpen) {
          // The provider dial is still opening: queue the cancel so it is
          // applied when the upstream opens (stale buffered frames dropped).
          pendingInterrupt = true;
          try {
            // Local playback flush signal: the client flushes its buffered
            // audio on this frame. Voice output only — never a run control.
            socket.send(JSON.stringify({ type: 'response.cancelled', sessionId }));
          } catch {
            // The socket may be closing.
          }
          appendProjectEvent(db, {
            projectId,
            sessionId,
            type: 'voice.response.cancelled',
            data: { sessionId },
            requestId,
          });
          flushed = true;
          return;
        }
        try {
          provider.send(JSON.stringify({ type: 'response.cancel' }));
        } catch {
          // The disconnect path handles a dead upstream.
        }
        try {
          // Local playback flush signal: the client flushes its buffered
          // audio on this frame. Voice output only — never a run control.
          socket.send(JSON.stringify({ type: 'response.cancelled', sessionId }));
        } catch {
          // The socket may be closing.
        }
        appendProjectEvent(db, {
          projectId,
          sessionId,
          type: 'voice.response.cancelled',
          data: { sessionId },
          requestId,
        });
        flushed = true;
      });
      return flushed;
    },
  });
}

/**
 * Browser voice and latest-frame screen transport for the Ranger v1 contract.
 *
 * The browser only ever talks to Ranger over same-origin routes. Device access
 * (`getUserMedia`, `getDisplayMedia`) is requested only when a start method is
 * called from a user gesture, never on import or page load. Nothing here keeps
 * a MediaStream, raw audio, or frame bytes beyond the operation that needs
 * them, and every asynchronous result is dropped if its run has ended.
 */
import { MediaLifecycle } from './ui/lifecycle'
import { rangerApi, voiceRelayUrl, type ApiFailure, type ApiResult, type Inspection, type RangerApi } from './api'
import type { Capabilities } from './ui/liveHelpers'

// ---------------------------------------------------------------------------
// Contract constants (docs/frontend-guide.md, src/capture/frames.ts, src/voice/relay.ts)
// ---------------------------------------------------------------------------

/** Voice contract: 16-bit little-endian PCM, mono, 24 kHz, in both directions. */
export const VOICE_SAMPLE_RATE = 24_000
/** 40 ms of audio per relay frame keeps messages small without adding noticeable latency. */
export const VOICE_CHUNK_SAMPLES = 960
/** Locally queued assistant audio beyond this is dropped instead of growing memory. */
export const VOICE_MAX_QUEUED_SECONDS = 30
/** Largest base64 audio delta accepted from the relay (relay frames are bounded at 2 MiB). */
export const VOICE_MAX_DELTA_CHARS = 1_000_000
/** Mic frames are dropped, never queued, when the socket already holds this many unsent bytes. */
export const VOICE_MAX_SEND_BUFFER_BYTES = 256 * 1024
export const VOICE_READY_TIMEOUT_MS = 20_000
/** The relay has no ready frame of its own; the first frame relayed from the provider proves the upstream is open. */
const RELAY_OPEN = 1

/** Capture contract: JPEG/PNG frames, at most 6 MiB, at most 5 uploads per second, strictly increasing timestamps. */
export const CAPTURE_LIMITS = {
  maxFrameBytes: 6 * 1024 * 1024,
  maxUploadsPerSecond: 5,
  minDimension: 16,
  maxDimension: 8192,
} as const
/** One frame per second is well under the upload limit and is all that on-demand inspection needs. */
export const FRAME_INTERVAL_MS = 1_000
export const FRAME_MAX_WIDTH = 1280
export const FRAME_MIN_WIDTH = 320
export const FRAME_JPEG_QUALITY = 0.7
const MAX_CONSECUTIVE_UPLOAD_FAILURES = 5
const FRAME_READY_TIMEOUT_MS = 8_000

// ---------------------------------------------------------------------------
// Dependency seams (real browser implementations are built lazily below)
// ---------------------------------------------------------------------------

export type MediaApi = Pick<RangerApi,
  'startVoiceSession' | 'createRelayTicket' | 'cancelVoiceResponse' | 'endVoiceSession' |
  'startCaptureSession' | 'ingestCaptureFrame' | 'requestInspection' | 'endCaptureSession'>

export interface SocketLike {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string): void
  close(code?: number, reason?: string): void
}
export interface SocketHandlers {
  onOpen(): void
  onMessage(data: unknown): void
  onClose(code: number): void
  onError(): void
}

export interface VoiceAudio {
  /** Connects the microphone stream to a PCM16 24 kHz chunk callback. */
  start(stream: MediaStream, onChunk: (pcm: Int16Array) => void): Promise<void>
  /** Queues assistant audio for playback; false when the bounded queue dropped it. */
  play(pcm: Int16Array): boolean
  flush(): void
  readonly queuedMs: number
  close(): void
}

export interface GrabbedFrame { bytes: Uint8Array; mimeType: 'image/jpeg'; width: number; height: number }
export interface FrameSource {
  ready(): Promise<void>
  grab(maxWidth: number, quality: number): Promise<GrabbedFrame | null>
  dispose(): void
}

export interface MediaDeps {
  api: MediaApi
  mediaDevices(): Pick<MediaDevices, 'getUserMedia' | 'getDisplayMedia'> | undefined
  /** Called synchronously inside the click handler so the AudioContext starts unsuspended. */
  createAudio(): VoiceAudio | null
  createSocket(url: string, handlers: SocketHandlers): SocketLike
  createFrameSource(stream: MediaStream): FrameSource
  relayUrl(projectId: string, sessionId: string, ticket: string): string
  now(): number
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export interface MediaHooks { onAuthLost(): void }
export type MediaTarget = { projectId: string; conversationId: string }

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function pcm16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i += 1) view.setInt16(i * 2, samples[i], true)
  return bytesToBase64(bytes)
}

export function base64ToPcm16(encoded: string): Int16Array | null {
  let binary: string
  try { binary = atob(encoded) } catch { return null }
  const count = binary.length >> 1
  if (count === 0) return null
  const view = new DataView(new ArrayBuffer(count * 2))
  for (let i = 0; i < count * 2; i += 1) view.setUint8(i, binary.charCodeAt(i))
  const samples = new Int16Array(count)
  for (let i = 0; i < count; i += 1) samples[i] = view.getInt16(i * 2, true)
  return samples
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

/** Why an action that needs a provider is offered or not. Unknown or failed status never counts as configured. */
export function providerGate(state: 'idle' | 'loading' | 'ready' | 'error', value: Capabilities | null): string | null {
  if (state === 'loading' || state === 'idle') return 'Checking whether xAI is available on the backend.'
  if (state === 'error' || value === null) return 'xAI availability could not be checked, so this is not offered.'
  return value.xai ? null : 'xAI is not configured on the backend.'
}

function deviceProblem(error: unknown, what: 'microphone' | 'screen'): string {
  const name = typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string' ? (error as { name: string }).name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return what === 'microphone' ? 'Microphone access was not granted. Allow it in the browser to start a call.' : 'Screen sharing was declined or the picker was closed.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return what === 'microphone' ? 'No microphone was found.' : 'No screen or window was available to share.'
  if (name === 'NotReadableError') return `The ${what} is in use by another application or could not be read.`
  return `The browser could not start the ${what}.`
}

function closeProblem(code: number, serverMessage: string | null): { text: string; failure: boolean } {
  if (serverMessage) return { text: serverMessage, failure: true }
  switch (code) {
    case 1000: return { text: 'The call ended.', failure: false }
    case 4401: return { text: 'Ranger rejected the call connection (its ticket or your access). Start a fresh call.', failure: true }
    case 4400: return { text: 'Ranger rejected a call message as invalid, so the call ended.', failure: true }
    case 4404: return { text: 'That call session no longer exists. Start a fresh call.', failure: true }
    case 4408: return { text: 'The call reached its time limit. Start a fresh call to continue.', failure: false }
    case 4409: return { text: 'That call session had already ended or was already connected. Start a fresh call.', failure: true }
    case 4502: return { text: 'The browser could not keep up with the audio stream, so the call ended.', failure: true }
    case 4503: return { text: 'The voice provider is unavailable or disconnected. Nothing was resumed; start a fresh call to try again.', failure: true }
    default: return { text: 'The connection to Ranger dropped and the call ended. Starting again creates a fresh session.', failure: true }
  }
}

/**
 * Whether Ranger still has a session this browser created and could not confirm ended.
 * `failed` keeps the session id until an explicit retry succeeds; `ending` is an end request in flight.
 */
export type CleanupState = { phase: 'idle' | 'ending' | 'failed'; message: string | null }
const IDLE_CLEANUP: CleanupState = { phase: 'idle', message: null }

class Store<T extends { cleanup: CleanupState }> {
  private listeners = new Set<() => void>()
  constructor(private value: T) {}
  get status(): T { return this.value }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  protected set(patch: Partial<T>) {
    this.value = { ...this.value, ...patch }
    this.listeners.forEach(listener => listener())
  }
  /** Replaces the run state but never the cleanup state: an unresolved server session outlives the run that made it. */
  protected reset(next: T) {
    this.value = { ...next, cleanup: this.value.cleanup }
    this.listeners.forEach(listener => listener())
  }
}

/**
 * Tracks server sessions that must be ended. Local resources are always released first; this only
 * observes the end request. A failed end keeps its session id for an explicit, user-triggered retry
 * (there is no automatic retry), and new sessions are refused while anything is unresolved so ids
 * are never overwritten or leaked. Each completion only touches its own entry.
 */
class SessionCleanup {
  private entries = new Map<string, { projectId: string; state: 'ending' | 'failed'; message: string | null }>()
  private orphanedCreates = 0

  constructor(
    private readonly end: (projectId: string, sessionId: string) => Promise<ApiResult<void>>,
    private readonly changed: () => void,
    private readonly authLost: () => void,
    private readonly noun: string,
  ) {}

  get state(): CleanupState {
    const failed = [...this.entries.values()].find(entry => entry.state === 'failed')
    if (failed) return { phase: 'failed', message: failed.message }
    if (this.entries.size > 0 || this.orphanedCreates > 0) return { phase: 'ending', message: null }
    return IDLE_CLEANUP
  }

  get unresolved() { return this.entries.size > 0 || this.orphanedCreates > 0 }

  /** A session-create request is still in flight for a run that already ended; its session must be ended when it lands. */
  orphan() { this.orphanedCreates += 1; this.changed() }
  settleOrphan() { this.orphanedCreates -= 1; this.changed() }

  track(projectId: string, sessionId: string) {
    if (this.entries.has(sessionId)) return
    this.entries.set(sessionId, { projectId, state: 'ending', message: null })
    this.changed()
    void this.attempt(sessionId)
  }

  /** Explicit user retry of every failed end; never called automatically. */
  async retry(): Promise<void> {
    const failed = [...this.entries.entries()].filter(([, entry]) => entry.state === 'failed').map(([id]) => id)
    await Promise.all(failed.map(id => this.attempt(id)))
  }

  private async attempt(sessionId: string) {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    entry.state = 'ending'
    entry.message = null
    this.changed()
    let result: ApiResult<void>
    try {
      result = await this.end(entry.projectId, sessionId)
    } catch {
      result = { ok: false, reason: 'unavailable', message: 'The Ranger API is unreachable.' }
    }
    if (this.entries.get(sessionId) !== entry) return
    if (result.ok || result.code === 'not_found') {
      this.entries.delete(sessionId)
    } else {
      entry.state = 'failed'
      entry.message = `Could not end the ${this.noun} on Ranger: ${result.message} It may stay active until it is ended.`
      if (result.reason === 'unauthorized') this.authLost()
    }
    this.changed()
  }
}

// ---------------------------------------------------------------------------
// Playback queue
// ---------------------------------------------------------------------------

/** Schedules PCM chunks back to back with a bounded look-ahead; flush stops everything already scheduled. */
export class PcmPlayer {
  private nextTime = 0
  private sources = new Set<AudioBufferSourceNode>()

  constructor(
    private readonly context: AudioContext,
    private readonly destination: AudioNode,
    private readonly sampleRate: number,
    private readonly maxQueuedSeconds: number,
  ) {}

  get queuedMs(): number {
    return Math.max(0, this.nextTime - this.context.currentTime) * 1000
  }

  enqueue(pcm: Int16Array): boolean {
    if (pcm.length === 0) return true
    const seconds = pcm.length / this.sampleRate
    const now = this.context.currentTime
    if (this.nextTime < now + 0.02) this.nextTime = now + 0.05
    if (this.nextTime - now + seconds > this.maxQueuedSeconds) return false
    const samples = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i += 1) samples[i] = pcm[i] / 32768
    const buffer = this.context.createBuffer(1, samples.length, this.sampleRate)
    buffer.copyToChannel(samples, 0)
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.destination)
    source.onended = () => {
      this.sources.delete(source)
      try { source.disconnect() } catch { /* already disconnected */ }
    }
    source.start(this.nextTime)
    this.nextTime += seconds
    this.sources.add(source)
    return true
  }

  flush() {
    const scheduled = [...this.sources]
    this.sources.clear()
    this.nextTime = 0
    for (const source of scheduled) {
      source.onended = null
      try { source.stop() } catch { /* never started */ }
      try { source.disconnect() } catch { /* already disconnected */ }
    }
  }
}

/** AudioWorklet module: mono capture, linear resample to 24 kHz when the context runs at another rate, 40 ms PCM16 chunks. */
export const PCM_CAPTURE_WORKLET = `
class RangerPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / ${VOICE_SAMPLE_RATE}
    this.position = 0
    this.last = 0
    this.out = new Int16Array(${VOICE_CHUNK_SAMPLES})
    this.count = 0
  }
  push(sample) {
    const clamped = Math.max(-1, Math.min(1, sample))
    this.out[this.count++] = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767)
    if (this.count === this.out.length) {
      const buffer = this.out.buffer
      this.port.postMessage(buffer, [buffer])
      this.out = new Int16Array(${VOICE_CHUNK_SAMPLES})
      this.count = 0
    }
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel || channel.length === 0) return true
    if (this.ratio === 1) {
      for (let i = 0; i < channel.length; i++) this.push(channel[i])
      return true
    }
    const length = channel.length
    while (this.position < length) {
      const index = Math.floor(this.position)
      const fraction = this.position - index
      const before = index === 0 ? this.last : channel[index - 1]
      const after = channel[index]
      this.push(before + (after - before) * fraction)
      this.position += this.ratio
    }
    this.position -= length
    this.last = channel[length - 1]
    return true
  }
}
registerProcessor('ranger-pcm-capture', RangerPcmCapture)
`

class BrowserVoiceAudio implements VoiceAudio {
  private readonly player: PcmPlayer
  private nodes: AudioNode[] = []
  private captureNode: AudioWorkletNode | null = null
  private closed = false

  constructor(private readonly context: AudioContext) {
    this.player = new PcmPlayer(context, context.destination, VOICE_SAMPLE_RATE, VOICE_MAX_QUEUED_SECONDS)
  }

  get queuedMs() { return this.player.queuedMs }

  async start(stream: MediaStream, onChunk: (pcm: Int16Array) => void): Promise<void> {
    const url = URL.createObjectURL(new Blob([PCM_CAPTURE_WORKLET], { type: 'text/javascript' }))
    try { await this.context.audioWorklet.addModule(url) } finally { URL.revokeObjectURL(url) }
    if (this.closed) return
    await this.context.resume()
    if (this.closed) return
    const source = this.context.createMediaStreamSource(stream)
    const capture = new AudioWorkletNode(this.context, 'ranger-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    capture.port.onmessage = event => {
      if (!this.closed && event.data instanceof ArrayBuffer) onChunk(new Int16Array(event.data))
    }
    // Some engines only pull a worklet that reaches the destination; the gain keeps the mic out of the speakers.
    const mute = this.context.createGain()
    mute.gain.value = 0
    source.connect(capture)
    capture.connect(mute)
    mute.connect(this.context.destination)
    this.captureNode = capture
    this.nodes = [source, capture, mute]
  }

  play(pcm: Int16Array) { return !this.closed && this.player.enqueue(pcm) }
  flush() { this.player.flush() }

  close() {
    if (this.closed) return
    this.closed = true
    this.player.flush()
    if (this.captureNode) this.captureNode.port.onmessage = null
    for (const node of this.nodes) {
      try { node.disconnect() } catch { /* already disconnected */ }
    }
    this.nodes = []
    this.captureNode = null
    void this.context.close().catch(() => undefined)
  }
}

function createBrowserAudio(): VoiceAudio | null {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Context || typeof AudioWorkletNode === 'undefined') return null
  let context: AudioContext
  try { context = new Context({ sampleRate: VOICE_SAMPLE_RATE }) } catch { return null }
  if (!context.audioWorklet) {
    void context.close().catch(() => undefined)
    return null
  }
  void context.resume().catch(() => undefined)
  return new BrowserVoiceAudio(context)
}

function createBrowserSocket(url: string, handlers: SocketHandlers): SocketLike {
  const socket = new WebSocket(url)
  socket.onopen = () => handlers.onOpen()
  socket.onmessage = event => handlers.onMessage(event.data)
  socket.onclose = event => handlers.onClose(event.code)
  socket.onerror = () => handlers.onError()
  return socket
}

function createBrowserFrameSource(stream: MediaStream): FrameSource {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  const canvas = document.createElement('canvas')
  return {
    async ready() {
      await video.play()
      if (video.videoWidth > 0) return
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('timeout')), FRAME_READY_TIMEOUT_MS)
        video.addEventListener('loadedmetadata', () => { window.clearTimeout(timer); resolve() }, { once: true })
      })
    },
    async grab(maxWidth, quality) {
      if (video.videoWidth === 0 || video.videoHeight === 0) return null
      const scale = Math.min(1, maxWidth / video.videoWidth)
      const width = Math.max(CAPTURE_LIMITS.minDimension, Math.round(video.videoWidth * scale))
      const height = Math.max(CAPTURE_LIMITS.minDimension, Math.round(video.videoHeight * scale))
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) return null
      context.drawImage(video, 0, 0, width, height)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
      if (!blob) return null
      return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: 'image/jpeg', width, height }
    },
    dispose() {
      video.pause()
      video.srcObject = null
      canvas.width = 0
      canvas.height = 0
    },
  }
}

/** Builds the real browser seams. Nothing here touches a device or the network until a start method runs. */
export function browserMediaDeps(): MediaDeps {
  return {
    api: rangerApi,
    mediaDevices: () => (typeof navigator === 'undefined' ? undefined : navigator.mediaDevices),
    createAudio: createBrowserAudio,
    createSocket: createBrowserSocket,
    createFrameSource: createBrowserFrameSource,
    relayUrl: (projectId, sessionId, ticket) => voiceRelayUrl(projectId, sessionId, ticket),
    now: () => Date.now(),
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: handle => window.clearTimeout(handle as number),
  }
}

// ---------------------------------------------------------------------------
// Voice channel
// ---------------------------------------------------------------------------

export type VoiceStatus = {
  phase: 'idle' | 'starting' | 'live'
  step: 'permission' | 'session' | 'relay' | 'ready' | null
  error: string | null
  notice: string | null
  responding: boolean
  droppedAudio: number
  cleanup: CleanupState
}
const IDLE_VOICE: VoiceStatus = { phase: 'idle', step: null, error: null, notice: null, responding: false, droppedAudio: 0, cleanup: IDLE_CLEANUP }

type VoiceRun = {
  projectId: string
  operation: number
  abort: AbortController
  audio: VoiceAudio
  socket: SocketLike | null
  sessionId: string | null
  stream: MediaStream | null
  ready: boolean
  /** Set after a local interrupt or barge-in so late deltas of the cancelled response are never played. */
  discardAudio: boolean
  serverError: string | null
  readyTimer: unknown
  creating: boolean
  /** The run ended while its session-create request was still in flight. */
  orphaned: boolean
}

export class VoiceChannel extends Store<VoiceStatus> {
  private run: VoiceRun | null = null
  private readonly lifecycle = new MediaLifecycle(() => undefined)
  private readonly cleanup: SessionCleanup

  constructor(private readonly deps: MediaDeps, private readonly hooks: MediaHooks) {
    super(IDLE_VOICE)
    this.cleanup = new SessionCleanup(
      (projectId, sessionId) => deps.api.endVoiceSession(projectId, sessionId, new AbortController().signal),
      () => this.set({ cleanup: this.cleanup.state }),
      () => hooks.onAuthLost(),
      'call',
    )
  }

  /** Explicit retry for a call session Ranger could not confirm ended. */
  retryCleanup(): Promise<void> { return this.cleanup.retry() }

  /** Must be called from a click handler: the audio context and microphone prompt both need the gesture. */
  async start(target: MediaTarget): Promise<void> {
    if (this.run) return
    if (this.cleanup.unresolved) {
      this.set({ notice: 'The previous call is still being ended on Ranger. Wait for it, or retry ending it, before starting another.' })
      return
    }
    const devices = this.deps.mediaDevices()
    if (!devices || typeof devices.getUserMedia !== 'function') {
      this.reset({ ...IDLE_VOICE, error: 'This browser cannot capture microphone audio.' })
      return
    }
    const audio = this.deps.createAudio()
    if (!audio) {
      this.reset({ ...IDLE_VOICE, error: 'This browser cannot capture and play call audio (AudioWorklet is unavailable).' })
      return
    }
    const operation = this.lifecycle.begin()
    if (operation === null) { audio.close(); return }
    const run: VoiceRun = {
      projectId: target.projectId, operation, abort: new AbortController(), audio, socket: null, sessionId: null,
      stream: null, ready: false, discardAudio: false, serverError: null, readyTimer: null, creating: false, orphaned: false,
    }
    this.run = run
    this.reset({ ...IDLE_VOICE, phase: 'starting', step: 'permission' })

    let stream: MediaStream
    try {
      stream = await devices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch (error) {
      this.fail(run, deviceProblem(error, 'microphone'))
      return
    }
    if (!this.lifecycle.attach(operation, stream)) return
    run.stream = stream
    this.set({ step: 'session' })

    // Not tied to the run's abort signal: a session created after cancellation must be ended, not orphaned.
    run.creating = true
    const started = await this.deps.api.startVoiceSession(target.projectId, target.conversationId, new AbortController().signal)
    run.creating = false
    if (run.orphaned) {
      if (started.ok) this.cleanup.track(target.projectId, started.data.sessionId)
      this.cleanup.settleOrphan()
      return
    }
    if (!started.ok) { this.failFromApi(run, started); return }
    if (!this.lifecycle.setSession(operation, started.data.sessionId)) {
      this.cleanup.track(target.projectId, started.data.sessionId)
      return
    }
    run.sessionId = started.data.sessionId
    this.set({ step: 'relay' })

    const ticket = await this.deps.api.createRelayTicket(target.projectId, run.abort.signal)
    if (!this.isCurrent(run)) return
    if (!ticket.ok) { this.failFromApi(run, ticket); return }
    try {
      run.socket = this.deps.createSocket(this.deps.relayUrl(target.projectId, started.data.sessionId, ticket.data.ticket), {
        onOpen: () => this.onOpen(run, stream),
        onMessage: data => this.onMessage(run, data),
        onClose: code => this.onClose(run, code),
        onError: () => undefined,
      })
    } catch {
      this.fail(run, 'The browser could not open the call connection.')
      return
    }
    run.readyTimer = this.deps.setTimer(() => this.fail(run, 'The call connection did not become ready in time. Nothing was started.'), VOICE_READY_TIMEOUT_MS)
  }

  /** Stops local playback immediately and asks Ranger to cancel only the in-flight voice response. */
  async interrupt(): Promise<void> {
    const run = this.run
    if (!run || !run.ready || !run.sessionId) return
    run.audio.flush()
    run.discardAudio = true
    this.set({ responding: false })
    const result = await this.deps.api.cancelVoiceResponse(run.projectId, run.sessionId, run.abort.signal)
    if (!this.isCurrent(run) || result.ok || result.reason === 'aborted') return
    if (result.reason === 'unauthorized') { this.hooks.onAuthLost(); this.fail(run, 'Your session ended, so the call was stopped.'); return }
    this.set({ notice: `The interrupt request failed: ${result.message}` })
  }

  stop(notice?: string): void {
    const active = this.run !== null
    this.teardown()
    this.reset({ ...IDLE_VOICE, notice: active ? notice ?? null : null })
  }

  private isCurrent(run: VoiceRun) { return this.run === run }

  private onOpen(run: VoiceRun, stream: MediaStream) {
    if (!this.isCurrent(run)) return
    run.audio.start(stream, pcm => this.sendAudio(run, pcm)).catch(() => {
      this.fail(run, 'The browser could not start microphone processing.')
    })
  }

  private sendAudio(run: VoiceRun, pcm: Int16Array) {
    const socket = run.socket
    if (!this.isCurrent(run) || !run.ready || !socket || socket.readyState !== RELAY_OPEN) return
    if (socket.bufferedAmount > VOICE_MAX_SEND_BUFFER_BYTES) return
    socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm16ToBase64(pcm) }))
  }

  private onMessage(run: VoiceRun, data: unknown) {
    if (!this.isCurrent(run) || typeof data !== 'string' || data.length > 3_000_000) return
    let frame: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(data)
      if (parsed === null || typeof parsed !== 'object') return
      frame = parsed as Record<string, unknown>
    } catch { return }

    if (frame.kind === 'error') {
      const message = (frame.error as { message?: unknown } | undefined)?.message
      const text = typeof message === 'string' ? message.slice(0, 300) : null
      // Ranger sends one error frame and then closes; before ready that ends the start, after ready the close reports it.
      if (!run.ready) { this.fail(run, text ?? 'Ranger reported an error before the call was ready.'); return }
      if (text) run.serverError = text
      return
    }
    const type = frame.type
    if (typeof type !== 'string') return
    if (!run.ready) {
      if (type === 'error') {
        const message = (frame.error as { message?: unknown } | undefined)?.message
        this.fail(run, `The voice provider reported a problem before the call was ready${typeof message === 'string' ? `: ${message.slice(0, 200)}` : '.'}`)
        return
      }
      // Only the documented initial frames prove the upstream session exists; anything else is not readiness.
      if (type === 'session.created' || type === 'conversation.created') this.markReady(run)
      return
    }

    switch (type) {
      case 'response.created':
        run.discardAudio = false
        this.set({ responding: true })
        break
      case 'response.done':
        this.set({ responding: false })
        break
      case 'response.cancelled':
      case 'input_audio_buffer.speech_started':
        run.audio.flush()
        run.discardAudio = true
        this.set({ responding: false })
        break
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        const delta = frame.delta
        if (run.discardAudio || typeof delta !== 'string' || delta.length > VOICE_MAX_DELTA_CHARS) break
        const pcm = base64ToPcm16(delta)
        if (!pcm) break
        if (!run.audio.play(pcm)) {
          this.set({ droppedAudio: this.status.droppedAudio + 1, notice: 'Playback fell behind, so some assistant audio was dropped.' })
        } else if (!this.status.responding) this.set({ responding: true })
        break
      }
      case 'error': {
        const message = (frame.error as { message?: unknown } | undefined)?.message
        this.set({ notice: `The voice provider reported a problem${typeof message === 'string' ? `: ${message.slice(0, 200)}` : '.'}` })
        break
      }
      default:
        break
    }
  }

  private markReady(run: VoiceRun) {
    run.ready = true
    this.deps.clearTimer(run.readyTimer)
    run.readyTimer = null
    if (!this.lifecycle.activate(run.operation)) return
    try {
      run.socket?.send(JSON.stringify({
        type: 'session.update',
        session: {
          turn_detection: { type: 'server_vad' },
          audio: {
            input: { format: { type: 'audio/pcm', rate: VOICE_SAMPLE_RATE } },
            output: { format: { type: 'audio/pcm', rate: VOICE_SAMPLE_RATE } },
          },
        },
      }))
    } catch { /* the close handler reports the lost connection */ }
    this.set({ phase: 'live', step: 'ready' })
  }

  private onClose(run: VoiceRun, code: number) {
    if (!this.isCurrent(run)) return
    const wasLive = run.ready
    const problem = closeProblem(code, run.serverError)
    this.teardown()
    this.reset(problem.failure || !wasLive ? { ...IDLE_VOICE, error: problem.text } : { ...IDLE_VOICE, notice: problem.text })
  }

  private failFromApi(run: VoiceRun, failure: ApiFailure) {
    if (!this.isCurrent(run) || failure.reason === 'aborted') return
    if (failure.reason === 'unauthorized') {
      this.hooks.onAuthLost()
      this.fail(run, 'Your session ended, so the call was not started.')
      return
    }
    this.fail(run, failure.message)
  }

  private fail(run: VoiceRun, message: string) {
    if (!this.isCurrent(run)) return
    this.teardown()
    this.reset({ ...IDLE_VOICE, error: message })
  }

  /** Releases every local resource immediately; the server session end is observed separately and never gates this. */
  private teardown() {
    const run = this.run
    this.run = null
    if (run) {
      this.deps.clearTimer(run.readyTimer)
      run.readyTimer = null
      run.abort.abort()
      const socket = run.socket
      run.socket = null
      try { socket?.close(1000, 'client_stop') } catch { /* already closed */ }
      run.audio.flush()
      run.audio.close()
      run.orphaned = run.creating
    }
    this.lifecycle.release()
    if (run?.orphaned) this.cleanup.orphan()
    if (run?.sessionId) this.cleanup.track(run.projectId, run.sessionId)
  }
}

// ---------------------------------------------------------------------------
// Screen channel
// ---------------------------------------------------------------------------

export type ScreenInspection = { result: Inspection; receivedAt: number }
export type ScreenStatus = {
  phase: 'idle' | 'starting' | 'sharing'
  step: 'permission' | 'session' | 'preview' | null
  error: string | null
  notice: string | null
  framesSent: number
  framesDropped: number
  lastFrame: { frameId: string; width: number; height: number; capturedAt: string } | null
  inspecting: boolean
  inspection: ScreenInspection | null
  cleanup: CleanupState
}
const IDLE_SCREEN: ScreenStatus = {
  phase: 'idle', step: null, error: null, notice: null, framesSent: 0, framesDropped: 0, lastFrame: null, inspecting: false, inspection: null, cleanup: IDLE_CLEANUP,
}

type ScreenRun = {
  projectId: string
  operation: number
  abort: AbortController
  sessionId: string | null
  source: FrameSource | null
  maxWidth: number
  sequence: number
  lastTimestamp: number
  consecutiveFailures: number
  retryAfterMs: number
  sleepTimer: unknown
  wake: (() => void) | null
  creating: boolean
  orphaned: boolean
}

export class ScreenChannel extends Store<ScreenStatus> {
  private run: ScreenRun | null = null
  private readonly lifecycle = new MediaLifecycle(() => undefined)
  private readonly cleanup: SessionCleanup

  constructor(private readonly deps: MediaDeps, private readonly hooks: MediaHooks) {
    super(IDLE_SCREEN)
    this.cleanup = new SessionCleanup(
      (projectId, sessionId) => deps.api.endCaptureSession(projectId, sessionId, new AbortController().signal),
      () => this.set({ cleanup: this.cleanup.state }),
      () => hooks.onAuthLost(),
      'screen share',
    )
  }

  /** Explicit retry for a capture session Ranger could not confirm ended. */
  retryCleanup(): Promise<void> { return this.cleanup.retry() }

  /** Must be called from a click handler: the display picker needs the gesture. */
  async start(target: MediaTarget): Promise<void> {
    if (this.run) return
    if (this.cleanup.unresolved) {
      this.set({ notice: 'The previous screen share is still being ended on Ranger. Wait for it, or retry ending it, before sharing again.' })
      return
    }
    const devices = this.deps.mediaDevices()
    if (!devices || typeof devices.getDisplayMedia !== 'function') {
      this.reset({ ...IDLE_SCREEN, error: 'This browser cannot share a screen.' })
      return
    }
    const operation = this.lifecycle.begin()
    if (operation === null) return
    const run: ScreenRun = {
      projectId: target.projectId, operation, abort: new AbortController(), sessionId: null, source: null,
      maxWidth: FRAME_MAX_WIDTH, sequence: 0, lastTimestamp: 0, consecutiveFailures: 0, retryAfterMs: 0, sleepTimer: null, wake: null, creating: false, orphaned: false,
    }
    this.run = run
    this.reset({ ...IDLE_SCREEN, phase: 'starting', step: 'permission' })

    let stream: MediaStream
    try {
      stream = await devices.getDisplayMedia({ video: { frameRate: { ideal: 2, max: CAPTURE_LIMITS.maxUploadsPerSecond } }, audio: false })
    } catch (error) {
      this.fail(run, deviceProblem(error, 'screen'))
      return
    }
    if (!this.lifecycle.attach(operation, stream)) return
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        if (this.isCurrent(run)) this.stop('Screen sharing was stopped in the browser.')
      })
    }
    this.set({ step: 'session' })

    // Not tied to the run's abort signal: a session created after cancellation must be ended, not orphaned.
    run.creating = true
    const started = await this.deps.api.startCaptureSession(target.projectId, target.conversationId, new AbortController().signal)
    run.creating = false
    if (run.orphaned) {
      if (started.ok) this.cleanup.track(target.projectId, started.data.sessionId)
      this.cleanup.settleOrphan()
      return
    }
    if (!started.ok) { this.failFromApi(run, started); return }
    if (!this.lifecycle.setSession(operation, started.data.sessionId)) {
      this.cleanup.track(target.projectId, started.data.sessionId)
      return
    }
    run.sessionId = started.data.sessionId
    this.set({ step: 'preview' })

    const source = this.deps.createFrameSource(stream)
    run.source = source
    try {
      await source.ready()
    } catch {
      this.fail(run, 'The shared screen did not produce any video.')
      return
    }
    if (!this.isCurrent(run) || !this.lifecycle.activate(operation)) return
    this.set({ phase: 'sharing', step: null })
    void this.pump(run)
  }

  /** On-demand only: one real inspection request per call, tied to the frame Ranger currently holds. */
  async inspect(): Promise<void> {
    const run = this.run
    if (!run || !run.sessionId || this.status.phase !== 'sharing' || this.status.inspecting) return
    if (this.status.framesSent === 0) { this.set({ notice: 'No frame has reached Ranger yet. Wait a moment and try again.' }); return }
    this.set({ inspecting: true, notice: null })
    const result = await this.deps.api.requestInspection(run.projectId, run.sessionId, run.abort.signal)
    if (!this.isCurrent(run)) return
    if (!result.ok) {
      if (result.reason === 'aborted') return
      this.set({ inspecting: false })
      if (result.reason === 'unauthorized') { this.hooks.onAuthLost(); this.fail(run, 'Your session ended, so screen sharing was stopped.'); return }
      if (result.detail === 'capture_ended') { this.stop('The capture session ended on Ranger.'); return }
      this.set({
        notice: result.detail === 'superseded_frame'
          ? 'A newer frame arrived while Ranger was looking, so that result was discarded. Try again.'
          : `Inspection failed: ${result.message}`,
      })
      return
    }
    this.set({ inspecting: false, inspection: { result: result.data, receivedAt: this.deps.now() } })
  }

  stop(notice?: string): void {
    const active = this.run !== null
    this.teardown()
    this.reset({ ...IDLE_SCREEN, notice: active ? notice ?? null : null })
  }

  private isCurrent(run: ScreenRun) { return this.run === run }

  private async pump(run: ScreenRun) {
    while (this.isCurrent(run)) {
      const started = this.deps.now()
      await this.captureOnce(run)
      if (!this.isCurrent(run)) return
      const wait = Math.max(run.retryAfterMs, FRAME_INTERVAL_MS - (this.deps.now() - started))
      run.retryAfterMs = 0
      await this.sleep(run, wait)
    }
  }

  private sleep(run: ScreenRun, ms: number): Promise<void> {
    return new Promise(resolve => {
      run.wake = resolve
      run.sleepTimer = this.deps.setTimer(() => { run.wake = null; resolve() }, ms)
    })
  }

  /** One frame at a time: nothing is grabbed while an upload is in flight, so superseded frames never exist. */
  private async captureOnce(run: ScreenRun) {
    const source = run.source
    if (!source || !run.sessionId) return
    let frame: GrabbedFrame | null
    try { frame = await source.grab(run.maxWidth, FRAME_JPEG_QUALITY) } catch { frame = null }
    if (!this.isCurrent(run)) return
    if (!frame) { this.set({ framesDropped: this.status.framesDropped + 1 }); return }
    if (frame.bytes.length > CAPTURE_LIMITS.maxFrameBytes) {
      run.maxWidth = Math.max(FRAME_MIN_WIDTH, Math.floor(run.maxWidth * 0.75))
      this.set({ framesDropped: this.status.framesDropped + 1 })
      return
    }
    const timestamp = Math.max(this.deps.now(), run.lastTimestamp + 1)
    run.lastTimestamp = timestamp
    run.sequence += 1
    const frameId = `${run.sessionId.slice(4, 12)}-${run.sequence}`
    const captureTimestamp = new Date(timestamp).toISOString()
    const result = await this.deps.api.ingestCaptureFrame(
      { projectId: run.projectId, sessionId: run.sessionId, frameId, imageBase64: bytesToBase64(frame.bytes), captureTimestamp },
      run.abort.signal,
    )
    if (!this.isCurrent(run)) return

    if (result.ok) {
      run.consecutiveFailures = 0
      this.set({
        framesSent: this.status.framesSent + 1,
        lastFrame: { frameId, width: result.data.width, height: result.data.height, capturedAt: captureTimestamp },
        notice: null,
      })
      return
    }
    if (result.reason === 'aborted') return
    if (result.reason === 'unauthorized') { this.hooks.onAuthLost(); this.fail(run, 'Your session ended, so screen sharing was stopped.'); return }
    if (result.detail === 'capture_ended' || result.code === 'not_found') { this.stop('The capture session ended on Ranger, so sharing stopped.'); return }
    this.set({ framesDropped: this.status.framesDropped + 1 })
    if (result.code === 'rate_limited') { run.retryAfterMs = result.retryAfterMs ?? FRAME_INTERVAL_MS; return }
    if (result.detail === 'out_of_order_frame' || result.detail === 'duplicate_frame_id') return
    if (result.detail === 'frame_too_large') { run.maxWidth = Math.max(FRAME_MIN_WIDTH, Math.floor(run.maxWidth * 0.75)); return }
    run.consecutiveFailures += 1
    if (run.consecutiveFailures >= MAX_CONSECUTIVE_UPLOAD_FAILURES) {
      this.fail(run, `Frame uploads kept failing, so sharing stopped. ${result.message}`)
      return
    }
    this.set({ notice: `A frame was not accepted: ${result.message}` })
  }

  private failFromApi(run: ScreenRun, failure: ApiFailure) {
    if (!this.isCurrent(run) || failure.reason === 'aborted') return
    if (failure.reason === 'unauthorized') {
      this.hooks.onAuthLost()
      this.fail(run, 'Your session ended, so screen sharing was not started.')
      return
    }
    this.fail(run, failure.message)
  }

  private fail(run: ScreenRun, message: string) {
    if (!this.isCurrent(run)) return
    this.teardown()
    this.reset({ ...IDLE_SCREEN, error: message })
  }

  private teardown() {
    const run = this.run
    this.run = null
    if (run) {
      this.deps.clearTimer(run.sleepTimer)
      run.abort.abort()
      run.wake?.()
      run.wake = null
      run.source?.dispose()
      run.source = null
      run.orphaned = run.creating
    }
    this.lifecycle.release()
    if (run?.orphaned) this.cleanup.orphan()
    if (run?.sessionId) this.cleanup.track(run.projectId, run.sessionId)
  }
}

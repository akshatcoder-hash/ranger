import { describe, expect, it, vi } from 'vitest'
import type { ApiFailure, ApiResult, Inspection } from './api'
import {
  CAPTURE_LIMITS,
  FRAME_INTERVAL_MS,
  FRAME_MAX_WIDTH,
  PCM_CAPTURE_WORKLET,
  PcmPlayer,
  ScreenChannel,
  VOICE_MAX_SEND_BUFFER_BYTES,
  VoiceChannel,
  base64ToPcm16,
  browserMediaDeps,
  bytesToBase64,
  pcm16ToBase64,
  providerGate,
  type FrameSource,
  type GrabbedFrame,
  type MediaApi,
  type MediaDeps,
  type SocketHandlers,
  type SocketLike,
  type VoiceAudio,
} from './media'

// Every device, socket, audio engine and timer below is a labelled local fake: no real device, network or provider is involved.

const PROJECT = 'prj_11111111-1111-1111-1111-111111111111'
const CONVERSATION = 'cnv_22222222-2222-2222-2222-222222222222'
const VOICE = 'vcs_44444444-4444-4444-4444-444444444444'
const VOICE_2 = 'vcs_66666666-6666-6666-6666-666666666666'
const CAPTURE = 'cap_55555555-5555-5555-5555-555555555555'
const TARGET = { projectId: PROJECT, conversationId: CONVERSATION }

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const good = <T,>(data: T): ApiResult<T> => ({ ok: true, data })
const bad = (patch: Partial<ApiFailure> = {}): ApiFailure => ({ ok: false, reason: 'backend', message: 'rejected', ...patch })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function fakeStream(kind: 'audio' | 'video' = 'audio') {
  const stop = vi.fn()
  const ended: (() => void)[] = []
  const track = { stop, addEventListener: (_: string, listener: () => void) => { ended.push(listener) } } as unknown as MediaStreamTrack
  const stream = { getTracks: () => [track], getVideoTracks: () => (kind === 'video' ? [track] : []) } as unknown as MediaStream
  return { stream, stop, endFromBrowser: () => ended.forEach(listener => listener()) }
}

function scheduler() {
  let next = 0
  const pending = new Map<number, { callback: () => void; ms: number }>()
  return {
    pending,
    setTimer: (callback: () => void, ms: number) => { next += 1; pending.set(next, { callback, ms }); return next },
    clearTimer: (handle: unknown) => { pending.delete(handle as number) },
    lastMs: () => [...pending.values()].at(-1)?.ms,
    fire() {
      const entry = [...pending.entries()].at(-1)
      if (!entry) throw new Error('no pending timer')
      pending.delete(entry[0])
      entry[1].callback()
    },
  }
}

class FakeSocket implements SocketLike {
  readyState = 1
  bufferedAmount = 0
  sent: Record<string, unknown>[] = []
  close = vi.fn((_code?: number, _reason?: string) => { this.readyState = 3 })
  constructor(readonly url: string, readonly handlers: SocketHandlers) {}
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>) }
  frame(value: unknown) { this.handlers.onMessage(JSON.stringify(value)) }
}

function fakeAudio() {
  let onChunk: ((pcm: Int16Array) => void) | null = null
  const audio = {
    start: vi.fn(async (_stream: MediaStream, callback: (pcm: Int16Array) => void) => { onChunk = callback }),
    play: vi.fn((_pcm: Int16Array) => true),
    flush: vi.fn(),
    close: vi.fn(),
    queuedMs: 0,
  }
  return { audio: audio as VoiceAudio & typeof audio, chunk: (pcm: Int16Array) => onChunk?.(pcm) }
}

function fakeFrameSource() {
  let sequence = 0
  const source = {
    ready: vi.fn(async () => undefined),
    grab: vi.fn(async (_width: number, _quality: number): Promise<GrabbedFrame | null> => {
      sequence += 1
      return { bytes: new Uint8Array([0xff, 0xd8, 0xff, sequence]), mimeType: 'image/jpeg', width: 640, height: 360 }
    }),
    dispose: vi.fn(),
  }
  return source satisfies FrameSource
}

function setup(options: { audio?: boolean; devices?: boolean } = {}) {
  const sched = scheduler()
  const sockets: FakeSocket[] = []
  const clock = { value: Date.parse('2026-01-01T00:00:10.000Z') }
  const audioParts = fakeAudio()
  const source = fakeFrameSource()
  const mic = fakeStream('audio')
  const display = fakeStream('video')
  const getUserMedia = vi.fn(async () => mic.stream)
  const getDisplayMedia = vi.fn(async () => display.stream)
  const api = {
    startVoiceSession: vi.fn<MediaApi['startVoiceSession']>(async () => good({ sessionId: VOICE, model: 'm', expiresAt: 'x' })),
    createRelayTicket: vi.fn<MediaApi['createRelayTicket']>(async () => good({ ticket: 'tkt-secret' })),
    cancelVoiceResponse: vi.fn<MediaApi['cancelVoiceResponse']>(async () => good({ interrupted: true })),
    endVoiceSession: vi.fn<MediaApi['endVoiceSession']>(async () => good(undefined)),
    startCaptureSession: vi.fn<MediaApi['startCaptureSession']>(async () => good({ sessionId: CAPTURE, generation: 1 })),
    ingestCaptureFrame: vi.fn<MediaApi['ingestCaptureFrame']>(async request => good({ frameId: request.frameId, width: 640, height: 360, byteSize: 4, captureTimestamp: request.captureTimestamp })),
    requestInspection: vi.fn<MediaApi['requestInspection']>(async () => good(observed())),
    endCaptureSession: vi.fn<MediaApi['endCaptureSession']>(async () => good(undefined)),
  }
  const deps: MediaDeps = {
    api,
    mediaDevices: () => (options.devices === false ? undefined : { getUserMedia, getDisplayMedia } as unknown as MediaDevices),
    createAudio: () => (options.audio === false ? null : audioParts.audio),
    createSocket: (url, handlers) => { const socket = new FakeSocket(url, handlers); sockets.push(socket); return socket },
    createFrameSource: () => source,
    relayUrl: (project, session, ticket) => `ws://fake/${project}/${session}?ticket=${ticket}`,
    now: () => clock.value,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
  }
  const hooks = { onAuthLost: vi.fn() }
  const voice = new VoiceChannel(deps, hooks)
  const screen = new ScreenChannel(deps, hooks)
  return { deps, api, hooks, voice, screen, sched, sockets, clock, audio: audioParts, source, mic, display, getUserMedia, getDisplayMedia }
}

function observed(): Inspection {
  return {
    state: 'observed',
    observations: [{ text: 'A terminal shows a failing test.', uncertainty: 0.3, sourceFrameId: 'f', sourceTimestamp: '2026-01-01T00:00:10.000Z' }],
    sourceFrameId: 'f',
    sourceTimestamp: '2026-01-01T00:00:10.000Z',
    freshness: 'current',
  }
}

async function goLive(ctx: ReturnType<typeof setup>) {
  await ctx.voice.start(TARGET)
  const socket = ctx.sockets[0]
  socket.handlers.onOpen()
  await tick()
  socket.frame({ type: 'session.created' })
  return socket
}

describe('voice transport', () => {
  it('builds browser dependencies and idle channels without touching a device, socket or the network', () => {
    const getUserMedia = vi.fn()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, getDisplayMedia: getUserMedia } })
    vi.stubGlobal('fetch', vi.fn())
    const deps = browserMediaDeps()
    const voice = new VoiceChannel(deps, { onAuthLost: vi.fn() })
    const screen = new ScreenChannel(deps, { onAuthLost: vi.fn() })

    expect(voice.status.phase).toBe('idle')
    expect(screen.status.phase).toBe('idle')
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('walks permission, session, ticket and relay, and is not live until a relayed frame arrives', async () => {
    const ctx = setup()

    const starting = ctx.voice.start(TARGET)
    expect(ctx.voice.status).toMatchObject({ phase: 'starting', step: 'permission' })
    await starting

    expect(ctx.api.startVoiceSession).toHaveBeenCalledWith(PROJECT, CONVERSATION, expect.anything())
    expect(ctx.api.createRelayTicket).toHaveBeenCalledWith(PROJECT, expect.anything())
    expect(ctx.sockets[0].url).toBe(`ws://fake/${PROJECT}/${VOICE}?ticket=tkt-secret`)
    expect(ctx.voice.status).toMatchObject({ phase: 'starting', step: 'relay' })

    ctx.sockets[0].handlers.onOpen()
    await tick()
    expect(ctx.audio.audio.start).toHaveBeenCalledTimes(1)
    expect(ctx.voice.status.phase).toBe('starting')

    ctx.sockets[0].frame({ type: 'session.created' })
    expect(ctx.voice.status).toMatchObject({ phase: 'live', step: 'ready' })
    expect(ctx.sockets[0].sent[0]).toEqual({
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },
        audio: { input: { format: { type: 'audio/pcm', rate: 24000 } }, output: { format: { type: 'audio/pcm', rate: 24000 } } },
      },
    })
    expect(JSON.stringify(ctx.api.startVoiceSession.mock.calls)).not.toContain('getTracks')
  })

  it('sends microphone PCM as base64 append frames only after ready and drops it when the socket is backed up', async () => {
    const ctx = setup()
    await ctx.voice.start(TARGET)
    const socket = ctx.sockets[0]
    socket.handlers.onOpen()
    await tick()
    const pcm = new Int16Array([1, -2, 256, 32767, -32768])

    ctx.audio.chunk(pcm)
    expect(socket.sent).toHaveLength(0)

    socket.frame({ type: 'session.created' })
    ctx.audio.chunk(pcm)
    expect(socket.sent.at(-1)).toEqual({ type: 'input_audio_buffer.append', audio: pcm16ToBase64(pcm) })
    expect(Array.from(base64ToPcm16(String(socket.sent.at(-1)?.audio)) ?? [])).toEqual(Array.from(pcm))

    const before = socket.sent.length
    socket.bufferedAmount = VOICE_MAX_SEND_BUFFER_BYTES + 1
    ctx.audio.chunk(pcm)
    expect(socket.sent).toHaveLength(before)
  })

  it('plays assistant audio from both documented delta event names and ignores malformed audio', async () => {
    const ctx = setup()
    const socket = await goLive(ctx)
    const pcm = new Int16Array([100, -100, 5000])

    socket.frame({ type: 'response.output_audio.delta', delta: pcm16ToBase64(pcm) })
    socket.frame({ type: 'response.audio.delta', delta: pcm16ToBase64(pcm) })
    socket.frame({ type: 'response.output_audio.delta', delta: '***not base64***' })
    socket.frame({ type: 'response.output_audio.delta' })
    socket.handlers.onMessage('not json')

    expect(ctx.audio.audio.play).toHaveBeenCalledTimes(2)
    expect(Array.from(ctx.audio.audio.play.mock.calls[0][0])).toEqual([100, -100, 5000])
    expect(ctx.voice.status.phase).toBe('live')
  })

  it('reports dropped playback when the bounded queue refuses audio', async () => {
    const ctx = setup()
    const socket = await goLive(ctx)
    ctx.audio.audio.play.mockReturnValue(false)

    socket.frame({ type: 'response.output_audio.delta', delta: pcm16ToBase64(new Int16Array([1, 2])) })

    expect(ctx.voice.status.droppedAudio).toBe(1)
    expect(ctx.voice.status.notice).toContain('dropped')
  })

  it('interrupts by flushing local playback and cancelling only the voice response', async () => {
    const ctx = setup()
    const socket = await goLive(ctx)
    const delta = pcm16ToBase64(new Int16Array([7, 8]))
    socket.frame({ type: 'response.created' })

    await ctx.voice.interrupt()

    expect(ctx.audio.audio.flush).toHaveBeenCalled()
    expect(ctx.api.cancelVoiceResponse).toHaveBeenCalledWith(PROJECT, VOICE, expect.anything())
    expect(ctx.api.endVoiceSession).not.toHaveBeenCalled()
    expect(ctx.voice.status).toMatchObject({ phase: 'live', responding: false })

    ctx.audio.audio.play.mockClear()
    socket.frame({ type: 'response.output_audio.delta', delta })
    expect(ctx.audio.audio.play).not.toHaveBeenCalled()

    socket.frame({ type: 'response.created' })
    socket.frame({ type: 'response.output_audio.delta', delta })
    expect(ctx.audio.audio.play).toHaveBeenCalledTimes(1)
  })

  it('flushes playback on server cancellation and on user barge-in', async () => {
    const ctx = setup()
    const socket = await goLive(ctx)

    socket.frame({ type: 'response.cancelled', sessionId: VOICE })
    socket.frame({ type: 'input_audio_buffer.speech_started' })

    expect(ctx.audio.audio.flush).toHaveBeenCalledTimes(2)
  })

  it('ends the session and releases everything on a provider disconnect, then starts a fresh session with no replay', async () => {
    const ctx = setup()
    const socket = await goLive(ctx)

    socket.frame({ kind: 'error', error: { code: 'conflict', message: 'The provider connection dropped.' } })
    socket.handlers.onClose(4503)

    expect(ctx.voice.status).toMatchObject({ phase: 'idle', error: 'The provider connection dropped.' })
    expect(ctx.mic.stop).toHaveBeenCalledTimes(1)
    expect(ctx.audio.audio.close).toHaveBeenCalled()
    expect(ctx.api.endVoiceSession).toHaveBeenCalledWith(PROJECT, VOICE, expect.anything())

    await vi.waitFor(() => expect(ctx.voice.status.cleanup.phase).toBe('idle'))
    ctx.api.startVoiceSession.mockResolvedValueOnce(good({ sessionId: VOICE_2, model: 'm', expiresAt: 'x' }))
    await ctx.voice.start(TARGET)
    expect(ctx.sockets).toHaveLength(2)
    expect(ctx.sockets[1].url).toContain(VOICE_2)
    expect(ctx.sockets[1].sent).toHaveLength(0)
    expect(ctx.api.createRelayTicket).toHaveBeenCalledTimes(2)
  })

  it.each([
    [4401, 'rejected the call connection'],
    [4408, 'time limit'],
    [4409, 'already ended'],
    [4502, 'keep up'],
    [1006, 'dropped'],
  ])('explains relay close code %i without pretending the call is still live', async (code, text) => {
    const ctx = setup()
    const socket = await goLive(ctx)

    socket.handlers.onClose(code)

    const shown = ctx.voice.status.error ?? ctx.voice.status.notice
    expect(ctx.voice.status.phase).toBe('idle')
    expect(shown).toContain(text)
  })

  it('treats a relay that closes before any provider frame as a failed start', async () => {
    const ctx = setup()
    await ctx.voice.start(TARGET)
    ctx.sockets[0].handlers.onClose(4503)

    expect(ctx.voice.status).toMatchObject({ phase: 'idle' })
    expect(ctx.voice.status.error).toContain('unavailable')
    expect(ctx.mic.stop).toHaveBeenCalled()
  })

  it('gives up when the relay never produces a provider frame', async () => {
    const ctx = setup()
    await ctx.voice.start(TARGET)

    ctx.sched.fire()

    expect(ctx.voice.status.phase).toBe('idle')
    expect(ctx.voice.status.error).toContain('did not become ready')
    expect(ctx.sockets[0].close).toHaveBeenCalled()
    expect(ctx.api.endVoiceSession).toHaveBeenCalledWith(PROJECT, VOICE, expect.anything())
  })

  it('stays honest when permission is denied, no device exists, or the browser lacks audio support', async () => {
    const denied = setup()
    denied.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    await denied.voice.start(TARGET)
    expect(denied.voice.status).toMatchObject({ phase: 'idle', error: expect.stringContaining('not granted') })
    expect(denied.api.startVoiceSession).not.toHaveBeenCalled()
    expect(denied.sockets).toHaveLength(0)
    expect(denied.audio.audio.close).toHaveBeenCalled()

    const missing = setup()
    missing.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotFoundError' }))
    await missing.voice.start(TARGET)
    expect(missing.voice.status.error).toContain('No microphone')

    const noApi = setup({ devices: false })
    await noApi.voice.start(TARGET)
    expect(noApi.voice.status.error).toContain('cannot capture')
    expect(noApi.getUserMedia).not.toHaveBeenCalled()

    const noAudio = setup({ audio: false })
    await noAudio.voice.start(TARGET)
    expect(noAudio.voice.status.error).toContain('AudioWorklet')
    expect(noAudio.getUserMedia).not.toHaveBeenCalled()
  })

  it('stops a microphone grant that arrives after cancellation and never starts a session', async () => {
    const ctx = setup()
    const grant = deferred<MediaStream>()
    ctx.getUserMedia.mockReturnValueOnce(grant.promise)

    const starting = ctx.voice.start(TARGET)
    ctx.voice.stop()
    grant.resolve(ctx.mic.stream)
    await starting

    expect(ctx.mic.stop).toHaveBeenCalledTimes(1)
    expect(ctx.api.startVoiceSession).not.toHaveBeenCalled()
    expect(ctx.voice.status.phase).toBe('idle')
    expect(ctx.audio.audio.close).toHaveBeenCalled()
  })

  it('ends a session that was created after the call was cancelled instead of opening a relay', async () => {
    const ctx = setup()
    const created = deferred<ApiResult<{ sessionId: string; model: string; expiresAt: string }>>()
    ctx.api.startVoiceSession.mockReturnValueOnce(created.promise)

    const starting = ctx.voice.start(TARGET)
    await tick()
    ctx.voice.stop()
    created.resolve(good({ sessionId: VOICE, model: 'm', expiresAt: 'x' }))
    await starting

    expect(ctx.api.endVoiceSession).toHaveBeenCalledWith(PROJECT, VOICE, expect.anything())
    expect(ctx.api.createRelayTicket).not.toHaveBeenCalled()
    expect(ctx.sockets).toHaveLength(0)
    expect(ctx.mic.stop).toHaveBeenCalled()
  })

  it('cleans up on route change or unmount and ignores everything the old relay says afterwards', async () => {
    const ctx = setup()
    const socket = await goLive(ctx)

    ctx.voice.stop('Left the project.')

    expect(socket.close).toHaveBeenCalled()
    expect(ctx.mic.stop).toHaveBeenCalledTimes(1)
    expect(ctx.audio.audio.close).toHaveBeenCalled()
    expect(ctx.api.endVoiceSession).toHaveBeenCalledTimes(1)
    expect(ctx.api.endVoiceSession).toHaveBeenCalledWith(PROJECT, VOICE, expect.anything())
    expect(ctx.voice.status).toMatchObject({ phase: 'idle', notice: 'Left the project.' })

    ctx.audio.audio.play.mockClear()
    socket.frame({ type: 'response.output_audio.delta', delta: pcm16ToBase64(new Int16Array([1])) })
    socket.handlers.onClose(4503)
    ctx.audio.chunk(new Int16Array([1]))
    expect(ctx.audio.audio.play).not.toHaveBeenCalled()
    expect(socket.sent.filter(frame => frame.type === 'input_audio_buffer.append')).toHaveLength(0)
    expect(ctx.voice.status).toMatchObject({ phase: 'idle', notice: 'Left the project.', error: null })
  })

  it('signals auth loss and ends the created session when the ticket is refused as unauthorized', async () => {
    const ctx = setup()
    ctx.api.createRelayTicket.mockResolvedValueOnce(bad({ reason: 'unauthorized', message: 'no' }))

    await ctx.voice.start(TARGET)

    expect(ctx.hooks.onAuthLost).toHaveBeenCalledTimes(1)
    expect(ctx.voice.status.phase).toBe('idle')
    expect(ctx.sockets).toHaveLength(0)
    expect(ctx.api.endVoiceSession).toHaveBeenCalledWith(PROJECT, VOICE, expect.anything())
    expect(ctx.mic.stop).toHaveBeenCalled()
  })

  it('does not mark a call active just because the session row exists', async () => {
    const ctx = setup()
    const ticket = deferred<ApiResult<{ ticket: string }>>()
    ctx.api.createRelayTicket.mockReturnValueOnce(ticket.promise)

    const starting = ctx.voice.start(TARGET)
    await tick()

    expect(ctx.api.startVoiceSession).toHaveBeenCalled()
    expect(ctx.voice.status.phase).toBe('starting')
    ticket.resolve(good({ ticket: 't' }))
    await starting
    expect(ctx.voice.status.phase).toBe('starting')
  })
})

describe('playback queue and worklet', () => {
  function fakeContext() {
    const started: { when: number; stopped: boolean; source: Record<string, unknown> }[] = []
    const context = {
      currentTime: 0,
      createBuffer: (_channels: number, length: number) => ({ length, copyToChannel: vi.fn() }),
      createBufferSource: () => {
        const entry = { when: -1, stopped: false, source: {} as Record<string, unknown> }
        const source = {
          buffer: null,
          onended: null as null | (() => void),
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: (when: number) => { entry.when = when },
          stop: () => { entry.stopped = true },
        }
        entry.source = source
        started.push(entry)
        return source
      },
    }
    return { context: context as unknown as AudioContext, raw: context, started }
  }

  it('schedules chunks back to back, bounds the queue, and flush stops everything scheduled', () => {
    const { context, started } = fakeContext()
    const player = new PcmPlayer(context, {} as AudioNode, 24000, 1)
    const half = new Int16Array(12000)

    expect(player.enqueue(half)).toBe(true)
    expect(player.enqueue(half)).toBe(false)
    expect(started).toHaveLength(1)
    expect(player.queuedMs).toBeGreaterThan(500)

    player.flush()
    expect(started.every(entry => entry.stopped)).toBe(true)
    expect(player.queuedMs).toBe(0)
    expect(player.enqueue(half)).toBe(true)
  })

  it('converts captured audio to little-endian PCM16 chunks, resampling when the context rate differs', () => {
    const run = (rate: number, input: Float32Array) => {
      const messages: Int16Array[] = []
      class Base { port = { postMessage: (buffer: ArrayBuffer) => messages.push(new Int16Array(buffer)) } }
      let Processor: new () => { process(inputs: Float32Array[][]): boolean } = Base as never
      new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', PCM_CAPTURE_WORKLET)(
        Base,
        (_name: string, ctor: typeof Processor) => { Processor = ctor },
        rate,
      )
      const processor = new Processor()
      for (let offset = 0; offset < input.length; offset += 128) processor.process([[input.subarray(offset, offset + 128)]])
      return messages
    }

    const direct = new Float32Array(960)
    direct[0] = 1
    direct[1] = -1
    direct[2] = 0.5
    const same = run(24000, direct)
    expect(same).toHaveLength(1)
    expect(Array.from(same[0].subarray(0, 3))).toEqual([32767, -32768, 16384])

    const doubled = run(48000, new Float32Array(1920).fill(0.5))
    expect(doubled).toHaveLength(1)
    expect(doubled[0]).toHaveLength(960)
    expect(Math.abs(doubled[0][500] - 16384)).toBeLessThanOrEqual(1)
  })

  it('gates provider-dependent actions on known availability only', () => {
    expect(providerGate('idle', null)).not.toBeNull()
    expect(providerGate('loading', null)).not.toBeNull()
    expect(providerGate('error', null)).toContain('could not be checked')
    expect(providerGate('ready', { xai: false, instabox: true, trace: true })).toContain('not configured')
    expect(providerGate('ready', { xai: true, instabox: false, trace: false })).toBeNull()
  })
})

describe('screen transport', () => {
  async function share(ctx = setup()) {
    await ctx.screen.start(TARGET)
    await tick()
    return ctx
  }

  it('requests the display only on start, creates a capture session and uploads a JPEG frame with its id and capture time', async () => {
    const ctx = setup()
    expect(ctx.getDisplayMedia).not.toHaveBeenCalled()

    await share(ctx)

    expect(ctx.getDisplayMedia).toHaveBeenCalledTimes(1)
    expect(ctx.getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }))
    expect(ctx.api.startCaptureSession).toHaveBeenCalledWith(PROJECT, CONVERSATION, expect.anything())
    expect(ctx.api.ingestCaptureFrame).toHaveBeenCalledTimes(1)
    const request = ctx.api.ingestCaptureFrame.mock.calls[0][0]
    expect(request).toMatchObject({ projectId: PROJECT, sessionId: CAPTURE, captureTimestamp: '2026-01-01T00:00:10.000Z' })
    expect(request.frameId).toMatch(/^[\w-]{1,200}$/)
    expect(request.imageBase64).toBe(bytesToBase64(new Uint8Array([0xff, 0xd8, 0xff, 1])))
    expect(ctx.screen.status).toMatchObject({ phase: 'sharing', framesSent: 1, lastFrame: { width: 640, height: 360 } })
    expect(ctx.source.grab).toHaveBeenCalledWith(FRAME_MAX_WIDTH, expect.any(Number))
  })

  it('stays within the documented upload rate and never grabs a frame while an upload is in flight', async () => {
    expect(1000 / FRAME_INTERVAL_MS).toBeLessThanOrEqual(CAPTURE_LIMITS.maxUploadsPerSecond)
    const ctx = setup()
    const upload = deferred<ApiResult<{ frameId: string; width: number; height: number; byteSize: number; captureTimestamp: string }>>()
    ctx.api.ingestCaptureFrame.mockReturnValueOnce(upload.promise)

    await ctx.screen.start(TARGET)
    await tick()
    expect(ctx.source.grab).toHaveBeenCalledTimes(1)
    expect(ctx.sched.pending.size).toBe(0)

    upload.resolve(good({ frameId: 'f', width: 640, height: 360, byteSize: 4, captureTimestamp: 'x' }))
    await tick()
    expect(ctx.sched.lastMs()).toBe(FRAME_INTERVAL_MS)
    expect(ctx.source.grab).toHaveBeenCalledTimes(1)

    ctx.sched.fire()
    await tick()
    expect(ctx.source.grab).toHaveBeenCalledTimes(2)
  })

  it('keeps capture timestamps strictly increasing even when the clock does not move', async () => {
    const ctx = await share()
    ctx.sched.fire()
    await tick()

    const [first, second] = ctx.api.ingestCaptureFrame.mock.calls.map(call => Date.parse(call[0].captureTimestamp))
    expect(second).toBe(first + 1)
    expect(ctx.api.ingestCaptureFrame.mock.calls[0][0].frameId).not.toBe(ctx.api.ingestCaptureFrame.mock.calls[1][0].frameId)
  })

  it('shrinks and skips oversized frames instead of uploading them', async () => {
    const ctx = setup()
    ctx.source.grab.mockResolvedValueOnce({ bytes: new Uint8Array(CAPTURE_LIMITS.maxFrameBytes + 1), mimeType: 'image/jpeg', width: 640, height: 360 })

    await share(ctx)

    expect(ctx.api.ingestCaptureFrame).not.toHaveBeenCalled()
    expect(ctx.screen.status.framesDropped).toBe(1)
    ctx.sched.fire()
    await tick()
    expect(ctx.source.grab.mock.calls[1][0]).toBeLessThan(FRAME_MAX_WIDTH)
  })

  it('backs off for the server retry hint on a rate limit and skips frames the server ordered out', async () => {
    const ctx = setup()
    ctx.api.ingestCaptureFrame.mockResolvedValueOnce(bad({ code: 'rate_limited', retryAfterMs: 3500 }))
    await share(ctx)
    expect(ctx.sched.lastMs()).toBe(3500)
    expect(ctx.screen.status.framesDropped).toBe(1)

    ctx.api.ingestCaptureFrame.mockResolvedValueOnce(bad({ detail: 'out_of_order_frame' }))
    ctx.sched.fire()
    await tick()
    expect(ctx.screen.status).toMatchObject({ phase: 'sharing', error: null, framesDropped: 2 })
  })

  it('stops with an error after repeated upload failures', async () => {
    const ctx = setup()
    ctx.api.ingestCaptureFrame.mockResolvedValue(bad({ reason: 'unavailable', message: 'offline' }))
    await share(ctx)
    for (let i = 0; i < 4; i += 1) { ctx.sched.fire(); await tick() }

    expect(ctx.screen.status).toMatchObject({ phase: 'idle', error: expect.stringContaining('kept failing') })
    expect(ctx.display.stop).toHaveBeenCalled()
    expect(ctx.api.endCaptureSession).toHaveBeenCalledWith(PROJECT, CAPTURE, expect.anything())
  })

  it('clears timers, frame source, tracks and the server session on stop, and ignores late uploads and inspections', async () => {
    const ctx = setup()
    const upload = deferred<ApiResult<{ frameId: string; width: number; height: number; byteSize: number; captureTimestamp: string }>>()
    await share(ctx)
    ctx.api.ingestCaptureFrame.mockReturnValueOnce(upload.promise)
    ctx.sched.fire()
    await tick()
    const inspection = deferred<ApiResult<Inspection>>()
    ctx.api.requestInspection.mockReturnValueOnce(inspection.promise)
    const inspecting = ctx.screen.inspect()

    ctx.screen.stop()

    expect(ctx.sched.pending.size).toBe(0)
    expect(ctx.source.dispose).toHaveBeenCalledTimes(1)
    expect(ctx.display.stop).toHaveBeenCalledTimes(1)
    expect(ctx.api.endCaptureSession).toHaveBeenCalledWith(PROJECT, CAPTURE, expect.anything())
    expect(ctx.screen.status).toMatchObject({ phase: 'idle', framesSent: 0, lastFrame: null, inspection: null })

    upload.resolve(good({ frameId: 'late', width: 1, height: 1, byteSize: 1, captureTimestamp: 'x' }))
    inspection.resolve(good(observed()))
    await inspecting
    await tick()
    expect(ctx.screen.status).toMatchObject({ phase: 'idle', framesSent: 0, lastFrame: null, inspection: null, inspecting: false })
    expect(ctx.source.grab).toHaveBeenCalledTimes(2)
  })

  it('stops a display grant that arrives after cancellation and never creates a capture session', async () => {
    const ctx = setup()
    const grant = deferred<MediaStream>()
    ctx.getDisplayMedia.mockReturnValueOnce(grant.promise)

    const starting = ctx.screen.start(TARGET)
    ctx.screen.stop()
    grant.resolve(ctx.display.stream)
    await starting

    expect(ctx.display.stop).toHaveBeenCalledTimes(1)
    expect(ctx.api.startCaptureSession).not.toHaveBeenCalled()
    expect(ctx.screen.status.phase).toBe('idle')
  })

  it('ends a capture session created after cancellation', async () => {
    const ctx = setup()
    const created = deferred<ApiResult<{ sessionId: string; generation: number }>>()
    ctx.api.startCaptureSession.mockReturnValueOnce(created.promise)

    const starting = ctx.screen.start(TARGET)
    await tick()
    ctx.screen.stop()
    created.resolve(good({ sessionId: CAPTURE, generation: 1 }))
    await starting

    expect(ctx.api.endCaptureSession).toHaveBeenCalledWith(PROJECT, CAPTURE, expect.anything())
    expect(ctx.source.ready).not.toHaveBeenCalled()
    expect(ctx.display.stop).toHaveBeenCalled()
  })

  it('reports denial and unsupported browsers without creating anything', async () => {
    const denied = setup()
    denied.getDisplayMedia.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    await denied.screen.start(TARGET)
    expect(denied.screen.status).toMatchObject({ phase: 'idle', error: expect.stringContaining('declined') })
    expect(denied.api.startCaptureSession).not.toHaveBeenCalled()

    const unsupported = setup({ devices: false })
    await unsupported.screen.start(TARGET)
    expect(unsupported.screen.status.error).toContain('cannot share')
  })

  it('stops when the browser ends the share or Ranger reports the capture ended', async () => {
    const browserStop = await share()
    browserStop.display.endFromBrowser()
    expect(browserStop.screen.status).toMatchObject({ phase: 'idle', notice: expect.stringContaining('stopped in the browser') })
    expect(browserStop.display.stop).toHaveBeenCalled()

    const serverEnd = setup()
    serverEnd.api.ingestCaptureFrame.mockResolvedValueOnce(bad({ detail: 'capture_ended' }))
    await share(serverEnd)
    expect(serverEnd.screen.status).toMatchObject({ phase: 'idle', notice: expect.stringContaining('ended on Ranger') })
  })

  it('inspects only on demand, once at a time, and shows uncertainty with the source frame', async () => {
    const ctx = setup()
    ctx.api.ingestCaptureFrame.mockImplementationOnce(() => new Promise(() => undefined))
    await ctx.screen.start(TARGET)
    await tick()
    await ctx.screen.inspect()
    expect(ctx.api.requestInspection).not.toHaveBeenCalled()
    expect(ctx.screen.status.notice).toContain('No frame')
    ctx.screen.stop()

    const live = await share()
    expect(live.api.requestInspection).not.toHaveBeenCalled()
    const slow = deferred<ApiResult<Inspection>>()
    live.api.requestInspection.mockReturnValueOnce(slow.promise)
    const first = live.screen.inspect()
    void live.screen.inspect()
    expect(live.screen.status.inspecting).toBe(true)
    slow.resolve(good(observed()))
    await first

    expect(live.api.requestInspection).toHaveBeenCalledTimes(1)
    expect(live.api.requestInspection).toHaveBeenCalledWith(PROJECT, CAPTURE, expect.anything())
    expect(live.screen.status.inspecting).toBe(false)
    expect(live.screen.status.inspection?.result.observations[0]).toMatchObject({ uncertainty: 0.3, sourceFrameId: 'f' })
    expect(live.screen.status.inspection?.result.sourceTimestamp).toBe('2026-01-01T00:00:10.000Z')
  })

  it('shows a stale-frame inspection as no observation and discards a superseded result with an explanation', async () => {
    const ctx = await share()
    ctx.api.requestInspection.mockResolvedValueOnce(good({ state: 'fresh-frame-requested', observations: [], sourceFrameId: 'f', sourceTimestamp: 't', freshness: 'stale' }))
    await ctx.screen.inspect()
    expect(ctx.screen.status.inspection?.result).toMatchObject({ state: 'fresh-frame-requested', observations: [], freshness: 'stale' })

    ctx.api.requestInspection.mockResolvedValueOnce(bad({ detail: 'superseded_frame', message: 'discarded' }))
    await ctx.screen.inspect()
    expect(ctx.screen.status.notice).toContain('newer frame')
    expect(ctx.screen.status.phase).toBe('sharing')
  })

  it('signals auth loss and releases the share when the session ends mid-capture', async () => {
    const ctx = setup()
    ctx.api.ingestCaptureFrame.mockResolvedValueOnce(bad({ reason: 'unauthorized' }))

    await share(ctx)

    expect(ctx.hooks.onAuthLost).toHaveBeenCalledTimes(1)
    expect(ctx.screen.status.phase).toBe('idle')
    expect(ctx.display.stop).toHaveBeenCalled()
  })
})

describe('voice and screen together', () => {
  it('runs both channels independently and stopping one leaves the other running', async () => {
    const ctx = setup()
    await goLive(ctx)
    await ctx.screen.start(TARGET)
    await tick()

    expect(ctx.voice.status.phase).toBe('live')
    expect(ctx.screen.status.phase).toBe('sharing')

    ctx.screen.stop()
    expect(ctx.voice.status.phase).toBe('live')
    expect(ctx.mic.stop).not.toHaveBeenCalled()
    expect(ctx.display.stop).toHaveBeenCalledTimes(1)

    ctx.voice.stop()
    expect(ctx.mic.stop).toHaveBeenCalledTimes(1)
    expect(ctx.api.endVoiceSession).toHaveBeenCalledTimes(1)
    expect(ctx.api.endCaptureSession).toHaveBeenCalledTimes(1)
  })
})

describe('readiness is only the documented initial frame', () => {
  async function opened() {
    const ctx = setup()
    await ctx.voice.start(TARGET)
    const socket = ctx.sockets[0]
    socket.handlers.onOpen()
    await tick()
    return { ctx, socket }
  }

  it.each([
    ['a provider error frame', { type: 'error', error: { message: 'bad key' } }, 'bad key'],
    ['a relay error frame', { kind: 'error', error: { code: 'not_configured', message: 'provider not configured' } }, 'provider not configured'],
  ])('fails the start on %s before ready without sending session.update or audio', async (_label, frame, text) => {
    const { ctx, socket } = await opened()

    socket.frame(frame)
    ctx.audio.chunk(new Int16Array([1, 2, 3]))

    expect(ctx.voice.status).toMatchObject({ phase: 'idle', error: expect.stringContaining(text) })
    expect(socket.sent).toEqual([])
    expect(socket.close).toHaveBeenCalled()
    expect(ctx.mic.stop).toHaveBeenCalledTimes(1)
    expect(ctx.audio.audio.close).toHaveBeenCalled()
    expect(ctx.sched.pending.size).toBe(0)
    expect(ctx.api.endVoiceSession).toHaveBeenCalledWith(PROJECT, VOICE, expect.anything())
  })

  it('does not treat other or unknown frames as ready, and does not play or send audio for them', async () => {
    const { ctx, socket } = await opened()

    for (const type of ['session.updated', 'response.created', 'response.output_audio.delta', 'rate_limits.updated', 'something.new']) {
      socket.frame({ type, delta: pcm16ToBase64(new Int16Array([5])) })
    }
    ctx.audio.chunk(new Int16Array([1]))

    expect(ctx.voice.status.phase).toBe('starting')
    expect(socket.sent).toEqual([])
    expect(ctx.audio.audio.play).not.toHaveBeenCalled()
    expect(ctx.sched.pending.size).toBe(1)
  })

  it.each(['conversation.created', 'session.created'])('is live after the documented %s frame', async type => {
    const { ctx, socket } = await opened()

    socket.frame({ type })

    expect(ctx.voice.status.phase).toBe('live')
    expect(socket.sent[0]).toMatchObject({ type: 'session.update' })
    expect(ctx.sched.pending.size).toBe(0)
  })

  it('keeps a live call through a recoverable provider error and reports a relay error at its close', async () => {
    const { ctx, socket } = await opened()
    socket.frame({ type: 'conversation.created' })

    socket.frame({ type: 'error', error: { message: 'bad audio chunk' } })
    expect(ctx.voice.status).toMatchObject({ phase: 'live', notice: expect.stringContaining('bad audio chunk') })

    socket.frame({ kind: 'error', error: { code: 'rate_limited', message: 'The call reached its limit.' } })
    expect(ctx.voice.status.phase).toBe('live')
    socket.handlers.onClose(4408)
    expect(ctx.voice.status).toMatchObject({ phase: 'idle', error: 'The call reached its limit.' })
  })
})

describe('server session cleanup', () => {
  const endFailure = () => bad({ reason: 'unavailable', message: 'The Ranger API is unreachable.' })

  it('keeps a failed end visible with its id, blocks a new call, and retries only on request', async () => {
    const ctx = setup()
    const socket = await goLive(ctx)
    ctx.api.endVoiceSession.mockResolvedValueOnce(endFailure())

    ctx.voice.stop()
    await tick()

    expect(ctx.mic.stop).toHaveBeenCalledTimes(1)
    expect(socket.close).toHaveBeenCalled()
    expect(ctx.audio.audio.close).toHaveBeenCalled()
    expect(ctx.voice.status.cleanup).toMatchObject({ phase: 'failed', message: expect.stringContaining('Could not end the call') })
    expect(ctx.api.endVoiceSession).toHaveBeenCalledTimes(1)
    expect(ctx.sched.pending.size).toBe(0)

    await ctx.voice.start(TARGET)
    expect(ctx.getUserMedia).toHaveBeenCalledTimes(1)
    expect(ctx.voice.status.notice).toContain('still being ended')
    expect(ctx.sockets).toHaveLength(1)

    ctx.api.endVoiceSession.mockResolvedValueOnce(endFailure())
    await ctx.voice.retryCleanup()
    expect(ctx.voice.status.cleanup.phase).toBe('failed')
    expect(ctx.api.endVoiceSession).toHaveBeenCalledTimes(2)
    expect(ctx.api.endVoiceSession).toHaveBeenLastCalledWith(PROJECT, VOICE, expect.anything())

    await ctx.voice.retryCleanup()
    expect(ctx.voice.status.cleanup).toEqual({ phase: 'idle', message: null })
    expect(ctx.api.endVoiceSession).toHaveBeenCalledTimes(3)

    ctx.api.startVoiceSession.mockResolvedValueOnce(good({ sessionId: VOICE_2, model: 'm', expiresAt: 'x' }))
    await ctx.voice.start(TARGET)
    expect(ctx.sockets).toHaveLength(2)
    await ctx.voice.retryCleanup()
    expect(ctx.api.endVoiceSession).toHaveBeenCalledTimes(3)
  })

  it('ends the session when a call is cancelled while the ticket is pending, and keeps both errors visible if that fails', async () => {
    const ctx = setup()
    const ticket = deferred<ApiResult<{ ticket: string }>>()
    ctx.api.createRelayTicket.mockReturnValueOnce(ticket.promise)
    ctx.api.endVoiceSession.mockResolvedValueOnce(endFailure())

    const starting = ctx.voice.start(TARGET)
    await tick()
    ctx.voice.stop()
    ticket.resolve(good({ ticket: 't' }))
    await starting
    await tick()

    expect(ctx.sockets).toHaveLength(0)
    expect(ctx.mic.stop).toHaveBeenCalled()
    expect(ctx.api.endVoiceSession).toHaveBeenCalledWith(PROJECT, VOICE, expect.anything())
    expect(ctx.voice.status.cleanup.phase).toBe('failed')
  })

  it('does not let a start error replace a cleanup failure, nor a later end result replace the start error', async () => {
    const ctx = setup()
    const end = deferred<ApiResult<void>>()
    ctx.api.createRelayTicket.mockResolvedValueOnce(bad({ message: 'ticket refused' }))
    ctx.api.endVoiceSession.mockReturnValueOnce(end.promise)

    await ctx.voice.start(TARGET)
    expect(ctx.voice.status).toMatchObject({ phase: 'idle', error: 'ticket refused', cleanup: { phase: 'ending' } })

    end.resolve(endFailure())
    await tick()
    expect(ctx.voice.status).toMatchObject({ error: 'ticket refused', cleanup: { phase: 'failed' } })
  })

  it('ends a session created after cancellation, blocks restart until that lands, and surfaces a failed end', async () => {
    const ctx = setup()
    const created = deferred<ApiResult<{ sessionId: string; model: string; expiresAt: string }>>()
    ctx.api.startVoiceSession.mockReturnValueOnce(created.promise)
    ctx.api.endVoiceSession.mockResolvedValueOnce(endFailure())

    const starting = ctx.voice.start(TARGET)
    await tick()
    ctx.voice.stop()
    expect(ctx.voice.status.cleanup.phase).toBe('ending')
    await ctx.voice.start(TARGET)
    expect(ctx.getUserMedia).toHaveBeenCalledTimes(1)

    created.resolve(good({ sessionId: VOICE, model: 'm', expiresAt: 'x' }))
    await starting
    await tick()

    expect(ctx.api.endVoiceSession).toHaveBeenCalledWith(PROJECT, VOICE, expect.anything())
    expect(ctx.voice.status.cleanup.phase).toBe('failed')
    expect(ctx.sockets).toHaveLength(0)

    await ctx.voice.retryCleanup()
    expect(ctx.voice.status.cleanup.phase).toBe('idle')
  })

  it('clears the pending marker when a late create fails and treats an already-missing session as ended', async () => {
    const ctx = setup()
    const created = deferred<ApiResult<{ sessionId: string; model: string; expiresAt: string }>>()
    ctx.api.startVoiceSession.mockReturnValueOnce(created.promise)
    const starting = ctx.voice.start(TARGET)
    await tick()
    ctx.voice.stop()
    created.resolve(bad({ message: 'nope' }))
    await starting
    expect(ctx.voice.status.cleanup.phase).toBe('idle')

    const gone = setup()
    await goLive(gone)
    gone.api.endVoiceSession.mockResolvedValueOnce(bad({ code: 'not_found' }))
    gone.voice.stop()
    await tick()
    expect(gone.voice.status.cleanup.phase).toBe('idle')
  })

  it('signals auth loss when the end is refused as unauthorized but keeps the id for a retry', async () => {
    const ctx = setup()
    await goLive(ctx)
    ctx.api.endVoiceSession.mockResolvedValueOnce(bad({ reason: 'unauthorized', message: 'no session' }))

    ctx.voice.stop()
    await tick()

    expect(ctx.hooks.onAuthLost).toHaveBeenCalledTimes(1)
    expect(ctx.voice.status.cleanup.phase).toBe('failed')
  })

  it('does not notify a listener that unsubscribed before the end request settled', async () => {
    const ctx = setup()
    await goLive(ctx)
    const end = deferred<ApiResult<void>>()
    ctx.api.endVoiceSession.mockReturnValueOnce(end.promise)
    const listener = vi.fn()
    const unsubscribe = ctx.voice.subscribe(listener)

    ctx.voice.stop()
    unsubscribe()
    listener.mockClear()
    end.resolve(endFailure())
    await tick()

    expect(listener).not.toHaveBeenCalled()
    expect(ctx.voice.status.cleanup.phase).toBe('failed')
  })

  it('reports a failed screen end, blocks sharing again, and clears it on retry', async () => {
    const ctx = setup()
    await ctx.screen.start(TARGET)
    await tick()
    ctx.api.endCaptureSession.mockResolvedValueOnce(endFailure())

    ctx.screen.stop()
    await tick()

    expect(ctx.display.stop).toHaveBeenCalledTimes(1)
    expect(ctx.source.dispose).toHaveBeenCalledTimes(1)
    expect(ctx.screen.status.cleanup).toMatchObject({ phase: 'failed', message: expect.stringContaining('screen share') })

    await ctx.screen.start(TARGET)
    expect(ctx.getDisplayMedia).toHaveBeenCalledTimes(1)
    expect(ctx.screen.status.notice).toContain('still being ended')

    await ctx.screen.retryCleanup()
    expect(ctx.screen.status.cleanup.phase).toBe('idle')
    expect(ctx.api.endCaptureSession).toHaveBeenCalledTimes(2)
    await ctx.screen.start(TARGET)
    expect(ctx.getDisplayMedia).toHaveBeenCalledTimes(2)
  })

  it('tracks a capture session created after cancellation and its failed end', async () => {
    const ctx = setup()
    const created = deferred<ApiResult<{ sessionId: string; generation: number }>>()
    ctx.api.startCaptureSession.mockReturnValueOnce(created.promise)
    ctx.api.endCaptureSession.mockResolvedValueOnce(endFailure())

    const starting = ctx.screen.start(TARGET)
    await tick()
    ctx.screen.stop()
    created.resolve(good({ sessionId: CAPTURE, generation: 1 }))
    await starting
    await tick()

    expect(ctx.screen.status.cleanup.phase).toBe('failed')
    expect(ctx.source.ready).not.toHaveBeenCalled()
    await ctx.screen.retryCleanup()
    expect(ctx.screen.status.cleanup.phase).toBe('idle')
  })

  it('keeps voice and screen cleanup independent', async () => {
    const ctx = setup()
    await goLive(ctx)
    await ctx.screen.start(TARGET)
    await tick()
    ctx.api.endVoiceSession.mockResolvedValueOnce(endFailure())

    ctx.voice.stop()
    ctx.screen.stop()
    await tick()

    expect(ctx.voice.status.cleanup.phase).toBe('failed')
    expect(ctx.screen.status.cleanup.phase).toBe('idle')
  })
})

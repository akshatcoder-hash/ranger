import { describe, expect, it, vi } from 'vitest'
import { MediaLifecycle, OperationEpoch } from './lifecycle'

function fakeStream() {
  const stop = vi.fn()
  const track = { stop, addEventListener: vi.fn() } as unknown as MediaStreamTrack
  const stream = { getTracks: () => [track] } as unknown as MediaStream
  return { stream, stop }
}

describe('OperationEpoch', () => {
  it('marks results stale when navigation invalidates the pending operation', () => {
    const epoch = new OperationEpoch()
    const request = epoch.begin()

    epoch.invalidate()

    expect(epoch.isCurrent(request)).toBe(false)
  })
})

describe('MediaLifecycle', () => {
  it('stops a permission result that arrives after cancellation', () => {
    const lifecycle = new MediaLifecycle(vi.fn())
    const request = lifecycle.begin()!
    const { stream, stop } = fakeStream()

    lifecycle.release()
    expect(lifecycle.attach(request, stream)).toBe(false)

    expect(stop).toHaveBeenCalledTimes(1)
    expect(lifecycle.phase).toBe('idle')
  })

  it('does not replace an active stream when another media kind is requested', () => {
    const endSession = vi.fn()
    const lifecycle = new MediaLifecycle(endSession)
    const voice = lifecycle.begin()!
    const first = fakeStream()
    lifecycle.attach(voice, first.stream)
    lifecycle.setSession(voice, 'voice-session')
    lifecycle.activate(voice)

    expect(lifecycle.begin()).toBeNull()
    expect(first.stop).not.toHaveBeenCalled()

    lifecycle.release()
    expect(first.stop).toHaveBeenCalledTimes(1)
    expect(endSession).toHaveBeenCalledWith('voice-session')

    const screen = lifecycle.begin()!
    const second = fakeStream()
    expect(lifecycle.attach(screen, second.stream)).toBe(true)
    lifecycle.release(screen)
    expect(second.stop).toHaveBeenCalledTimes(1)
  })

  it('rejects stale server sessions after navigation cleanup', () => {
    const lifecycle = new MediaLifecycle(vi.fn())
    const request = lifecycle.begin()!
    const { stream, stop } = fakeStream()
    lifecycle.attach(request, stream)

    lifecycle.release()

    expect(lifecycle.setSession(request, 'late-session')).toBe(false)
    expect(lifecycle.activate(request)).toBe(false)
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

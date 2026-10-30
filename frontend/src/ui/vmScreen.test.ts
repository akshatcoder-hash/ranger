import { afterEach, describe, expect, it, vi } from 'vitest'
import { rangerApi } from '../api'
import { vmInputQueue, vmPoint, watchVmScreen } from './vmScreen'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('VM screen refresh', () => {
  it('maps displayed image coordinates to bounded guest pixels', () => {
    const image = { naturalWidth: 1280, naturalHeight: 800, getBoundingClientRect: () => ({ left: 10, top: 20, width: 640, height: 400 }) } as HTMLImageElement
    expect(vmPoint(image, 330, 220)).toEqual({ x: 640, y: 400 })
    expect(vmPoint(image, -20, 5000)).toEqual({ x: 0, y: 799 })
  })

  it('serializes and batches typing, then drops queued input on abort', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof rangerApi.sendWorkspaceDesktopInput>>) => void
    const input = vi.spyOn(rangerApi, 'sendWorkspaceDesktopInput').mockImplementation(() => new Promise(done => { resolve = done }))
    const controller = new AbortController()
    const send = vmInputQueue('project', controller.signal, vi.fn())
    send({ action: 'click', x: 10, y: 10 })
    send({ action: 'type', text: 'a' })
    send({ action: 'type', text: 'b' })
    expect(input).toHaveBeenCalledTimes(1)
    resolve({ ok: true, data: undefined })
    await Promise.resolve()
    expect(input).toHaveBeenCalledTimes(2)
    expect(input.mock.calls[1]?.[1]).toEqual({ action: 'type', text: 'ab' })
    send({ action: 'press', keys: ['Return'] })
    controller.abort()
    resolve({ ok: true, data: undefined })
    await Promise.resolve()
    expect(input).toHaveBeenCalledTimes(2)
  })

  it('does not retry failed desktop actions', async () => {
    const input = vi.spyOn(rangerApi, 'sendWorkspaceDesktopInput').mockResolvedValue({ ok: false, reason: 'backend', message: 'VM unavailable' })
    const failed = vi.fn()
    const send = vmInputQueue('project', new AbortController().signal, failed)
    send({ action: 'type', text: 'x' })
    await Promise.resolve()
    send({ action: 'type', text: 'y' })
    expect(input).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledWith('VM unavailable')
  })
  it('captures without artifacts, never overlaps requests, and stops on abort', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('document', { visibilityState: 'visible' })
    let resolve!: (value: Awaited<ReturnType<typeof rangerApi.captureWorkspaceScreenshot>>) => void
    const capture = vi.spyOn(rangerApi, 'captureWorkspaceScreenshot').mockImplementation(() => new Promise(done => { resolve = done }))
    const update = vi.fn()
    const controller = new AbortController()
    watchVmScreen('project', controller.signal, update)
    expect(capture).toHaveBeenCalledWith('project', controller.signal, false)
    await vi.advanceTimersByTimeAsync(9000)
    expect(capture).toHaveBeenCalledTimes(1)
    resolve({ ok: true, data: { contentBase64: 'png', artifactId: null } })
    await vi.advanceTimersByTimeAsync(3000)
    expect(capture).toHaveBeenCalledTimes(2)
    controller.abort()
    resolve({ ok: true, data: { contentBase64: 'late', artifactId: null } })
    await vi.advanceTimersByTimeAsync(9000)
    expect(update).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('pauses hidden tabs and stops retrying after a failed capture', async () => {
    vi.useFakeTimers()
    const document = { visibilityState: 'hidden' }
    vi.stubGlobal('document', document)
    const capture = vi.spyOn(rangerApi, 'captureWorkspaceScreenshot').mockResolvedValue({ ok: false, reason: 'backend', message: 'VM stopped' })
    const update = vi.fn()
    const controller = new AbortController()
    watchVmScreen('project', controller.signal, update)
    await vi.advanceTimersByTimeAsync(6000)
    expect(capture).not.toHaveBeenCalled()
    document.visibilityState = 'visible'
    await vi.advanceTimersByTimeAsync(12000)
    expect(capture).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    controller.abort()
  })
})

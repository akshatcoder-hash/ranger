import { rangerApi, type ApiResult, type DesktopInput, type WorkspaceScreenshot } from '../api'

export function vmPoint(image: HTMLImageElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = image.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(image.naturalWidth - 1, Math.floor((clientX - rect.left) * image.naturalWidth / rect.width))),
    y: Math.max(0, Math.min(image.naturalHeight - 1, Math.floor((clientY - rect.top) * image.naturalHeight / rect.height))),
  }
}

/** Serialize human input; coalesce queued typing/movement, never retry an uncertain action. */
export function vmInputQueue(projectId: string, signal: AbortSignal, failed: (message: string) => void) {
  const pending: DesktopInput[] = []
  let busy = false
  let stopped = false
  signal.addEventListener('abort', () => { pending.length = 0 }, { once: true })
  const pump = async () => {
    if (busy) return
    busy = true
    try {
      while (!signal.aborted && !stopped && pending.length) {
        const result = await rangerApi.sendWorkspaceDesktopInput(projectId, pending.shift()!, signal)
        if (signal.aborted) return
        if (!result.ok) { stopped = true; pending.length = 0; failed(result.message) }
      }
    } finally { busy = false }
  }
  return (input: DesktopInput) => {
    if (signal.aborted || stopped) return
    const last = pending.at(-1)
    if (input.action === 'type' && last?.action === 'type' && last.text.length + input.text.length <= 2000) last.text += input.text
    else if (input.action === 'move' && last?.action === 'move') pending[pending.length - 1] = input
    else {
      if (pending.length >= 64) { stopped = true; pending.length = 0; failed('VM input fell behind. Take control again when the screen catches up.'); return }
      pending.push(input)
    }
    void pump()
  }
}

/** Read-only frames, one request at a time; never save preview frames as artifacts. */
export function watchVmScreen(projectId: string, signal: AbortSignal, update: (frame: ApiResult<WorkspaceScreenshot>) => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  const next = async () => {
    if (signal.aborted) return
    if (document.visibilityState !== 'hidden') {
      const frame = await rangerApi.captureWorkspaceScreenshot(projectId, signal, false)
      if (signal.aborted) return
      update(frame)
      if (!frame.ok) return
    }
    if (!signal.aborted) timer = setTimeout(() => { void next() }, 3000)
  }
  void next()
}

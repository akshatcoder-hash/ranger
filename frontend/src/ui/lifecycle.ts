export class OperationEpoch {
  private value = 0

  begin() {
    return ++this.value
  }

  invalidate() {
    this.value += 1
  }

  isCurrent(operation: number) {
    return operation === this.value
  }
}

type MediaPhase = 'idle' | 'requesting' | 'active'

export class MediaLifecycle {
  private sequence = 0
  private phaseValue: MediaPhase = 'idle'
  private stream: MediaStream | null = null
  private sessionId: string | null = null

  constructor(private readonly endSession: (id: string) => void) {}

  get phase() {
    return this.phaseValue
  }

  begin() {
    if (this.phaseValue !== 'idle') return null
    this.phaseValue = 'requesting'
    return ++this.sequence
  }

  isCurrent(operation: number) {
    return operation === this.sequence && this.phaseValue !== 'idle'
  }

  attach(operation: number, stream: MediaStream) {
    if (!this.isCurrent(operation) || this.phaseValue !== 'requesting') {
      stopStream(stream)
      return false
    }
    this.stream = stream
    return true
  }

  setSession(operation: number, sessionId: string) {
    if (!this.isCurrent(operation)) return false
    this.sessionId = sessionId
    return true
  }

  activate(operation: number) {
    if (!this.isCurrent(operation) || !this.stream) return false
    this.phaseValue = 'active'
    return true
  }

  release(operation?: number) {
    if (operation !== undefined && !this.isCurrent(operation)) return false
    this.sequence += 1
    this.phaseValue = 'idle'
    const stream = this.stream
    const sessionId = this.sessionId
    this.stream = null
    this.sessionId = null
    if (stream) stopStream(stream)
    if (sessionId) this.endSession(sessionId)
    return true
  }
}

export function stopStream(stream: MediaStream) {
  stream.getTracks().forEach(track => track.stop())
}

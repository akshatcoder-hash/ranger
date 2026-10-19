import { formatBytes, formatDuration, PREPARATION_EVENT } from './liveHelpers'

export type ActivityEvent = { eventId: string; sequence: number; type: string; data?: Record<string, unknown> }
export type ActivityTone = 'neutral' | 'good' | 'warn' | 'bad'
export type ActivityLine = { title: string; detail?: string; tone: ActivityTone }

const text = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const shortId = (value: unknown): string => (text(value) ?? '').replace(/^[a-z]+_/, '').slice(0, 8)

const versionLabel = (data: Record<string, unknown>): string => count(data.version) === undefined ? '' : ` version ${count(data.version)}`

const PHASE_TITLE: Record<string, string> = {
  queued: 'Preparation queued',
  preparing: 'Provisioning the VM and loading the repository',
  indexing: 'Indexing the repository with Trace',
  ready: 'Workspace ready',
  failed: 'Preparation failed',
}

function preparationLine(data: Record<string, unknown>): ActivityLine {
  const phase = text(data.phase) ?? ''
  const facts = [
    count(data.fileCount) !== undefined ? `${count(data.fileCount)} files` : null,
    count(data.byteCount) !== undefined ? formatBytes(count(data.byteCount) as number) : null,
    count(data.cloneElapsedMs) !== undefined ? `clone ${formatDuration(count(data.cloneElapsedMs) as number)}` : null,
    count(data.indexElapsedMs) !== undefined ? `index ${formatDuration(count(data.indexElapsedMs) as number)}` : null,
    count(data.elapsedMs) !== undefined ? `total ${formatDuration(count(data.elapsedMs) as number)}` : null,
  ].filter((item): item is string => item !== null)
  const detail = phase === 'failed' ? text(data.message) ?? text(data.errorCode) : facts.join(' · ') || undefined
  return { title: PHASE_TITLE[phase] ?? `Preparation ${phase}`, ...(detail ? { detail } : {}), tone: phase === 'ready' ? 'good' : phase === 'failed' ? 'bad' : 'neutral' }
}

/** Turns one project event into a readable line. Unknown event types fall back to their name; no field is invented. */
export function describeEvent(event: ActivityEvent): ActivityLine {
  const data = event.data ?? {}
  switch (event.type) {
    case PREPARATION_EVENT: return preparationLine(data)
    case 'run.state.changed': {
      const to = text(data.to) ?? 'updated'
      const reason = text(data.reason)
      return { title: `Run ${shortId(data.runId)} ${to}`, ...(reason ? { detail: reason } : {}), tone: to === 'succeeded' ? 'good' : to === 'failed' ? 'bad' : 'neutral' }
    }
    case 'run.tool.progress': {
      const status = text(data.status) ?? 'unknown'
      return { title: `Tool ${text(data.tool) ?? 'call'}: ${status}`, detail: `run ${shortId(data.runId)}`, tone: status === 'ok' ? 'good' : status === 'error' ? 'bad' : 'warn' }
    }
    case 'run.scope.violation': return { title: `Blocked ${text(data.tool) ?? 'a tool call'}`, ...(text(data.reason) ? { detail: text(data.reason) } : {}), tone: 'warn' }
    case 'plan.version.created': return { title: `Plan${versionLabel(data)} drafted`, tone: 'neutral' }
    case 'plan.approval.granted': return { title: `Plan${versionLabel(data)} approved`, tone: 'good' }
    case 'plan.approval.invalidated': return { title: 'Plan approval invalidated', ...(text(data.reason) ? { detail: text(data.reason) } : {}), tone: 'warn' }
    case 'repository.connected': return { title: 'Repository connected', ...(text(data.url) ? { detail: `${text(data.url)}${text(data.ref) ? ` @ ${text(data.ref)}` : ''}` } : {}), tone: 'neutral' }
    case 'conversation.message.created': return { title: text(data.role) === 'agent' ? 'Engineer replied' : text(data.role) === 'system' ? 'System note' : 'You sent a message', tone: 'neutral' }
    case 'workspace.command.started': return { title: 'VM command started', ...(text(data.command) ? { detail: `$ ${text(data.command)}` } : {}), tone: 'neutral' }
    case 'workspace.command.finished': {
      const state = text(data.state)
      const exit = count(data.exitCode)
      const detail = [text(data.command) ? `$ ${text(data.command)}` : null, exit !== undefined ? `exit ${exit}` : null].filter((item): item is string => item !== null).join(' · ')
      return { title: `VM command ${state ?? 'finished'}`, ...(detail ? { detail } : {}), tone: state === 'succeeded' ? 'good' : state === 'failed' || state === 'terminated' ? 'bad' : 'neutral' }
    }
    default: return { title: event.type.replace(/[._-]+/g, ' '), tone: 'neutral' }
  }
}

/** Per-frame capture and usage events arrive every second and would bury the events a viewer cares about. */
export function isNoisyEvent(event: ActivityEvent): boolean {
  return event.type.startsWith('capture.frame.') || event.type === 'voice.usage.recorded'
}

/** True while any run's latest recorded transition is queued or running. */
export function hasActiveRun(events: readonly ActivityEvent[]): boolean {
  const latest = new Map<string, string>()
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type !== 'run.state.changed') continue
    const runId = text(event.data?.runId)
    const to = text(event.data?.to)
    if (runId && to) latest.set(runId, to)
  }
  return [...latest.values()].some(state => state === 'queued' || state === 'running')
}

/** Highest sequence of an event that changes the project record (messages, plans, repository), so the record is reloaded only when it changed. */
export function projectRecordRevision(events: readonly ActivityEvent[]): number {
  return events.reduce((revision, event) => /^(conversation\.|plan\.|repository\.)/.test(event.type) ? Math.max(revision, event.sequence) : revision, 0)
}

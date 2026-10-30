export type Capabilities = { xai: boolean; instabox: boolean; trace: boolean }

const PROJECT_ID = /^prj_[0-9a-fA-F-]+$/

/** Backend project ids are prefixed UUIDs; anything else is never sent to the backend. */
export function isProjectId(value: string | null | undefined): value is string {
  return typeof value === 'string' && PROJECT_ID.test(value)
}

export function parseLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean)
}

/** Appends unseen events and keeps strict sequence order. Replays never duplicate a row. */
export function mergeEvents<T extends { eventId: string; sequence: number }>(existing: readonly T[], incoming: readonly T[]): T[] {
  const seen = new Set(existing.map(event => event.eventId))
  const added = incoming.filter(event => !seen.has(event.eventId) && seen.add(event.eventId))
  if (!added.length) return existing as T[]
  return [...existing, ...added].sort((a, b) => a.sequence - b.sequence)
}

export function executionBlockers(capabilities: Capabilities | null): string[] {
  if (!capabilities) return ['Provider availability could not be checked.']
  const blockers: string[] = []
  if (!capabilities.xai) blockers.push('xAI is not configured on the backend.')
  if (!capabilities.instabox) blockers.push('Instabox is not available on the backend.')
  return blockers
}

/**
 * Returns a user-facing problem, or null when the repository reference and ref look acceptable.
 * Accepts an https URL, an absolute local path, or a file URL with no host and no credentials.
 * The backend still decides, including whether a public https repository can be cloned and whether a local path is an operator-approved checkout.
 */
export function validateRepositoryInput(url: string, ref: string): string | null {
  const cleanUrl = url.trim()
  if (!cleanUrl) return 'Enter an https repository URL, or an absolute local checkout path on the Ranger server.'
  if (cleanUrl.startsWith('/')) {
    if (cleanUrl.includes('\0') || cleanUrl.includes('\\')) return 'That local path is not a plain absolute path.'
  } else {
    let parsed: URL
    try { parsed = new URL(cleanUrl) } catch { return 'Enter an https repository URL, an absolute local path, or a file:// URL for a checkout on the Ranger server.' }
    if (parsed.protocol === 'file:') {
      if (parsed.host) return 'A file URL cannot name another host. Use a local checkout path on the Ranger server.'
      if (parsed.username || parsed.password) return 'Do not put credentials in the repository URL.'
    } else if (parsed.protocol === 'https:') {
      if (parsed.username || parsed.password) return 'Do not put credentials in the repository URL.'
    } else {
      return 'Use an https URL, an absolute local path, or a file:// URL.'
    }
  }
  const cleanRef = ref.trim()
  if (!cleanRef) return 'Enter a branch, tag or commit to use.'
  if (cleanRef.length > 255 || /\s/.test(cleanRef)) return 'The ref cannot contain spaces.'
  return null
}

export const PREPARATION_EVENT = 'workspace.preparation.updated'
export const PREPARATION_PHASES = ['queued', 'preparing', 'indexing', 'ready', 'failed'] as const
export type PreparationPhase = (typeof PREPARATION_PHASES)[number]
export type PreparationStatus = {
  jobId: string
  phase: PreparationPhase
  fileCount?: number
  byteCount?: number
  /** Time the backend spent cloning a remote repository; absent for local checkouts and older backends. */
  cloneElapsedMs?: number
  indexElapsedMs?: number
  elapsedMs?: number
  errorCode?: string
  message?: string
  repositoryCommit?: string
}

type PreparationEvent = { sequence: number; type: string; data?: Record<string, unknown> }

export const SEARCH_EVENT = 'retrieval.search.completed'
export type SearchMeasurement = { provider: 'trace' | 'file-search-fallback'; durationMs: number; resultCount: number }

export function latestSearch(events: readonly PreparationEvent[]): SearchMeasurement | null {
  for (const event of [...events].sort((a, b) => b.sequence - a.sequence)) {
    if (event.type !== SEARCH_EVENT) continue
    const { provider, durationMs, resultCount } = event.data ?? {}
    if ((provider === 'trace' || provider === 'file-search-fallback') &&
      typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 &&
      typeof resultCount === 'number' && Number.isInteger(resultCount) && resultCount >= 0) {
      return { provider, durationMs, resultCount }
    }
  }
  return null
}

export const formatSearchDuration = (ms: number): string => `${ms.toLocaleString('en-US', { maximumFractionDigits: 1 })} ms`

const COUNT_FIELDS = ['fileCount', 'byteCount', 'cloneElapsedMs', 'indexElapsedMs', 'elapsedMs'] as const
const TEXT_FIELDS = ['errorCode', 'message', 'repositoryCommit'] as const

export function preparationIsActive(status: PreparationStatus | null): boolean {
  return status !== null && (status.phase === 'queued' || status.phase === 'preparing' || status.phase === 'indexing')
}

function preparationEvents(events: readonly PreparationEvent[]) {
  return [...events].filter(event => event.type === PREPARATION_EVENT && event.data).sort((left, right) => left.sequence - right.sequence)
}

function validPhase(data: Record<string, unknown>): { jobId: string; phase: PreparationPhase } | null {
  const { jobId, phase } = data
  if (typeof jobId !== 'string' || jobId === '' || typeof phase !== 'string' || !PREPARATION_PHASES.includes(phase as PreparationPhase)) return null
  return { jobId, phase: phase as PreparationPhase }
}

/** Latest preparation phase for one project. A later event keeps an earlier real count when it omits that field. Missing data never becomes ready. */
export function latestPreparation(events: readonly PreparationEvent[]): PreparationStatus | null {
  let latest: PreparationStatus | null = null
  for (const event of preparationEvents(events)) {
    const data = event.data
    const head = data ? validPhase(data) : null
    if (!data || !head) continue
    const next: PreparationStatus = { ...(latest?.jobId === head.jobId ? latest : {}), ...head }
    for (const field of COUNT_FIELDS) {
      const value = data[field]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) next[field] = value
    }
    for (const field of TEXT_FIELDS) {
      const value = data[field]
      if (typeof value === 'string' && value !== '') next[field] = value
    }
    latest = next
  }
  return latest
}

/**
 * Indexing speed in files per second, from backend-reported counters only.
 * Prefers the last two consecutive indexing events; a single event falls back to its own total over its own index time.
 */
export function indexingRate(events: readonly PreparationEvent[]): number | null {
  const latest = latestPreparation(events)
  if (!latest) return null
  const samples = preparationEvents(events).flatMap(event => {
    const data = event.data
    const head = data ? validPhase(data) : null
    if (!data || !head || head.jobId !== latest.jobId || head.phase !== 'indexing') return []
    const files = data.fileCount
    const ms = typeof data.indexElapsedMs === 'number' ? data.indexElapsedMs : data.elapsedMs
    return typeof files === 'number' && typeof ms === 'number' && Number.isFinite(files) && Number.isFinite(ms) && files >= 0 && ms >= 0 ? [{ files, ms }] : []
  })
  const last = samples[samples.length - 1]
  if (!last) return null
  const before = samples[samples.length - 2]
  if (before && last.ms > before.ms && last.files >= before.files) return (last.files - before.files) / ((last.ms - before.ms) / 1000)
  return last.ms > 0 ? last.files / (last.ms / 1000) : null
}

/** Files per second over a finished index, from the event's own totals. */
export function averageIndexRate(status: PreparationStatus): number | null {
  return status.fileCount !== undefined && status.indexElapsedMs !== undefined && status.indexElapsedMs > 0 ? status.fileCount / (status.indexElapsedMs / 1000) : null
}

/** Client-side stopwatch for one preparation job. Timestamps are the browser's own clock, never backend fields. */
export type PreparationClock = { jobId: string; phase: PreparationPhase; jobStartedAt: number; phaseStartedAt: number }

export function advancePreparationClock(previous: PreparationClock | null, status: PreparationStatus | null, now: number): PreparationClock | null {
  if (!status) return null
  if (previous?.jobId === status.jobId) return previous.phase === status.phase ? previous : { ...previous, phase: status.phase, phaseStartedAt: now }
  // A job first seen mid-flight (page reload) starts from the elapsed time the backend already reported.
  return { jobId: status.jobId, phase: status.phase, jobStartedAt: now - (status.elapsedMs ?? 0), phaseStartedAt: now }
}

/** 0.84 s, 12.4 s, 2m 05s. */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)} s`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type CreateResult = { ok: true; data: { projectId: string } } | { ok: false; reason: string; message: string }

export type CreateOutcome =
  | { kind: 'created'; projectId: string }
  | { kind: 'recovered'; projectId: string; reason: string; message: string }
  | { kind: 'failed'; reason: string; message: string }
  | { kind: 'aborted' }

const PROJECT_ID_IN_TEXT = /(?<![A-Za-z0-9_])prj_[0-9a-fA-F]+(?:-[0-9a-fA-F]+)*/

/** A failed create may already have persisted the project; the adapter names its id in the message. Never invents one. */
export function planCreateOutcome(result: CreateResult): CreateOutcome {
  if (result.ok) return { kind: 'created', projectId: result.data.projectId }
  if (result.reason === 'aborted') return { kind: 'aborted' }
  const projectId = result.message.match(PROJECT_ID_IN_TEXT)?.[0]
  if (projectId && isProjectId(projectId)) return { kind: 'recovered', projectId, reason: result.reason, message: result.message }
  return { kind: 'failed', reason: result.reason, message: result.message }
}

export type EventPage<T> = { events: readonly T[]; cursor?: string; hasMore: boolean }
export type EventPullState<T> = { events: T[]; cursor?: string }
export type EventPullStep<T> = { state: EventPullState<T>; fetchMore: boolean; error?: string }

/** Folds one replay page into the pull state. Follows hasMore while the cursor advances; a stalled cursor is an explicit error, never a retry loop. */
export function applyEventPage<T extends { eventId: string; sequence: number }>(state: EventPullState<T>, page: EventPage<T>): EventPullStep<T> {
  const next: EventPullState<T> = { events: mergeEvents(state.events, page.events), cursor: page.cursor ?? state.cursor }
  if (!page.hasMore) return { state: next, fetchMore: false }
  if (!next.cursor || next.cursor === state.cursor) {
    return { state: next, fetchMore: false, error: 'The event history reports more events, but its cursor did not advance. Refresh to try again.' }
  }
  return { state: next, fetchMore: true }
}

export const DEFAULT_ENGINEER_NAME = 'Ranger'

/** Project screens show the loaded project's engineer only; a missing, foreign or denied project never inherits a previous name. */
export function projectViewEngineerName(projectEngineer: string | null | undefined): string {
  return projectEngineer ?? DEFAULT_ENGINEER_NAME
}

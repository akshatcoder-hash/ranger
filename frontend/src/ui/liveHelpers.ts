export const DEMO_PROJECT_ID = 'northstar-return-support'

export type Capabilities = { xai: boolean; instabox: boolean; trace: boolean }

const LIVE_PROJECT_ID = /^prj_[0-9a-fA-F-]+$/

/** Backend project ids are prefixed UUIDs; anything else (including the demo id) is never sent to the backend. */
export function isLiveProjectId(value: string | null | undefined): value is string {
  return typeof value === 'string' && LIVE_PROJECT_ID.test(value)
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
 * The backend still decides, including whether a local path is an operator-approved checkout.
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
      return 'Use an https URL, an absolute local path, or a file:// URL. A remote URL is only a reference; it does not load files.'
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
  indexElapsedMs?: number
  elapsedMs?: number
  errorCode?: string
  message?: string
  repositoryCommit?: string
}

type PreparationEvent = { sequence: number; type: string; data?: Record<string, unknown> }

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Latest preparation phase for one project. A later event keeps an earlier real count when it omits that field. Missing data never becomes ready. */
export function latestPreparation(events: readonly PreparationEvent[]): PreparationStatus | null {
  const ordered = [...events].filter(event => event.type === PREPARATION_EVENT && event.data).sort((left, right) => left.sequence - right.sequence)
  let latest: PreparationStatus | null = null
  for (const event of ordered) {
    const data = event.data
    if (!data) continue
    const phase = data.phase
    const jobId = data.jobId
    if (typeof jobId !== 'string' || jobId === '' || typeof phase !== 'string' || !PREPARATION_PHASES.includes(phase as PreparationPhase)) continue
    const previous: PreparationStatus | null = latest?.jobId === jobId ? latest : null
    const carried: PreparationStatus = {
      jobId,
      phase: phase as PreparationPhase,
      ...(previous?.fileCount !== undefined ? { fileCount: previous.fileCount } : {}),
      ...(previous?.byteCount !== undefined ? { byteCount: previous.byteCount } : {}),
      ...(previous?.indexElapsedMs !== undefined ? { indexElapsedMs: previous.indexElapsedMs } : {}),
      ...(previous?.elapsedMs !== undefined ? { elapsedMs: previous.elapsedMs } : {}),
      ...(previous?.errorCode ? { errorCode: previous.errorCode } : {}),
      ...(previous?.message ? { message: previous.message } : {}),
      ...(previous?.repositoryCommit ? { repositoryCommit: previous.repositoryCommit } : {}),
    }
    const fileCount = optionalCount(data.fileCount)
    const byteCount = optionalCount(data.byteCount)
    const indexElapsedMs = optionalCount(data.indexElapsedMs)
    const elapsedMs = optionalCount(data.elapsedMs)
    const errorCode = optionalText(data.errorCode)
    const message = optionalText(data.message)
    const repositoryCommit = optionalText(data.repositoryCommit)
    latest = {
      ...carried,
      ...(fileCount !== undefined ? { fileCount } : {}),
      ...(byteCount !== undefined ? { byteCount } : {}),
      ...(indexElapsedMs !== undefined ? { indexElapsedMs } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(message ? { message } : {}),
      ...(repositoryCommit ? { repositoryCommit } : {}),
    }
  }
  return latest
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
  if (projectId && isLiveProjectId(projectId)) return { kind: 'recovered', projectId, reason: result.reason, message: result.message }
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

const BOOTSTRAP_PREFIX = 'RANGER_BOOTSTRAP_TOKEN='

/** Accepts a bare token or the exact `RANGER_BOOTSTRAP_TOKEN=<token>` line from the bootstrap file. Anything else with whitespace is rejected locally. */
export function normalizeCredential(raw: string): string | null {
  let value = raw.trim()
  if (value.startsWith(BOOTSTRAP_PREFIX)) value = value.slice(BOOTSTRAP_PREFIX.length).trim()
  return value && !/\s/.test(value) ? value : null
}

export const DEFAULT_ENGINEER_NAME = 'Ranger'

/** Project screens show the loaded project's engineer only; a missing, foreign or denied project never inherits a previous name. */
export function projectViewEngineerName(demo: boolean, draft: string, projectEngineer: string | null | undefined): string {
  return demo ? draft : projectEngineer ?? DEFAULT_ENGINEER_NAME
}

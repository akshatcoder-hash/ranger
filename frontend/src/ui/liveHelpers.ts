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

/** Returns a user-facing problem, or null when the repository URL and ref look acceptable. The backend still decides. */
export function validateRepositoryInput(url: string, ref: string): string | null {
  let parsed: URL
  try { parsed = new URL(url.trim()) } catch { return 'Enter a full repository URL, for example https://github.com/owner/name.' }
  if (parsed.protocol !== 'https:') return 'Only https repository URLs are supported.'
  if (parsed.username || parsed.password) return 'Do not put credentials in the repository URL.'
  const cleanRef = ref.trim()
  if (!cleanRef) return 'Enter a branch, tag or commit to use.'
  if (cleanRef.length > 255 || /\s/.test(cleanRef)) return 'The ref cannot contain spaces.'
  return null
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

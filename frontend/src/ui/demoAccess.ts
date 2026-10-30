import type { DemoProject } from '../api'

/** Canonical comparison key for a public GitHub-style https URL; null for anything else (local paths, credentials, query strings). */
export function repositoryKey(raw: string): string | null {
  let url: URL
  try { url = new URL(raw.trim()) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
  const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
  if (!path) return null
  const host = url.host.toLowerCase()
  return `${host}${host === 'github.com' ? path.toLowerCase() : path}`
}

/** True only for the exact repository and ref the operator opted in; any other repository keeps the normal create flow. */
export function matchesDemoProject(demo: DemoProject | undefined, url: string, ref: string): demo is DemoProject {
  if (!demo || ref.trim() !== demo.ref) return false
  const wanted = repositoryKey(demo.repositoryUrl)
  return wanted !== null && repositoryKey(url) === wanted
}

type EventLike = { sequence: number; type: string; data?: Record<string, unknown> }

/**
 * Events from this conversation's creation onward. The shared demo project keeps earlier history (including past
 * preparation attempts); a fresh visitor's view starts at their own conversation, and nothing is deleted or rewritten.
 * Before the creation event is seen the view is empty rather than falling back to older history.
 */
export function eventsSinceConversation<T extends EventLike>(events: readonly T[], conversationId: string): T[] {
  const start = events.find(event => event.type === 'conversation.created' && event.data?.conversationId === conversationId)
  return start ? events.filter(event => event.sequence >= start.sequence) : []
}

const STORAGE_KEY = 'ranger.demo.conversation'
type Store = Pick<Storage, 'getItem' | 'setItem'>

/** The visitor's own conversation in the shared project. Tab-scoped, an identifier only: never a credential. */
export function rememberDemoConversation(projectId: string, conversationId: string, store: Store | null = browserStore()): void {
  try { store?.setItem(STORAGE_KEY, JSON.stringify({ projectId, conversationId })) } catch { /* storage may be blocked; the view then shows the latest conversation */ }
}

export function recallDemoConversation(projectId: string | null, store: Store | null = browserStore()): string | undefined {
  if (!projectId) return undefined
  try {
    const saved = JSON.parse(store?.getItem(STORAGE_KEY) ?? 'null') as { projectId?: unknown; conversationId?: unknown } | null
    return saved?.projectId === projectId && typeof saved.conversationId === 'string' ? saved.conversationId : undefined
  } catch { return undefined }
}

function browserStore(): Store | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage } catch { return null }
}

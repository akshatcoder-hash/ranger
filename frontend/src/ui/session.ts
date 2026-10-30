import type { ApiResult, RangerApi, Session } from '../api'

/**
 * Boot sequence: reuse the cookie session if the backend still honours it, otherwise open one anonymous session and use it.
 * Only a real 401 opens a session; an unreachable or failing backend is reported as-is rather than creating principals.
 */
export async function bootSession(api: Pick<RangerApi, 'getSession' | 'openAnonymousSession'>, signal: AbortSignal): Promise<ApiResult<Session>> {
  const existing = await api.getSession(signal)
  if (existing.ok || existing.reason !== 'unauthorized') return existing
  return api.openAnonymousSession(signal)
}

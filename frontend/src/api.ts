/** The API contract is owned by Factory and has not been published yet.
 * Live mode intentionally refuses to imply a successful connection until it is wired. */
export type ApiUnavailable = { ok: false; reason: 'contract_missing' | 'aborted'; message: string }
export type ApiResult<T> = { ok: true; data: T } | ApiUnavailable

export type ProjectRequest = { prompt: string; engineerName: string; repository?: string }
export type PlanDecision = { approved: boolean; planId: string }
export type MediaSessionRequest = { kind: 'voice' | 'screen'; stream: MediaStream }
export type MediaSession = { id: string }

export interface RangerApi {
  createProject(request: ProjectRequest, signal: AbortSignal): Promise<ApiResult<{ projectId: string }>>
  decidePlan(decision: PlanDecision, signal: AbortSignal): Promise<ApiResult<{ accepted: boolean }>>
  startMediaSession(request: MediaSessionRequest, signal: AbortSignal): Promise<ApiResult<MediaSession>>
  endMediaSession(sessionId: string, signal: AbortSignal): Promise<ApiResult<void>>
}

/** Contract-backed adapter seam. Add endpoint mappings only when Factory publishes them. */
export class UnconfiguredRangerApi implements RangerApi {
  private unavailable<T>(signal: AbortSignal): ApiResult<T> {
    return signal.aborted
      ? { ok: false, reason: 'aborted', message: 'Request cancelled.' }
      : { ok: false, reason: 'contract_missing', message: 'The Ranger backend contract is not connected yet.' }
  }
  async createProject(_request: ProjectRequest, signal: AbortSignal) { return this.unavailable<{ projectId: string }>(signal) }
  async decidePlan(_decision: PlanDecision, signal: AbortSignal) { return this.unavailable<{ accepted: boolean }>(signal) }
  async startMediaSession(_request: MediaSessionRequest, signal: AbortSignal) { return this.unavailable<MediaSession>(signal) }
  async endMediaSession(_sessionId: string, signal: AbortSignal) { return this.unavailable<void>(signal) }
}

export const rangerApi: RangerApi = new UnconfiguredRangerApi()

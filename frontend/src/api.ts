/**
 * Same-origin browser adapter for the Ranger v1 control API.
 * Provider calls stay on the backend. Credentials never enter storage, logs, or URLs.
 */

export type ApiReason = 'aborted' | 'unauthorized' | 'unavailable' | 'unsupported' | 'partial' | 'backend'
export type ApiFailure = {
  ok: false
  reason: ApiReason
  message: string
  /** Backend error code, when the failure came from a Ranger error envelope. */
  code?: string
  /** Backend `details.reason`, for example `capture_ended` or `upload_rate`. */
  detail?: string
  retryAfterMs?: number
}
export type ApiResult<T> = { ok: true; data: T } | ApiFailure

export type ProjectRequest = { prompt: string; engineerName: string; repository?: string }
export type PlanDecision = { approved: boolean; planId: string }
export type VoiceSession = { sessionId: string; model: string; expiresAt: string }
export type CaptureSession = { sessionId: string; generation: number }
export type FrameReceipt = { frameId: string; width: number; height: number; byteSize: number; captureTimestamp: string }
export type InspectionObservation = { text: string; uncertainty: number; sourceFrameId: string; sourceTimestamp: string }
export type Inspection = {
  state: 'observed' | 'fresh-frame-requested'
  observations: InspectionObservation[]
  sourceFrameId: string | null
  sourceTimestamp: string | null
  freshness: 'current' | 'stale' | 'absent'
}
export type LivePlan = {
  planId: string
  version: number
  items: string[]
  acceptanceCriteria: string[]
  permittedScope: string[]
}
export type LiveProject = {
  projectId: string
  name: string
  engineerName: string
  conversationId: string | null
  messages: string[]
  plan: LivePlan | null
  approved: boolean
  repositoryUrl: string | null
}
/** GET /v1/projects/:id/workspace/status envelope. Fields match the workspace contract; nothing else is invented. */
export type WorkspaceStatus = {
  projectId: string
  adapter: string
  adapterKind: 'vm'
  desiredState: string
  observedState: string
  sourceRevision: string | null
}
export type PlanState = { plan: LivePlan | null; approved: boolean }
export type RunRecord = {
  runId: string
  projectId: string
  planId: string
  planVersion: number
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  createdAt: string
  updatedAt: string
  failureCode?: string
  failureMessage?: string
}
export type WorkspaceFile = { path: string; sizeBytes: number; text: string | null }
export type WorkspaceDiff = { diff: string; changedFiles: string[] }
export type TestResult = { testResultId: string; suite: string; state: string; exitCode: number; ranAt: string }
export type RunTool = { callId: string; name: string; status: string; result?: Record<string, unknown>; error?: string; createdAt: string }
export type ProjectEvent = { eventId: string; sequence: number; type: string; data?: Record<string, unknown> }

export interface RangerApi {
  connectSession(credential: string, signal: AbortSignal): Promise<ApiResult<{ principalId: string }>>
  getSession(signal: AbortSignal): Promise<ApiResult<{ principalId: string }>>
  getCapabilities(signal: AbortSignal): Promise<ApiResult<{ xai: boolean; instabox: boolean; trace: boolean }>>
  createProject(request: ProjectRequest, signal: AbortSignal): Promise<ApiResult<{ projectId: string; conversationId: string }>>
  getPlanState(projectId: string, signal: AbortSignal): Promise<ApiResult<PlanState>>
  listRuns(projectId: string, signal: AbortSignal): Promise<ApiResult<RunRecord[]>>
  readWorkspaceFile(projectId: string, path: string, signal: AbortSignal): Promise<ApiResult<WorkspaceFile>>
  getWorkspaceDiff(projectId: string, signal: AbortSignal): Promise<ApiResult<WorkspaceDiff>>
  listTestResults(projectId: string, signal: AbortSignal): Promise<ApiResult<TestResult[]>>
  listRunTools(projectId: string, runId: string, signal: AbortSignal): Promise<ApiResult<RunTool[]>>
  loadProject(projectId: string, signal: AbortSignal): Promise<ApiResult<LiveProject>>
  renameEngineer(projectId: string, name: string, signal: AbortSignal): Promise<ApiResult<void>>
  sendMessage(projectId: string, conversationId: string, content: string, signal: AbortSignal): Promise<ApiResult<void>>
  createManualPlan(
    request: { projectId: string; conversationId: string; items: string[]; acceptanceCriteria: string[] },
    signal: AbortSignal,
  ): Promise<ApiResult<LivePlan>>
  decidePlan(
    request: { projectId: string; conversationId: string; approved: boolean; planId: string; permittedScope: string[] },
    signal: AbortSignal,
  ): Promise<ApiResult<{ accepted: boolean }>>
  connectRepository(projectId: string, url: string, ref: string, signal: AbortSignal): Promise<ApiResult<void>>
  getWorkspaceStatus(projectId: string, signal: AbortSignal): Promise<ApiResult<WorkspaceStatus>>
  getEvents(
    projectId: string,
    signal: AbortSignal,
    cursor?: string,
  ): Promise<ApiResult<{ events: ProjectEvent[]; cursor?: string; hasMore: boolean }>>
  startVoiceSession(projectId: string, conversationId: string, signal: AbortSignal): Promise<ApiResult<VoiceSession>>
  createRelayTicket(projectId: string, signal: AbortSignal): Promise<ApiResult<{ ticket: string }>>
  cancelVoiceResponse(projectId: string, sessionId: string, signal: AbortSignal): Promise<ApiResult<{ interrupted: boolean }>>
  endVoiceSession(projectId: string, sessionId: string, signal: AbortSignal): Promise<ApiResult<void>>
  startCaptureSession(projectId: string, conversationId: string, signal: AbortSignal): Promise<ApiResult<CaptureSession>>
  ingestCaptureFrame(
    request: { projectId: string; sessionId: string; frameId: string; imageBase64: string; captureTimestamp: string },
    signal: AbortSignal,
  ): Promise<ApiResult<FrameReceipt>>
  requestInspection(projectId: string, sessionId: string, signal: AbortSignal): Promise<ApiResult<Inspection>>
  endCaptureSession(projectId: string, sessionId: string, signal: AbortSignal): Promise<ApiResult<void>>
}

/** Operator-authored plans may edit the project tree and run sandbox commands. */
export const MANUAL_PLAN_SCOPE = ['edit:.', 'command'] as const
const TITLE_LIMIT = 200
const MESSAGE_PAGE = '100'
const EVENT_PAGE = '100'
const MAX_EVENT_PAGES = 50
const ID = /^(prj|cnv|pln|vcs|cap|run)_[0-9a-fA-F-]+$/

type Envelope = { requestId?: string; error?: { code?: string; message?: string; details?: { reason?: unknown; retryAfterMs?: unknown } } }

class HttpRangerApi implements RangerApi {
  private csrfToken: string | null = null

  async connectSession(credential: string, signal: AbortSignal): Promise<ApiResult<{ principalId: string }>> {
    const secret = credential.trim()
    if (!secret) return fail('unauthorized', 'A Ranger credential is required.')
    const created = await this.request<{ sessionId?: string; csrfToken?: string }>(
      'POST',
      '/v1/auth/browser-sessions',
      signal,
      { body: { apiToken: secret }, bearer: secret },
    )
    if (!created.ok) return created
    if (typeof created.data.csrfToken === 'string' && created.data.csrfToken !== '') this.csrfToken = created.data.csrfToken
    return this.getSession(signal)
  }

  async getSession(signal: AbortSignal): Promise<ApiResult<{ principalId: string }>> {
    const me = await this.request<{ principalId?: string }>('GET', '/v1/auth/me', signal)
    if (!me.ok) return me
    if (typeof me.data.principalId !== 'string' || me.data.principalId === '') {
      return fail('backend', 'The session response did not include a principal.')
    }
    return ok({ principalId: me.data.principalId })
  }

  async getCapabilities(signal: AbortSignal): Promise<ApiResult<{ xai: boolean; instabox: boolean; trace: boolean }>> {
    const result = await this.request<{ providers?: { xai?: { configured?: boolean }; instabox?: { configured?: boolean }; trace?: { configured?: boolean } } }>(
      'GET',
      '/v1/capabilities',
      signal,
    )
    if (!result.ok) return result
    const providers = result.data.providers
    return ok({
      xai: providers?.xai?.configured === true,
      instabox: providers?.instabox?.configured === true,
      trace: providers?.trace?.configured === true,
    })
  }

  async createProject(request: ProjectRequest, signal: AbortSignal): Promise<ApiResult<{ projectId: string; conversationId: string }>> {
    const prompt = request.prompt.trim()
    const engineerName = request.engineerName.trim()
    if (!prompt || !engineerName) return fail('backend', 'A prompt and engineer name are required.')
    const title = prompt.slice(0, TITLE_LIMIT)
    const project = await this.request<{ project?: { projectId?: string } }>('POST', '/v1/projects', signal, {
      body: { name: title, engineerDisplayName: engineerName },
      idempotent: true,
    })
    if (!project.ok) return uncertain(project, 'project')
    const projectId = project.data.project?.projectId
    if (!validId(projectId, 'prj')) return fail('partial', 'The project request returned success, but its id was missing. Reload before retrying.')

    const conversation = await this.request<{ conversation?: { conversationId?: string } }>(
      'POST',
      `/v1/projects/${projectId}/conversations`,
      signal,
      { body: { title }, idempotent: true },
    )
    if (!conversation.ok) return uncertain(conversation, 'conversation', projectId)
    const conversationId = conversation.data.conversation?.conversationId
    if (!validId(conversationId, 'cnv')) {
      return fail('partial', `Project ${projectId} exists. The conversation response did not include an id, so it may already be saved. Reload before retrying.`)
    }

    const message = await this.request('POST', `/v1/projects/${projectId}/conversations/${conversationId}/messages`, signal, {
      body: { role: 'user', content: prompt },
      idempotent: true,
    })
    if (!message.ok) return uncertain(message, 'initial message', projectId, conversationId)
    return ok({ projectId, conversationId })
  }

  async loadProject(projectId: string, signal: AbortSignal): Promise<ApiResult<LiveProject>> {
    if (!validId(projectId, 'prj')) return fail('backend', 'That project id is not a Ranger project id.')
    const project = await this.request<{ project?: { projectId?: string; name?: string; engineerDisplayName?: string } }>(
      'GET',
      `/v1/projects/${projectId}`,
      signal,
    )
    if (!project.ok) return project
    const name = project.data.project?.name
    const engineerName = project.data.project?.engineerDisplayName
    if (typeof name !== 'string' || typeof engineerName !== 'string') {
      return fail('backend', 'The project response was missing its name.')
    }

    const conversations = await this.request<{ conversations?: { conversationId?: string; createdAt?: string }[] }>(
      'GET',
      `/v1/projects/${projectId}/conversations`,
      signal,
    )
    if (!conversations.ok) return conversations
    const conversationId = latestId(conversations.data.conversations, 'conversationId', 'cnv')

    const [messages, planState, repository] = await Promise.all([
      conversationId === null ? Promise.resolve(ok<string[]>([])) : this.readMessages(projectId, conversationId, signal),
      this.getPlanState(projectId, signal),
      this.readRepository(projectId, signal),
    ])
    if (!messages.ok) return messages
    if (!planState.ok) return planState
    if (!repository.ok) return repository
    return ok({
      projectId,
      name,
      engineerName,
      conversationId,
      messages: messages.data,
      plan: planState.data.plan,
      approved: planState.data.approved,
      repositoryUrl: repository.data,
    })
  }

  async renameEngineer(projectId: string, name: string, signal: AbortSignal): Promise<ApiResult<void>> {
    if (!validId(projectId, 'prj')) return fail('backend', 'That project id is not a Ranger project id.')
    const engineerDisplayName = name.trim()
    if (!engineerDisplayName) return fail('backend', 'An engineer name is required.')
    const result = await this.request('PATCH', `/v1/projects/${projectId}`, signal, {
      body: { engineerDisplayName },
      idempotent: true,
    })
    return result.ok ? ok(undefined) : result
  }

  async sendMessage(projectId: string, conversationId: string, content: string, signal: AbortSignal): Promise<ApiResult<void>> {
    if (!validId(projectId, 'prj') || !validId(conversationId, 'cnv')) {
      return fail('backend', 'A project and conversation id are required.')
    }
    const text = content.trim()
    if (!text) return fail('backend', 'A message is required.')
    const result = await this.request('POST', `/v1/projects/${projectId}/conversations/${conversationId}/messages`, signal, {
      body: { role: 'user', content: text },
      idempotent: true,
    })
    return result.ok ? ok(undefined) : result
  }

  async createManualPlan(request: { projectId: string; conversationId: string; items: string[]; acceptanceCriteria: string[] }, signal: AbortSignal): Promise<ApiResult<LivePlan>> {
    if (!validId(request.projectId, 'prj') || !validId(request.conversationId, 'cnv')) {
      return fail('backend', 'A project and conversation id are required.')
    }
    const items = cleanList(request.items)
    const acceptanceCriteria = cleanList(request.acceptanceCriteria)
    if (!items.length || !acceptanceCriteria.length) {
      return fail('backend', 'A manual plan needs at least one item and one acceptance criterion.')
    }
    const note = await this.request('POST', `/v1/projects/${request.projectId}/conversations/${request.conversationId}/messages`, signal, {
      body: { role: 'system', content: 'Operator-authored plan. This plan was written in the browser and was not generated by a model.' },
      idempotent: true,
    })
    if (!note.ok) return uncertain(note, 'operator note', request.projectId, request.conversationId)
    const created = await this.request<{ plan?: RawPlan }>('POST', `/v1/projects/${request.projectId}/plans`, signal, {
      body: { items, acceptanceCriteria, permittedScope: [...MANUAL_PLAN_SCOPE] },
      idempotent: true,
    })
    if (!created.ok) return uncertain(created, 'plan', request.projectId, request.conversationId)
    const plan = toPlan(created.data.plan)
    if (plan) return ok(plan)
    const returnedId = created.data.plan?.planId
    const knownId = typeof returnedId === 'string' && returnedId !== '' ? ` Returned plan id: ${returnedId}.` : ''
    return fail('partial', `Project ${request.projectId} accepted the plan request, but the response was incomplete.${knownId} Reload before retrying; a new plan version was not created.`)
  }

  async decidePlan(request: { projectId: string; conversationId: string; approved: boolean; planId: string; permittedScope: string[] }, signal: AbortSignal): Promise<ApiResult<{ accepted: boolean }>> {
    if (!validId(request.projectId, 'prj') || !validId(request.conversationId, 'cnv') || !validId(request.planId, 'pln')) {
      return fail('backend', 'Approval needs a project, conversation, and exact plan id.')
    }
    if (!request.approved) {
      const note = await this.request('POST', `/v1/projects/${request.projectId}/conversations/${request.conversationId}/messages`, signal, {
        body: { role: 'user', content: `Change requested for plan ${request.planId}.` },
        idempotent: true,
      })
      return note.ok ? ok({ accepted: false }) : note
    }
    const scope = cleanList(request.permittedScope)
    if (!scope.length) return fail('backend', 'Approval needs the exact permitted scope.')
    const approved = await this.request<{ approval?: { status?: string; planId?: string } }>(
      'POST',
      `/v1/projects/${request.projectId}/plans/${request.planId}/approvals`,
      signal,
      { body: { permittedScope: scope }, idempotent: true },
    )
    if (!approved.ok) return approved
    return ok({ accepted: approved.data.approval?.status === 'active' && approved.data.approval.planId === request.planId })
  }

  async connectRepository(projectId: string, url: string, ref: string, signal: AbortSignal): Promise<ApiResult<void>> {
    if (!validId(projectId, 'prj')) return fail('backend', 'That project id is not a Ranger project id.')
    const cleanUrl = url.trim()
    const cleanRef = ref.trim()
    if (!cleanUrl || !cleanRef) return fail('backend', 'A repository URL and ref are required.')
    const result = await this.request('PUT', `/v1/projects/${projectId}/repository`, signal, {
      body: { url: cleanUrl, ref: cleanRef },
      idempotent: true,
    })
    return result.ok ? ok(undefined) : result
  }

  async getWorkspaceStatus(projectId: string, signal: AbortSignal): Promise<ApiResult<WorkspaceStatus>> {
    if (!validId(projectId, 'prj')) return fail('backend', 'That project id is not a Ranger project id.')
    const result = await this.request<{ workspace?: Record<string, unknown> }>('GET', `/v1/projects/${projectId}/workspace/status`, signal)
    if (!result.ok) return result
    const workspace = toWorkspaceStatus(result.data.workspace)
    return workspace ? ok(workspace) : fail('backend', 'The workspace status response was incomplete.')
  }

  async listRuns(projectId: string, signal: AbortSignal): Promise<ApiResult<RunRecord[]>> {
    if (!validId(projectId, 'prj')) return fail('backend', 'That project id is not a Ranger project id.')
    const result = await this.request<{ runs?: RunRecord[] }>('GET', `/v1/projects/${projectId}/runs`, signal)
    if (!result.ok) return result
    const runs = result.data.runs
    if (!Array.isArray(runs) || runs.some(run => !run || !validId(run.runId, 'run') || run.projectId !== projectId || !validId(run.planId, 'pln') || !Number.isInteger(run.planVersion) || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(run.state) || typeof run.createdAt !== 'string' || typeof run.updatedAt !== 'string')) return fail('backend', 'The run list response was incomplete.')
    return ok([...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId)))
  }

  async readWorkspaceFile(projectId: string, path: string, signal: AbortSignal): Promise<ApiResult<WorkspaceFile>> {
    if (!validId(projectId, 'prj') || !path) return fail('backend', 'A project and file path are required.')
    const result = await this.request<{ path?: string; contentBase64?: string; sizeBytes?: number }>('GET', `/v1/projects/${projectId}/workspace/file?${new URLSearchParams({ path })}`, signal)
    if (!result.ok) return result
    if (result.data.path !== path || typeof result.data.contentBase64 !== 'string' || typeof result.data.sizeBytes !== 'number') return fail('backend', 'The workspace file response was incomplete.')
    let bytes: Uint8Array
    try { bytes = Uint8Array.from(atob(result.data.contentBase64), character => character.charCodeAt(0)) }
    catch { return fail('backend', 'The workspace file encoding was invalid.') }
    if (bytes.length !== result.data.sizeBytes) return fail('backend', 'The workspace file size did not match its contents.')
    let text: string | null = null
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.includes('\0')) text = null } catch { /* Binary content is not rendered as source. */ }
    return ok({ path, sizeBytes: result.data.sizeBytes, text })
  }

  async getWorkspaceDiff(projectId: string, signal: AbortSignal): Promise<ApiResult<WorkspaceDiff>> {
    if (!validId(projectId, 'prj')) return fail('backend', 'That project id is not a Ranger project id.')
    const result = await this.request<WorkspaceDiff>('GET', `/v1/projects/${projectId}/workspace/diff`, signal)
    if (!result.ok) return result
    if (typeof result.data.diff !== 'string' || !Array.isArray(result.data.changedFiles) || result.data.changedFiles.some(path => typeof path !== 'string')) return fail('backend', 'The workspace diff response was incomplete.')
    return ok({ diff: result.data.diff, changedFiles: result.data.changedFiles })
  }

  async listTestResults(projectId: string, signal: AbortSignal): Promise<ApiResult<TestResult[]>> {
    if (!validId(projectId, 'prj')) return fail('backend', 'That project id is not a Ranger project id.')
    const result = await this.request<{ testResults?: TestResult[] }>('GET', `/v1/projects/${projectId}/workspace/test-results`, signal)
    if (!result.ok) return result
    const rows = result.data.testResults
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.testResultId !== 'string' || typeof row.suite !== 'string' || typeof row.state !== 'string' || !Number.isInteger(row.exitCode) || typeof row.ranAt !== 'string')) return fail('backend', 'The test results response was incomplete.')
    return ok([...rows].sort((left, right) => right.ranAt.localeCompare(left.ranAt)))
  }

  async listRunTools(projectId: string, runId: string, signal: AbortSignal): Promise<ApiResult<RunTool[]>> {
    if (!validId(projectId, 'prj') || !validId(runId, 'run')) return fail('backend', 'A project and run id are required.')
    const result = await this.request<{ tools?: RunTool[] }>('GET', `/v1/projects/${projectId}/runs/${runId}/tools`, signal)
    if (!result.ok) return result
    const rows = result.data.tools
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.callId !== 'string' || typeof row.name !== 'string' || typeof row.status !== 'string' || typeof row.createdAt !== 'string')) return fail('backend', 'The run tools response was incomplete.')
    return ok(rows)
  }

  async getEvents(projectId: string, signal: AbortSignal, cursor?: string): Promise<ApiResult<{ events: ProjectEvent[]; cursor?: string; hasMore: boolean }>> {
    if (!validId(projectId, 'prj')) return fail('backend', 'That project id is not a Ranger project id.')
    const events: ProjectEvent[] = []
    let pageCursor = cursor
    let hasMore = false
    for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
      const params = new URLSearchParams({ limit: EVENT_PAGE })
      if (pageCursor) params.set('cursor', pageCursor)
      const result = await this.request<{ events?: { eventId?: string; sequence?: number; type?: string; data?: unknown }[]; nextCursor?: string | null; hasMore?: boolean }>(
        'GET',
        `/v1/projects/${projectId}/events?${params}`,
        signal,
      )
      if (!result.ok) {
        if (events.length === 0) return result
        return fail(result.reason, `Loaded ${events.length} events through cursor ${pageCursor ?? 'start'}, then paging failed. ${result.message}`)
      }
      for (const event of result.data.events ?? []) {
        if (typeof event.eventId === 'string' && typeof event.sequence === 'number' && typeof event.type === 'string') {
          const data = eventData(event.data)
          events.push({ eventId: event.eventId, sequence: event.sequence, type: event.type, ...(data ? { data } : {}) })
        }
      }
      const nextCursor = typeof result.data.nextCursor === 'string' && result.data.nextCursor !== '' ? result.data.nextCursor : undefined
      hasMore = result.data.hasMore === true
      if (!hasMore || nextCursor === undefined) {
        return ok({ events, ...(nextCursor ? { cursor: nextCursor } : {}), hasMore: false })
      }
      if (nextCursor === pageCursor) return ok({ events, cursor: nextCursor, hasMore: true })
      pageCursor = nextCursor
    }
    return ok({ events, ...(pageCursor ? { cursor: pageCursor } : {}), hasMore })
  }

  async startVoiceSession(projectId: string, conversationId: string, signal: AbortSignal): Promise<ApiResult<VoiceSession>> {
    if (!validId(projectId, 'prj') || !validId(conversationId, 'cnv')) return fail('backend', 'A voice call needs a project and conversation id.')
    const result = await this.request<{ session?: { sessionId?: string; model?: string; expiresAt?: string; state?: string } }>(
      'POST',
      `/v1/projects/${projectId}/voice/sessions`,
      signal,
      { body: { conversationId }, idempotent: true },
    )
    if (!result.ok) return result
    const session = result.data.session
    if (!validId(session?.sessionId, 'vcs') || session.state !== 'active') return fail('backend', 'The voice session response was incomplete, so no call was started.')
    return ok({ sessionId: session.sessionId, model: typeof session.model === 'string' ? session.model : '', expiresAt: typeof session.expiresAt === 'string' ? session.expiresAt : '' })
  }

  async createRelayTicket(projectId: string, signal: AbortSignal): Promise<ApiResult<{ ticket: string }>> {
    if (!validId(projectId, 'prj')) return fail('backend', 'That project id is not a Ranger project id.')
    const result = await this.request<{ ticket?: string }>('POST', '/v1/auth/connection-tickets', signal, {
      body: { projectId, purpose: 'voice-relay', origin: window.location.origin },
    })
    if (!result.ok) return result
    if (typeof result.data.ticket !== 'string' || result.data.ticket === '') return fail('backend', 'The ticket response did not include a ticket.')
    return ok({ ticket: result.data.ticket })
  }

  async cancelVoiceResponse(projectId: string, sessionId: string, signal: AbortSignal): Promise<ApiResult<{ interrupted: boolean }>> {
    if (!validId(projectId, 'prj') || !validId(sessionId, 'vcs')) return fail('backend', 'A project and voice session id are required.')
    const result = await this.request<{ interrupted?: boolean }>('POST', `/v1/projects/${projectId}/voice/sessions/${sessionId}/response/cancel`, signal)
    return result.ok ? ok({ interrupted: result.data.interrupted === true }) : result
  }

  async endVoiceSession(projectId: string, sessionId: string, signal: AbortSignal): Promise<ApiResult<void>> {
    if (!validId(projectId, 'prj') || !validId(sessionId, 'vcs')) return fail('backend', 'A project and voice session id are required.')
    const result = await this.request('POST', `/v1/projects/${projectId}/voice/sessions/${sessionId}/end`, signal)
    return result.ok ? ok(undefined) : result
  }

  async startCaptureSession(projectId: string, conversationId: string, signal: AbortSignal): Promise<ApiResult<CaptureSession>> {
    if (!validId(projectId, 'prj') || !validId(conversationId, 'cnv')) return fail('backend', 'Screen sharing needs a project and conversation id.')
    const result = await this.request<{ session?: { sessionId?: string; generation?: number; state?: string } }>(
      'POST',
      `/v1/projects/${projectId}/capture/sessions`,
      signal,
      { body: { conversationId }, idempotent: true },
    )
    if (!result.ok) return result
    const session = result.data.session
    if (!validId(session?.sessionId, 'cap') || session.state !== 'active' || typeof session.generation !== 'number') {
      return fail('backend', 'The capture session response was incomplete, so no screen share was started.')
    }
    return ok({ sessionId: session.sessionId, generation: session.generation })
  }

  async ingestCaptureFrame(
    request: { projectId: string; sessionId: string; frameId: string; imageBase64: string; captureTimestamp: string },
    signal: AbortSignal,
  ): Promise<ApiResult<FrameReceipt>> {
    if (!validId(request.projectId, 'prj') || !validId(request.sessionId, 'cap')) return fail('backend', 'A project and capture session id are required.')
    const result = await this.request<{ frame?: { frameId?: string; width?: number; height?: number; byteSize?: number; captureTimestamp?: string; stored?: boolean } }>(
      'POST',
      `/v1/projects/${request.projectId}/capture/sessions/${request.sessionId}/frames`,
      signal,
      { body: { frameId: request.frameId, imageBase64: request.imageBase64, captureTimestamp: request.captureTimestamp } },
    )
    if (!result.ok) return result
    const frame = result.data.frame
    if (frame?.stored !== true || frame.frameId !== request.frameId) return fail('backend', 'The frame response did not confirm that the frame was stored.')
    return ok({
      frameId: frame.frameId,
      width: typeof frame.width === 'number' ? frame.width : 0,
      height: typeof frame.height === 'number' ? frame.height : 0,
      byteSize: typeof frame.byteSize === 'number' ? frame.byteSize : 0,
      captureTimestamp: typeof frame.captureTimestamp === 'string' ? frame.captureTimestamp : request.captureTimestamp,
    })
  }

  async requestInspection(projectId: string, sessionId: string, signal: AbortSignal): Promise<ApiResult<Inspection>> {
    if (!validId(projectId, 'prj') || !validId(sessionId, 'cap')) return fail('backend', 'A project and capture session id are required.')
    const result = await this.request<{ inspection?: Record<string, unknown> }>(
      'POST',
      `/v1/projects/${projectId}/capture/sessions/${sessionId}/inspection`,
      signal,
      { body: {} },
    )
    if (!result.ok) return result
    const inspection = toInspection(result.data.inspection)
    return inspection ? ok(inspection) : fail('backend', 'The inspection response was incomplete, so no observation is shown.')
  }

  async endCaptureSession(projectId: string, sessionId: string, signal: AbortSignal): Promise<ApiResult<void>> {
    if (!validId(projectId, 'prj') || !validId(sessionId, 'cap')) return fail('backend', 'A project and capture session id are required.')
    const result = await this.request('POST', `/v1/projects/${projectId}/capture/sessions/${sessionId}/end`, signal)
    return result.ok ? ok(undefined) : result
  }

  private async readMessages(projectId: string, conversationId: string, signal: AbortSignal): Promise<ApiResult<string[]>> {
    const messages: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page += 1) {
      const params = new URLSearchParams({ limit: MESSAGE_PAGE })
      if (cursor) params.set('cursor', cursor)
      const result = await this.request<{ messages?: { content?: string }[]; nextCursor?: string | null }>(
        'GET',
        `/v1/projects/${projectId}/conversations/${conversationId}/messages?${params}`,
        signal,
      )
      if (!result.ok) return result
      for (const message of result.data.messages ?? []) {
        if (typeof message.content === 'string') messages.push(message.content)
      }
      if (typeof result.data.nextCursor !== 'string' || result.data.nextCursor === '' || result.data.nextCursor === cursor) break
      cursor = result.data.nextCursor
    }
    return ok(messages)
  }

  async getPlanState(projectId: string, signal: AbortSignal): Promise<ApiResult<PlanState>> {
    if (!validId(projectId, 'prj')) return fail('backend', 'That project id is not a Ranger project id.')
    const listed = await this.request<{ plans?: RawPlan[] }>('GET', `/v1/projects/${projectId}/plans`, signal)
    if (!listed.ok) return listed
    if (!Array.isArray(listed.data.plans) || listed.data.plans.some(plan => !toPlan(plan))) return fail('backend', 'The plan list response was incomplete.')
    const plans = listed.data.plans
    const latest = plans.reduce<RawPlan | null>((current, plan) => (current === null || (plan.version ?? 0) > (current.version ?? 0) ? plan : current), null)
    const plan = toPlan(latest)
    if (!plan) return ok({ plan: null, approved: false })
    const approvals = await this.request<{ approvals?: { planId?: string; version?: number; status?: string }[] }>(
      'GET',
      `/v1/projects/${projectId}/approvals`,
      signal,
    )
    if (!approvals.ok) return approvals
    if (!Array.isArray(approvals.data.approvals)) return fail('backend', 'The approval list response was incomplete.')
    const approved = (approvals.data.approvals ?? []).some(approval =>
      approval.planId === plan.planId && approval.version === plan.version && approval.status === 'active')
    return ok({ plan, approved })
  }

  private async readRepository(projectId: string, signal: AbortSignal): Promise<ApiResult<string | null>> {
    const result = await this.request<{ repository?: { url?: string } }>('GET', `/v1/projects/${projectId}/repository`, signal)
    if (result.ok) return ok(typeof result.data.repository?.url === 'string' ? result.data.repository.url : null)
    if (result.message.includes('not_found')) return ok(null)
    return result
  }

  private async request<T>(
    method: string,
    path: string,
    signal: AbortSignal,
    options: { body?: unknown; bearer?: string; idempotent?: boolean } = {},
  ): Promise<ApiResult<T>> {
    if (signal.aborted) return aborted()
    const headers = new Headers({ accept: 'application/json' })
    if (options.body !== undefined) headers.set('content-type', 'application/json')
    if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`)
    if (options.idempotent) headers.set('idempotency-key', idempotencyKey())
    if (options.bearer === undefined && method !== 'GET' && method !== 'HEAD' && this.csrfToken) {
      headers.set('x-ranger-csrf', this.csrfToken)
    }
    let response: Response
    try {
      response = await fetch(path, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: 'include',
        signal,
      })
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return aborted()
      return fail('unavailable', 'The Ranger API is unreachable.')
    }
    const payload = await readJson(response)
    if (response.ok) return ok((payload ?? {}) as T)
    const failure = fail(reasonFor(response.status, payload), errorMessage(response.status, payload))
    const code = payload?.error?.code
    const detail = payload?.error?.details?.reason
    const retryAfterMs = payload?.error?.details?.retryAfterMs
    if (typeof code === 'string') failure.code = code
    if (typeof detail === 'string') failure.detail = detail
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)) failure.retryAfterMs = retryAfterMs
    return failure
  }
}

type RawPlan = {
  planId?: string
  version?: number
  items?: unknown
  acceptanceCriteria?: unknown
  permittedScope?: unknown
}

function toWorkspaceStatus(raw: Record<string, unknown> | undefined): WorkspaceStatus | null {
  const projectId = typeof raw?.projectId === 'string' ? raw.projectId : undefined
  if (!raw || !validId(projectId, 'prj')) return null
  if (typeof raw.adapter !== 'string' || raw.adapterKind !== 'vm' || typeof raw.desiredState !== 'string' || typeof raw.observedState !== 'string') return null
  return {
    projectId,
    adapter: raw.adapter,
    adapterKind: 'vm',
    desiredState: raw.desiredState,
    observedState: raw.observedState,
    sourceRevision: typeof raw.sourceRevision === 'string' ? raw.sourceRevision : null,
  }
}

function eventData(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function toPlan(raw: RawPlan | null | undefined): LivePlan | null {
  if (!raw || !validId(raw.planId, 'pln') || typeof raw.version !== 'number') return null
  return {
    planId: raw.planId,
    version: raw.version,
    items: strings(raw.items),
    acceptanceCriteria: strings(raw.acceptanceCriteria),
    permittedScope: strings(raw.permittedScope),
  }
}

function toInspection(raw: Record<string, unknown> | undefined): Inspection | null {
  if (!raw) return null
  const state = raw.state
  const freshness = raw.freshness
  if (state !== 'observed' && state !== 'fresh-frame-requested') return null
  if (freshness !== 'current' && freshness !== 'stale' && freshness !== 'absent') return null
  const observations: InspectionObservation[] = []
  for (const item of Array.isArray(raw.observations) ? raw.observations : []) {
    const entry = item as Record<string, unknown> | null
    if (!entry || typeof entry.text !== 'string' || typeof entry.sourceFrameId !== 'string' || typeof entry.sourceTimestamp !== 'string') continue
    const uncertainty = typeof entry.uncertainty === 'number' && Number.isFinite(entry.uncertainty) ? Math.min(1, Math.max(0, entry.uncertainty)) : 1
    observations.push({ text: entry.text, uncertainty, sourceFrameId: entry.sourceFrameId, sourceTimestamp: entry.sourceTimestamp })
  }
  if (state === 'observed' && observations.length === 0) return null
  return {
    state,
    observations: state === 'observed' ? observations : [],
    sourceFrameId: typeof raw.sourceFrameId === 'string' ? raw.sourceFrameId : null,
    sourceTimestamp: typeof raw.sourceTimestamp === 'string' ? raw.sourceTimestamp : null,
    freshness,
  }
}

function latestId<T extends { createdAt?: string }>(rows: T[] | undefined, field: keyof T, prefix: string): string | null {
  const ranked = [...(rows ?? [])].sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
  const id = ranked[0]?.[field]
  return typeof id === 'string' && validId(id, prefix) ? id : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function cleanList(values: string[]): string[] {
  return values.map(value => value.trim()).filter(Boolean)
}

function validId(value: string | undefined, prefix: string): value is string {
  return typeof value === 'string' && ID.test(value) && value.startsWith(`${prefix}_`)
}

/** Builds the same-origin relay URL. The ticket is a one-time secret: never log or display the result. */
export function voiceRelayUrl(projectId: string, sessionId: string, ticket: string, location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}/v1/projects/${encodeURIComponent(projectId)}/voice/sessions/${encodeURIComponent(sessionId)}/relay?ticket=${encodeURIComponent(ticket)}`
}

function idempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function readJson(response: Response): Promise<Envelope | null> {
  try {
    return await response.json() as Envelope
  } catch {
    return null
  }
}

function reasonFor(status: number, payload: Envelope | null): ApiReason {
  if (status === 401) return 'unauthorized'
  if (payload?.error?.code === 'not_configured' || payload?.error?.code === 'unsupported_operation') return 'unsupported'
  if (status === 502 || status === 503 || status === 504) return 'unavailable'
  return 'backend'
}

function errorMessage(status: number, payload: Envelope | null): string {
  const code = payload?.error?.code
  const message = payload?.error?.message
  const requestId = payload?.requestId ? ` (${payload.requestId})` : ''
  const text = message && code ? `${code}: ${message}` : message || code || `The Ranger API returned HTTP ${status}.`
  return `${text}${requestId}`
}

function uncertain(result: ApiFailure, step: string, projectId?: string, conversationId?: string): ApiFailure {
  const where = [projectId ? `project ${projectId}` : '', conversationId ? `conversation ${conversationId}` : ''].filter(Boolean).join(' and ')
  const scope = where ? ` for ${where}` : ''
  if (result.reason === 'unavailable' || result.reason === 'aborted') {
    return fail('partial', `The ${step} may already be saved${scope}. Reload before retrying. ${result.message}`)
  }
  return fail(result.reason, `${where ? `${where}: ` : ''}${step} was rejected. ${result.message}`)
}

function aborted(): ApiFailure {
  return fail('aborted', 'Request cancelled.')
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data }
}

function fail(reason: ApiReason, message: string): ApiFailure {
  return { ok: false, reason, message }
}

export const rangerApi: RangerApi = new HttpRangerApi()

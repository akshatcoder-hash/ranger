/**
 * Same-origin browser adapter for the Ranger v1 control API.
 * Provider calls stay on the backend. Credentials never enter storage, logs, or URLs.
 */

export type ApiReason = 'aborted' | 'unauthorized' | 'unavailable' | 'unsupported' | 'partial' | 'backend'
export type ApiFailure = { ok: false; reason: ApiReason; message: string }
export type ApiResult<T> = { ok: true; data: T } | ApiFailure

export type ProjectRequest = { prompt: string; engineerName: string; repository?: string }
export type PlanDecision = { approved: boolean; planId: string }
export type MediaSessionRequest = {
  kind: 'voice' | 'screen'
  stream: MediaStream
  projectId: string
  conversationId: string
}
export type MediaSession = { id: string }
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

export interface RangerApi {
  connectSession(credential: string, signal: AbortSignal): Promise<ApiResult<{ principalId: string }>>
  getSession(signal: AbortSignal): Promise<ApiResult<{ principalId: string }>>
  getCapabilities(signal: AbortSignal): Promise<ApiResult<{ xai: boolean; instabox: boolean; trace: boolean }>>
  createProject(request: ProjectRequest, signal: AbortSignal): Promise<ApiResult<{ projectId: string; conversationId: string }>>
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
  getEvents(
    projectId: string,
    signal: AbortSignal,
    cursor?: string,
  ): Promise<ApiResult<{ events: { eventId: string; sequence: number; type: string }[]; cursor?: string; hasMore: boolean }>>
  startMediaSession(request: MediaSessionRequest, signal: AbortSignal): Promise<ApiResult<MediaSession>>
  endMediaSession(sessionId: string, signal: AbortSignal): Promise<ApiResult<void>>
}

/** Operator-authored plans may edit the project tree and run sandbox commands. */
export const MANUAL_PLAN_SCOPE = ['edit:.', 'command'] as const
const TITLE_LIMIT = 200
const MESSAGE_PAGE = '100'
const EVENT_PAGE = '100'
const MAX_EVENT_PAGES = 50
const ID = /^(prj|cnv|pln)_[0-9a-fA-F-]+$/

type Envelope = { requestId?: string; error?: { code?: string; message?: string } }

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
      this.readPlan(projectId, signal),
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

  async getEvents(projectId: string, signal: AbortSignal, cursor?: string): Promise<ApiResult<{ events: { eventId: string; sequence: number; type: string }[]; cursor?: string; hasMore: boolean }>> {
    if (!validId(projectId, 'prj')) return fail('backend', 'That project id is not a Ranger project id.')
    const events: { eventId: string; sequence: number; type: string }[] = []
    let pageCursor = cursor
    let hasMore = false
    for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
      const params = new URLSearchParams({ limit: EVENT_PAGE })
      if (pageCursor) params.set('cursor', pageCursor)
      const result = await this.request<{ events?: { eventId?: string; sequence?: number; type?: string }[]; nextCursor?: string | null; hasMore?: boolean }>(
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
          events.push({ eventId: event.eventId, sequence: event.sequence, type: event.type })
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

  async startMediaSession(request: MediaSessionRequest, signal: AbortSignal): Promise<ApiResult<MediaSession>> {
    if (signal.aborted) return aborted()
    if (!validId(request.projectId, 'prj') || !validId(request.conversationId, 'cnv')) {
      return fail('unsupported', 'Live media needs a project and conversation, and browser audio or frame relay is not wired.')
    }
    void request.stream
    void request.kind
    return fail('unsupported', 'Browser audio and frame relay is not wired yet. No media session was created.')
  }

  async endMediaSession(sessionId: string, signal: AbortSignal): Promise<ApiResult<void>> {
    if (signal.aborted) return aborted()
    void sessionId
    return fail('unsupported', 'Browser media sessions are not wired, so there is no session to end.')
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

  private async readPlan(projectId: string, signal: AbortSignal): Promise<ApiResult<{ plan: LivePlan | null; approved: boolean }>> {
    const listed = await this.request<{ plans?: RawPlan[] }>('GET', `/v1/projects/${projectId}/plans`, signal)
    if (!listed.ok) return listed
    const plans = (listed.data.plans ?? []).filter(plan => typeof plan.version === 'number')
    const latest = plans.reduce<RawPlan | null>((current, plan) => (current === null || (plan.version ?? 0) > (current.version ?? 0) ? plan : current), null)
    const plan = toPlan(latest)
    if (!plan) return ok({ plan: null, approved: false })
    const approvals = await this.request<{ approvals?: { planId?: string; version?: number; status?: string }[] }>(
      'GET',
      `/v1/projects/${projectId}/approvals`,
      signal,
    )
    if (!approvals.ok) return approvals
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
    return fail(reasonFor(response.status, payload), errorMessage(response.status, payload))
  }
}

type RawPlan = {
  planId?: string
  version?: number
  items?: unknown
  acceptanceCriteria?: unknown
  permittedScope?: unknown
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

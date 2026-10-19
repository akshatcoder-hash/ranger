import { afterEach, describe, expect, it, vi } from 'vitest'
import { MANUAL_PLAN_SCOPE, rangerApi, voiceRelayUrl } from './api'

const PROJECT = 'prj_11111111-1111-1111-1111-111111111111'
const CONVERSATION = 'cnv_22222222-2222-2222-2222-222222222222'
const PLAN = 'pln_33333333-3333-3333-3333-333333333333'
const VOICE = 'vcs_44444444-4444-4444-4444-444444444444'
const CAPTURE = 'cap_55555555-5555-5555-5555-555555555555'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('browser backend adapter', () => {
  it('exchanges a bearer credential once and keeps it out of storage and later requests', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const headers = new Headers(init?.headers)
      if (path === '/v1/auth/browser-sessions') {
        expect(init?.method).toBe('POST')
        expect(init?.credentials).toBe('include')
        expect(headers.get('authorization')).toBe('Bearer secret-token')
        expect(JSON.parse(String(init?.body))).toEqual({ apiToken: 'secret-token' })
        return json({ sessionId: 'ses_1', expiresAt: '2026-01-01T00:00:00.000Z', csrfToken: 'csrf-once', requestId: 'req-session' })
      }
      expect(headers.has('authorization')).toBe(false)
      expect(String(init?.body ?? '')).not.toContain('secret-token')
      return json({ principalId: 'prin_operator', requestId: 'req-me' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const storageWrites = vi.fn()
    vi.stubGlobal('localStorage', { setItem: storageWrites, getItem: vi.fn(), removeItem: vi.fn() })
    vi.stubGlobal('sessionStorage', { setItem: storageWrites, getItem: vi.fn(), removeItem: vi.fn() })

    const connected = await rangerApi.connectSession(' secret-token ', new AbortController().signal)

    expect(connected).toEqual({ ok: true, data: { principalId: 'prin_operator' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(storageWrites).not.toHaveBeenCalled()
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('csrf-once')
  })

  it('sends the in-memory CSRF token on a later cookie mutation and never retries it', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      const headers = new Headers(init?.headers)
      if (String(input) === '/v1/auth/browser-sessions') return json({ csrfToken: 'csrf-memory', requestId: 'req-1' })
      if (String(input) === '/v1/auth/me') return json({ principalId: 'prin_operator', requestId: 'req-2' })
      expect(headers.get('x-ranger-csrf')).toBe('csrf-memory')
      expect(headers.has('authorization')).toBe(false)
      expect(headers.get('idempotency-key')).toMatch(/^[0-9a-f]{32}$/)
      return json({ requestId: 'req-rename' }, 409)
    }))

    await rangerApi.connectSession('secret-token', new AbortController().signal)
    const renamed = await rangerApi.renameEngineer(PROJECT, 'Ada', new AbortController().signal)

    expect(renamed.ok).toBe(false)
    if (!renamed.ok) expect(renamed).toMatchObject({ reason: 'backend', message: expect.stringContaining('req-rename') })
    expect(calls).toBe(3)
  })

  it('maps capabilities to false when a provider is absent or the endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      requestId: 'req-cap',
      providers: { xai: { configured: true }, instabox: {}, trace: { configured: false } },
    })))
    await expect(rangerApi.getCapabilities(new AbortController().signal)).resolves.toEqual({
      ok: true,
      data: { xai: true, instabox: false, trace: false },
    })

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    const offline = await rangerApi.getCapabilities(new AbortController().signal)
    expect(offline).toMatchObject({ ok: false, reason: 'unavailable' })

    vi.stubGlobal('fetch', vi.fn(async () => json({ requestId: 'req-cap-down', error: { code: 'internal_error', message: 'unavailable' } }, 500)))
    const failed = await rangerApi.getCapabilities(new AbortController().signal)
    expect(failed).toMatchObject({ ok: false, reason: 'backend' })
  })

  it('creates a project, conversation, and initial message without hiding a partial failure', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null)
      if (path === '/v1/projects') return json({ project: { projectId: PROJECT }, requestId: 'req-project' })
      if (path.endsWith('/conversations')) return json({ conversation: { conversationId: CONVERSATION }, requestId: 'req-conversation' })
      return json({ requestId: 'req-message', error: { code: 'conflict', message: 'message was not stored' } }, 409)
    }))

    const created = await rangerApi.createProject({
      prompt: `${'A'.repeat(220)} tail`,
      engineerName: ' Ada ',
    }, new AbortController().signal)

    expect(bodies[0]).toEqual({ name: 'A'.repeat(200), engineerDisplayName: 'Ada' })
    expect(bodies[1]).toEqual({ title: 'A'.repeat(200) })
    expect(bodies[2]).toEqual({ role: 'user', content: `${'A'.repeat(220)} tail` })
    expect(created.ok).toBe(false)
    if (!created.ok) {
      expect(created.reason).toBe('backend')
      expect(created.message).toContain(PROJECT)
      expect(created.message).toContain(CONVERSATION)
      expect(created.message).toContain('conflict')
    }
  })

  it('loads the latest conversation and only an active approval for that exact plan version', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === `/v1/projects/${PROJECT}`) {
        return json({ project: { projectId: PROJECT, name: 'Inbox', engineerDisplayName: 'Ada' }, requestId: 'req-project' })
      }
      if (path.endsWith('/conversations')) {
        return json({
          conversations: [
            { conversationId: 'cnv_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', createdAt: '2026-01-01T00:00:00.000Z' },
            { conversationId: CONVERSATION, createdAt: '2026-02-01T00:00:00.000Z' },
          ],
          requestId: 'req-conversations',
        })
      }
      if (path.includes('/messages')) {
        return json({
          messages: [{ content: 'first' }, { content: 'second' }],
          nextCursor: null,
          requestId: 'req-messages',
        })
      }
      if (path.endsWith('/plans')) {
        return json({
          plans: [
            { planId: 'pln_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', version: 1, items: ['old'], acceptanceCriteria: ['old'], permittedScope: ['command'] },
            { planId: PLAN, version: 2, items: ['new'], acceptanceCriteria: ['checked'], permittedScope: ['edit:.', 'command'] },
          ],
          requestId: 'req-plans',
        })
      }
      if (path.endsWith('/approvals')) {
        return json({
          approvals: [
            { planId: 'pln_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', version: 1, status: 'active' },
            { planId: PLAN, version: 2, status: 'invalidated' },
          ],
          requestId: 'req-approvals',
        })
      }
      if (path.endsWith('/repository')) return json({ requestId: 'req-repo', error: { code: 'not_found', message: 'No repository is connected' } }, 404)
      throw new Error(`unexpected ${path}`)
    }))

    const loaded = await rangerApi.loadProject(PROJECT, new AbortController().signal)

    expect(loaded).toEqual({
      ok: true,
      data: {
        projectId: PROJECT,
        name: 'Inbox',
        engineerName: 'Ada',
        conversationId: CONVERSATION,
        messages: ['first', 'second'],
        plan: { planId: PLAN, version: 2, items: ['new'], acceptanceCriteria: ['checked'], permittedScope: ['edit:.', 'command'] },
        approved: false,
        repositoryUrl: null,
      },
    })
  })

  it('writes an operator-authored plan with the sandbox scope and does not call a model', async () => {
    const paths: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      paths.push(path)
      if (path.endsWith('/messages')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ role: 'system', content: expect.stringContaining('Operator-authored plan') })
        return json({ requestId: 'req-note' })
      }
      expect(JSON.parse(String(init?.body))).toEqual({
        items: ['Inspect the inbox'],
        acceptanceCriteria: ['The draft is saved'],
        permittedScope: [...MANUAL_PLAN_SCOPE],
      })
      return json({
        plan: { planId: PLAN, version: 1, items: ['Inspect the inbox'], acceptanceCriteria: ['The draft is saved'], permittedScope: [...MANUAL_PLAN_SCOPE] },
        requestId: 'req-plan',
      })
    }))

    const plan = await rangerApi.createManualPlan({
      projectId: PROJECT,
      conversationId: CONVERSATION,
      items: [' Inspect the inbox '],
      acceptanceCriteria: ['The draft is saved'],
    }, new AbortController().signal)

    expect(plan.ok).toBe(true)
    expect(paths.some(path => path.includes('/plans/generate') || path.includes('/clarification'))).toBe(false)
  })

  it('does not claim a manual plan was unsaved when the response is incomplete or the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/messages')) return json({ requestId: 'req-note' })
      return json({ plan: { planId: 'not-a-plan-id' }, requestId: 'req-malformed' })
    }))
    const malformed = await rangerApi.createManualPlan({
      projectId: PROJECT,
      conversationId: CONVERSATION,
      items: ['Inspect the inbox'],
      acceptanceCriteria: ['The draft is saved'],
    }, new AbortController().signal)
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) {
      expect(malformed.reason).toBe('partial')
      expect(malformed.message).toContain('not-a-plan-id')
      expect(malformed.message).toContain('Reload before retrying')
      expect(malformed.message).not.toContain('was not saved')
    }

    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      calls += 1
      if (String(input).endsWith('/messages')) return json({ requestId: 'req-note' })
      throw new TypeError('socket closed')
    }))
    const dropped = await rangerApi.createManualPlan({
      projectId: PROJECT,
      conversationId: CONVERSATION,
      items: ['Inspect the inbox'],
      acceptanceCriteria: ['The draft is saved'],
    }, new AbortController().signal)
    expect(dropped).toMatchObject({ ok: false, reason: 'partial' })
    if (!dropped.ok) {
      expect(dropped.message).toContain('may already be saved')
      expect(dropped.message).toContain('Reload before retrying')
      expect(dropped.message).not.toContain('was not saved')
    }
    expect(calls).toBe(2)
  })

  it('approves the exact plan and records rejection as a user change request', async () => {
    const calls: { path: string; body: unknown }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path.endsWith('/approvals')) return json({ approval: { planId: PLAN, status: 'active' }, requestId: 'req-approval' })
      return json({ requestId: 'req-change' })
    }))
    const signal = new AbortController().signal

    const accepted = await rangerApi.decidePlan({
      projectId: PROJECT,
      conversationId: CONVERSATION,
      approved: true,
      planId: PLAN,
      permittedScope: ['edit:.', 'command'],
    }, signal)
    const rejected = await rangerApi.decidePlan({
      projectId: PROJECT,
      conversationId: CONVERSATION,
      approved: false,
      planId: PLAN,
      permittedScope: ['edit:.'],
    }, signal)

    expect(accepted).toEqual({ ok: true, data: { accepted: true } })
    expect(rejected).toEqual({ ok: true, data: { accepted: false } })
    expect(calls[0]).toEqual({ path: `/v1/projects/${PROJECT}/plans/${PLAN}/approvals`, body: { permittedScope: ['edit:.', 'command'] } })
    expect(calls[1]?.path).toContain('/messages')
    expect(calls[1]?.body).toMatchObject({ role: 'user', content: expect.stringContaining(PLAN) })
  })

  it('maps the events nextCursor and preserves abort and invalid ids', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('cursor=opaque-cursor')
      return json({
        events: [{ eventId: 'evt_1', sequence: 4, type: 'conversation.message.created', data: { secret: 'hidden' } }],
        nextCursor: 'opaque-next',
        hasMore: false,
        requestId: 'req-events',
      })
    }))

    await expect(rangerApi.getEvents(PROJECT, new AbortController().signal, 'opaque-cursor')).resolves.toEqual({
      ok: true,
      data: { events: [{ eventId: 'evt_1', sequence: 4, type: 'conversation.message.created', data: { secret: 'hidden' } }], cursor: 'opaque-next', hasMore: false },
    })

    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted.', 'AbortError') }))
    const aborted = await rangerApi.sendMessage(PROJECT, CONVERSATION, 'hello', controller.signal)
    expect(aborted).toEqual({ ok: false, reason: 'aborted', message: 'Request cancelled.' })
    await expect(rangerApi.loadProject('northstar', new AbortController().signal)).resolves.toMatchObject({ ok: false, reason: 'backend' })
  })

  it('drains event pages past the default limit and stops on a failed or aborted page', async () => {
    const cursors: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const cursor = new URL(String(input), 'http://ranger.local').searchParams.get('cursor') ?? ''
      cursors.push(cursor)
      const start = cursor === '' ? 1 : Number(cursor.replace('cursor-', '')) + 1
      const count = Math.min(100, 151 - start)
      const events = Array.from({ length: count }, (_, index) => ({ eventId: `evt_${start + index}`, sequence: start + index, type: 'conversation.message.created' }))
      const last = start + 99
      const hasMore = last < 150
      return json({ events, nextCursor: hasMore ? `cursor-${last}` : null, hasMore, requestId: `req-${last}` })
    }))

    const drained = await rangerApi.getEvents(PROJECT, new AbortController().signal)
    expect(drained.ok).toBe(true)
    if (drained.ok) {
      expect(drained.data.events).toHaveLength(150)
      expect(drained.data.events[0]).toEqual({ eventId: 'evt_1', sequence: 1, type: 'conversation.message.created' })
      expect(drained.data.events[149]).toEqual({ eventId: 'evt_150', sequence: 150, type: 'conversation.message.created' })
      expect(drained.data.cursor).toBeUndefined()
      expect(drained.data.hasMore).toBe(false)
    }
    expect(cursors).toEqual(['', 'cursor-100'])

    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const cursor = new URL(String(input), 'http://ranger.local').searchParams.get('cursor')
      if (!cursor) return json({ events: [{ eventId: 'evt_1', sequence: 1, type: 'run.started' }], nextCursor: 'cursor-1', hasMore: true, requestId: 'req-page' })
      controller.abort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    }))
    const aborted = await rangerApi.getEvents(PROJECT, controller.signal)
    expect(aborted).toMatchObject({ ok: false, reason: 'aborted' })
    if (!aborted.ok) expect(aborted.message).toContain('cursor-1')

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const cursor = new URL(String(input), 'http://ranger.local').searchParams.get('cursor')
      if (!cursor) return json({ events: [{ eventId: 'evt_9', sequence: 9, type: 'run.started' }], nextCursor: 'cursor-9', hasMore: true, requestId: 'req-page' })
      return json({ requestId: 'req-failed', error: { code: 'internal_error', message: 'page failed' } }, 500)
    }))
    const failed = await rangerApi.getEvents(PROJECT, new AbortController().signal)
    expect(failed).toMatchObject({ ok: false, reason: 'backend' })
    if (!failed.ok) expect(failed.message).toContain('cursor-9')
  })

  it('reads workspace status and keeps preparation event data', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith('/workspace/status')) {
        return json({
          workspace: { projectId: PROJECT, adapter: 'instabox', adapterKind: 'vm', desiredState: 'running', observedState: 'ready', sourceRevision: 'abc123' },
          requestId: 'req-workspace',
        })
      }
      return json({
        events: [
          { eventId: 'evt_1', sequence: 1, type: 'conversation.message.created' },
          { eventId: 'evt_2', sequence: 2, type: 'workspace.preparation.updated', data: { jobId: 'job_1', phase: 'indexing', fileCount: 40, indexElapsedMs: 900 } },
        ],
        nextCursor: null,
        hasMore: false,
        requestId: 'req-events',
      })
    }))

    await expect(rangerApi.getWorkspaceStatus(PROJECT, new AbortController().signal)).resolves.toEqual({
      ok: true,
      data: { projectId: PROJECT, adapter: 'instabox', adapterKind: 'vm', desiredState: 'running', observedState: 'ready', sourceRevision: 'abc123' },
    })
    const events = await rangerApi.getEvents(PROJECT, new AbortController().signal)
    expect(events.ok).toBe(true)
    if (events.ok) {
      expect(events.data.events[0]).toEqual({ eventId: 'evt_1', sequence: 1, type: 'conversation.message.created' })
      expect(events.data.events[1]?.data).toEqual({ jobId: 'job_1', phase: 'indexing', fileCount: 40, indexElapsedMs: 900 })
    }
    await expect(rangerApi.getWorkspaceStatus('northstar', new AbortController().signal)).resolves.toMatchObject({ ok: false, reason: 'backend' })
  })

  it('starts a voice session and issues a relay ticket without exposing it outside the result', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:5173', protocol: 'http:', host: '127.0.0.1:5173' } })
    const calls: { path: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ path: String(input), init })
      if (String(input).endsWith('/voice/sessions')) {
        return json({ session: { sessionId: VOICE, model: 'grok-voice-latest', state: 'active', expiresAt: '2026-01-01T00:00:00.000Z' } })
      }
      return json({ ticket: 'tkt-secret', expiresAt: '2026-01-01T00:01:00.000Z' })
    }))

    const started = await rangerApi.startVoiceSession(PROJECT, CONVERSATION, new AbortController().signal)
    const ticket = await rangerApi.createRelayTicket(PROJECT, new AbortController().signal)

    expect(started).toEqual({ ok: true, data: { sessionId: VOICE, model: 'grok-voice-latest', expiresAt: '2026-01-01T00:00:00.000Z' } })
    expect(calls[0].path).toBe(`/v1/projects/${PROJECT}/voice/sessions`)
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ conversationId: CONVERSATION })
    expect(new Headers(calls[0].init?.headers).get('idempotency-key')).toMatch(/^[0-9a-f]{32}$/)
    expect(calls[1].path).toBe('/v1/auth/connection-tickets')
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ projectId: PROJECT, purpose: 'voice-relay', origin: 'http://127.0.0.1:5173' })
    expect(ticket).toEqual({ ok: true, data: { ticket: 'tkt-secret' } })
  })

  it('rejects incomplete or inactive media sessions instead of reporting a started call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ session: { sessionId: VOICE, state: 'ended' } })))
    await expect(rangerApi.startVoiceSession(PROJECT, CONVERSATION, new AbortController().signal)).resolves.toMatchObject({ ok: false, reason: 'backend' })
    vi.stubGlobal('fetch', vi.fn(async () => json({ session: { sessionId: 'cap_bad id', state: 'active', generation: 1 } })))
    await expect(rangerApi.startCaptureSession(PROJECT, CONVERSATION, new AbortController().signal)).resolves.toMatchObject({ ok: false, reason: 'backend' })
  })

  it('builds same-origin relay URLs and refuses foreign ids before any request', async () => {
    expect(voiceRelayUrl(PROJECT, VOICE, 'a b/c', { protocol: 'http:', host: '127.0.0.1:5173' }))
      .toBe(`ws://127.0.0.1:5173/v1/projects/${PROJECT}/voice/sessions/${VOICE}/relay?ticket=a%20b%2Fc`)
    expect(voiceRelayUrl(PROJECT, VOICE, 't', { protocol: 'https:', host: 'ranger.example' })).toMatch(/^wss:\/\/ranger\.example\//)

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    await expect(rangerApi.startVoiceSession('demo', CONVERSATION, signal)).resolves.toMatchObject({ ok: false })
    await expect(rangerApi.cancelVoiceResponse(PROJECT, 'cap_1', signal)).resolves.toMatchObject({ ok: false })
    await expect(rangerApi.ingestCaptureFrame({ projectId: PROJECT, sessionId: VOICE, frameId: 'f', imageBase64: 'AA==', captureTimestamp: 'x' }, signal)).resolves.toMatchObject({ ok: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cancels only the voice response and ends sessions on their own routes', async () => {
    const paths: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      paths.push(String(input))
      return String(input).endsWith('/response/cancel') ? json({ ok: true, interrupted: true }) : json({ session: { state: 'ended' } })
    }))
    const signal = new AbortController().signal

    await expect(rangerApi.cancelVoiceResponse(PROJECT, VOICE, signal)).resolves.toEqual({ ok: true, data: { interrupted: true } })
    await expect(rangerApi.endVoiceSession(PROJECT, VOICE, signal)).resolves.toEqual({ ok: true, data: undefined })
    await expect(rangerApi.endCaptureSession(PROJECT, CAPTURE, signal)).resolves.toEqual({ ok: true, data: undefined })

    expect(paths).toEqual([
      `/v1/projects/${PROJECT}/voice/sessions/${VOICE}/response/cancel`,
      `/v1/projects/${PROJECT}/voice/sessions/${VOICE}/end`,
      `/v1/projects/${PROJECT}/capture/sessions/${CAPTURE}/end`,
    ])
    expect(paths.join()).not.toContain('/runs')
  })

  it('starts capture, ingests a frame with its id and timestamp, and keeps error details for pacing', async () => {
    const calls: { path: string; body: unknown }[] = []
    let ingest = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (path.endsWith('/capture/sessions')) return json({ session: { sessionId: CAPTURE, generation: 1, state: 'active' } })
      ingest += 1
      if (ingest === 1) return json({ frame: { frameId: 'f-1', sessionId: CAPTURE, byteSize: 10, width: 640, height: 360, captureTimestamp: '2026-01-01T00:00:00.000Z', stored: true } })
      return json({ requestId: 'req-rate', error: { code: 'rate_limited', message: 'slow down', details: { reason: 'upload_rate', retryAfterMs: 250 } } }, 429)
    }))
    const signal = new AbortController().signal

    const session = await rangerApi.startCaptureSession(PROJECT, CONVERSATION, signal)
    const frame = { projectId: PROJECT, sessionId: CAPTURE, frameId: 'f-1', imageBase64: '/9j/AA==', captureTimestamp: '2026-01-01T00:00:00.000Z' }
    const accepted = await rangerApi.ingestCaptureFrame(frame, signal)
    const limited = await rangerApi.ingestCaptureFrame({ ...frame, frameId: 'f-2' }, signal)

    expect(session).toEqual({ ok: true, data: { sessionId: CAPTURE, generation: 1 } })
    expect(calls[0].body).toEqual({ conversationId: CONVERSATION })
    expect(calls[1].body).toEqual({ frameId: 'f-1', imageBase64: '/9j/AA==', captureTimestamp: '2026-01-01T00:00:00.000Z' })
    expect(accepted).toEqual({ ok: true, data: { frameId: 'f-1', width: 640, height: 360, byteSize: 10, captureTimestamp: '2026-01-01T00:00:00.000Z' } })
    expect(limited).toMatchObject({ ok: false, code: 'rate_limited', detail: 'upload_rate', retryAfterMs: 250 })
  })

  it('maps inspections with uncertainty and source frame, and refuses a malformed result', async () => {
    const inspection = {
      state: 'observed',
      observations: [{ text: 'A terminal shows a failing test.', uncertainty: 1.7, sourceFrameId: 'f-1', sourceTimestamp: '2026-01-01T00:00:00.000Z' }],
      sourceFrameId: 'f-1',
      sourceTimestamp: '2026-01-01T00:00:00.000Z',
      freshness: 'current',
    }
    vi.stubGlobal('fetch', vi.fn(async () => json({ inspection })))
    const signal = new AbortController().signal
    const mapped = await rangerApi.requestInspection(PROJECT, CAPTURE, signal)
    expect(mapped).toMatchObject({ ok: true, data: { state: 'observed', freshness: 'current', sourceFrameId: 'f-1' } })
    if (mapped.ok) expect(mapped.data.observations[0].uncertainty).toBe(1)

    vi.stubGlobal('fetch', vi.fn(async () => json({ inspection: { state: 'observed', observations: [], freshness: 'current' } })))
    await expect(rangerApi.requestInspection(PROJECT, CAPTURE, signal)).resolves.toMatchObject({ ok: false, reason: 'backend' })

    vi.stubGlobal('fetch', vi.fn(async () => json({ inspection: { state: 'fresh-frame-requested', observations: [], sourceFrameId: null, sourceTimestamp: null, freshness: 'absent' } })))
    await expect(rangerApi.requestInspection(PROJECT, CAPTURE, signal)).resolves.toMatchObject({ ok: true, data: { state: 'fresh-frame-requested', freshness: 'absent' } })
  })
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

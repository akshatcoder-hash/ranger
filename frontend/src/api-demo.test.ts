import { afterEach, describe, expect, it, vi } from 'vitest'
import { rangerApi } from './api'

const DEMO = 'prj_6f5b65e6-e85d-4380-9b52-67c7a12fde4c'
const CONVERSATION = 'cnv_22222222-2222-2222-2222-222222222222'
const OLDER = 'cnv_11111111-1111-1111-1111-111111111111'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('shared demo project access', () => {
  it('reads the optional demo target from the session and tolerates its absence or a malformed value', async () => {
    const responses = [
      { principalId: 'prin_a', demoProject: { projectId: DEMO, repositoryUrl: 'https://github.com/satnaing/shadcn-admin', ref: 'HEAD' } },
      { principalId: 'prin_b' },
      { principalId: 'prin_c', demoProject: { projectId: 'nope', repositoryUrl: 1 } },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => json(responses.shift())))
    const signal = new AbortController().signal
    expect(await rangerApi.getSession(signal)).toEqual({ ok: true, data: { principalId: 'prin_a', demoProject: { projectId: DEMO, repositoryUrl: 'https://github.com/satnaing/shadcn-admin', ref: 'HEAD' } } })
    expect(await rangerApi.getSession(signal)).toEqual({ ok: true, data: { principalId: 'prin_b' } })
    expect(await rangerApi.getSession(signal)).toEqual({ ok: true, data: { principalId: 'prin_c' } })
  })

  it('creates only a conversation and message on the authorized project, never a project or repository write', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      calls.push(`${init?.method} ${path}`)
      if (path.endsWith('/conversations')) return json({ conversation: { conversationId: CONVERSATION } })
      return json({})
    }))
    const created = await rangerApi.createProject({ prompt: 'Explain this repo', engineerName: 'Ranger', demoProjectId: DEMO }, new AbortController().signal)
    expect(created).toEqual({ ok: true, data: { projectId: DEMO, conversationId: CONVERSATION } })
    expect(calls).toEqual([
      `POST /v1/projects/${DEMO}/conversations`,
      `POST /v1/projects/${DEMO}/conversations/${CONVERSATION}/messages`,
    ])
  })

  it('pins the loaded conversation, and an unknown pin yields none instead of someone else\'s', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === `/v1/projects/${DEMO}`) return json({ project: { projectId: DEMO, name: 'Demo', engineerDisplayName: 'Ranger' } })
      if (path === `/v1/projects/${DEMO}/conversations`) {
        return json({ conversations: [{ conversationId: OLDER, createdAt: '2026-01-01T00:00:00.000Z' }, { conversationId: CONVERSATION, createdAt: '2026-01-02T00:00:00.000Z' }] })
      }
      if (path.includes('/messages')) return json({ messages: [{ content: path.includes(OLDER) ? 'older' : 'newer' }] })
      if (path.endsWith('/plans')) return json({ plans: [] })
      return json({ repository: { url: 'https://github.com/satnaing/shadcn-admin' } })
    }))
    const signal = new AbortController().signal
    const pinned = await rangerApi.loadProject(DEMO, signal, OLDER)
    expect(pinned.ok && pinned.data).toMatchObject({ conversationId: OLDER, messages: [{ role: 'user', content: 'older' }] })
    const latest = await rangerApi.loadProject(DEMO, signal)
    expect(latest.ok && latest.data).toMatchObject({ conversationId: CONVERSATION })
    const unknown = await rangerApi.loadProject(DEMO, signal, 'cnv_99999999-9999-9999-9999-999999999999')
    expect(unknown.ok && unknown.data).toMatchObject({ conversationId: null, messages: [] })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { rangerApi } from './api'
const PROJECT = 'prj_11111111-1111-1111-1111-111111111111', PLAN = 'pln_22222222-2222-2222-2222-222222222222', RUN = 'run_33333333-3333-3333-3333-333333333333'
const plan = { planId: PLAN, version: 1, items: ['fix'], acceptanceCriteria: ['test'], permittedScope: ['edit:src/', 'command'] }
const run = { runId: RUN, projectId: PROJECT, planId: PLAN, planVersion: 1, state: 'running', createdAt: '2026-10-19T01:00:00Z', updatedAt: '2026-10-19T01:00:00Z' }
const signal = () => new AbortController().signal
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('read-only review adapters with fake HTTP responses', () => {
  it('rereads latest plan and exact-version approval without carrying older approval', async () => {
    let version = 1
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/plans') ? json({ plans: [plan, { ...plan, planId: version === 1 ? PLAN : 'pln_abcdef', version }] }) : json({ approvals: [{ planId: PLAN, version: 1, status: 'active' }] })))
    expect(await rangerApi.getPlanState(PROJECT, signal())).toMatchObject({ ok: true, data: { approved: true, plan: { version: 1 } } })
    version = 2
    expect(await rangerApi.getPlanState(PROJECT, signal())).toMatchObject({ ok: true, data: { approved: false, plan: { version: 2, permittedScope: ['edit:src/', 'command'] } } })
  })
  it('rejects malformed plan, run, diff, test or tool responses rather than inventing empty evidence', async () => {
    for (const data of [{}, { plans: [{ version: 3 }] }]) {
      vi.stubGlobal('fetch', vi.fn(async () => json(data)))
      expect(await rangerApi.getPlanState(PROJECT, signal())).toMatchObject({ ok: false, reason: 'backend' })
    }
    vi.stubGlobal('fetch', vi.fn(async () => json({ runs: [{ ...run, projectId: 'prj_abcdef' }] })))
    expect(await rangerApi.listRuns(PROJECT, signal())).toMatchObject({ ok: false })
    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    for (const read of [rangerApi.listRuns(PROJECT, signal()), rangerApi.getWorkspaceDiff(PROJECT, signal()), rangerApi.listTestResults(PROJECT, signal()), rangerApi.listRunTools(PROJECT, RUN, signal())]) expect(await read).toMatchObject({ ok: false, reason: 'backend' })
  })
  it('orders runs newest first using cookie-authenticated GET only', async () => {
    const fetch = vi.fn(async (_path: string, init: RequestInit) => { expect(init.method).toBe('GET'); expect(init.credentials).toBe('include'); return json({ runs: [run, { ...run, runId: 'run_abcdef', createdAt: '2026-10-19T02:00:00Z' }] }) })
    vi.stubGlobal('fetch', fetch)
    const result = await rangerApi.listRuns(PROJECT, signal())
    expect(result.ok && result.data[0].runId).toBe('run_abcdef'); expect(fetch.mock.calls[0][0]).toBe(`/v1/projects/${PROJECT}/runs`)
  })
  it('keeps inventory and pending test exits without manufacturing a patch or pass', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path.endsWith('/diff') ? json({ diff: 'saved a.ts', changedFiles: ['a.ts'] }) : json({ testResults: [{ testResultId: 'cmd_a', suite: 'npm test', state: 'running', exitCode: -1, ranAt: 'now' }] })))
    expect(await rangerApi.getWorkspaceDiff(PROJECT, signal())).toEqual({ ok: true, data: { diff: 'saved a.ts', changedFiles: ['a.ts'] } })
    expect(await rangerApi.listTestResults(PROJECT, signal())).toMatchObject({ ok: true, data: [{ state: 'running', exitCode: -1 }] })
  })
  it('surfaces authorization and workspace unavailability', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'unauthorized', message: 'expired' } }, 401)))
    expect(await rangerApi.listRuns(PROJECT, signal())).toMatchObject({ ok: false, reason: 'unauthorized' })
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'not_found', message: 'no workspace' } }, 404)))
    expect(await rangerApi.getWorkspaceDiff(PROJECT, signal())).toMatchObject({ ok: false, code: 'not_found' })
  })
  it('reads encoded UTF-8 saved source and rejects mismatched or corrupt responses', async () => {
    const path = 'src/a & b.ts', text = 'const value = "☀";', bytes = new TextEncoder().encode(text), base64 = btoa(String.fromCharCode(...bytes))
    const fetch = vi.fn(async (_path: string) => json({ path, contentBase64: base64, sizeBytes: bytes.length })); vi.stubGlobal('fetch', fetch)
    expect(await rangerApi.readWorkspaceFile(PROJECT, path, signal())).toEqual({ ok: true, data: { path, text, sizeBytes: bytes.length } })
    expect(fetch.mock.calls[0][0]).toBe(`/v1/projects/${PROJECT}/workspace/file?path=src%2Fa+%26+b.ts`)
    vi.stubGlobal('fetch', vi.fn(async () => json({ path, contentBase64: 'AA==', sizeBytes: 1 })))
    expect(await rangerApi.readWorkspaceFile(PROJECT, path, signal())).toMatchObject({ ok: true, data: { text: null } })
    for (const data of [{ path: 'wrong', contentBase64: base64, sizeBytes: bytes.length }, { path, contentBase64: base64, sizeBytes: 0 }]) {
      vi.stubGlobal('fetch', vi.fn(async () => json(data))); expect(await rangerApi.readWorkspaceFile(PROJECT, path, signal())).toMatchObject({ ok: false })
    }
  })
  it('does not request aborted or invalid-project reads', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const controller = new AbortController(); controller.abort()
    expect(await rangerApi.listRuns(PROJECT, controller.signal)).toMatchObject({ ok: false, reason: 'aborted' })
    expect(await rangerApi.getWorkspaceDiff('demo', signal())).toMatchObject({ ok: false }); expect(fetch).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { ApiResult, LivePlan, RangerApi, RunRecord, RunTool, TestResult, WorkspaceDiff } from '../api'
import { LatestRead, diffIsInventory, editedPaths, evidenceEventRevision, readProjectEvidence, sameReviewedPlan, testOutcome, type ReadState } from './liveEvidence'

// Local fake API outcomes only. These tests make no browser, provider, worker or VM calls.
const good = <T>(data: T): ApiResult<T> => ({ ok: true, data })
const bad: ApiResult<never> = { ok: false, reason: 'unavailable', message: 'offline' }
const run: RunRecord = { runId: 'run_a', projectId: 'prj_a', planId: 'pln_a', planVersion: 2, state: 'running', createdAt: '2026-10-19T12:00:00Z', updatedAt: '2026-10-19T12:00:01Z' }
const plan: LivePlan = { planId: 'pln_a', version: 2, items: ['Fix the display'], acceptanceCriteria: ['Targeted check passes'], permittedScope: ['edit:src/', 'command'] }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(res => { resolve = res }); return { promise, resolve } }

describe('latest-result fences', () => {
  it('keeps a newer refresh when an older response ignores abort and finishes later', async () => {
    const reader = new LatestRead<string>(), old = deferred<string>(), fresh = deferred<string>()
    const updates: ReadState<string>[] = []
    let firstSignal!: AbortSignal
    const one = reader.start(signal => { firstSignal = signal; return old.promise }, value => updates.push(value))
    const two = reader.start(() => fresh.promise, value => updates.push(value))
    expect(firstSignal.aborted).toBe(true)
    fresh.resolve('new project'); await two
    old.resolve('old project'); await one
    expect(updates).toEqual([{ state: 'loading' }, { state: 'loading' }, { state: 'ready', value: 'new project' }])
  })
  it('dismissal or navigation prevents a late plan/file result from being published', async () => {
    const reader = new LatestRead<string>(), response = deferred<string>(), publish = vi.fn()
    const pending = reader.start(() => response.promise, publish)
    reader.cancel(); response.resolve('closed dialog'); await pending
    expect(publish).toHaveBeenCalledExactlyOnceWith({ state: 'loading' })
  })
  it('a repeated open always requests fresh data and publishes loading before a plan can be approved', async () => {
    const reader = new LatestRead<LivePlan>(), calls = vi.fn().mockResolvedValueOnce(plan).mockResolvedValueOnce({ ...plan, version: 3, planId: 'pln_b' })
    const publish = vi.fn()
    await reader.start(calls, publish); reader.cancel(); await reader.start(calls, publish)
    expect(calls).toHaveBeenCalledTimes(2)
    expect(publish.mock.calls.map(call => call[0].state)).toEqual(['loading', 'ready', 'loading', 'ready'])
    expect(publish.mock.lastCall?.[0].value.version).toBe(3)
  })
})

describe('reviewed scope and evidence', () => {
  it('requires the exact version, id, content and scope that was shown, without adding launch', () => {
    expect(sameReviewedPlan(plan, { ...plan })).toBe(true)
    for (const latest of [null, { ...plan, version: 3 }, { ...plan, planId: 'pln_b' }, { ...plan, items: ['Deploy instead'] }, { ...plan, acceptanceCriteria: [] }, { ...plan, permittedScope: [...plan.permittedScope, 'launch'] }]) expect(sameReviewedPlan(plan, latest)).toBe(false)
  })
  it('refreshes from relevant events in the existing feed, without treating speech as execution', () => {
    expect(evidenceEventRevision([{ sequence: 8, type: 'run.tool.progress' }, { sequence: 10, type: 'run.state.changed' }, { sequence: 20, type: 'conversation.message.created' }])).toBe(10)
    expect(evidenceEventRevision([])).toBe(0)
  })
  it('reads independent real endpoints, then the latest run tools; a failed diff does not hide status or tests', async () => {
    const tests: TestResult[] = [{ testResultId: 'cmd_a', suite: 'npm test', state: 'failed', exitCode: 1, ranAt: 'earlier' }]
    const api = {
      listRuns: vi.fn().mockResolvedValue(good([run])), getWorkspaceDiff: vi.fn().mockResolvedValue(bad),
      listTestResults: vi.fn().mockResolvedValue(good(tests)), listRunTools: vi.fn().mockResolvedValue(good([])),
    } as unknown as RangerApi
    const signal = new AbortController().signal
    const result = await readProjectEvidence(api, run.projectId, signal)
    expect(result.runs).toEqual(good([run])); expect(result.diff).toEqual(bad); expect(result.tests).toEqual(good(tests))
    expect(api.listRunTools).toHaveBeenCalledExactlyOnceWith(run.projectId, run.runId, signal)
  })
  it('does not invent run evidence or fetch tools if run-list is unavailable', async () => {
    const api = { listRuns: vi.fn().mockResolvedValue(bad), getWorkspaceDiff: vi.fn().mockResolvedValue(good<WorkspaceDiff>({ diff: '', changedFiles: [] })), listTestResults: vi.fn().mockResolvedValue(good([])), listRunTools: vi.fn() } as unknown as RangerApi
    const result = await readProjectEvidence(api, 'prj_a', new AbortController().signal)
    expect(result.runs).toEqual(bad); expect(result.tools).toBeNull(); expect(api.listRunTools).not.toHaveBeenCalled()
  })
  it('does not fetch further run tools after the read is aborted', async () => {
    const controller = new AbortController(); controller.abort()
    const api = { listRuns: vi.fn().mockResolvedValue(good([run])), getWorkspaceDiff: vi.fn().mockResolvedValue(bad), listTestResults: vi.fn().mockResolvedValue(bad), listRunTools: vi.fn() } as unknown as RangerApi
    await readProjectEvidence(api, 'prj_a', controller.signal)
    expect(api.listRunTools).not.toHaveBeenCalled()
  })
  it('identifies inventories and only credits successful actual edits', () => {
    expect(diffIsInventory({ diff: 'saved src/a.ts\nsaved README.md', changedFiles: ['src/a.ts', 'README.md'] })).toBe(true)
    expect(diffIsInventory({ diff: '', changedFiles: [] })).toBe(false)
    expect(diffIsInventory({ diff: '@@ -1 +1 @@\n-old\n+new', changedFiles: ['a'] })).toBe(false)
    const tool: RunTool = { callId: '1', name: 'edit_file', status: 'ok', createdAt: 'now', result: { path: 'src/a.ts', saved: true } }
    expect(editedPaths([tool, tool, { ...tool, status: 'denied', result: { path: 'secrets', saved: true } }, { ...tool, name: 'read_file', result: { path: 'read.ts', saved: true } }])).toEqual(['src/a.ts'])
  })
  it('requires completed state plus exit zero for passed, never pending/unknown', () => {
    const test: TestResult = { testResultId: 'cmd_a', suite: 'npm test', state: 'succeeded', exitCode: 0, ranAt: 'now' }
    expect(testOutcome(test)).toBe('Passed')
    expect(testOutcome({ ...test, state: 'running', exitCode: -1 })).toBe('In progress')
    expect(testOutcome({ ...test, state: 'failed', exitCode: 1 })).toBe('Did not pass')
    expect(testOutcome({ ...test, state: 'unknown' })).toBe('Result unconfirmed')
    expect(testOutcome({ ...test, exitCode: -1 })).toBe('Result unconfirmed')
  })
})

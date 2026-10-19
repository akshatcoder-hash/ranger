import type { ApiResult, LivePlan, RangerApi, RunRecord, RunTool, TestResult, WorkspaceDiff } from '../api'

export type ReadState<T> = { state: 'idle' | 'loading' } | { state: 'ready'; value: T }

/** One replaceable read. Navigation, dismissal and a newer refresh fence late results, even if fetch ignores abort. */
export class LatestRead<T> {
  private epoch = 0
  private controller: AbortController | null = null

  async start(read: (signal: AbortSignal) => Promise<T>, publish: (state: ReadState<T>) => void): Promise<void> {
    this.cancel()
    const epoch = this.epoch
    const controller = new AbortController()
    this.controller = controller
    publish({ state: 'loading' })
    const value = await read(controller.signal)
    if (epoch !== this.epoch || controller.signal.aborted) return
    this.controller = null
    publish({ state: 'ready', value })
  }

  cancel() {
    this.epoch += 1
    this.controller?.abort()
    this.controller = null
  }
}

export type ProjectEvidence = {
  projectId: string
  runs: ApiResult<RunRecord[]>
  diff: ApiResult<WorkspaceDiff>
  tests: ApiResult<TestResult[]>
  tools: ApiResult<RunTool[]> | null
  observedAt: string
}

/** Independent endpoint failures stay independent; a failed read is never an empty or passing result. */
export async function readProjectEvidence(api: RangerApi, projectId: string, signal: AbortSignal): Promise<ProjectEvidence> {
  const [runs, diff, tests] = await Promise.all([
    api.listRuns(projectId, signal), api.getWorkspaceDiff(projectId, signal), api.listTestResults(projectId, signal),
  ])
  const latestRun = runs.ok ? runs.data[0] : null
  const tools = latestRun && !signal.aborted ? await api.listRunTools(projectId, latestRun.runId, signal) : null
  return { projectId, runs, diff, tests, tools, observedAt: new Date().toISOString() }
}

/** Authorize only what the customer actually reviewed, including scope and content. */
export function sameReviewedPlan(reviewed: LivePlan, latest: LivePlan | null): boolean {
  return latest !== null && reviewed.planId === latest.planId && reviewed.version === latest.version
    && JSON.stringify(reviewed.items) === JSON.stringify(latest.items)
    && JSON.stringify(reviewed.acceptanceCriteria) === JSON.stringify(latest.acceptanceCriteria)
    && JSON.stringify(reviewed.permittedScope) === JSON.stringify(latest.permittedScope)
}

export function evidenceEventRevision(events: readonly { sequence: number; type: string }[]): number {
  return events.reduce((revision, event) => /^(run\.|workspace\.|plan\.|decision\.|approval\.)/.test(event.type) ? Math.max(revision, event.sequence) : revision, 0)
}

export function testOutcome(test: TestResult): string {
  if (test.state === 'succeeded' && test.exitCode === 0) return 'Passed'
  if (test.state === 'running' || test.state === 'queued') return 'In progress'
  if (test.state === 'failed' || test.state === 'terminated' || test.state === 'cancelled') return 'Did not pass'
  return 'Result unconfirmed'
}

/** The current backend may expose an inventory, which must not be described as a patch. */
export function diffIsInventory(diff: WorkspaceDiff): boolean {
  return diff.diff.length > 0 && diff.diff.split('\n').every(line => line.startsWith('saved '))
}

export function editedPaths(tools: readonly RunTool[]): string[] {
  return [...new Set(tools.flatMap(tool => tool.name === 'edit_file' && tool.status === 'ok' && tool.result?.saved === true && typeof tool.result.path === 'string' ? [tool.result.path] : []))]
}

import { describe, expect, it } from 'vitest'
import { describeEvent, hasActiveRun, isNoisyEvent, projectRecordRevision } from './activity'

const event = (sequence: number, type: string, data?: Record<string, unknown>) => ({ eventId: `e${sequence}`, sequence, type, ...(data ? { data } : {}) })

describe('describeEvent', () => {
  it('reads preparation phases and shows only the fields the event carried', () => {
    expect(describeEvent(event(1, 'workspace.preparation.updated', { jobId: 'j', phase: 'preparing' }))).toEqual({ title: 'Provisioning the VM and loading the repository', tone: 'neutral' })
    const ready = describeEvent(event(2, 'workspace.preparation.updated', { jobId: 'j', phase: 'ready', fileCount: 1280, cloneElapsedMs: 2400, indexElapsedMs: 840, elapsedMs: 3500, byteCount: 2048 }))
    expect(ready).toMatchObject({ title: 'Workspace ready', tone: 'good' })
    expect(ready.detail).toBe('1280 files · 2.0 KB · clone 2.4 s · index 0.84 s · total 3.5 s')
    expect(describeEvent(event(3, 'workspace.preparation.updated', { jobId: 'j', phase: 'failed', message: 'clone failed' }))).toMatchObject({ title: 'Preparation failed', detail: 'clone failed', tone: 'bad' })
  })

  it('describes run, tool and plan progress', () => {
    expect(describeEvent(event(1, 'run.state.changed', { runId: 'run_abcdef123456', from: 'queued', to: 'running' }))).toMatchObject({ title: 'Run abcdef12 running' })
    expect(describeEvent(event(2, 'run.state.changed', { runId: 'run_abcdef123456', from: 'running', to: 'succeeded' })).tone).toBe('good')
    expect(describeEvent(event(3, 'run.tool.progress', { runId: 'run_abcdef123456', callId: 'c', tool: 'run_tests', status: 'error' }))).toMatchObject({ title: 'Tool run_tests: error', tone: 'bad' })
    expect(describeEvent(event(4, 'run.scope.violation', { tool: 'write_file', reason: 'outside scope' }))).toMatchObject({ title: 'Blocked write_file', detail: 'outside scope', tone: 'warn' })
    expect(describeEvent(event(5, 'plan.approval.granted', { version: 2 })).title).toBe('Plan version 2 approved')
    expect(describeEvent(event(6, 'plan.version.created', {})).title).toBe('Plan drafted')
  })

  it('describes VM commands with their real exit status', () => {
    expect(describeEvent(event(1, 'workspace.command.started', { command: 'sh -c ls' }))).toEqual({ title: 'VM command started', detail: '$ sh -c ls', tone: 'neutral' })
    expect(describeEvent(event(2, 'workspace.command.finished', { command: 'sh -c ls', state: 'succeeded', exitCode: 0 }))).toEqual({ title: 'VM command succeeded', detail: '$ sh -c ls · exit 0', tone: 'good' })
    expect(describeEvent(event(3, 'workspace.command.finished', { state: 'failed', exitCode: 2 }))).toMatchObject({ title: 'VM command failed', detail: 'exit 2', tone: 'bad' })
    expect(describeEvent(event(4, 'workspace.command.finished'))).toEqual({ title: 'VM command finished', tone: 'neutral' })
  })

  it('falls back to the event name instead of inventing detail', () => {
    expect(describeEvent(event(1, 'capture.session.started'))).toEqual({ title: 'capture session started', tone: 'neutral' })
    expect(describeEvent(event(2, 'workspace.preparation.updated', { phase: 'indexing' })).detail).toBeUndefined()
  })
})

describe('hasActiveRun', () => {
  it('is true only while a run\'s latest transition is queued or running', () => {
    const queued = event(1, 'run.state.changed', { runId: 'run_1', from: null, to: 'queued' })
    const running = event(2, 'run.state.changed', { runId: 'run_1', from: 'queued', to: 'running' })
    const done = event(3, 'run.state.changed', { runId: 'run_1', from: 'running', to: 'succeeded' })
    expect(hasActiveRun([queued])).toBe(true)
    expect(hasActiveRun([done, queued, running])).toBe(false)
    expect(hasActiveRun([queued, running, done, event(4, 'run.state.changed', { runId: 'run_2', to: 'running' })])).toBe(true)
    expect(hasActiveRun([])).toBe(false)
  })
})

describe('feed filtering and record revision', () => {
  it('hides per-frame capture noise only', () => {
    expect(isNoisyEvent(event(1, 'capture.frame.ingested'))).toBe(true)
    expect(isNoisyEvent(event(2, 'voice.usage.recorded'))).toBe(true)
    expect(isNoisyEvent(event(3, 'capture.session.started'))).toBe(false)
  })

  it('tracks the newest message, plan or repository event', () => {
    expect(projectRecordRevision([event(1, 'run.state.changed'), event(4, 'conversation.message.created'), event(9, 'run.tool.progress'), event(7, 'plan.version.created')])).toBe(7)
    expect(projectRecordRevision([event(2, 'repository.connected')])).toBe(2)
    expect(projectRecordRevision([event(2, 'run.state.changed')])).toBe(0)
  })
})

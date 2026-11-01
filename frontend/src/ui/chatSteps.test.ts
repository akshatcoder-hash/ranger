import { describe, expect, it } from 'vitest'
import type { RunRecord, RunTool } from '../api'
import { activityHeadline, chatSteps, describeTool, runIsActive } from './chatSteps'

const tool = (name: string, result: Record<string, unknown> = {}, status = 'ok'): RunTool => ({ callId: `call-${name}`, name, status, result, createdAt: '2026-10-31T00:00:00.000Z' })
const run = (state: RunRecord['state'], failureCode?: string): RunRecord => ({
  runId: 'run_11111111-1111-1111-1111-111111111111', projectId: 'prj_11111111-1111-1111-1111-111111111111',
  planId: 'pln_11111111-1111-1111-1111-111111111111', planVersion: 1, state,
  createdAt: '2026-10-31T00:00:00.000Z', updatedAt: '2026-10-31T00:00:00.000Z', ...(failureCode ? { failureCode } : {}),
})
const event = (sequence: number, type: string, data: Record<string, unknown> = {}) => ({ eventId: `evt_${sequence}`, sequence, type, data })

describe('describeTool', () => {
  it('names the file a tool touched and the exit code a check returned', () => {
    expect(describeTool(tool('edit_file', { path: 'src/triage.mjs', saved: true }))).toMatchObject({ title: 'Edited a file', detail: 'src/triage.mjs', tone: 'good' })
    expect(describeTool(tool('run_tests', { exitCode: 1, passed: false }))).toMatchObject({ title: 'Ran the checks', detail: 'exit 1', tone: 'bad' })
    expect(describeTool(tool('run_tests', { exitCode: 0, passed: true }))).toMatchObject({ tone: 'good' })
  })

  it('marks denied and failed calls so color is never the only cue', () => {
    expect(describeTool({ ...tool('edit_file'), status: 'denied' }).tone).toBe('warn')
    expect(describeTool({ ...tool('edit_file'), status: 'error', error: 'scope' }).detail).toBe('scope')
  })
})

describe('chatSteps', () => {
  it('shows the recorded tool steps without repeating the run state line', () => {
    const steps = chatSteps({
      events: [event(1, 'run.state.changed', { runId: 'run_11111111', to: 'running' }), event(2, 'capture.frame.ingested')],
      tools: [tool('search_code', { resultCount: 2 }), tool('edit_file', { path: 'src/triage.mjs', saved: true })],
    })
    expect(steps.map(step => step.title)).toEqual(['Searched the code index', 'Edited a file'])
    expect(steps.some(step => step.title.includes('Run') || step.title.includes('capture'))).toBe(false)
  })

  it('falls back to project activity when no run exists', () => {
    const steps = chatSteps({ events: [event(1, 'repository.connected', { url: 'https://github.com/o/r' }), event(2, 'plan.version.created', { version: 1 })], tools: null })
    expect(steps.map(step => step.title)).toEqual(['Repository connected', 'Plan version 1 drafted'])
  })

  it('caps the list without dropping the newest step', () => {
    const tools = [1, 2, 3, 4, 5, 6, 7].map(index => tool('edit_file', { path: `src/f${index}.ts`, saved: true }))
    expect(chatSteps({ events: [], tools }).at(-1)?.detail).toBe('src/f7.ts')
    expect(chatSteps({ events: [], tools })).toHaveLength(6)
  })
})

describe('activityHeadline', () => {
  it('says what is happening now, including the tool in flight', () => {
    expect(activityHeadline({ run: run('queued'), tools: null, preparation: null, busy: false }).title).toContain('queued')
    expect(activityHeadline({ run: run('running'), tools: [tool('edit_file', { path: 'src/triage.mjs', saved: true })], preparation: null, busy: false }).title).toBe('Working: Edited a file (src/triage.mjs).')
    expect(activityHeadline({ run: null, tools: null, preparation: { jobId: 'j', phase: 'indexing' } as never, busy: false }).title).toContain('Indexing')
  })

  it('reports the finished result and how to recover from a failure', () => {
    const headline = activityHeadline({ run: run('succeeded'), tools: [tool('edit_file', { path: 'a.ts', saved: true }), tool('run_tests', { exitCode: 0, passed: true })], preparation: null, busy: false })
    expect(headline).toEqual({ title: 'Finished. Files edited: 1 · checks exit 0.', tone: 'good' })
    expect(activityHeadline({ run: run('failed', 'check_failed'), tools: null, preparation: null, busy: false }).title).toContain('Start the work again')
    expect(activityHeadline({ run: run('cancelled'), tools: null, preparation: null, busy: false }).title).toContain('Nothing is running')
  })

  it('treats only queued and running runs as active', () => {
    expect(runIsActive(run('running'))).toBe(true)
    expect(runIsActive(run('succeeded'))).toBe(false)
    expect(runIsActive(null)).toBe(false)
  })
})

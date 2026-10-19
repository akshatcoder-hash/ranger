import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ActivityFeed, PreparationCard, VmPanel } from './LiveVm'

const prep = (sequence: number, data: Record<string, unknown>) => ({ eventId: `e${sequence}`, sequence, type: 'workspace.preparation.updated', data })

describe('PreparationCard', () => {
  it('shows a live clock, counts and a rate while indexing, and no clone time that was not reported', () => {
    const events = [prep(1, { jobId: 'j', phase: 'indexing', fileCount: 100, indexElapsedMs: 1000 }), prep(2, { jobId: 'j', phase: 'indexing', fileCount: 700, byteCount: 2048, indexElapsedMs: 2000 })]
    const html = renderToStaticMarkup(<PreparationCard repositoryUrl="https://github.com/o/r" preparation={{ jobId: 'j', phase: 'indexing', fileCount: 700, byteCount: 2048, indexElapsedMs: 2000 }} events={events} clock={{ jobId: 'j', phase: 'indexing', jobStartedAt: Date.now() - 12_000, phaseStartedAt: Date.now() - 3000 }} />)
    expect(html).toContain('Indexing with Trace')
    expect(html).toContain('Elapsed')
    expect(html).toContain('This phase')
    expect(html).toContain('700')
    expect(html).toContain('2.0 KB')
    expect(html).toContain('600 files/s')
    expect(html).not.toContain('Clone')
    expect(html).toContain('data-state="current"')
  })

  it('shows clone, index and total times on ready, and only when the events carried them', () => {
    const status = { jobId: 'j', phase: 'ready' as const, fileCount: 1280, byteCount: 5 * 1024 * 1024, cloneElapsedMs: 2400, indexElapsedMs: 640, elapsedMs: 3500, repositoryCommit: 'abcdef1234567890' }
    const html = renderToStaticMarkup(<PreparationCard repositoryUrl="https://github.com/o/r" preparation={status} events={[]} clock={null} />)
    expect(html).toContain('Clone')
    expect(html).toContain('2.4 s')
    expect(html).toContain('Index time')
    expect(html).toContain('Total')
    expect(html).toContain('2,000 files/s')
    expect(html).toContain('abcdef1234')
    expect(html).not.toContain('Elapsed<')
    const older = renderToStaticMarkup(<PreparationCard repositoryUrl={null} preparation={{ jobId: 'j', phase: 'ready', elapsedMs: 900 }} events={[]} clock={null} />)
    expect(older).not.toContain('Clone')
    expect(older).not.toContain('files/s')
  })

  it('reports failure without claiming ready and explains the empty state', () => {
    expect(renderToStaticMarkup(<PreparationCard repositoryUrl={null} preparation={{ jobId: 'j', phase: 'failed', message: 'clone failed' }} events={[]} clock={null} />)).toContain('clone failed')
    expect(renderToStaticMarkup(<PreparationCard repositoryUrl={null} preparation={null} events={[]} clock={null} />)).toContain('Connect a repository')
  })
})

describe('VmPanel', () => {
  const PROJECT = 'prj_11111111-1111-1111-1111-111111111111'

  it('shows the observed VM state, a command input and no stale output', () => {
    const html = renderToStaticMarkup(<VmPanel projectId={PROJECT} workspace={{ status: { projectId: PROJECT, adapter: 'instabox', adapterKind: 'vm', desiredState: 'running', observedState: 'running', sourceRevision: 'abcdef1234567890' }, }} />)
    expect(html).toContain('instabox · running · abcdef1234')
    expect(html).toContain('Command to run in the VM')
    expect(html).not.toContain('Command output')
  })

  it('explains a missing VM and a status failure separately', () => {
    expect(renderToStaticMarkup(<VmPanel projectId={PROJECT} workspace={{ status: null, error: 'not_found: No workspace for this project' }} />)).toContain('No VM has been provisioned')
    expect(renderToStaticMarkup(<VmPanel projectId={PROJECT} workspace={{ status: null, error: 'The Ranger API is unreachable.' }} />)).toContain('Could not read VM status')
  })
})

describe('ActivityFeed', () => {
  it('renders readable lines newest first and hides per-frame noise', () => {
    const events = [
      { eventId: 'e1', sequence: 1, type: 'workspace.preparation.updated', data: { jobId: 'j', phase: 'preparing' } },
      { eventId: 'e2', sequence: 2, type: 'capture.frame.ingested' },
      { eventId: 'e3', sequence: 3, type: 'run.tool.progress', data: { runId: 'run_abcdef12', callId: 'c', tool: 'run_tests', status: 'ok' } },
    ]
    const html = renderToStaticMarkup(<ActivityFeed events={events} status="polling" onRefresh={() => {}} />)
    expect(html.indexOf('Tool run_tests: ok')).toBeLessThan(html.indexOf('Provisioning the VM'))
    expect(html).not.toContain('capture frame')
    expect(html).toContain('Live')
  })

  it('says so when nothing has happened and when history failed', () => {
    expect(renderToStaticMarkup(<ActivityFeed events={[]} status="polling" onRefresh={() => {}} />)).toContain('No activity has been recorded yet.')
    expect(renderToStaticMarkup(<ActivityFeed events={[]} status="error" error="boom" onRefresh={() => {}} />)).toContain('Activity could not be loaded.')
  })
})

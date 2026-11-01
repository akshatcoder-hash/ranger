import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PreparationCard, VmPanel } from './LiveVm'

const prep = (sequence: number, data: Record<string, unknown>) => ({ eventId: `e${sequence}`, sequence, type: 'workspace.preparation.updated', data })

describe('PreparationCard', () => {
  it('shows live preparation progress without presenting index throughput as search speed', () => {
    const events = [prep(1, { jobId: 'j', phase: 'indexing', fileCount: 100, indexElapsedMs: 1000 }), prep(2, { jobId: 'j', phase: 'indexing', fileCount: 700, byteCount: 2048, indexElapsedMs: 2000 })]
    const html = renderToStaticMarkup(<PreparationCard repositoryUrl="https://github.com/o/r" preparation={{ jobId: 'j', phase: 'indexing', fileCount: 700, byteCount: 2048, indexElapsedMs: 2000 }} events={events} clock={{ jobId: 'j', phase: 'indexing', jobStartedAt: Date.now() - 12_000, phaseStartedAt: Date.now() - 3000 }} />)
    expect(html).toContain('Indexing with Trace')
    expect(html).toContain('Elapsed')
    expect(html).toContain('This phase')
    expect(html).toContain('700')
    expect(html).toContain('2.0 KB')
    expect(html).not.toContain('files/s')
    expect(html).not.toContain('Trace search')
    expect(html).not.toContain('Clone')
    expect(html).toContain('data-state="current"')
  })

  it('shows indexed files and measured index time separately from search speed', () => {
    const status = { jobId: 'j', phase: 'ready' as const, fileCount: 1280, byteCount: 5 * 1024 * 1024, cloneElapsedMs: 2400, indexElapsedMs: 640, elapsedMs: 3500, repositoryCommit: 'abcdef1234567890' }
    const html = renderToStaticMarkup(<PreparationCard repositoryUrl="https://github.com/o/r" preparation={status} events={[]} clock={null} />)
    expect(html).not.toContain('Clone')
    expect(html).not.toContain('2.4 s')
    expect(html).toContain('Indexed files')
    expect(html).toContain('1,280')
    expect(html).toContain('Index time')
    expect(html).toContain('0.64 s')
    expect(html).not.toContain('Total')
    expect(html).not.toContain('files/s')
    expect(html).toContain('Ask about the code to measure a search.')
    expect(html).not.toContain('Preparation progress')
    expect(html).toContain('abcdef1234')
    expect(html).not.toContain('Elapsed<')
    const older = renderToStaticMarkup(<PreparationCard repositoryUrl={null} preparation={{ jobId: 'j', phase: 'ready', elapsedMs: 900 }} events={[]} clock={null} />)
    expect(older).not.toContain('Clone')
    expect(older).not.toContain('files/s')
  })

  it('shows the newest real search measurement and never labels fallback as Trace', () => {
    const search = (sequence: number, provider = 'trace') => ({
      eventId: `s${sequence}`, sequence, type: 'retrieval.search.completed',
      data: { provider, durationMs: sequence === 2 ? 18.4 : 43, resultCount: sequence === 2 ? 0 : 3 },
    })
    const render = (events: ReturnType<typeof search>[]) => renderToStaticMarkup(
      <PreparationCard repositoryUrl={null} preparation={{ jobId: 'j', phase: 'ready' }} events={events} clock={null} />,
    )
    const html = render([search(2), search(1)])
    expect(html).toContain('Trace search')
    expect(html).toContain('18.4 ms')
    expect(html).toContain('<dd>0</dd>')
    expect(html).not.toContain('43 ms')
    const fallback = render([search(1), search(2, 'file-search-fallback')])
    expect(fallback).toContain('File search fallback')
    expect(fallback).not.toContain('Trace search')
    expect(render([{ ...search(1), data: { provider: 'trace', durationMs: -1, resultCount: 3 } }])).not.toContain('Trace search')
  })

  it('reports failure without claiming ready and explains the empty state', () => {
    expect(renderToStaticMarkup(<PreparationCard repositoryUrl={null} preparation={{ jobId: 'j', phase: 'failed', message: 'clone failed' }} events={[]} clock={null} />)).toContain('clone failed')
    expect(renderToStaticMarkup(<PreparationCard repositoryUrl={null} preparation={null} events={[]} clock={null} />)).toContain('Connect a repository')
  })

  it('keeps search metrics visible when only workspace state is available', () => {
    const html = renderToStaticMarkup(<PreparationCard repositoryUrl="https://github.com/o/r" preparation={null} clock={null} workspaceState="running" events={[{ eventId: 's1', sequence: 1, type: 'retrieval.search.completed', data: { provider: 'trace', durationMs: 23.1, resultCount: 2 } }]} />)
    expect(html).toContain('Workspace running')
    expect(html).toContain('Trace search')
    expect(html).toContain('23.1 ms')
    expect(html).not.toContain('Preparation starts')
  })
})

describe('VmPanel', () => {
  const PROJECT = 'prj_11111111-1111-1111-1111-111111111111'

  it('shows the observed VM state, a command input and no stale output', () => {
    const html = renderToStaticMarkup(<VmPanel projectId={PROJECT} workspace={{ status: { projectId: PROJECT, adapter: 'instabox', adapterKind: 'vm', desiredState: 'running', observedState: 'running', sourceRevision: 'abcdef1234567890' }, }} />)
    expect(html).toContain('instabox · running · abcdef1234')
    expect(html).toContain('Command to run in the VM')
    expect(html).toContain('Stop VM')
    expect(html).toContain('Show VM screen')
    expect(html).not.toContain('Command output')
  })

  it('explains a missing VM and a status failure separately', () => {
    expect(renderToStaticMarkup(<VmPanel projectId={PROJECT} workspace={{ status: null, error: 'not_found: No workspace for this project' }} />)).toContain('No VM has been provisioned')
    expect(renderToStaticMarkup(<VmPanel projectId={PROJECT} workspace={{ status: null, error: 'The Ranger API is unreachable.' }} />)).toContain('Could not read VM status')
  })
})

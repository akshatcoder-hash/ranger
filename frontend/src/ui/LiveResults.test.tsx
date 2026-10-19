import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LiveResults } from './LiveResults'
import type { ProjectEvidence } from './liveEvidence'
const evidence: ProjectEvidence = {
  projectId: 'prj_a', observedAt: '2026-10-19T12:00:00Z',
  runs: { ok: true, data: [{ runId: 'run_a', projectId: 'prj_a', planId: 'pln_a', planVersion: 3, state: 'failed', failureCode: 'check_failed', failureMessage: 'Tests failed', createdAt: 'now', updatedAt: 'now' }] },
  diff: { ok: true, data: { diff: 'saved src/fix.ts', changedFiles: ['src/fix.ts'] } },
  tests: { ok: true, data: [{ testResultId: 'cmd_a', suite: 'npm test', state: 'failed', exitCode: 1, ranAt: 'earlier' }] },
  tools: { ok: true, data: [{ callId: 'call_a', name: 'edit_file', status: 'ok', result: { path: 'src/fix.ts', saved: true }, createdAt: 'now' }] },
}
const render = (data = evidence, projectId = data.projectId) => renderToStaticMarkup(<LiveResults evidence={{ state: 'ready', value: data }} projectId={projectId} view="review" onRefresh={() => {}} />)
describe('observed results static rendering, no live execution', () => {
  it('shows failed run, edited file and actual exit without false empty or passed claims', () => {
    const html = render()
    expect(html).toContain('check_failed'); expect(html).toContain('Exit 1'); expect(html).toContain('Files edited in the latest run')
    expect(html).toContain('saved-file inventory, not a line-by-line diff'); expect(html).toContain('may include earlier runs')
    expect(html).not.toContain('No run has started'); expect(html).not.toContain('All checks passed'); expect(html).not.toContain('No runs recorded')
  })
  it('withholds a previous project snapshot during navigation', () => {
    const html = render(evidence, 'prj_b')
    expect(html).toContain('Loading observed run results'); expect(html).not.toContain('src/fix.ts'); expect(html).not.toContain('check_failed')
  })
  it('distinguishes unavailable endpoint from empty recorded history', () => {
    const failure = { ok: false as const, reason: 'unavailable' as const, message: 'temporarily unavailable' }
    const html = render({ ...evidence, runs: failure, diff: failure, tests: failure })
    expect(html).toContain('Run status unavailable'); expect(html).toContain('Workspace diff unavailable'); expect(html).toContain('Test results unavailable')
    expect(html).not.toContain('No runs recorded'); expect(html).not.toContain('No test-command results')
  })
  it('labels confirmed empty run and test lists', () => {
    const html = render({ ...evidence, runs: { ok: true, data: [] }, tests: { ok: true, data: [] }, tools: null })
    expect(html).toContain('No runs recorded for this project'); expect(html).toContain('No test-command results have been recorded')
  })
  it('escapes source-like backend evidence instead of rendering it as HTML', () => {
    const html = render({ ...evidence, diff: { ok: true, data: { diff: '<script>alert(1)</script>', changedFiles: [] } } })
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>')
  })
})

import { useEffect, useState } from 'react'
import { rangerApi, type ApiResult, type WorkspaceFile } from '../api'
import { LatestRead, diffIsInventory, editedPaths, testOutcome, type ProjectEvidence, type ReadState } from './liveEvidence'

type Props = { evidence: ReadState<ProjectEvidence>; projectId: string; view: 'changes' | 'checks' | 'review' | 'summary'; onRefresh: () => void; onReview?: () => void }

export function LiveResults({ evidence, projectId, view, onRefresh, onReview }: Props) {
  const [selectedFile, setSelectedFile] = useState<{ projectId: string; path: string } | null>(null)
  const data = evidence.state === 'ready' && evidence.value.projectId === projectId ? evidence.value : null
  if (!data) return <article className="detail-card"><h3>Run results</h3><p role="status" className="small-muted">Loading observed run results…</p></article>
  const latestRun = data.runs.ok ? data.runs.data[0] : null
  const edits = data.tools?.ok ? editedPaths(data.tools.data) : []
  const inventory = data.diff.ok && diffIsInventory(data.diff.data)
  return <div style={{ display: 'grid', gap: 14 }} aria-label="Observed run results">
    <article className="detail-card"><div className="diff-heading"><h3>Latest run</h3><button className="button button-secondary" onClick={onRefresh}>Refresh results</button></div>
      {!data.runs.ok ? <p role="alert">Run status unavailable: {data.runs.message}</p>
        : latestRun ? <><p><strong>{latestRun.state}</strong> · Approved plan version {latestRun.planVersion}</p><p className="small-muted">{latestRun.runId} · Updated {latestRun.updatedAt}</p>{latestRun.failureCode && <p role="alert">{latestRun.failureCode}: {latestRun.failureMessage}</p>}</>
          : <p>No runs recorded for this project.</p>}
      <p className="small-muted">Observed {data.observedAt}. This is a backend snapshot.</p>
      {view === 'summary' && onReview && <button className="button button-secondary" onClick={onReview}>Review results</button>}
    </article>
    {(view === 'changes' || view === 'review') && <article className="detail-card diff-card"><h3>{inventory ? 'Saved workspace files' : 'Workspace changes'}</h3>
      {edits.length > 0 && <><p className="field-label">Files edited in the latest run</p><ul className="plan-list">{edits.map(path => <li key={path}><button className="text-link" onClick={() => setSelectedFile({ projectId, path })}>{path}</button></li>)}</ul></>}
      {!data.diff.ok ? <p role="alert">Workspace diff unavailable: {data.diff.message}</p>
        : <><p className="small-muted">{inventory ? 'The backend currently returns a saved-file inventory, not a line-by-line diff. These files are not proof of edits in this run.' : 'Current project workspace evidence; it is not scoped to a single run.'}</p>
          {data.diff.data.changedFiles.length > 0 && <details><summary>Browse {data.diff.data.changedFiles.length} recorded files</summary><ul className="plan-list" style={{ maxHeight: 240, overflow: 'auto' }}>{data.diff.data.changedFiles.map(path => <li key={path}><button className="text-link" onClick={() => setSelectedFile({ projectId, path })}>{path}</button></li>)}</ul></details>}
          {data.diff.data.diff ? <pre aria-label={inventory ? 'Saved file inventory' : 'Workspace diff'} style={{ maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{data.diff.data.diff}</pre> : <p>No diff content was returned by the backend.</p>}
        </>}
      {selectedFile?.projectId === projectId && <SavedSource key={`${projectId}/${selectedFile.path}`} projectId={projectId} path={selectedFile.path} observedAt={data.observedAt} onClose={() => setSelectedFile(null)} />}
      {view === 'changes' && onReview && <button className="button button-secondary" onClick={onReview}>Open full review</button>}
    </article>}
    {(view === 'checks' || view === 'review') && <article className="detail-card"><h3>Executed test commands</h3><p className="small-muted">Project-wide command results with actual exit codes. They do not establish that every acceptance criterion passed, and may include earlier runs.</p>
      {!data.tests.ok ? <p role="alert">Test results unavailable: {data.tests.message}</p> : data.tests.data.length ? data.tests.data.map(test => <div className="activity-row" key={test.testResultId}><strong>{testOutcome(test)}</strong><p><code>{test.suite}</code></p><small>{test.state} · {test.state === 'running' || test.state === 'queued' ? 'Exit pending' : `Exit ${test.exitCode}`} · {test.ranAt}</small></div>) : <p>No test-command results have been recorded.</p>}
    </article>}
    {view !== 'summary' && latestRun && <article className="detail-card"><h3>Latest run activity</h3>
      {data.tools === null ? <p>Tool evidence has not been loaded.</p> : !data.tools.ok ? <p role="alert">Tool evidence unavailable: {data.tools.message}</p> : data.tools.data.length ? data.tools.data.map(tool => <details className="activity-row" key={tool.callId}><summary>{tool.name} · {tool.status}</summary><small>{tool.createdAt}</small>{tool.error && <p role="alert">{tool.error}</p>}{tool.result && <pre style={{ maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(tool.result, null, 2)}</pre>}</details>) : <p>No tool outcomes recorded for this run yet.</p>}
    </article>}
  </div>
}

function SavedSource({ projectId, path, observedAt, onClose }: { projectId: string; path: string; observedAt: string; onClose: () => void }) {
  const [reader] = useState(() => new LatestRead<ApiResult<WorkspaceFile>>())
  const [source, setSource] = useState<ReadState<ApiResult<WorkspaceFile>>>({ state: 'idle' })
  useEffect(() => {
    void reader.start(signal => rangerApi.readWorkspaceFile(projectId, path, signal), setSource)
    return () => reader.cancel()
  }, [observedAt, path, projectId, reader])
  const file = source.state === 'ready' && source.value.ok ? source.value.data : null
  return <section aria-label="Saved file content"><h4>{path}</h4><p className="small-muted">Latest saved source from the backend; this is not a before/after diff.</p><button className="button button-secondary" onClick={onClose}>Close file</button>
    {source.state !== 'ready' ? <p role="status">Reading saved source…</p> : !source.value.ok ? <p role="alert">Source unavailable: {source.value.message}</p> : file?.text === null ? <p>Binary or non-UTF-8 file · {file.sizeBytes} bytes. Text preview unavailable.</p> : <><pre style={{ maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{file?.text?.slice(0, 40_000) || '(empty file)'}</pre>{(file?.text?.length ?? 0) > 40_000 && <p className="small-muted">Preview limited to the first 40,000 characters.</p>}</>}
  </section>
}

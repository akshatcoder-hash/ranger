import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { rangerApi, type WorkspaceStatus } from '../api'
import { describeEvent, isNoisyEvent, type ActivityEvent } from './activity'
import { averageIndexRate, formatBytes, formatDuration, indexingRate, preparationIsActive, type PreparationClock, type PreparationStatus } from './liveHelpers'
import { Button, StatusPill } from './primitives'

const PHASE_LABEL: Record<PreparationStatus['phase'], string> = {
  queued: 'Queued',
  preparing: 'Provisioning VM + loading repo',
  indexing: 'Indexing with Trace',
  ready: 'Ready',
  failed: 'Preparation failed',
}
const STEPS: { phase: PreparationStatus['phase']; label: string }[] = [
  { phase: 'queued', label: 'Queued' },
  { phase: 'preparing', label: 'VM + repo' },
  { phase: 'indexing', label: 'Trace index' },
  { phase: 'ready', label: 'Ready' },
]
const COMMAND_TIMEOUT_MS = 60_000
const FEED_LIMIT = 80

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

function formatRate(rate: number): string {
  return rate >= 100 ? Math.round(rate).toLocaleString() : rate.toFixed(1)
}

/** Preparation progress and speeds. Every number is a backend event field or the browser's own stopwatch; nothing is estimated. */
export function PreparationCard({ repositoryUrl, preparation, events, clock }: { repositoryUrl: string | null; preparation: PreparationStatus | null; events: readonly ActivityEvent[]; clock: PreparationClock | null }) {
  const active = preparationIsActive(preparation)
  const now = useNow(active)
  const rate = useMemo(() => active ? indexingRate(events) : preparation ? averageIndexRate(preparation) : null, [active, events, preparation])
  const tone = preparation?.phase === 'ready' ? 'green' : preparation?.phase === 'failed' ? 'amber' : preparation ? 'violet' : 'gray'
  const tiles: { label: string; value: string }[] = []
  if (preparation) {
    if (active && clock?.jobId === preparation.jobId) {
      tiles.push({ label: 'Elapsed', value: formatDuration(Math.max(0, now - clock.jobStartedAt)) })
      tiles.push({ label: 'This phase', value: formatDuration(Math.max(0, now - clock.phaseStartedAt)) })
    }
    if (preparation.fileCount !== undefined) tiles.push({ label: 'Files', value: preparation.fileCount.toLocaleString() })
    if (preparation.byteCount !== undefined) tiles.push({ label: 'Size', value: formatBytes(preparation.byteCount) })
    if (rate !== null) tiles.push({ label: active ? 'Index speed' : 'Avg index speed', value: `${formatRate(rate)} files/s` })
    if (preparation.cloneElapsedMs !== undefined) tiles.push({ label: 'Clone', value: formatDuration(preparation.cloneElapsedMs) })
    if (preparation.indexElapsedMs !== undefined) tiles.push({ label: 'Index time', value: formatDuration(preparation.indexElapsedMs) })
    if (preparation.elapsedMs !== undefined) tiles.push({ label: preparation.phase === 'ready' ? 'Total' : 'Backend elapsed', value: formatDuration(preparation.elapsedMs) })
    if (preparation.repositoryCommit) tiles.push({ label: 'Commit', value: preparation.repositoryCommit.slice(0, 10) })
  }
  const stepIndex = preparation ? STEPS.findIndex(step => step.phase === preparation.phase) : -1
  return <article className="detail-card" aria-label="Project preparation">
    <div className="card-heading">
      <h3>Project</h3>
      <StatusPill tone={tone}>{preparation ? PHASE_LABEL[preparation.phase] : 'Not started'}</StatusPill>
    </div>
    <p role="status">{repositoryUrl ? `Connected repository: ${repositoryUrl}` : 'No repository connected yet.'}</p>
    {preparation && preparation.phase !== 'failed' && <ol className="prep-steps" aria-label="Preparation progress">{STEPS.map((step, index) => <li key={step.phase} data-state={index < stepIndex || preparation.phase === 'ready' ? 'done' : index === stepIndex ? 'current' : 'pending'}>{step.label}</li>)}</ol>}
    {tiles.length > 0 && <dl className="speed-grid" aria-label="Preparation speeds">{tiles.map(tile => <div className="speed-tile" key={tile.label}><dt>{tile.label}</dt><dd>{tile.value}</dd></div>)}</dl>}
    {preparation?.phase === 'failed' && <p role="alert" className="small-muted">{preparation.message ?? preparation.errorCode ?? 'Preparation failed. No files were marked ready.'}</p>}
    {!preparation && <p className="small-muted">{repositoryUrl ? 'Start a call and ask Ranger to prepare this repository. Its VM and indexing progress will appear here.' : 'Connect a repository, then start a call to prepare its VM and code index.'}</p>}
  </article>
}

type CommandResult =
  | { kind: 'idle' }
  | { kind: 'running'; command: string; startedAt: number }
  | { kind: 'done'; command: string; commandId: string; state: string; exitCode: number | null; output: string; truncated: boolean; logsError?: string }
  | { kind: 'error'; command: string; message: string }
type Shot = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; base64: string } | { kind: 'error'; message: string }

function vmStatusLine(workspace: { status: WorkspaceStatus | null; error?: string }): string {
  const { status, error } = workspace
  if (status) {
    const desired = status.desiredState !== status.observedState ? ` (desired ${status.desiredState})` : ''
    return `${status.adapter} · ${status.observedState}${desired}${status.sourceRevision ? ` · ${status.sourceRevision.slice(0, 10)}` : ''}`
  }
  if (error) return error.includes('not_found') ? 'No VM has been provisioned for this project yet.' : `Could not read VM status: ${error}`
  return 'Checking VM status…'
}

/** VM status, a plain command console and a desktop screenshot. Commands run in the project's own VM through the supervised exec API. */
export function VmPanel({ projectId, workspace }: { projectId: string; workspace: { status: WorkspaceStatus | null; error?: string } }) {
  const [input, setInput] = useState('')
  const [result, setResult] = useState<CommandResult>({ kind: 'idle' })
  const [shot, setShot] = useState<Shot>({ kind: 'idle' })
  const abortRef = useRef<AbortController | null>(null)
  const shotAbortRef = useRef<AbortController | null>(null)
  const running = result.kind === 'running'
  const now = useNow(running)
  useEffect(() => () => { abortRef.current?.abort(); shotAbortRef.current?.abort() }, [])

  const readLogs = async (command: string, commandId: string, state: string, exitCode: number | null, signal: AbortSignal) => {
    const logs = await rangerApi.getWorkspaceCommandLogs(projectId, commandId, signal)
    if (signal.aborted) return
    setResult({ kind: 'done', command, commandId, state, exitCode, output: logs.ok ? logs.data.logs : '', truncated: logs.ok && logs.data.truncated, ...(logs.ok ? {} : { logsError: logs.message }) })
  }

  const run = async (event: FormEvent) => {
    event.preventDefault()
    const command = input.trim()
    if (!command || running) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setResult({ kind: 'running', command, startedAt: Date.now() })
    // The API holds a foreground command open until it exits and only then records its output, so the logs are read once afterwards.
    const started = await rangerApi.runWorkspaceCommand(projectId, { command: 'sh', args: ['-c', command], timeoutMs: COMMAND_TIMEOUT_MS }, controller.signal)
    if (controller.signal.aborted) return
    if (!started.ok) { setResult({ kind: 'error', command, message: started.message }); return }
    await readLogs(command, started.data.commandId, started.data.state, started.data.exitCode, controller.signal)
  }

  const takeScreenshot = async () => {
    const controller = new AbortController()
    shotAbortRef.current?.abort()
    shotAbortRef.current = controller
    setShot({ kind: 'loading' })
    const captured = await rangerApi.captureWorkspaceScreenshot(projectId, controller.signal)
    if (controller.signal.aborted) return
    setShot(captured.ok ? { kind: 'ready', base64: captured.data.contentBase64 } : { kind: 'error', message: captured.message })
  }

  const observed = workspace.status?.observedState
  return <article className="detail-card" aria-label="Virtual machine">
    <div className="card-heading">
      <h3>VM</h3>
      <StatusPill tone={observed === 'running' ? 'green' : observed ? 'amber' : 'gray'}>{observed ?? 'Unknown'}</StatusPill>
    </div>
    <p className="small-muted" role="status">{vmStatusLine(workspace)}</p>
    <form className="vm-form" onSubmit={run}>
      <label className="sr-only" htmlFor="vm-command">Command to run in the VM</label>
      <input id="vm-command" autoComplete="off" spellCheck={false} placeholder="ls -la   (runs in the VM)" value={input} onChange={event => setInput(event.target.value)} />
      <Button kind="primary" type="submit" disabled={running || !input.trim()}>{running ? 'Running…' : 'Run'}</Button>
      <Button type="button" disabled={shot.kind === 'loading'} onClick={() => { void takeScreenshot() }}>{shot.kind === 'loading' ? 'Capturing…' : 'Screenshot'}</Button>
    </form>
    {result.kind !== 'idle' && <div aria-label="Command output">
      <p className="small-muted"><code>$ {result.command}</code>
        {result.kind === 'running' && ` · running ${formatDuration(Math.max(0, now - result.startedAt))}`}
        {result.kind === 'done' && ` · ${result.state}${result.exitCode !== null ? `, exit ${result.exitCode}` : ''}`}
      </p>
      {result.kind === 'error' && <p role="alert" className="small-muted">{result.message}</p>}
      {result.kind === 'done' && <>
        {result.logsError && <p role="alert" className="small-muted">Output could not be read: {result.logsError}</p>}
        <pre className="vm-output">{result.output || (result.logsError ? '' : '(no output)')}</pre>
        {result.truncated && <p className="small-muted">Output was truncated by the backend.</p>}
        {result.state === 'running' && <Button onClick={() => { abortRef.current?.abort(); const controller = new AbortController(); abortRef.current = controller; void readLogs(result.command, result.commandId, result.state, result.exitCode, controller.signal) }}>Refresh output</Button>}
      </>}
    </div>}
    {shot.kind === 'error' && <p role="alert" className="small-muted">Screenshot unavailable: {shot.message}</p>}
    {shot.kind === 'ready' && <img className="vm-shot" alt="Screenshot of the VM desktop" src={`data:image/png;base64,${shot.base64}`} />}
  </article>
}

/** Readable project activity: preparation phases, plan and run progress. Unknown event types show their name. */
export function ActivityFeed({ events, status, error, onRefresh }: { events: readonly ActivityEvent[]; status: 'idle' | 'polling' | 'paused' | 'error'; error?: string; onRefresh: () => void }) {
  const lines = useMemo(() => events.filter(event => !isNoisyEvent(event)).slice(-FEED_LIMIT).reverse().map(event => ({ event, line: describeEvent(event) })), [events])
  return <article className="detail-card" aria-label="Live activity">
    <div className="card-heading">
      <h3>Live activity</h3>
      <StatusPill tone={status === 'polling' ? 'green' : status === 'error' ? 'amber' : 'gray'}>{status === 'polling' ? 'Live' : status === 'paused' ? 'Paused' : status === 'error' ? 'Error' : 'Idle'}</StatusPill>
    </div>
    <div className="activity-feed">{lines.length
      ? lines.map(({ event, line }) => <p className="activity-line" data-tone={line.tone} key={event.eventId}><strong>{line.title}</strong>{line.detail && <span>{line.detail}</span>}<small>Event {event.sequence}</small></p>)
      : <p className="small-muted">{status === 'error' ? 'Activity could not be loaded.' : 'No activity has been recorded yet.'}</p>}</div>
    {status === 'error' && error && <p role="alert" className="small-muted">{error}</p>}
    {status === 'paused' && <p className="small-muted">Automatic refresh stopped while nothing was happening. Refresh to check again.</p>}
    <Button onClick={onRefresh}>Refresh</Button>
  </article>
}

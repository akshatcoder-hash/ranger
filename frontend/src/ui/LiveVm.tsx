import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { rangerApi, type WorkspaceStatus } from '../api'
import type { ActivityEvent } from './activity'
import { formatBytes, formatDuration, formatSearchDuration, latestSearch, preparationIsActive, type PreparationClock, type PreparationStatus } from './liveHelpers'
import { Button, StatusPill } from './primitives'
import { watchVmScreen } from './vmScreen'
import { VmDesktop } from './VmDesktop'

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

/** Preparation state and measured search latency; no synthetic speed figures. */
export function PreparationCard({ repositoryUrl, preparation, events, clock, workspaceState }: { repositoryUrl: string | null; preparation: PreparationStatus | null; events: readonly ActivityEvent[]; clock: PreparationClock | null; workspaceState?: string }) {
  const active = preparationIsActive(preparation)
  const now = useNow(active)
  const search = useMemo(() => latestSearch(events), [events])
  const tone = preparation?.phase === 'ready' ? 'green' : preparation?.phase === 'failed' ? 'amber' : preparation ? 'violet' : 'gray'
  const tiles: { label: string; value: string }[] = []
  if (search) {
    tiles.push({ label: search.provider === 'trace' ? 'Trace search' : 'File search fallback', value: formatSearchDuration(search.durationMs) })
    tiles.push({ label: 'Retrieved results', value: search.resultCount.toLocaleString() })
  }
  if (preparation) {
    if (active && clock?.jobId === preparation.jobId) {
      tiles.push({ label: 'Elapsed', value: formatDuration(Math.max(0, now - clock.jobStartedAt)) })
      tiles.push({ label: 'This phase', value: formatDuration(Math.max(0, now - clock.phaseStartedAt)) })
    }
    if (preparation.fileCount !== undefined) tiles.push({ label: preparation.phase === 'ready' ? 'Indexed files' : 'Files', value: preparation.fileCount.toLocaleString() })
    if (preparation.indexElapsedMs !== undefined) tiles.push({ label: 'Index time', value: formatDuration(preparation.indexElapsedMs) })
    if (preparation.byteCount !== undefined) tiles.push({ label: 'Size', value: formatBytes(preparation.byteCount) })
    if (preparation.repositoryCommit) tiles.push({ label: 'Commit', value: preparation.repositoryCommit.slice(0, 10) })
  }
  const stepIndex = preparation ? STEPS.findIndex(step => step.phase === preparation.phase) : -1
  return <article className="detail-card" aria-label="Project preparation">
    <div className="card-heading">
      <h3>Project</h3>
      <StatusPill tone={tone}>{preparation ? PHASE_LABEL[preparation.phase] : workspaceState ? `Workspace ${workspaceState}` : 'Not started'}</StatusPill>
    </div>
    <p role="status">{repositoryUrl ? `Connected repository: ${repositoryUrl}` : 'No repository connected yet.'}</p>
    {active && <ol className="prep-steps" aria-label="Preparation progress">{STEPS.map((step, index) => <li key={step.phase} data-state={index < stepIndex ? 'done' : index === stepIndex ? 'current' : 'pending'}>{step.label}</li>)}</ol>}
    {tiles.length > 0 && <dl className="speed-grid" aria-label="Project metrics">{tiles.map(tile => <div className="speed-tile" key={tile.label}><dt>{tile.label}</dt><dd>{tile.value}</dd></div>)}</dl>}
    {search && <p className="small-muted">Latest server-side search, including retrieval and citation checks. Excludes the model’s response time.</p>}
    {!search && preparation?.phase === 'ready' && <p className="small-muted">Ask about the code to measure a search.</p>}
    {preparation?.phase === 'failed' && <p role="alert" className="small-muted">{preparation.message ?? preparation.errorCode ?? 'Preparation failed. No files were marked ready.'}</p>}
    {!preparation && !workspaceState && <p className="small-muted">{repositoryUrl ? 'Preparation starts when the repository is connected. Its VM and indexing progress will appear here; no call is required.' : 'Connect a repository to prepare its VM and code index automatically. No call is required.'}</p>}
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
export function VmPanel({ projectId, workspace, onStopped }: { projectId: string; workspace: { status: WorkspaceStatus | null; error?: string }; onStopped?: () => void }) {
  const [input, setInput] = useState('')
  const [result, setResult] = useState<CommandResult>({ kind: 'idle' })
  const [shot, setShot] = useState<Shot>({ kind: 'idle' })
  const [watching, setWatching] = useState(false)
  const [stopping, setStopping] = useState<'idle' | 'pending' | 'done'>('idle')
  const [stopError, setStopError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const shotAbortRef = useRef<AbortController | null>(null)
  const stopAbortRef = useRef<AbortController | null>(null)
  const observed = workspace.status?.observedState
  const available = observed === 'running' && stopping === 'idle'
  const running = result.kind === 'running'
  const now = useNow(running)
  useEffect(() => () => { abortRef.current?.abort(); shotAbortRef.current?.abort(); stopAbortRef.current?.abort() }, [])
  useEffect(() => {
    if (observed === 'destroyed') setStopping('idle')
    if (observed !== 'running') {
      setWatching(false)
      setShot({ kind: 'idle' })
      shotAbortRef.current?.abort()
    }
  }, [observed])
  useEffect(() => {
    if (!watching || !available) return
    const controller = new AbortController()
    shotAbortRef.current?.abort()
    shotAbortRef.current = controller
    watchVmScreen(projectId, controller.signal, frame => {
      setShot(frame.ok ? { kind: 'ready', base64: frame.data.contentBase64 } : { kind: 'error', message: frame.message })
      if (!frame.ok) setWatching(false)
    })
    return () => controller.abort()
  }, [watching, available, projectId])

  const stopVm = async () => {
    if (!available || !window.confirm('Stop this VM? Running commands will end and files only in the VM will be lost. Saved project history stays.')) return
    setWatching(false)
    abortRef.current?.abort()
    shotAbortRef.current?.abort()
    const controller = new AbortController()
    stopAbortRef.current = controller
    setStopping('pending')
    setStopError(null)
    const stopped = await rangerApi.stopWorkspace(projectId, controller.signal)
    if (controller.signal.aborted) return
    setStopping(stopped.ok ? 'done' : 'idle')
    if (!stopped.ok) { setStopError(stopped.message); return }
    setResult({ kind: 'idle' })
    setShot({ kind: 'idle' })
    onStopped?.()
  }

  const readLogs = async (command: string, commandId: string, state: string, exitCode: number | null, signal: AbortSignal) => {
    const logs = await rangerApi.getWorkspaceCommandLogs(projectId, commandId, signal)
    if (signal.aborted) return
    setResult({ kind: 'done', command, commandId, state, exitCode, output: logs.ok ? logs.data.logs : '', truncated: logs.ok && logs.data.truncated, ...(logs.ok ? {} : { logsError: logs.message }) })
  }

  const run = async (event: FormEvent) => {
    event.preventDefault()
    const command = input.trim()
    if (!command || running || !available) return
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

  return <article className="detail-card" aria-label="Virtual machine">
    <div className="card-heading">
      <h3>VM</h3>
      <StatusPill tone={available ? 'green' : observed ? 'amber' : 'gray'}>{stopping === 'done' ? 'destroyed' : observed ?? 'Unknown'}</StatusPill>
    </div>
    <p className="small-muted" role="status">{vmStatusLine(workspace)}</p>
    <div className="media-controls">
      <Button type="button" disabled={!available} onClick={() => { setShot({ kind: watching ? 'idle' : 'loading' }); setWatching(!watching) }}>{watching ? 'Hide VM screen' : 'Show VM screen'}</Button>
      <Button type="button" disabled={!available} onClick={() => { void stopVm() }}>{stopping === 'pending' ? 'Stopping VM…' : 'Stop VM'}</Button>
    </div>
    {stopError && <p role="alert" className="small-muted">Could not stop VM: {stopError}</p>}
    {stopping === 'done' && <p role="status" className="small-muted">VM stopped.</p>}
    {watching && available && <p className="small-muted" role="status">VM screen refreshes every 3 seconds after each capture and pauses in background tabs. Choose Control VM to use its mouse and keyboard. Background commands appear in Live activity.</p>}
    {watching && shot.kind === 'loading' && <p role="status" className="small-muted">Opening the VM desktop. Its first start may take a moment…</p>}
    <form className="vm-form" onSubmit={run}>
      <label className="sr-only" htmlFor="vm-command">Command to run in the VM</label>
      <input id="vm-command" autoComplete="off" spellCheck={false} placeholder="ls -la   (runs in the VM)" value={input} onChange={event => setInput(event.target.value)} />
      <Button kind="primary" type="submit" disabled={!available || running || !input.trim()}>{running ? 'Running…' : 'Run'}</Button>
      <Button type="button" disabled={!available || watching || shot.kind === 'loading'} onClick={() => { void takeScreenshot() }}>{shot.kind === 'loading' ? 'Capturing…' : 'Screenshot'}</Button>
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
    {shot.kind === 'ready' && <VmDesktop projectId={projectId} base64={shot.base64} interactive={watching && available} />}
  </article>
}

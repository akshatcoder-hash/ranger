import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react'
import { rangerApi, type WorkspaceStatus } from '../api'
import { ScreenChannel, VoiceChannel, browserMediaDeps, providerGate, type ScreenStatus, type VoiceStatus } from '../media'
import { MediaLifecycle, OperationEpoch } from './lifecycle'
import { DEMO_PROJECT_ID, applyEventPage, executionBlockers, isLiveProjectId, latestPreparation, normalizeCredential, parseLines, planCreateOutcome, projectViewEngineerName, validateRepositoryInput, type Capabilities, type PreparationStatus } from './liveHelpers'

type Screen = 'home' | 'start' | 'workspace' | 'review'
type Mode = 'live' | 'demo'
type WorkspaceTab = 'workspace' | 'changes' | 'checks'
type Notice = { kind: 'error' | 'info' | 'success'; text: string }
type Modal = 'name' | 'plan' | 'manual' | 'repo'
type OkData<T> = T extends { ok: true; data: infer D } ? D : never
type Failure = Extract<Awaited<ReturnType<typeof rangerApi.getSession>>, { ok: false }>
type LiveProject = OkData<Awaited<ReturnType<typeof rangerApi.loadProject>>>
type LivePlan = NonNullable<LiveProject['plan']>
type ProjectEvent = OkData<Awaited<ReturnType<typeof rangerApi.getEvents>>>['events'][number]
type Auth = { state: 'checking' } | { state: 'signed-out'; message?: string } | { state: 'connected'; principalId: string }
type CapabilityState = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; value: Capabilities } | { state: 'error'; message: string }
type ProjectLoad = { state: 'idle' } | { state: 'loading'; projectId: string } | { state: 'ready'; projectId: string } | { state: 'error'; projectId: string; message: string }
type EventFeed = { projectId: string | null; events: ProjectEvent[]; preparation: PreparationStatus | null; status: 'idle' | 'polling' | 'paused' | 'error'; error?: string }
type WorkspaceView = { projectId: string | null; status: WorkspaceStatus | null; error?: string }
type LiveMedia = {
  voice: VoiceStatus
  screen: ScreenStatus
  voiceBlocked: string | null
  screenBlocked: string | null
  inspectBlocked: string | null
  onStartVoice: () => void
  onStopVoice: () => void
  onInterrupt: () => void
  onStartScreen: () => void
  onStopScreen: () => void
  onInspect: () => void
  onRetryVoiceCleanup: () => void
  onRetryScreenCleanup: () => void
}
type LiveStatus = { kind: 'ok' } | { kind: 'checking' } | { kind: 'needs-session' } | { kind: 'no-project' } | { kind: 'invalid' } | { kind: 'loading' } | { kind: 'error'; message: string }

const EVENT_POLL_MS = 5000
const EVENT_MAX_POLLS = 24
const EVENT_MAX_PAGES = 5
const fieldStyle: CSSProperties = { width: '100%', padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 7, resize: 'vertical' }

function readLocation() {
  const path = window.location.pathname.split('/').filter(Boolean)
  const screen: Screen = path[0] === 'start' ? 'start' : path[0] === 'workspace' ? 'workspace' : path[0] === 'review' ? 'review' : 'home'
  const mode = new URLSearchParams(window.location.search).get('mode') === 'demo' ? 'demo' as const : 'live' as const
  return { screen, projectId: path[1] || (mode === 'demo' ? DEMO_PROJECT_ID : null), mode }
}

function Brand({ small = false }: { small?: boolean }) {
  return <span className={`brand ${small ? 'brand-small' : ''}`} aria-label="Ranger"><img className="brand-mark" src="/assets/ranger-mark.svg" alt="" /><span>ranger</span></span>
}

function Button({ children, kind = 'secondary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'secondary' | 'quiet' }) {
  return <button className={`button button-${kind} ${className}`} {...props}>{children}</button>
}

function StatusPill({ children, tone = 'green' }: { children: React.ReactNode; tone?: 'green' | 'violet' | 'gray' | 'amber' }) {
  return <span className={`status-pill status-${tone}`}><span className="status-dot" />{children}</span>
}

export function App() {
  const [location, setLocation] = useState(readLocation)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [engineer, setEngineer] = useState('Ranger')
  const [modal, setModal] = useState<Modal | null>(null)
  const [modalError, setModalError] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState(engineer)
  const [repoDraft, setRepoDraft] = useState({ url: '', ref: 'main' })
  const [planDraft, setPlanDraft] = useState({ items: '', criteria: '' })
  const [pendingRepo, setPendingRepo] = useState<{ url: string; ref: string } | null>(null)
  const [repoConnected, setRepoConnected] = useState(false)
  const [contextFiles, setContextFiles] = useState<string[]>([])
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('workspace')
  const [approved, setApproved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [message, setMessage] = useState('')
  const [messages, setMessages] = useState<string[]>([])
  const [mediaState, setMediaState] = useState<'idle' | 'requesting' | 'active'>('idle')
  const [auth, setAuth] = useState<Auth>({ state: 'checking' })
  const [capabilities, setCapabilities] = useState<CapabilityState>({ state: 'idle' })
  const [project, setProject] = useState<LiveProject | null>(null)
  const [projectLoad, setProjectLoad] = useState<ProjectLoad>({ state: 'idle' })
  const [reloadKey, setReloadKey] = useState(0)
  const [eventsKey, setEventsKey] = useState(0)
  const [eventFeed, setEventFeed] = useState<EventFeed>({ projectId: null, events: [], preparation: null, status: 'idle' })
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>({ projectId: null, status: null })
  const [mediaLifecycle] = useState(() => new MediaLifecycle(() => {}))
  const authLostRef = useRef<() => void>(() => {})
  const [voice] = useState(() => new VoiceChannel(browserMediaDeps(), { onAuthLost: () => authLostRef.current() }))
  const [screen] = useState(() => new ScreenChannel(browserMediaDeps(), { onAuthLost: () => authLostRef.current() }))
  const [voiceStatus, setVoiceStatus] = useState(voice.status)
  const [screenStatus, setScreenStatus] = useState(screen.status)
  const requestRef = useRef<AbortController | null>(null)
  const operationEpochRef = useRef(new OperationEpoch())
  const projectRef = useRef<LiveProject | null>(null)
  const lastProjectIdRef = useRef<string | null>(null)
  const previousModeRef = useRef(location.mode)
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const demo = location.mode === 'demo'
  const routeProjectId = location.projectId
  const principalId = auth.state === 'connected' ? auth.principalId : null
  const needsProject = !demo && principalId !== null && (location.screen === 'workspace' || location.screen === 'review') && isLiveProjectId(routeProjectId)
  const activeProject = !demo && project && project.projectId === routeProjectId ? project : null
  const liveStatus: LiveStatus = demo ? { kind: 'ok' }
    : auth.state === 'checking' ? { kind: 'checking' }
    : auth.state === 'signed-out' ? { kind: 'needs-session' }
    : !routeProjectId ? { kind: 'no-project' }
    : !isLiveProjectId(routeProjectId) ? { kind: 'invalid' }
    : activeProject ? { kind: 'ok' }
    : projectLoad.state === 'error' && projectLoad.projectId === routeProjectId ? { kind: 'error', message: projectLoad.message }
    : { kind: 'loading' }
  const capabilityValue = capabilities.state === 'ready' ? capabilities.value : null

  const applyProject = useCallback((next: LiveProject | null) => {
    projectRef.current = next
    if (next) lastProjectIdRef.current = next.projectId
    setProject(next)
  }, [])

  const patchProject = useCallback((projectId: string, patch: Partial<LiveProject>) => {
    const current = projectRef.current
    if (current && current.projectId === projectId) applyProject({ ...current, ...patch })
  }, [applyProject])

  const refreshLive = useCallback(() => { setReloadKey(key => key + 1); setEventsKey(key => key + 1) }, [])

  const invalidateRequest = useCallback(() => {
    operationEpochRef.current.invalidate()
    requestRef.current?.abort()
    requestRef.current = null
    setBusy(false)
  }, [])

  const clearMedia = useCallback(() => {
    mediaLifecycle.release()
    voice.stop()
    screen.stop()
    setMediaState('idle')
  }, [mediaLifecycle, screen, voice])

  const navigate = useCallback((screen: Screen, mode: Mode = location.mode, projectId: string | null = mode === location.mode ? location.projectId : null, replace = false) => {
    invalidateRequest()
    clearMedia()
    const id = projectId ?? (mode === 'demo' ? DEMO_PROJECT_ID : null)
    const path = screen === 'home' ? '/' : screen === 'start' ? '/start' : id ? `/${screen}/${encodeURIComponent(id)}` : `/${screen}`
    const query = mode === 'demo' ? '?mode=demo' : ''
    window.history[replace ? 'replaceState' : 'pushState']({}, '', `${path}${query}`)
    setLocation(readLocation())
    setNotice(null)
    setModal(null)
    if (screen === 'workspace') setWorkspaceTab('workspace')
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  }, [clearMedia, invalidateRequest, location.mode, location.projectId])

  useEffect(() => {
    const onPop = () => {
      invalidateRequest()
      clearMedia()
      setLocation(readLocation())
      setNotice(null)
      setModal(null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [clearMedia, invalidateRequest])

  useEffect(() => {
    if (previousModeRef.current === location.mode) return
    previousModeRef.current = location.mode
    invalidateRequest()
    clearMedia()
    lastProjectIdRef.current = null
    setEngineer('Ranger'); setRepoConnected(false); setPendingRepo(null); setContextFiles([]); setApproved(false); setMessages([]); setMediaState('idle'); setBusy(false); setModal(null)
  }, [clearMedia, invalidateRequest, location.mode])

  useEffect(() => {
    if (demo) return
    const controller = new AbortController()
    let current = true
    setAuth({ state: 'checking' })
    void rangerApi.getSession(controller.signal).then(result => {
      if (!current) return
      setAuth(result.ok ? { state: 'connected', principalId: result.data.principalId } : { state: 'signed-out', message: result.reason === 'unauthorized' ? undefined : result.message })
    })
    return () => { current = false; controller.abort() }
  }, [demo])

  useEffect(() => {
    if (!principalId) { setCapabilities({ state: 'idle' }); return }
    const controller = new AbortController()
    let current = true
    setCapabilities({ state: 'loading' })
    void rangerApi.getCapabilities(controller.signal).then(result => {
      if (!current) return
      setCapabilities(result.ok ? { state: 'ready', value: result.data } : { state: 'error', message: result.message })
    })
    return () => { current = false; controller.abort() }
  }, [principalId])

  const loadProjectId = needsProject ? routeProjectId : null
  useEffect(() => {
    if (!loadProjectId) {
      applyProject(null)
      setProjectLoad({ state: 'idle' })
      return
    }
    const controller = new AbortController()
    let current = true
    setProjectLoad(state => (state.state === 'ready' && state.projectId === loadProjectId ? state : { state: 'loading', projectId: loadProjectId }))
    void rangerApi.loadProject(loadProjectId, controller.signal).then(result => {
      if (!current) return
      if (result.ok) {
        applyProject(result.data)
        setProjectLoad({ state: 'ready', projectId: loadProjectId })
        return
      }
      if (result.reason === 'unauthorized') { setAuth({ state: 'signed-out', message: 'Your session has ended. Connect again to continue.' }); return }
      setProjectLoad({ state: 'error', projectId: loadProjectId, message: result.message })
      if (projectRef.current?.projectId === loadProjectId) setNotice({ kind: 'error', text: `Could not refresh the project: ${result.message}` })
    })
    return () => { current = false; controller.abort() }
  }, [applyProject, loadProjectId, principalId, reloadKey])

  const eventProjectId = activeProject?.projectId ?? null
  useEffect(() => {
    if (!eventProjectId) { setEventFeed({ projectId: null, events: [], preparation: null, status: 'idle' }); return }
    const controller = new AbortController()
    let current = true
    let events: ProjectEvent[] = []
    let preparation: PreparationStatus | null = null
    let cursor: string | undefined
    let polls = 0
    let timer: number | undefined
    setEventFeed({ projectId: eventProjectId, events: [], preparation: null, status: 'polling' })

    const remember = (next: ProjectEvent[]) => {
      const seen = latestPreparation(next)
      if (seen) preparation = seen
    }
    const publish = (status: EventFeed['status'], error?: string) => {
      setEventFeed({ projectId: eventProjectId, events, preparation, status, ...(error ? { error } : {}) })
    }
    const pull = async () => {
      for (let page = 0; page < EVENT_MAX_PAGES; page += 1) {
        const result = await rangerApi.getEvents(eventProjectId, controller.signal, cursor)
        if (!current) return false
        if (!result.ok) {
          if (result.reason === 'unauthorized') setAuth({ state: 'signed-out', message: 'Your session has ended. Connect again to continue.' })
          else publish('error', result.message)
          return false
        }
        const step = applyEventPage({ events, cursor }, result.data)
        const added = step.state.events !== events
        events = step.state.events
        cursor = step.state.cursor
        remember(events)
        if (added || preparation) publish('polling')
        if (step.error) { publish('error', step.error); return false }
        if (!step.fetchMore) break
      }
      return true
    }
    const loop = async () => {
      const ok = await pull()
      if (!current || !ok) return
      polls += 1
      if (polls >= EVENT_MAX_POLLS) { setEventFeed(feed => ({ ...feed, status: 'paused' })); return }
      setEventFeed(feed => (feed.status === 'polling' && !feed.error ? feed : { ...feed, status: 'polling', error: undefined }))
      timer = window.setTimeout(() => { void loop() }, EVENT_POLL_MS)
    }
    void loop()
    return () => { current = false; controller.abort(); window.clearTimeout(timer) }
  }, [eventProjectId, eventsKey])

  const workspaceProjectId = activeProject?.projectId ?? null
  useEffect(() => {
    if (!workspaceProjectId) { setWorkspaceView({ projectId: null, status: null }); return }
    const controller = new AbortController()
    let current = true
    setWorkspaceView(view => (view.projectId === workspaceProjectId ? view : { projectId: workspaceProjectId, status: null }))
    void rangerApi.getWorkspaceStatus(workspaceProjectId, controller.signal).then(result => {
      if (!current) return
      if (result.ok) setWorkspaceView({ projectId: workspaceProjectId, status: result.data })
      else if (result.reason === 'unauthorized') setAuth({ state: 'signed-out', message: 'Your session has ended. Connect again to continue.' })
      else setWorkspaceView({ projectId: workspaceProjectId, status: null, error: result.message })
    })
    return () => { current = false; controller.abort() }
  }, [workspaceProjectId, eventsKey])

  useEffect(() => {
    if (!modal) return
    const previous = document.activeElement as HTMLElement | null
    const onKey = (event: KeyboardEvent | globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setModal(null)
      if (event.key === 'Tab' && dialogRef.current) {
        const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href]'))
        if (!focusables.length) return
        const first = focusables[0], last = focusables[focusables.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    requestAnimationFrame(() => (modal === 'name' ? nameInputRef.current : dialogRef.current?.querySelector<HTMLElement>('input, textarea, button'))?.focus())
    return () => { document.removeEventListener('keydown', onKey); previous?.focus() }
  }, [modal])

  useEffect(() => () => {
    mediaLifecycle.release()
    requestRef.current?.abort()
  }, [mediaLifecycle])

  useEffect(() => {
    authLostRef.current = () => setAuth({ state: 'signed-out', message: 'Your session has ended. Connect again to continue.' })
  }, [])

  useEffect(() => {
    setVoiceStatus(voice.status)
    return voice.subscribe(() => setVoiceStatus(voice.status))
  }, [voice])

  useEffect(() => {
    setScreenStatus(screen.status)
    return screen.subscribe(() => setScreenStatus(screen.status))
  }, [screen])

  useEffect(() => {
    if (auth.state === 'connected') return
    voice.stop('Your session is not connected, so the call was stopped.')
    screen.stop('Your session is not connected, so screen sharing was stopped.')
  }, [auth.state, screen, voice])

  const mediaProjectId = activeProject?.projectId ?? null
  const mediaConversationId = activeProject?.conversationId ?? null
  useEffect(() => () => {
    voice.stop()
    screen.stop()
  }, [mediaProjectId, mediaConversationId, screen, voice])

  const openModal = (next: Modal) => { setModalError(null); setModal(next) }
  const openRename = () => { setNameDraft(location.screen === 'start' || demo ? engineer : viewEngineer); openModal('name') }

  const beginRequest = () => {
    if (busy || (requestRef.current && !requestRef.current.signal.aborted)) return null
    const controller = new AbortController(); requestRef.current = controller
    const operation = operationEpochRef.current.begin()
    setBusy(true)
    return { controller, operation }
  }
  const finishRequest = (operation: number) => {
    if (!operationEpochRef.current.isCurrent(operation)) return false
    requestRef.current = null
    setBusy(false)
    return true
  }
  const reportFailure = (result: Failure, inModal = false) => {
    if (result.reason === 'aborted') return
    if (result.reason === 'unauthorized') {
      invalidateRequest(); setModal(null)
      setAuth({ state: 'signed-out', message: 'Your session has ended. Connect again to continue.' })
      return
    }
    if (result.reason === 'partial') refreshLive()
    if (inModal) setModalError(result.message)
    else setNotice({ kind: 'error', text: result.message })
  }

  const connectSession = async (credential: string) => {
    const request = beginRequest()
    if (!request) return
    setNotice(null)
    const result = await rangerApi.connectSession(credential, request.controller.signal)
    if (!finishRequest(request.operation)) return
    if (result.ok) { setAuth({ state: 'connected', principalId: result.data.principalId }); setNotice({ kind: 'success', text: 'Session connected.' }) }
    else if (result.reason !== 'aborted') setAuth({ state: 'signed-out', message: result.message })
  }

  const saveRename = async (event: FormEvent) => {
    event.preventDefault()
    const clean = nameDraft.trim().slice(0, 32)
    if (!clean) { setModal(null); return }
    if (demo || location.screen === 'start') { setEngineer(clean); setModal(null); return }
    if (!activeProject) { setModal(null); return }
    const request = beginRequest()
    if (!request) return
    setModalError(null)
    const result = await rangerApi.renameEngineer(activeProject.projectId, clean, request.controller.signal)
    if (!finishRequest(request.operation)) return
    if (!result.ok) { reportFailure(result, true); return }
    patchProject(activeProject.projectId, { engineerName: clean }); setModal(null)
    setReloadKey(key => key + 1)
  }

  const createProject = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || (requestRef.current && !requestRef.current.signal.aborted) || !prompt.trim()) return
    if (demo) {
      requestRef.current?.abort()
      const controller = new AbortController(); requestRef.current = controller
      const operation = operationEpochRef.current.begin()
      setBusy(true)
      await new Promise<void>(resolve => {
        const timeout = window.setTimeout(resolve, 260)
        controller.signal.addEventListener('abort', () => { window.clearTimeout(timeout); resolve() }, { once: true })
      })
      if (!operationEpochRef.current.isCurrent(operation) || controller.signal.aborted) return
      requestRef.current = null
      setBusy(false); navigate('workspace', 'demo'); return
    }
    if (!principalId) { setNotice({ kind: 'error', text: 'Connect a session before creating a project.' }); return }
    const request = beginRequest()
    if (!request) return
    setNotice(null)
    const created = await rangerApi.createProject({ prompt: prompt.trim(), engineerName: engineer }, request.controller.signal)
    if (!operationEpochRef.current.isCurrent(request.operation)) return
    const outcome = planCreateOutcome(created)
    if (!created.ok) {
      finishRequest(request.operation)
      if (outcome.kind === 'recovered') {
        lastProjectIdRef.current = outcome.projectId
        setPrompt(''); setPendingRepo(null)
        navigate('workspace', 'live', outcome.projectId)
        if (outcome.reason === 'unauthorized') reportFailure(created)
        else setNotice({ kind: 'error', text: outcome.message })
      } else reportFailure(created)
      return
    }
    if (outcome.kind !== 'created') return
    const { projectId } = outcome
    let repositoryProblem: string | null = null
    if (pendingRepo) {
      const connected = await rangerApi.connectRepository(projectId, pendingRepo.url, pendingRepo.ref, request.controller.signal)
      if (!operationEpochRef.current.isCurrent(request.operation)) return
      if (!connected.ok) {
        if (connected.reason === 'unauthorized') { finishRequest(request.operation); reportFailure(connected); return }
        repositoryProblem = connected.message
      }
    }
    finishRequest(request.operation)
    lastProjectIdRef.current = projectId
    setPrompt(''); setPendingRepo(null)
    navigate('workspace', 'live', projectId)
    if (repositoryProblem) setNotice({ kind: 'error', text: `Project created, but the repository was not connected: ${repositoryProblem}` })
  }

  const openRepo = () => {
    if (demo) { setRepoConnected(true); setNotice({ kind: 'info', text: 'Sample repository connected for this walkthrough.' }); return }
    setRepoDraft(draft => ({ url: activeProject?.repositoryUrl ?? pendingRepo?.url ?? draft.url, ref: pendingRepo?.ref ?? draft.ref }))
    openModal('repo')
  }

  const submitRepo = async (event: FormEvent) => {
    event.preventDefault()
    const url = repoDraft.url.trim(), ref = repoDraft.ref.trim()
    const problem = validateRepositoryInput(url, ref)
    if (problem) { setModalError(problem); return }
    if (!activeProject) { setPendingRepo({ url, ref }); setModal(null); return }
    const request = beginRequest()
    if (!request) return
    setModalError(null)
    const result = await rangerApi.connectRepository(activeProject.projectId, url, ref, request.controller.signal)
    if (!finishRequest(request.operation)) return
    if (!result.ok) { reportFailure(result, true); return }
    setModal(null); setNotice({ kind: 'success', text: 'Repository connected.' }); refreshLive()
  }

  const selectContextFiles = (files: FileList | null) => {
    const names = files ? Array.from(files, file => file.name) : []
    setContextFiles(names)
    if (names.length) setNotice({ kind: 'info', text: demo ? 'Files are selected locally for this walkthrough; they are not uploaded.' : 'Files are selected locally in this browser only. They are not uploaded and Ranger cannot read them.' })
  }

  const submitManualPlan = async (event: FormEvent) => {
    event.preventDefault()
    if (!activeProject || !activeProject.conversationId) return
    const items = parseLines(planDraft.items), acceptanceCriteria = parseLines(planDraft.criteria)
    if (!items.length || !acceptanceCriteria.length) { setModalError('Add at least one step and one acceptance criterion, one per line.'); return }
    const request = beginRequest()
    if (!request) return
    setModalError(null)
    const { projectId, conversationId } = activeProject
    const result = await rangerApi.createManualPlan({ projectId, conversationId, items, acceptanceCriteria }, request.controller.signal)
    if (!finishRequest(request.operation)) return
    if (!result.ok) { reportFailure(result, true); return }
    patchProject(projectId, { plan: result.data, approved: false })
    setPlanDraft({ items: '', criteria: '' }); setModal(null)
    setNotice({ kind: 'success', text: `Manual plan version ${result.data.version} saved. It is not approved yet.` }); refreshLive()
  }

  const decidePlan = async (accept: boolean) => {
    if (busy || (requestRef.current && !requestRef.current.signal.aborted)) return
    if (demo) { setApproved(accept); setModal(null); setNotice({ kind: 'success', text: accept ? 'Sample plan approved for this walkthrough.' : 'Plan sent back for changes.' }); return }
    if (!activeProject || !activeProject.conversationId || !activeProject.plan || !accept) return
    const request = beginRequest()
    if (!request) return
    setModalError(null)
    const { projectId, conversationId, plan } = activeProject
    const result = await rangerApi.decidePlan({ projectId, conversationId, approved: true, planId: plan.planId, permittedScope: plan.permittedScope }, request.controller.signal)
    if (!finishRequest(request.operation)) return
    if (!result.ok) { reportFailure(result, true); return }
    setModal(null)
    if (result.data.accepted) setNotice({ kind: 'success', text: 'Plan approved. No work has been started.' })
    else setNotice({ kind: 'error', text: 'The backend did not accept this approval.' })
    refreshLive()
  }

  const startMedia = (kind: 'voice' | 'screen') => {
    if (!demo || busy || mediaLifecycle.phase !== 'idle') return
    setMediaState('active'); setNotice({ kind: 'info', text: `Sample ${kind === 'voice' ? 'call' : 'screen share'} shown. No media is being recorded.` })
  }

  const stopMedia = () => {
    clearMedia(); setNotice({ kind: 'info', text: 'Media stopped.' })
  }

  const mediaTarget = !demo && principalId !== null && activeProject?.conversationId
    ? { projectId: activeProject.projectId, conversationId: activeProject.conversationId }
    : null
  const mediaUnavailable = mediaTarget === null ? 'Open a project with a conversation to use media.' : null
  const providerBlocked = providerGate(capabilities.state, capabilityValue)
  const voiceBlocked = mediaUnavailable ?? providerBlocked
  const screenBlocked = mediaUnavailable
  const inspectBlocked = mediaUnavailable ?? providerBlocked ?? (screenStatus.framesSent === 0 ? 'Waiting for the first frame to reach Ranger.' : null)
  const liveMedia: LiveMedia = {
    voice: voiceStatus,
    screen: screenStatus,
    voiceBlocked,
    screenBlocked,
    inspectBlocked,
    onStartVoice: () => { if (mediaTarget && !voiceBlocked) { setNotice(null); void voice.start(mediaTarget) } },
    onStopVoice: () => voice.stop(),
    onInterrupt: () => { void voice.interrupt() },
    onStartScreen: () => { if (mediaTarget && !screenBlocked) { setNotice(null); void screen.start(mediaTarget) } },
    onStopScreen: () => screen.stop(),
    onInspect: () => { if (!inspectBlocked) void screen.inspect() },
    onRetryVoiceCleanup: () => { void voice.retryCleanup() },
    onRetryScreenCleanup: () => { void screen.retryCleanup() },
  }

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault()
    const clean = message.trim()
    if (!clean || busy) return
    if (demo) { setMessages(items => [...items, clean]); setMessage(''); return }
    if (!activeProject || !activeProject.conversationId) return
    const request = beginRequest()
    if (!request) return
    const { projectId, conversationId } = activeProject
    const result = await rangerApi.sendMessage(projectId, conversationId, clean, request.controller.signal)
    if (!finishRequest(request.operation)) return
    if (!result.ok) { reportFailure(result); return }
    setMessage('')
    patchProject(projectId, { messages: [...(projectRef.current?.messages ?? []), clean] })
    refreshLive()
  }

  const cancelRequest = () => {
    invalidateRequest()
    setBusy(false); setNotice({ kind: 'info', text: 'Request cancelled.' })
  }

  const openLiveWorkspace = () => {
    const id = lastProjectIdRef.current
    if (id) navigate('workspace', 'live', id)
    else navigate('start', 'live')
  }

  const viewEngineer = projectViewEngineerName(demo, engineer, activeProject?.engineerName)
  const projectName = demo ? 'Order support' : activeProject?.name ?? 'Project'
  const shownMessages = demo ? messages : activeProject?.messages ?? []
  const planApproved = demo ? approved : activeProject?.approved ?? false

  return <div className="app-shell">
    {location.screen === 'home' && <Landing demo={demo} onStart={() => navigate('start')} onDemo={() => navigate('start', 'demo')} onWorkspace={() => demo ? navigate('workspace', 'demo') : openLiveWorkspace()} />}
    {location.screen === 'start' && <Composer demo={demo} engineer={engineer} repoLabel={demo ? 'northstar / support-inbox' : pendingRepo?.url ?? null} repoState={demo ? 'Sample' : 'Selected'} repoConnected={demo ? repoConnected : pendingRepo !== null} contextFiles={contextFiles} prompt={prompt} busy={busy} signedIn={demo || principalId !== null} auth={auth} capabilities={capabilities} setPrompt={setPrompt} onContextFiles={selectContextFiles} onConnectRepo={openRepo} onConnect={connectSession} onRename={openRename} onStartCall={() => navigate('workspace', 'demo')} onSubmit={createProject} onCancel={cancelRequest} onHome={() => navigate('home')} onToggleMode={() => navigate('start', demo ? 'live' : 'demo')} />}
    {location.screen === 'workspace' && <Workspace demo={demo} engineer={viewEngineer} projectName={projectName} project={activeProject} status={liveStatus} auth={auth} capabilities={capabilities} eventFeed={eventFeed} workspaceView={workspaceView} tab={workspaceTab} setTab={setWorkspaceTab} approved={planApproved} mediaState={mediaState} messages={shownMessages} message={message} busy={busy} setMessage={setMessage} onSend={sendMessage} onReviewPlan={() => openModal('plan')} onConnectRepo={openRepo} onConnect={connectSession} onRetry={() => setReloadKey(key => key + 1)} onRefreshEvents={() => setEventsKey(key => key + 1)} onStartProject={() => navigate('start', 'live')} onReview={() => navigate('review')} onHome={() => navigate('home')} onRename={openRename} onStartVoice={() => startMedia('voice')} onStartScreen={() => startMedia('screen')} onStopMedia={stopMedia} live={activeProject ? liveMedia : null} />}
    {location.screen === 'review' && <Review demo={demo} engineer={viewEngineer} projectName={projectName} status={liveStatus} auth={auth} busy={busy} approved={planApproved} notice={notice} onConnect={connectSession} onRetry={() => setReloadKey(key => key + 1)} onStartProject={() => navigate('start', 'live')} onWorkspace={() => navigate('workspace')} onHome={() => navigate('home')} onRename={openRename} onReviewPlan={() => openModal('plan')} />}
    {notice && <div className={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.text}</span><button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}
    {modal && <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) setModal(null) }}><div ref={dialogRef} className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      {modal === 'name' ? <form onSubmit={saveRename}><p className="eyebrow">YOUR ENGINEER</p><h2 id="modal-title">Give your engineer a name</h2><label className="field-label" htmlFor="engineer-name">Name</label><input ref={nameInputRef} id="engineer-name" autoComplete="off" maxLength={32} value={nameDraft} onChange={event => setNameDraft(event.target.value)} />{modalError && <p role="alert">{modalError}</p>}<div className="modal-actions"><Button type="button" onClick={() => setModal(null)}>Cancel</Button><Button kind="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save name'}</Button></div></form>
        : modal === 'repo' ? <form onSubmit={submitRepo}><p className="eyebrow">REPOSITORY</p><h2 id="modal-title">Connect a repository</h2><p>{activeProject ? 'Ranger records this reference for the project. Files are not loaded until the engineer prepares the workspace.' : 'The reference is recorded right after the project is created. It does not load files by itself.'}</p><label className="field-label" htmlFor="repo-url">Repository URL or local checkout path</label><input id="repo-url" type="text" autoComplete="off" spellCheck={false} placeholder="https://… or /absolute/path/on/the/Ranger/server" value={repoDraft.url} onChange={event => setRepoDraft(draft => ({ ...draft, url: event.target.value }))} /><p className="small-muted">An absolute path or file:// URL is a checkout on the Ranger server and must already be operator-approved. An https URL is only a reference; it does not clone or load files.</p><label className="field-label" htmlFor="repo-ref">Branch, tag or commit</label><input id="repo-ref" autoComplete="off" value={repoDraft.ref} onChange={event => setRepoDraft(draft => ({ ...draft, ref: event.target.value }))} />{modalError && <p role="alert">{modalError}</p>}<div className="modal-actions"><Button type="button" onClick={() => setModal(null)}>Cancel</Button><Button kind="primary" type="submit" disabled={busy}>{busy ? 'Connecting…' : activeProject ? 'Connect repository' : 'Use repository'}</Button></div></form>
        : modal === 'manual' ? <form onSubmit={submitManualPlan}><p className="eyebrow">MANUAL PLAN</p><h2 id="modal-title">Write a plan by hand</h2><p>This is a plan you write as the operator. It is not generated by Ranger or a model, and it is saved as a new version that still needs your approval.</p><label className="field-label" htmlFor="manual-items">Steps, one per line</label><textarea id="manual-items" rows={5} style={fieldStyle} value={planDraft.items} onChange={event => setPlanDraft(draft => ({ ...draft, items: event.target.value }))} /><label className="field-label" htmlFor="manual-criteria">Acceptance criteria, one per line</label><textarea id="manual-criteria" rows={4} style={fieldStyle} value={planDraft.criteria} onChange={event => setPlanDraft(draft => ({ ...draft, criteria: event.target.value }))} />{modalError && <p role="alert">{modalError}</p>}<div className="modal-actions"><Button type="button" onClick={() => setModal(null)}>Cancel</Button><Button kind="primary" type="submit" disabled={busy || !activeProject?.conversationId}>{busy ? 'Saving…' : 'Save manual plan'}</Button></div></form>
        : demo ? <><p className="eyebrow">PLAN REVIEW</p><h2 id="modal-title">Before Ranger starts</h2><p className="muted">Review what will change. You can still talk through the plan before approving it.</p><ul className="plan-list"><li>Find the order behind each ticket</li><li>Apply the current return policy</li><li>Draft the customer reply</li><li>Ask before issuing a refund</li></ul><div className="modal-actions"><Button disabled={busy} onClick={() => decidePlan(false)}>Request changes</Button><Button kind="primary" disabled={busy} onClick={() => decidePlan(true)}>{busy ? 'Saving…' : 'Approve plan'}</Button></div></>
        : <LivePlanDialog plan={activeProject?.plan ?? null} approved={activeProject?.approved ?? false} busy={busy} modalError={modalError} blockers={executionBlockers(capabilityValue)} onClose={() => setModal(null)} onApprove={() => decidePlan(true)} onWriteNew={() => openModal('manual')} />}
    </div></div>}
  </div>
}

function LivePlanDialog({ plan, approved, busy, modalError, blockers, onClose, onApprove, onWriteNew }: { plan: LivePlan | null; approved: boolean; busy: boolean; modalError: string | null; blockers: string[]; onClose: () => void; onApprove: () => void; onWriteNew: () => void }) {
  if (!plan) return <><p className="eyebrow">PLAN REVIEW</p><h2 id="modal-title">No plan yet</h2><p className="muted">Nothing has been planned for this project. Ranger does not write plans in this view; you can write one by hand.</p><div className="modal-actions"><Button onClick={onClose}>Close</Button><Button kind="primary" onClick={onWriteNew}>Write manual plan</Button></div></>
  return <><p className="eyebrow">PLAN REVIEW · VERSION {plan.version}</p><h2 id="modal-title">{approved ? 'Approved plan' : 'Review this plan'}</h2><p className="muted">Approving binds exactly this version and the scope below. It does not start any work.</p>
    <div style={{ maxHeight: '42vh', overflowY: 'auto' }}>
      <p className="field-label">Steps</p><ul className="plan-list">{plan.items.map((item, i) => <li key={`${item}-${i}`}>{item}</li>)}</ul>
      <p className="field-label">Acceptance criteria</p><ul className="plan-list">{plan.acceptanceCriteria.length ? plan.acceptanceCriteria.map((item, i) => <li key={`${item}-${i}`}>{item}</li>) : <li>None recorded.</li>}</ul>
      <p className="field-label">Permitted scope</p><ul className="plan-list">{plan.permittedScope.length ? plan.permittedScope.map((item, i) => <li key={`${item}-${i}`}><code>{item}</code></li>) : <li>No scope is permitted by this plan.</li>}</ul>
    </div>
    {blockers.length > 0 && <p className="muted" role="status">Execution is blocked: {blockers.join(' ')}</p>}
    {modalError && <p role="alert">{modalError}</p>}
    <div className="modal-actions"><Button onClick={onClose}>Close</Button><Button onClick={onWriteNew}>Write a new version</Button>{!approved && <Button kind="primary" disabled={busy} onClick={onApprove}>{busy ? 'Saving…' : 'Approve plan'}</Button>}</div></>
}

function ConnectPanel({ auth, busy, onConnect }: { auth: Auth; busy: boolean; onConnect: (credential: string) => void }) {
  const [credential, setCredential] = useState('')
  const [formatError, setFormatError] = useState<string | null>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!credential.trim() || busy) return
    const secret = normalizeCredential(credential)
    setCredential('')
    if (!secret) { setFormatError('That does not look like a single credential. Paste the token, or the RANGER_BOOTSTRAP_TOKEN=… line from the bootstrap file.'); return }
    setFormatError(null)
    onConnect(secret)
  }
  if (auth.state === 'checking') return <p className="small-muted" role="status">Checking for an existing session…</p>
  if (auth.state === 'connected') return <p className="small-muted" role="status">Session connected.</p>
  return <form className="detail-card" onSubmit={submit} autoComplete="off">
    <h3>Connect to Ranger</h3>
    <p className="small-muted">Paste your Ranger access token (or the RANGER_BOOTSTRAP_TOKEN=… line from the bootstrap file) once to start a browser session. It is cleared from this page right away and is not stored.</p>
    <label className="sr-only" htmlFor="connect-credential">Ranger access credential</label>
    <input id="connect-credential" type="password" autoComplete="off" spellCheck={false} placeholder="Access credential" style={{ ...fieldStyle, resize: undefined, height: 36, margin: '10px 0' }} value={credential} onChange={event => setCredential(event.target.value)} />
    {(formatError ?? auth.message) && <p role="alert" className="small-muted">{formatError ?? auth.message}</p>}
    <Button kind="primary" type="submit" disabled={busy || !credential.trim()}>{busy ? 'Connecting…' : 'Connect'}</Button>
  </form>
}

function CapabilityStrip({ capabilities }: { capabilities: CapabilityState }) {
  if (capabilities.state === 'idle') return null
  if (capabilities.state === 'loading') return <p className="small-muted" role="status">Checking provider availability…</p>
  if (capabilities.state === 'error') return <p className="small-muted" role="status">Provider availability could not be checked: {capabilities.message}</p>
  const { xai, instabox, trace } = capabilities.value
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} aria-label="Provider availability">
    <StatusPill tone={xai ? 'green' : 'amber'}>xAI {xai ? 'available' : 'unavailable'}</StatusPill>
    <StatusPill tone={instabox ? 'green' : 'amber'}>Instabox {instabox ? 'available' : 'unavailable'}</StatusPill>
    <StatusPill tone={trace ? 'green' : 'gray'}>Trace {trace ? 'available' : 'unavailable'}</StatusPill>
  </div>
}

function DemoTag() { return <span className="demo-tag"><span className="status-dot" />Sample walkthrough</span> }

function Landing({ demo, onStart, onDemo, onWorkspace }: { demo: boolean; onStart: () => void; onDemo: () => void; onWorkspace: () => void }) {
  return <main className="landing">
    <header className="site-header"><a href="/" onClick={event => { event.preventDefault(); window.history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')) }}><Brand /></a><nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><button onClick={onWorkspace}>Workspace</button><a href="#github">GitHub</a></nav><div className="header-actions"><a href="#github">Log in</a><Button onClick={onStart}>Meet your engineer</Button></div></header>
    {demo && <div className="demo-banner"><DemoTag /><span>This is sample content. No repository, call, or changes are connected.</span></div>}
    <section className="hero"><div className="hero-title"><p className="eyebrow">YOUR AI FORWARD DEPLOYED ENGINEER</p><h1>Show the problem.<br />Build the fix.</h1></div><div className="hero-copy"><p>A call, a shared screen, and an engineer who stays until it works.</p><div className="hero-actions"><Button kind="primary" onClick={onStart}>Start a project <span aria-hidden="true">↗</span></Button><Button onClick={onDemo}>Explore sample walkthrough <span aria-hidden="true">↗</span></Button></div></div></section>
    <section className="stage-wrap" aria-label="Ranger workspace sample"><div className="stage-bg" /><div className="stage-card"><WorkspacePreview onWorkspace={onWorkspace} /></div><p className="stage-caption">A working session, with the plan and changes in view.</p></section>
    <WorkflowMotion />
    <section id="how-it-works" className="how-section"><div className="section-title"><p className="eyebrow">A PRACTICAL WAY TO WORK</p><h2>The context is in your head.<br />The work happens here.</h2><p>Show Ranger what you do. Build the part you wish existed.</p></div><div className="step-grid"><Step number="01" title="Talk it through" body="Share your screen and explain the messy bits. Ranger asks the questions a good engineer would." visual={<MiniWave />} /><Step number="02" title="Let it work" body="Review your plan, make a plan, and build in its own workspace. You can see every step." visual={<MiniTrace />} /><Step number="03" title="Try it together" body="Open the working app, review the changes, and ask for the next thing. The conversation carries on." visual={<MiniCheck />} /></div></section>
    <section className="closing-cta"><div><p className="eyebrow">START WITH A CONVERSATION</p><h2>Your next integration starts with a call.</h2><p>Give your engineer a name. Give it something worth solving.</p></div><Button kind="primary" onClick={onStart}>Meet your engineer <span aria-hidden="true">↗</span></Button></section>
    <footer className="site-footer"><Brand small /><div><a id="github" href="https://github.com/akshatcoder-hash/ranger" target="_blank" rel="noreferrer">GitHub ↗</a><a href="mailto:hello@ranger.local">Contact</a></div></footer>
  </main>
}

function Step({ number, title, body, visual }: { number: string; title: string; body: string; visual: React.ReactNode }) {
  return <article className="step-card"><div className="step-visual">{visual}</div><p className="step-number">{number} /</p><h3>{title}</h3><p>{body}</p></article>
}

function WorkspacePreview({ onWorkspace }: { onWorkspace: () => void }) {
  return <><div className="stage-preview-header"><Brand small /><span className="breadcrumbs">Projects <span>/</span> Northstar <span>/</span> Order support</span><StatusPill>Workspace ready</StatusPill><Button onClick={onWorkspace}>Open</Button></div><div className="stage-preview-body"><aside className="stage-rail" aria-hidden="true"><span>⌂</span><span>⌕</span><span>◷</span><span>▦</span></aside><div className="stage-chat"><StatusPill>Sample call</StatusPill><h3>Order support</h3><p className="small-muted">Northstar / customer operations</p><VoiceCard mediaState="idle" onStartVoice={onWorkspace} onStartScreen={onWorkspace} onStopMedia={onWorkspace} /><p className="speaker-label">YOU</p><p className="quote">“Every morning we copy the order details here before replying.”</p><div className="speech-bubble">I can connect those steps. Should refunds always wait for someone on your team?</div><div className="plan-saved"><strong>Saved to the plan</strong><span>Refunds need your approval.</span></div></div><div className="stage-work"><div className="stage-tabs"><span>Workspace</span><span>Changes</span><span>Checks</span></div><SampleWorkspace onReview={onWorkspace} /></div></div></>
}

function WorkflowMotion() {
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const poster = '/assets/workflow-poster.png'
  return <section className="workflow-motion" aria-label="How Ranger works">
    <div className="workflow-motion-frame">{reducedMotion
      ? <img src={poster} alt="Workflow: talk through the context, agree on the plan, then build and try it together." />
      : <video src="/assets/workflow-demo.mp4" poster={poster} autoPlay loop muted playsInline controls aria-label="A marker moves from shared context through an approved plan to working code." />}</div>
  </section>
}

function MiniWave() { return <div className="mini-wave-wrap"><StatusPill>On a call</StatusPill><div className="waveform" aria-label="Sample audio waveform">{Array.from({ length: 38 }, (_, i) => <i key={i} style={{ '--bar-height': `${8 + ((i * 17 + 7) % 25)}px` } as React.CSSProperties} />)}</div><p>“Let us approve the refund first.”</p></div> }
function MiniTrace() { return <div className="mini-trace"><strong>⌘ northstar / order-service</strong>{['src/routes/orders.ts', 'src/policies/returns.ts', 'src/integrations/support.ts'].map((x, i) => <p key={x}><code>{x}</code><span>{i === 2 ? '+ New' : 'Read'}</span></p>)}</div> }
function MiniCheck() { return <div className="mini-check"><StatusPill>Ready to try</StatusPill><div><strong>Return my order</strong><small>Order found. Reply drafted.</small></div><p>✓ Order lookup  ·  ✓ Approval rules</p></div> }

function Composer({ demo, engineer, repoLabel, repoState, repoConnected, contextFiles, prompt, busy, signedIn, auth, capabilities, setPrompt, onContextFiles, onConnectRepo, onConnect, onRename, onStartCall, onSubmit, onCancel, onHome, onToggleMode }: { demo: boolean; engineer: string; repoLabel: string | null; repoState: string; repoConnected: boolean; contextFiles: string[]; prompt: string; busy: boolean; signedIn: boolean; auth: Auth; capabilities: CapabilityState; setPrompt: (value: string) => void; onContextFiles: (files: FileList | null) => void; onConnectRepo: () => void; onConnect: (credential: string) => void; onRename: () => void; onStartCall: () => void; onSubmit: (event: FormEvent) => void; onCancel: () => void; onHome: () => void; onToggleMode: () => void }) {
  return <main className="composer-page"><header className="composer-header"><button className="brand-button" onClick={onHome}><Brand /></button><div className="header-actions"><button className="header-link" onClick={onHome}>Your projects</button><button className="avatar" aria-label="Your profile">AS</button></div></header>
    <div className="composer-art" />{demo && <div className="composer-demo"><DemoTag /></div>}
    <section className="composer-content"><p className="eyebrow">A NEW PROJECT</p><h1>What are we building?</h1><p className="composer-subtitle">Start with the problem. We’ll figure out the rest together.</p>
      {!demo && <ConnectPanel auth={auth} busy={busy} onConnect={onConnect} />}
      {!demo && signedIn && <CapabilityStrip capabilities={capabilities} />}
      <form className="composer-card" onSubmit={onSubmit}><label className="sr-only" htmlFor="project-prompt">Describe the problem you want to solve</label><textarea id="project-prompt" autoFocus placeholder="I want to connect our support inbox to our order system…" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={2000} />
        <button type="button" className={`repo-row ${repoConnected ? 'repo-connected' : ''}`} onClick={onConnectRepo}><span className="repo-icon" aria-hidden="true">⌘</span><strong>{repoConnected && repoLabel ? repoLabel : 'Connect a repository'}</strong><span className="repo-state">{repoConnected ? repoState : 'Choose repo'}</span></button>
        <div className="composer-controls"><button className="attach-button" type="button" onClick={() => document.getElementById('context-upload')?.click()}><span aria-hidden="true">＋</span> Add context{contextFiles.length ? ` · ${contextFiles.length} selected` : ''}</button><input id="context-upload" className="sr-only" type="file" multiple onChange={event => onContextFiles(event.currentTarget.files)} />
          <div>{busy ? <Button type="button" onClick={onCancel}>Cancel</Button> : <><Button kind="primary" type="button" disabled={!demo} title={demo ? undefined : 'Create a project first, then start a call from its workspace.'} onClick={onStartCall}>Start a call ↗</Button><Button kind="secondary" type="submit" disabled={!prompt.trim() || !signedIn}>Send <span aria-hidden="true">↑</span></Button></>}</div>
        </div>
      </form>
      {contextFiles.length > 0 && <p className="context-note">{contextFiles.join(' · ')} <span>Selected locally; not uploaded.</span></p>}
      <div className="suggestions"><Button onClick={() => setPrompt('Connect two tools I use every day and carry the right context between them.')}>Connect two tools</Button><Button onClick={() => setPrompt('Fix a workflow that keeps making us do the same thing by hand.')}>Fix a workflow</Button><Button onClick={() => setPrompt('Show me your screen and I’ll walk through what I need.')}>Show you my screen</Button></div>
      <p className="engineer-label">Your engineer’s name is {engineer}. <button onClick={onRename}>Change name</button></p>
      <p className="live-note">{demo ? 'Sample walkthrough: actions stay in this browser.' : 'Live mode. Your project and first message are saved to your Ranger backend. Calls and screen sharing start from a project workspace, and only when xAI is available.'}</p>
      <button className="text-link demo-switch" onClick={onToggleMode}>{demo ? 'Switch to live mode' : 'Open sample walkthrough'}</button>
    </section>
  </main>
}

function LiveGate({ status, auth, busy, onConnect, onRetry, onStartProject }: { status: LiveStatus; auth: Auth; busy: boolean; onConnect: (credential: string) => void; onRetry: () => void; onStartProject: () => void }) {
  if (status.kind === 'ok') return null
  if (status.kind === 'checking' || status.kind === 'needs-session') return <ConnectPanel auth={auth} busy={busy} onConnect={onConnect} />
  if (status.kind === 'loading') return <p className="small-muted" role="status">Loading project…</p>
  if (status.kind === 'error') return <div role="alert"><p className="small-muted">Could not load this project: {status.message}</p><Button onClick={onRetry}>Try again</Button></div>
  return <div className="empty-conversation"><span className="empty-icon">↗</span><h2>{status.kind === 'invalid' ? 'Project not found' : 'No project selected'}</h2><p>{status.kind === 'invalid' ? 'This address is not a Ranger project.' : 'Start a project to open its workspace.'}</p><Button kind="primary" onClick={onStartProject}>Start a project</Button></div>
}

function Workspace({ demo, engineer, projectName, project, status, auth, capabilities, eventFeed, workspaceView, tab, setTab, approved, mediaState, messages, message, busy, setMessage, onSend, onReviewPlan, onConnectRepo, onConnect, onRetry, onRefreshEvents, onStartProject, onReview, onHome, onRename, onStartVoice, onStartScreen, onStopMedia, live }: { demo: boolean; engineer: string; projectName: string; project: LiveProject | null; status: LiveStatus; auth: Auth; capabilities: CapabilityState; eventFeed: EventFeed; workspaceView: WorkspaceView; tab: WorkspaceTab; setTab: (tab: WorkspaceTab) => void; approved: boolean; mediaState: 'idle' | 'requesting' | 'active'; messages: string[]; message: string; busy: boolean; setMessage: (value: string) => void; onSend: (event: FormEvent) => void; onReviewPlan: () => void; onConnectRepo: () => void; onConnect: (credential: string) => void; onRetry: () => void; onRefreshEvents: () => void; onStartProject: () => void; onReview: () => void; onHome: () => void; onRename: () => void; onStartVoice: () => void; onStartScreen: () => void; onStopMedia: () => void; live: LiveMedia | null }) {
  const canMessage = demo || (status.kind === 'ok' && !!project?.conversationId)
  return <main className="workspace-page">
    <header className="workspace-topbar"><button className="brand-button" onClick={onHome}><Brand /></button><span className="breadcrumbs">Projects <span>/</span> {demo ? <>Northstar <span>/</span> Order support</> : projectName}</span><div className="topbar-right">{demo ? <DemoTag /> : auth.state === 'connected' ? <StatusPill>Session connected</StatusPill> : <StatusPill tone="amber">Not connected</StatusPill>}<Button disabled={!demo}>Share</Button></div></header>
    {demo && <div className="workspace-demo-strip"><DemoTag /><span>Sample conversation, repository, and change set. No real work has run.</span></div>}
    <div className="workspace-layout"><aside className="rail" aria-label="Workspace navigation"><button aria-label="Projects" onClick={onHome}>⌂</button><button aria-label="Search" onClick={() => {}}>⌕</button><button aria-label="History" onClick={() => {}}>◷</button><button aria-label="Connections" onClick={() => {}}>▦</button><button className="rail-avatar" onClick={onRename}>AS</button></aside>
      <section className="conversation-panel" aria-label="Conversation with your engineer"><div className="conversation-title"><span>{engineer}</span>{demo && <StatusPill>Sample call</StatusPill>}</div><h1>{demo ? 'Order support' : projectName}</h1><p className="small-muted">{demo ? 'Northstar / customer operations' : project ? (project.repositoryUrl ? `Repository: ${project.repositoryUrl}` : 'No repository connected') : ''}</p><hr />
        {demo ? <><VoiceCard mediaState={mediaState} onStartVoice={onStartVoice} onStartScreen={onStartScreen} onStopMedia={onStopMedia} /><p className="speaker-label">YOU</p><p className="quote">“Every morning we copy the order details here before replying.”</p><div className="speech-bubble"><p className="speaker-label">YOUR ENGINEER</p><p>I can connect those steps. Should refunds always wait for someone on your team?</p></div><p className="speaker-label">YOU</p><p className="quote">Yes. Draft the reply, but let us approve the refund.</p><button className="plan-saved" onClick={onReviewPlan}><strong>{approved ? 'Plan approved' : 'Saved to the plan'}</strong><span>Refunds need your approval. <u>Review plan</u></span></button>{messages.map((item, i) => <div className="message-bubble" key={`${item}-${i}`}>{item}</div>)}</>
          : status.kind !== 'ok' || !project ? <LiveGate status={status} auth={auth} busy={busy} onConnect={onConnect} onRetry={onRetry} onStartProject={onStartProject} />
          : <>{messages.length ? <><p className="speaker-label">CONVERSATION</p>{messages.map((item, i) => <div className="message-bubble" key={`${item}-${i}`}>{item}</div>)}</> : <div className="empty-conversation"><span className="empty-icon">↗</span><h2>No messages yet</h2><p>{project.conversationId ? 'Type a message below. It is saved to this project’s conversation.' : 'This project has no conversation to write to.'}</p></div>}
            <div className="media-controls" style={{ marginTop: 10 }}><Button disabled={busy} onClick={onConnectRepo}>{project.repositoryUrl ? 'Change repository' : 'Connect repository'}</Button></div></>}
        <div className="conversation-spacer" />
        {demo ? <div className="media-controls">{mediaState === 'active' ? <Button onClick={onStopMedia}>End media</Button> : <><Button onClick={onStartVoice} disabled={mediaState === 'requesting'}>{mediaState === 'requesting' ? 'Waiting for permission…' : 'Start call'}</Button><Button onClick={onStartScreen} disabled={mediaState === 'requesting'}>Share screen</Button></>}{mediaState === 'active' && <StatusPill>Sample</StatusPill>}</div>
          : live && <LiveMediaPanel live={live} />}
        <form className="message-form" onSubmit={onSend}><label className="sr-only" htmlFor="workspace-message">Type a message</label><input id="workspace-message" placeholder={canMessage ? 'Or type a message…' : 'Messaging is unavailable'} disabled={!canMessage} value={message} onChange={event => setMessage(event.target.value)} /><button aria-label="Send message" disabled={!message.trim() || busy || !canMessage}>↑</button></form>
      </section>
      <section className="work-panel"><div className="workspace-controls"><div className="tab-list" role="tablist" aria-label="Project details" onKeyDown={event => tabKeydown(event, setTab, ['workspace', 'changes', 'checks'])}>{(['workspace', 'changes', 'checks'] as const).map(item => <button key={item} role="tab" id={`tab-${item}`} aria-selected={tab === item} aria-controls="workspace-tab-panel" tabIndex={tab === item ? 0 : -1} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}{item === 'changes' && demo && <span className="tab-count">4</span>}</button>)}</div>{demo && <div className="build-controls"><StatusPill tone="violet">{tab === 'checks' ? 'Checks passed' : 'Building'}</StatusPill></div>}</div>
        <div id="workspace-tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="workspace-tab-panel">
          {tab === 'workspace' ? demo ? <SampleWorkspace onReview={onReview} /> : project ? <LiveWorkspace project={project} capabilities={capabilities} eventFeed={eventFeed} workspaceView={workspaceView} onRefresh={onRefreshEvents} /> : <LiveEmpty title="No project loaded" detail="Open a project to see its call, repository and preparation state." />
            : tab === 'changes' ? demo ? <SampleChanges onReview={onReview} /> : <LiveEmpty title="No change set available" detail="No code changes have been reported for this project." />
            : demo ? <SampleChecks onReview={onReview} /> : <LiveEmpty title="No checks have run" detail="Acceptance checks appear here only after a run reports results. No run has started." />}
        </div>
        <p className="work-footnote">{demo ? 'Sample activity for design review.' : 'Everything shown here comes from the backend. Nothing is sampled.'}</p>
      </section>
    </div>
  </main>
}

function LiveWorkspace({ project, capabilities, eventFeed, workspaceView, onRefresh }: { project: LiveProject; capabilities: CapabilityState; eventFeed: EventFeed; workspaceView: WorkspaceView; onRefresh: () => void }) {
  const sameProject = eventFeed.projectId === project.projectId
  const events = sameProject ? [...eventFeed.events].reverse().slice(0, 100) : []
  const preparation = sameProject ? eventFeed.preparation ?? latestPreparation(eventFeed.events) : null
  const workspace = workspaceView.projectId === project.projectId ? workspaceView : { projectId: project.projectId, status: null }
  return <div style={{ display: 'grid', gap: 14 }}>
    <PreparationCard project={project} preparation={preparation} workspace={workspace} />
    <article className="detail-card"><h3>Call</h3><CapabilityStrip capabilities={capabilities} /><p className="small-muted">Start the call, connect an operator-approved checkout, then ask the engineer to load the project. Indexing starts from that request. No plan approval is required to inspect or index.</p></article>
    <article className="detail-card"><h3>Project history</h3>
      <div style={{ maxHeight: 280, overflowY: 'auto' }}>{events.length ? events.map(item => <p className="activity-row" key={item.eventId}><code>{item.type}</code><small>Event {item.sequence}</small></p>) : <p className="small-muted">{eventFeed.status === 'error' ? 'History could not be loaded.' : 'No events have been recorded yet.'}</p>}</div>
      {eventFeed.status === 'error' && eventFeed.error && <p role="alert" className="small-muted">{eventFeed.error}</p>}
      <p className="small-muted">{eventFeed.status === 'polling' ? 'Checking for new events every few seconds.' : eventFeed.status === 'paused' ? 'Automatic refresh stopped. Refresh to check again.' : ''}</p>
      <Button onClick={onRefresh}>Refresh history</Button></article>
  </div>
}

function PreparationCard({ project, preparation, workspace }: { project: LiveProject; preparation: PreparationStatus | null; workspace: WorkspaceView }) {
  const phaseLabel: Record<PreparationStatus['phase'], string> = {
    queued: 'Queued',
    preparing: 'Preparing the VM',
    indexing: 'Indexing the project',
    ready: 'Ready',
    failed: 'Preparation failed',
  }
  const tone = preparation?.phase === 'ready' ? 'green' : preparation?.phase === 'failed' ? 'amber' : preparation ? 'violet' : 'gray'
  const observed = workspace.status?.observedState
  const facts = [
    preparation?.fileCount !== undefined ? `${preparation.fileCount} files` : null,
    preparation?.byteCount !== undefined ? `${preparation.byteCount} bytes` : null,
    preparation?.indexElapsedMs !== undefined ? `index ${preparation.indexElapsedMs} ms` : null,
    preparation?.elapsedMs !== undefined ? `elapsed ${preparation.elapsedMs} ms` : null,
    preparation?.repositoryCommit ? `commit ${preparation.repositoryCommit}` : null,
  ].filter((item): item is string => item !== null)
  return <article className="detail-card" aria-label="Project preparation">
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <h3>Project</h3>
      <StatusPill tone={tone}>{preparation ? phaseLabel[preparation.phase] : 'Not started'}</StatusPill>
    </div>
    <p role="status">{project.repositoryUrl ? `Connected repository: ${project.repositoryUrl}` : 'No repository connected yet.'}</p>
    <p className="small-muted">{preparation ? 'Ask the engineer on the call to load the project. This follows the latest preparation event; nothing here is estimated.' : 'Connect an operator-approved checkout, then ask the engineer on the call to load the project. A remote URL by itself does not load files.'}</p>
    {facts.length > 0 && <p className="small-muted">{facts.join(' · ')}</p>}
    {preparation?.phase === 'failed' && <p role="alert" className="small-muted">{preparation.message ?? preparation.errorCode ?? 'Preparation failed. No files were marked ready.'}</p>}
    {observed && <p className="small-muted">Workspace observed state: {observed}{workspace.status?.desiredState ? ` (desired ${workspace.status.desiredState})` : ''}.</p>}
    {workspace.error && <p className="small-muted" role="status">Workspace status could not be read: {workspace.error}</p>}
  </article>
}

function LiveMediaPanel({ live }: { live: LiveMedia }) {
  const { voice, screen } = live
  const voiceStep = { permission: 'Waiting for your browser’s microphone prompt…', session: 'Starting a call session…', relay: 'Connecting to the call relay…', ready: '' }
  const screenStep = { permission: 'Waiting for the screen picker…', session: 'Starting a capture session…', preview: 'Waiting for the first video frame…' }
  const header = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 7 } satisfies CSSProperties
  const controls = { flexWrap: 'wrap', marginTop: 8, marginBottom: 0 } satisfies CSSProperties
  const time = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString() : 'unknown time'
  const inspection = screen.inspection?.result ?? null
  return <div className="voice-card" aria-label="Voice and screen" style={{ marginBottom: 10 }}>
    <div style={header}><strong style={{ fontSize: 11, fontWeight: 500 }}>Voice call</strong><StatusPill tone={voice.phase === 'live' ? 'green' : voice.phase === 'starting' ? 'amber' : 'gray'}>{voice.phase === 'live' ? 'Live' : voice.phase === 'starting' ? 'Connecting' : 'Not connected'}</StatusPill></div>
    {voice.phase === 'starting' && voice.step && <p className="small-muted" role="status">{voiceStep[voice.step]}</p>}
    {voice.phase === 'live' && <p className="small-muted" role="status">Your microphone is on and sending audio to Ranger, which relays it to xAI. Ranger does not record it.{voice.responding ? ' Ranger is speaking.' : ''}</p>}
    {voice.phase === 'idle' && live.voiceBlocked && <p className="small-muted" role="status">Calls are not offered: {live.voiceBlocked}</p>}
    {voice.error && <p className="small-muted" role="alert">{voice.error}</p>}
    {voice.notice && <p className="small-muted" role="status">{voice.notice}</p>}
    {voice.cleanup.phase === 'ending' && <p className="small-muted" role="status">Ending the previous call on Ranger…</p>}
    {voice.cleanup.phase === 'failed' && <p className="small-muted" role="alert">{voice.cleanup.message}</p>}
    <div className="media-controls" style={controls}>
      {voice.cleanup.phase === 'failed' && <Button onClick={live.onRetryVoiceCleanup}>Retry ending call</Button>}
      {voice.phase === 'idle' && <Button onClick={live.onStartVoice} disabled={live.voiceBlocked !== null || voice.cleanup.phase !== 'idle'}>Start call</Button>}
      {voice.phase === 'starting' && <Button onClick={live.onStopVoice}>Cancel</Button>}
      {voice.phase === 'live' && <><Button onClick={live.onStopVoice}>End call</Button><Button onClick={live.onInterrupt}>Interrupt voice</Button></>}
    </div>
    <hr />
    <div style={header}><strong style={{ fontSize: 11, fontWeight: 500 }}>Screen share</strong><StatusPill tone={screen.phase === 'sharing' ? 'green' : screen.phase === 'starting' ? 'amber' : 'gray'}>{screen.phase === 'sharing' ? 'Sharing' : screen.phase === 'starting' ? 'Starting' : 'Not shared'}</StatusPill></div>
    {screen.phase === 'starting' && screen.step && <p className="small-muted" role="status">{screenStep[screen.step]}</p>}
    {screen.phase === 'sharing' && <p className="small-muted" role="status">Ranger receives about one still frame per second and only looks when you ask. Frames are not recorded and Ranger cannot control your screen. {screen.lastFrame ? `${screen.framesSent} sent, latest ${screen.lastFrame.width}×${screen.lastFrame.height} at ${time(screen.lastFrame.capturedAt)}.` : 'No frame has reached Ranger yet.'}{screen.framesDropped > 0 ? ` ${screen.framesDropped} skipped.` : ''}</p>}
    {screen.phase === 'sharing' && live.inspectBlocked && <p className="small-muted" role="status">Inspection is not offered: {live.inspectBlocked}</p>}
    {screen.error && <p className="small-muted" role="alert">{screen.error}</p>}
    {screen.notice && <p className="small-muted" role="status">{screen.notice}</p>}
    {screen.cleanup.phase === 'ending' && <p className="small-muted" role="status">Ending the previous screen share on Ranger…</p>}
    {screen.cleanup.phase === 'failed' && <p className="small-muted" role="alert">{screen.cleanup.message}</p>}
    <div className="media-controls" style={controls}>
      {screen.cleanup.phase === 'failed' && <Button onClick={live.onRetryScreenCleanup}>Retry ending screen share</Button>}
      {screen.phase === 'idle' && <Button onClick={live.onStartScreen} disabled={live.screenBlocked !== null || screen.cleanup.phase !== 'idle'} title={live.screenBlocked ?? undefined}>Share screen</Button>}
      {screen.phase === 'starting' && <Button onClick={live.onStopScreen}>Cancel</Button>}
      {screen.phase === 'sharing' && <><Button onClick={live.onStopScreen}>Stop sharing</Button><Button onClick={live.onInspect} disabled={screen.inspecting || live.inspectBlocked !== null} title={live.inspectBlocked ?? undefined}>{screen.inspecting ? 'Looking…' : 'Inspect screen'}</Button></>}
    </div>
    {screen.phase === 'sharing' && inspection && <div style={{ marginTop: 8 }} role="status" aria-label="Screen inspection result">
      {inspection.state === 'observed'
        ? <><p className="small-muted">Ranger’s reading of the frame captured at {time(inspection.sourceTimestamp)} (frame {inspection.sourceFrameId}). It can be wrong.</p><ul className="plan-list">{inspection.observations.map((item, i) => <li key={`${item.text}-${i}`}>{item.text} <small>({Math.round(item.uncertainty * 100)}% uncertain)</small></li>)}</ul></>
        : <p className="small-muted">No current frame was available ({inspection.freshness}), so nothing was inspected. Wait for the next frame and try again.</p>}
    </div>}
  </div>
}

function VoiceCard({ mediaState, onStartVoice, onStartScreen, onStopMedia }: { mediaState: 'idle' | 'requesting' | 'active'; onStartVoice: () => void; onStartScreen: () => void; onStopMedia: () => void }) {
  return <div className="voice-card"><div className="voice-head"><strong>{mediaState === 'active' ? 'Microphone active in this browser' : 'Voice call'}</strong><span>{mediaState === 'active' ? 'Local media' : 'Not connected'}</span></div><div className="waveform" aria-hidden="true">{Array.from({ length: 34 }, (_, i) => <i key={i} style={{ '--bar-height': `${8 + ((i * 13 + 4) % 26)}px` } as React.CSSProperties} />)}</div><div className="voice-foot"><span>Mic {mediaState === 'active' ? 'on' : 'off'}</span><span>Screen {mediaState === 'active' ? 'available' : 'not shared'}</span><span>—:—</span></div>{mediaState === 'idle' && <div className="voice-actions"><button onClick={onStartVoice}>Start call</button><button onClick={onStartScreen}>Share screen</button></div>}{mediaState === 'active' && <button className="voice-stop" onClick={onStopMedia}>Stop media</button>}</div>
}

function SampleWorkspace({ onReview }: { onReview: () => void }) {
  return <><div className="preview-window"><div className="preview-chrome"><div className="window-dots"><i /><i /><i /></div><span>northstar.local / support / 1042</span><a href="#preview" onClick={event => event.preventDefault()}>Live preview ↗</a></div><div className="support-preview"><aside><strong>Northstar</strong><small>Support inbox</small><hr /><b>#1042 · Return my order</b><small>Maya Chen · 8 min ago</small><small>#1041 · Delivery update</small><small>#1040 · Change address</small></aside><div className="ticket"><h2>Return my order</h2><p>“The jacket is too small. Can I return it?”</p><div className="order-line"><strong>Order #NS2048</strong><span>Delivered Oct 12</span><b>$84.00</b></div><div className="reply-draft"><b>Reply draft</b><p>Hi Maya, your order is within our 30 day return window.<br />I’ve prepared the return details for you.</p></div><div className="ticket-actions"><StatusPill>Refund needs approval</StatusPill><Button onClick={onReview}>Review reply</Button></div></div></div></div><div className="workspace-lower"><article className="detail-card"><h3>What we agreed</h3><ul className="check-list"><li>Find the order behind each ticket</li><li>Apply your return policy</li><li>Draft the customer reply</li><li>Ask before issuing a refund</li></ul><hr /><p>Approved by you · 2 min ago</p><Button onClick={onReview}>View plan</Button></article><article className="detail-card activity-card"><h3>Working on it</h3><p>Read <code>order-service/routes.ts</code></p><p>Found the customer lookup with Trace</p><p>Added ticket ↔ order matching</p><div className="terminal"><p>$ pnpm test order-support</p><p>✓ order found  ✓ missing order</p><p>Running duplicate ticket check…</p></div><small>Last update just now</small></article></div></>
}

function SampleChanges({ onReview }: { onReview: () => void }) {
  return <div className="changes-layout"><article className="detail-card diff-card"><div className="diff-heading"><div><h2>What changed</h2><p>src/integrations/order-support.ts</p></div><span>4 files changed</span></div><pre aria-label="Sample code diff"><span className="diff-context"> 18  const order = await orders.find(ticket.orderId);</span>{'\n'}<span className="diff-context"> 19  if (!order) return requestOrderDetails(ticket);</span>{'\n'}<span className="diff-add">+21  const policy = await policies.get("returns");</span>{'\n'}<span className="diff-add">+22  const reply = await draftReply(ticket, order, policy);</span>{'\n'}<span className="diff-add">+23  await tickets.saveDraft(ticket.id, reply);</span>{'\n'}<span className="diff-add">+24  </span>{'\n'}<span className="diff-add">+25  if (reply.refundRequested) {'{'}</span>{'\n'}<span className="diff-add">+26    await approvals.request({'{'}</span>{'\n'}<span className="diff-add">+27      ticketId: ticket.id,</span>{'\n'}<span className="diff-add">+28      orderId: order.id,</span>{'\n'}<span className="diff-add">+29      amount: order.total,</span>{'\n'}<span className="diff-add">+30    {'})'}</span>{'\n'}<span className="diff-add">+31  {'}}'}</span></pre><Button onClick={onReview}>Open full review</Button></article><article className="detail-card plan-checks"><h3>Checked against your plan</h3>{['Order found', 'Order missing', 'Duplicate ticket', 'Refund requested'].map((item, i) => <p key={item}><strong>✓ {item}</strong><small>{['The draft uses the right order.', 'Asks the customer for details.', 'Only one draft is created.', 'Waits for human approval.'][i]}</small></p>)}</article></div>
}

function SampleChecks({ onReview }: { onReview: () => void }) {
  return <div className="checks-screen"><div className="checks-banner"><div><h2>All 6 checks passed</h2><p>Tested against the plan you approved.</p></div><StatusPill>Sample results</StatusPill></div><div className="checks-columns"><article className="detail-card"><h3>Acceptance checks</h3>{['Order found for a matching ticket', 'Missing order asks for details', 'Duplicate ticket does not create a second draft', 'Refund waits for a person', 'Offline order service asks for help', 'Return policy uses current window'].map(text => <p className="check-row" key={text}><span>✓</span>{text}</p>)}</article><article className="detail-card"><h3>Activity</h3><p className="activity-row">Read <code>src/routes/orders.ts</code><small>Trace · sample</small></p><p className="activity-row">Ran order-support checks<small>6 passed · sample</small></p><Button onClick={onReview}>Review changes</Button></article></div></div>
}

function LiveEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className="live-empty"><span className="empty-icon">⌁</span><h2>{title}</h2><p>{detail}</p><p className="muted">The labeled sample walkthrough shows what this view looks like with example data.</p></div>
}

function tabKeydown(event: KeyboardEvent<HTMLDivElement>, setTab: (tab: WorkspaceTab) => void, tabs: WorkspaceTab[]) {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
  event.preventDefault(); const current = tabs.indexOf(document.activeElement?.id.replace('tab-', '') as WorkspaceTab)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  setTab(tabs[next]); requestAnimationFrame(() => document.getElementById(`tab-${tabs[next]}`)?.focus())
}

function Review({ demo, engineer, projectName, status, auth, busy, approved, notice, onConnect, onRetry, onStartProject, onWorkspace, onHome, onRename, onReviewPlan }: { demo: boolean; engineer: string; projectName: string; status: LiveStatus; auth: Auth; busy: boolean; approved: boolean; notice: Notice | null; onConnect: (credential: string) => void; onRetry: () => void; onStartProject: () => void; onWorkspace: () => void; onHome: () => void; onRename: () => void; onReviewPlan: () => void }) {
  return <main className="review-page"><header className="workspace-topbar"><button className="brand-button" onClick={onHome}><Brand /></button><span className="breadcrumbs">Projects <span>/</span> {demo ? <>Northstar <span>/</span> Order support</> : projectName}</span><div className="topbar-right">{demo ? <DemoTag /> : auth.state === 'connected' ? <StatusPill>Session connected</StatusPill> : <StatusPill tone="amber">Not connected</StatusPill>}<Button onClick={onWorkspace}>{demo ? 'Open preview ↗' : 'Open workspace'}</Button></div></header>
    <div className="review-layout"><aside className="review-sidebar"><p className="eyebrow">{demo ? 'NORTHSTAR' : 'PROJECT'}</p><h2>{demo ? 'Order support' : projectName}</h2><nav aria-label="Project views"><button onClick={onWorkspace}>Conversation</button><button disabled={!demo && status.kind !== 'ok'} onClick={onReviewPlan}>Plan</button><button className="active" aria-current="page">Changes{demo && <span>4</span>}</button><button onClick={onWorkspace}>Checks</button><button onClick={onWorkspace}>Workspace</button></nav><div className="review-engineer"><p>{engineer}</p><Button onClick={onRename}>Change name</Button><Button onClick={onWorkspace}>{demo ? 'Start a call' : 'Open workspace'}</Button></div></aside>
      <section className="review-content"><div className="review-heading"><div>{demo && <p className="eyebrow">SAMPLE WALKTHROUGH</p>}<h1>{demo ? 'Your integration is ready.' : 'Review changes'}</h1><p>{demo ? 'Order lookup, reply drafts and a human check before every refund.' : 'No code changes have been reported for this project.'}</p></div>{demo && <Button kind="primary" onClick={onWorkspace}>Try it now ↗</Button>}</div>
        {demo ? <><div className="checks-banner review-banner"><div><h2>All 6 checks passed</h2><p>Tested against the {approved ? 'plan you approved' : 'sample plan'}.</p></div><span className="review-summary">4 files changed</span><span className="review-summary">+128  −12</span></div><div className="review-cards"><article className="detail-card full-diff"><h3>What changed</h3><p className="file-path">src/integrations/order-support.ts</p><pre><span className="diff-context"> 18  const order = await orders.find(ticket.orderId);</span>{'\n'}<span className="diff-context"> 19  if (!order) return requestOrderDetails(ticket);</span>{'\n'}<span className="diff-context"> 20  </span>{'\n'}<span className="diff-add">+21  const policy = await policies.get("returns");</span>{'\n'}<span className="diff-add">+22  const reply = await draftReply(ticket, order, policy);</span>{'\n'}<span className="diff-add">+23  await tickets.saveDraft(ticket.id, reply);</span>{'\n'}<span className="diff-add">+24  </span>{'\n'}<span className="diff-add">+25  if (reply.refundRequested) {'{'}</span>{'\n'}<span className="diff-add">+26    await approvals.request({'{'}</span>{'\n'}<span className="diff-add">+27      ticketId: ticket.id,</span>{'\n'}<span className="diff-add">+28      orderId: order.id,</span>{'\n'}<span className="diff-add">+29      amount: order.total,</span>{'\n'}<span className="diff-add">+30    {'})'}</span>{'\n'}<span className="diff-add">+31  {'}}'}</span></pre></article><article className="detail-card plan-checks"><h3>Checked against your plan</h3>{[['Order found', 'The draft uses the right order.'], ['Order missing', 'Asks the customer for details.'], ['Duplicate ticket', 'Only one draft is created.'], ['Order service offline', 'Retries, then asks for help.'], ['Refund requested', 'Waits for human approval.'], ['Policy changed', 'Uses the latest return window.']].map(([title, sub]) => <p key={title}><strong>✓ {title}</strong><small>{sub}</small></p>)}</article></div><div className="change-question"><div><h3>Want to change anything?</h3><p>Talk it through or leave a note. Your engineer keeps the context.</p></div><Button onClick={onWorkspace}>Ask for a change</Button></div></> : <div className="live-review-empty">{status.kind === 'ok' ? <LiveEmpty title="No changes to review" detail="No diff or acceptance checks have been reported. No run has started." /> : <LiveGate status={status} auth={auth} busy={busy} onConnect={onConnect} onRetry={onRetry} onStartProject={onStartProject} />}{notice && notice.kind !== 'error' && <p role="status">{notice.text}</p>}</div>}
      </section>
    </div>
  </main>
}

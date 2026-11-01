import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react'
import { rangerApi, type ApiResult, type DemoProject, type PlanState, type WorkspaceStatus } from '../api'
import { ScreenChannel, VoiceChannel, browserMediaDeps, providerGate, type ScreenStatus, type VoiceStatus } from '../media'
import { MediaLifecycle, OperationEpoch } from './lifecycle'
import { advancePreparationClock, applyEventPage, executionBlockers, isProjectId, latestPreparation, parseLines, planCreateOutcome, preparationIsActive, projectViewEngineerName, validateRepositoryInput, type Capabilities, type PreparationClock, type PreparationStatus } from './liveHelpers'
import { hasActiveRun, projectRecordRevision } from './activity'
import { PreparationCard, VmPanel } from './LiveVm'
import { ChatActivity } from './ChatActivity'
import { Button, StatusPill } from './primitives'
import { bootSession } from './session'
import { EmptyPlate, RangeMark } from './texture'
import { LatestRead, evidenceEventRevision, readProjectEvidence, sameReviewedPlan, type ProjectEvidence, type ReadState } from './liveEvidence'
import { LiveResults } from './LiveResults'
import { eventsSinceConversation, matchesDemoProject, recallDemoConversation, rememberDemoConversation } from './demoAccess'

type Screen = 'home' | 'start' | 'workspace' | 'review'
type WorkspaceTab = 'workspace' | 'changes' | 'checks'
type Notice = { kind: 'error' | 'info' | 'success'; text: string }
type Modal = 'name' | 'plan' | 'manual' | 'repo'
type OkData<T> = T extends { ok: true; data: infer D } ? D : never
type Failure = Extract<Awaited<ReturnType<typeof rangerApi.getSession>>, { ok: false }>
type LiveProject = OkData<Awaited<ReturnType<typeof rangerApi.loadProject>>>
type ProjectEvent = OkData<Awaited<ReturnType<typeof rangerApi.getEvents>>>['events'][number]
type Auth = { state: 'checking' } | { state: 'failed'; message: string } | { state: 'connected'; principalId: string; demoProject?: DemoProject }
type CapabilityState = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; value: Capabilities } | { state: 'error'; message: string }
type ProjectLoad = { state: 'idle' } | { state: 'loading'; projectId: string } | { state: 'ready'; projectId: string } | { state: 'error'; projectId: string; message: string }
type EventFeed = { projectId: string | null; events: ProjectEvent[]; preparation: PreparationStatus | null; clock: PreparationClock | null; status: 'idle' | 'polling' | 'paused' | 'error'; error?: string }
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
type LiveStatus = { kind: 'ok' } | { kind: 'checking' } | { kind: 'session-failed' } | { kind: 'no-project' } | { kind: 'invalid' } | { kind: 'loading' } | { kind: 'error'; message: string }

const EVENT_POLL_MS = 5000
const EVENT_ACTIVE_POLL_MS = 2000
const EVENT_MAX_POLLS = 24
const EVENT_ACTIVE_MAX_POLLS = 600
const EVENT_BOOST_MS = 30000
const EVENT_MAX_PAGES = 5
const SESSION_LOST: Auth = { state: 'failed', message: 'Your session ended and could not be renewed automatically.' }
const fieldStyle: CSSProperties = { width: '100%', padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 7, resize: 'vertical' }

function readLocation() {
  const path = window.location.pathname.split('/').filter(Boolean)
  const screen: Screen = path[0] === 'start' ? 'start' : path[0] === 'workspace' ? 'workspace' : path[0] === 'review' ? 'review' : 'home'
  return { screen, projectId: path[1] || null }
}

function Brand({ small = false }: { small?: boolean }) {
  return <span className={`brand ${small ? 'brand-small' : ''}`} aria-label="Ranger"><img className="brand-mark" src="/assets/ranger-mark.svg" alt="" /><span>ranger</span></span>
}

export function App() {
  const [location, setLocation] = useState(readLocation)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [engineer, setEngineer] = useState('Ranger')
  const [modal, setModal] = useState<Modal | null>(null)
  const [modalError, setModalError] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState(engineer)
  const [repoDraft, setRepoDraft] = useState({ url: '', ref: 'HEAD' })
  const [pendingRepo, setPendingRepo] = useState<{ url: string; ref: string } | null>(null)
  const [planDraft, setPlanDraft] = useState({ items: '', criteria: '' })
  const [contextFiles, setContextFiles] = useState<string[]>([])
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('workspace')
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const approvalRef = useRef<{ projectId: string; approvalId: string } | null>(null)
  const [prompt, setPrompt] = useState('')
  const [message, setMessage] = useState('')
  const [auth, setAuth] = useState<Auth>({ state: 'checking' })
  const [capabilities, setCapabilities] = useState<CapabilityState>({ state: 'idle' })
  const [project, setProject] = useState<LiveProject | null>(null)
  const [projectLoad, setProjectLoad] = useState<ProjectLoad>({ state: 'idle' })
  const [reloadKey, setReloadKey] = useState(0)
  const [eventsKey, setEventsKey] = useState(0)
  const [bootKey, setBootKey] = useState(0)
  const [eventFeed, setEventFeed] = useState<EventFeed>({ projectId: null, events: [], preparation: null, clock: null, status: 'idle' })
  const [planReview, setPlanReview] = useState<ReadState<ApiResult<PlanState>>>({ state: 'idle' })
  const [planReader] = useState(() => new LatestRead<ApiResult<PlanState>>())
  const [evidence, setEvidence] = useState<ReadState<ProjectEvidence>>({ state: 'idle' })
  const [evidenceReader] = useState(() => new LatestRead<ProjectEvidence>())
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>({ projectId: null, status: null })
  const [mediaLifecycle] = useState(() => new MediaLifecycle(() => {}))
  const authLostRef = useRef<() => void>(() => {})
  const [voice] = useState(() => new VoiceChannel(browserMediaDeps(), { onAuthLost: () => authLostRef.current() }))
  const [screen] = useState(() => new ScreenChannel(browserMediaDeps(), { onAuthLost: () => authLostRef.current() }))
  const [voiceStatus, setVoiceStatus] = useState(voice.status)
  const voiceActive = voiceStatus.phase !== 'idle'
  const [screenStatus, setScreenStatus] = useState(screen.status)
  const requestRef = useRef<AbortController | null>(null)
  const operationEpochRef = useRef(new OperationEpoch())
  const projectRef = useRef<LiveProject | null>(null)
  const lastProjectIdRef = useRef<string | null>(null)
  const fastUntilRef = useRef(0)
  const prepClockRef = useRef<PreparationClock | null>(null)
  const recordRevisionRef = useRef<{ projectId: string; revision: number } | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const routeProjectId = location.projectId
  const principalId = auth.state === 'connected' ? auth.principalId : null
  const demoProject = auth.state === 'connected' ? auth.demoProject : undefined
  const needsProject = principalId !== null && (location.screen === 'workspace' || location.screen === 'review') && isProjectId(routeProjectId)
  const activeProject = project && project.projectId === routeProjectId ? project : null
  const liveStatus: LiveStatus = auth.state === 'checking' ? { kind: 'checking' }
    : auth.state === 'failed' ? { kind: 'session-failed' }
    : !routeProjectId ? { kind: 'no-project' }
    : !isProjectId(routeProjectId) ? { kind: 'invalid' }
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
  /** Poll quickly for a while after an action that is expected to start backend work. */
  const boostPolling = useCallback(() => { fastUntilRef.current = Date.now() + EVENT_BOOST_MS; refreshLive() }, [refreshLive])

  const invalidateRequest = useCallback(() => {
    operationEpochRef.current.invalidate()
    requestRef.current?.abort()
    requestRef.current = null
    setBusy(false)
  }, [])

  const closeModal = useCallback(() => {
    planReader.cancel()
    invalidateRequest()
    setModal(null)
  }, [invalidateRequest, planReader])

  const clearMedia = useCallback(() => {
    mediaLifecycle.release()
    voice.stop()
    screen.stop()
  }, [mediaLifecycle, screen, voice])

  const navigate = useCallback((screen: Screen, projectId: string | null = location.projectId, replace = false, keepCall = false) => {
    invalidateRequest()
    if (!keepCall) clearMedia()
    const path = screen === 'home' ? '/' : screen === 'start' ? '/start' : projectId ? `/${screen}/${encodeURIComponent(projectId)}` : `/${screen}`
    window.history[replace ? 'replaceState' : 'pushState']({}, '', path)
    setLocation(readLocation())
    setNotice(null)
    setModal(null)
    if (screen === 'workspace') setWorkspaceTab('workspace')
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  }, [clearMedia, invalidateRequest, location.projectId])

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
    const controller = new AbortController()
    let current = true
    setAuth({ state: 'checking' })
    void bootSession(rangerApi, controller.signal).then(result => {
      if (!current || (!result.ok && result.reason === 'aborted')) return
      setAuth(result.ok ? { state: 'connected', principalId: result.data.principalId, ...(result.data.demoProject ? { demoProject: result.data.demoProject } : {}) } : { state: 'failed', message: result.message })
    })
    return () => { current = false; controller.abort() }
  }, [bootKey])

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
    void rangerApi.loadProject(loadProjectId, controller.signal, recallDemoConversation(loadProjectId)).then(result => {
      if (!current) return
      if (result.ok) {
        applyProject(result.data)
        setProjectLoad({ state: 'ready', projectId: loadProjectId })
        return
      }
      if (result.reason === 'unauthorized') { setAuth(SESSION_LOST); return }
      setProjectLoad({ state: 'error', projectId: loadProjectId, message: result.message })
      if (projectRef.current?.projectId === loadProjectId) setNotice({ kind: 'error', text: `Could not refresh the project: ${result.message}` })
    })
    return () => { current = false; controller.abort() }
  }, [applyProject, loadProjectId, principalId, reloadKey])

  const eventProjectId = activeProject?.projectId ?? null
  useEffect(() => {
    if (!eventProjectId) { setEventFeed({ projectId: null, events: [], preparation: null, clock: null, status: 'idle' }); return }
    const controller = new AbortController()
    let current = true
    let events: ProjectEvent[] = []
    let preparation: PreparationStatus | null = null
    let clock = prepClockRef.current
    let cursor: string | undefined
    let idlePolls = 0
    let activePolls = 0
    let timer: number | undefined
    // A manual refresh restarts the pull; the previous feed stays visible, and the stopwatch survives, until the new pull replaces it.
    setEventFeed(feed => feed.projectId === eventProjectId ? { ...feed, status: 'polling', error: undefined } : { projectId: eventProjectId, events: [], preparation: null, clock: null, status: 'polling' })

    const remember = (next: ProjectEvent[]) => {
      const seen = latestPreparation(next)
      if (!seen) return
      preparation = seen
      clock = advancePreparationClock(clock, seen, Date.now())
      prepClockRef.current = clock
    }
    const publish = (status: EventFeed['status'], error?: string) => {
      setEventFeed({ projectId: eventProjectId, events, preparation, clock, status, ...(error ? { error } : {}) })
    }
    const pull = async () => {
      for (let page = 0; page < EVENT_MAX_PAGES; page += 1) {
        const result = await rangerApi.getEvents(eventProjectId, controller.signal, cursor)
        if (!current) return false
        if (!result.ok) {
          if (result.reason === 'unauthorized') setAuth(SESSION_LOST)
          else publish('error', result.message)
          return false
        }
        const step = applyEventPage({ events, cursor }, result.data)
        const added = step.state.events !== events
        events = step.state.events
        cursor = step.state.cursor
        remember(events)
        if (added) idlePolls = 0
        if (added || preparation) publish('polling')
        if (step.error) { publish('error', step.error); return false }
        if (!step.fetchMore) break
      }
      return true
    }
    const loop = async () => {
      const ok = await pull()
      if (!current || !ok) return
      // Preparation and runs are polled quickly until they finish; an idle project backs off and then pauses.
      const active = voiceActive || Date.now() < fastUntilRef.current || preparationIsActive(preparation) || hasActiveRun(events)
      if (active) { idlePolls = 0; activePolls += 1 } else { idlePolls += 1; activePolls = 0 }
      if (idlePolls >= EVENT_MAX_POLLS || activePolls >= EVENT_ACTIVE_MAX_POLLS) { setEventFeed(feed => ({ ...feed, status: 'paused' })); return }
      setEventFeed(feed => (feed.status === 'polling' && !feed.error ? feed : { ...feed, status: 'polling', error: undefined }))
      timer = window.setTimeout(() => { void loop() }, active ? EVENT_ACTIVE_POLL_MS : EVENT_POLL_MS)
    }
    void loop()
    return () => { current = false; controller.abort(); window.clearTimeout(timer) }
  }, [eventProjectId, eventsKey, voiceActive])

  const recordRevision = eventFeed.projectId === eventProjectId ? projectRecordRevision(eventFeed.events) : 0
  const feedLoaded = eventFeed.projectId === eventProjectId && eventFeed.events.length > 0
  useEffect(() => {
    if (!eventProjectId || !feedLoaded) return
    const seen = recordRevisionRef.current
    recordRevisionRef.current = { projectId: eventProjectId, revision: recordRevision }
    if (!seen || seen.projectId !== eventProjectId || recordRevision > seen.revision) setReloadKey(key => key + 1)
  }, [eventProjectId, feedLoaded, recordRevision])

  const workspaceProjectId = activeProject?.projectId ?? null
  const preparationPhase = eventFeed.projectId === workspaceProjectId ? eventFeed.preparation?.phase : undefined
  useEffect(() => {
    if (!workspaceProjectId) { setWorkspaceView({ projectId: null, status: null }); return }
    const controller = new AbortController()
    let current = true
    setWorkspaceView(view => (view.projectId === workspaceProjectId ? view : { projectId: workspaceProjectId, status: null }))
    void rangerApi.getWorkspaceStatus(workspaceProjectId, controller.signal).then(result => {
      if (!current) return
      if (result.ok) setWorkspaceView({ projectId: workspaceProjectId, status: result.data })
      else if (result.reason === 'unauthorized') setAuth(SESSION_LOST)
      else setWorkspaceView({ projectId: workspaceProjectId, status: null, error: result.message })
    })
    return () => { current = false; controller.abort() }
  }, [workspaceProjectId, eventsKey, preparationPhase])

  const resultProjectId = activeProject?.projectId ?? null
  const resultRevision = eventFeed.projectId === resultProjectId ? evidenceEventRevision(eventFeed.events) : 0
  useEffect(() => {
    if (!resultProjectId || !principalId) { evidenceReader.cancel(); setEvidence({ state: 'idle' }); return }
    void evidenceReader.start(signal => readProjectEvidence(rangerApi, resultProjectId, signal), state => {
      setEvidence(state)
      if (state.state === 'ready') {
        const values = [state.value.runs, state.value.diff, state.value.tests, state.value.tools]
        if (values.some(result => result && !result.ok && result.reason === 'unauthorized')) setAuth(SESSION_LOST)
      }
    })
    return () => evidenceReader.cancel()
  }, [evidenceReader, eventsKey, location.screen, principalId, resultProjectId, resultRevision, workspaceTab])

  useEffect(() => {
    if (modal !== 'plan' || !resultProjectId || !principalId) { planReader.cancel(); setPlanReview({ state: 'idle' }); return }
    void planReader.start(signal => rangerApi.getPlanState(resultProjectId, signal), state => {
      setPlanReview(state)
      if (state.state !== 'ready') return
      if (state.value.ok) patchProject(resultProjectId, state.value.data)
      else if (state.value.reason === 'unauthorized') setAuth(SESSION_LOST)
    })
    return () => planReader.cancel()
  }, [modal, patchProject, planReader, principalId, resultProjectId])

  useEffect(() => {
    if (!modal) return
    const previous = document.activeElement as HTMLElement | null
    const onKey = (event: KeyboardEvent | globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeModal()
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
  }, [closeModal, modal])

  useEffect(() => () => {
    mediaLifecycle.release()
    requestRef.current?.abort()
  }, [mediaLifecycle])

  useEffect(() => {
    authLostRef.current = () => setAuth(SESSION_LOST)
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
  useEffect(() => {
    if (!mediaProjectId || !mediaConversationId || !voice.isFor({ projectId: mediaProjectId, conversationId: mediaConversationId })) voice.stop()
    screen.stop()
  }, [mediaProjectId, mediaConversationId, screen, voice])
  useEffect(() => () => { voice.stop(); screen.stop() }, [screen, voice])

  const openModal = (next: Modal) => {
    if (next === 'plan') setPlanReview({ state: 'loading' })
    setModalError(null); setModal(next)
  }
  const openRename = () => { setNameDraft(location.screen === 'start' ? engineer : viewEngineer); openModal('name') }

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
      setAuth(SESSION_LOST)
      return
    }
    if (result.reason === 'partial') refreshLive()
    if (inModal) setModalError(result.message)
    else setNotice({ kind: 'error', text: result.message })
  }

  const retrySession = () => { setNotice(null); setBootKey(key => key + 1) }

  const saveRename = async (event: FormEvent) => {
    event.preventDefault()
    const clean = nameDraft.trim().slice(0, 32)
    if (!clean) { setModal(null); return }
    if (location.screen === 'start') { setEngineer(clean); setModal(null); return }
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

  const createProject = async (event: FormEvent, withCall = false) => {
    event.preventDefault()
    if (busy || voice.status.phase !== 'idle' || (requestRef.current && !requestRef.current.signal.aborted) || (!withCall && !prompt.trim())) return
    if (!principalId) { setNotice({ kind: 'error', text: 'No session is open yet. Try again in a moment.' }); return }
    const request = beginRequest()
    if (!request) return
    setNotice(null)
    let callProject: LiveProject | null = null
    // Only the exact repository and ref the operator opted in routes to the shared project; the pasted URL alone never mutates anything.
    const demo = pendingRepo && matchesDemoProject(demoProject, pendingRepo.url, pendingRepo.ref) ? demoProject : null
    const create = async () => {
      const created = await rangerApi.createProject({ prompt: prompt.trim() || 'Discuss my project with Ranger.', engineerName: engineer, ...(demo ? { demoProjectId: demo.projectId } : pendingRepo ? { repository: pendingRepo.url, repositoryRef: pendingRepo.ref } : {}) }, request.controller.signal)
      if (!operationEpochRef.current.isCurrent(request.operation)) return null
      const outcome = planCreateOutcome(created)
      if (!created.ok) {
        finishRequest(request.operation)
        if (outcome.kind === 'recovered') {
          lastProjectIdRef.current = outcome.projectId
          setPrompt(''); setPendingRepo(null)
          navigate('workspace', outcome.projectId)
          if (outcome.reason === 'unauthorized') reportFailure(created)
          else setNotice({ kind: 'error', text: outcome.message })
        } else reportFailure(created)
        return null
      }
      if (outcome.kind !== 'created') return null
      const { projectId } = outcome
      if (demo) rememberDemoConversation(projectId, created.data.conversationId)
      if (withCall) {
        const loaded = await rangerApi.loadProject(projectId, request.controller.signal, demo ? created.data.conversationId : undefined)
        if (!operationEpochRef.current.isCurrent(request.operation)) return null
        if (!loaded.ok) {
          finishRequest(request.operation)
          navigate('workspace', projectId)
          reportFailure(loaded)
          return null
        }
        callProject = loaded.data
        return created.data
      }
      finishRequest(request.operation)
      lastProjectIdRef.current = projectId
      setPrompt(''); setPendingRepo(null)
      navigate('workspace', projectId)
      fastUntilRef.current = Date.now() + EVENT_BOOST_MS
      return created.data
    }
    if (!withCall) { await create(); return }
    await voice.start(create)
    if (!operationEpochRef.current.isCurrent(request.operation)) return
    finishRequest(request.operation)
    if (callProject) {
      const next: LiveProject = callProject
      applyProject(next)
      setPrompt(''); setPendingRepo(null)
      navigate('workspace', next.projectId, false, true)
      fastUntilRef.current = Date.now() + EVENT_BOOST_MS
    }
  }

  const openRepo = () => {
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
    setModal(null); setNotice({ kind: 'success', text: 'Repository connected. Preparation progress is shown in the workspace.' }); boostPolling()
  }

  const selectContextFiles = (files: FileList | null) => {
    const names = files ? Array.from(files, file => file.name) : []
    setContextFiles(names)
    if (names.length) setNotice({ kind: 'info', text: 'Files are selected locally in this browser only. They are not uploaded and Ranger cannot read them.' })
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
    const reviewed = planReview.state === 'ready' && planReview.value.ok ? planReview.value.data.plan : null
    if (!activeProject || !activeProject.conversationId || !reviewed || !accept) return
    const request = beginRequest()
    if (!request) return
    setModalError(null)
    const { projectId, conversationId } = activeProject
    const latest = await rangerApi.getPlanState(projectId, request.controller.signal)
    if (!operationEpochRef.current.isCurrent(request.operation)) return
    if (!latest.ok) { finishRequest(request.operation); reportFailure(latest, true); return }
    if (!sameReviewedPlan(reviewed, latest.data.plan)) {
      finishRequest(request.operation)
      setPlanReview({ state: 'ready', value: latest })
      patchProject(projectId, latest.data)
      setModalError('The plan changed while you were reviewing it. Review the latest version before approving.')
      return
    }
    const result = await rangerApi.decidePlan({ projectId, conversationId, approved: true, planId: reviewed.planId, permittedScope: reviewed.permittedScope }, request.controller.signal)
    if (!result.ok) { finishRequest(request.operation); reportFailure(result, true); return }
    if (!result.data.accepted) {
      finishRequest(request.operation)
      setNotice({ kind: 'error', text: 'The backend did not accept this approval. Review the latest plan and try again.' })
      return
    }
    // Approval is the authorization: start the approved run in the same request window.
    const { approvalId } = result.data
    const started = approvalId === null ? null : await rangerApi.startRun(projectId, conversationId, approvalId, request.controller.signal)
    if (!finishRequest(request.operation)) return
    approvalRef.current = approvalId === null ? null : { projectId, approvalId }
    patchProject(projectId, { approved: true })
    setModal(null)
    if (started !== null && started.ok) setNotice({ kind: 'success', text: `Plan version ${reviewed.version} approved. The run is starting in the VM.` })
    else setNotice({ kind: 'error', text: `Plan version ${reviewed.version} approved, but the run did not start${started !== null && !started.ok ? `: ${started.message}` : '.'} Use Start work in the chat to try again.` })
    boostPolling()
  }

  const startWork = async () => {
    const approval = approvalRef.current
    if (!activeProject?.conversationId || approval === null || approval.projectId !== activeProject.projectId) {
      setNotice({ kind: 'error', text: 'No active approval is loaded here. Approve the plan again from Review plan.' })
      return
    }
    const request = beginRequest()
    if (!request) return
    const started = await rangerApi.startRun(activeProject.projectId, activeProject.conversationId, approval.approvalId, request.controller.signal)
    if (!finishRequest(request.operation)) return
    if (!started.ok) { reportFailure(started); return }
    setNotice({ kind: 'success', text: 'Work started in the VM.' })
    boostPolling()
  }

  const stopRun = async (runId: string) => {
    if (!activeProject || stopping) return
    const request = beginRequest()
    if (!request) {
      // Never swallow the click: another request holds the API client.
      setNotice({ kind: 'info', text: 'Wait for the current request to finish, then stop the run.' })
      return
    }
    setStopping(true)
    const result = await rangerApi.cancelRun(activeProject.projectId, runId, request.controller.signal)
    if (!finishRequest(request.operation)) { setStopping(false); return }
    if (!result.ok) { setStopping(false); reportFailure(result); return }
    // Cancellation is cooperative: the run stays visible until the worker stops it.
    setNotice({ kind: 'info', text: 'Stop requested. Ranger ends the run and destroys its VM.' })
    boostPolling()
  }

  useEffect(() => {
    // Only an authoritative run list may clear the stopping state; a loading or
    // failed read says nothing about whether the run ended. An empty list has no
    // run at index 0, so read it as null here just like the render does.
    if (evidence.state !== 'ready' || !evidence.value.runs.ok || evidence.value.projectId !== activeProject?.projectId) return
    const run = evidence.value.runs.data[0] ?? null
    if (run === null || (run.state !== 'queued' && run.state !== 'running')) setStopping(false)
  }, [evidence, activeProject?.projectId])

  const mediaTarget = principalId !== null && activeProject?.conversationId
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
    if (!activeProject || !activeProject.conversationId) return
    const request = beginRequest()
    if (!request) return
    const { projectId, conversationId } = activeProject
    const result = await rangerApi.sendMessage(projectId, conversationId, clean, request.controller.signal)
    if (!finishRequest(request.operation)) return
    if (!result.ok) { reportFailure(result); return }
    setMessage('')
    patchProject(projectId, { messages: [...(projectRef.current?.messages ?? []), { role: 'user', content: clean }] })
    setNotice(null)
    boostPolling()
  }

  const cancelRequest = () => {
    invalidateRequest()
    if (location.screen === 'start') voice.stop()
    setBusy(false); setNotice({ kind: 'info', text: 'Request cancelled.' })
  }

  const openLiveWorkspace = () => {
    const id = lastProjectIdRef.current
    if (id) navigate('workspace', id)
    else navigate('start')
  }

  const viewEngineer = projectViewEngineerName(activeProject?.engineerName)
  const projectName = activeProject?.name ?? 'Project'

  return <div className="app-shell">
    {location.screen === 'home' && <Landing onStart={() => navigate('start')} onWorkspace={openLiveWorkspace} />}
    {location.screen === 'start' && <Composer engineer={engineer} repoLabel={pendingRepo?.url ?? null} repoConnected={pendingRepo !== null} contextFiles={contextFiles} prompt={prompt} busy={busy} auth={auth} capabilities={capabilities} voice={voiceStatus} setPrompt={setPrompt} onContextFiles={selectContextFiles} onConnectRepo={openRepo} onRetrySession={retrySession} onRename={openRename} onSubmit={createProject} onStartCall={event => { void createProject(event, true) }} onCancel={cancelRequest} onHome={() => navigate('home')} />}
    {location.screen === 'workspace' && <Workspace demoProjectId={demoProject?.projectId} engineer={viewEngineer} projectName={projectName} project={activeProject} status={liveStatus} auth={auth} capabilities={capabilities} eventFeed={eventFeed} workspaceView={workspaceView} evidence={evidence} tab={workspaceTab} setTab={setWorkspaceTab} messages={activeProject?.messages ?? []} message={message} busy={busy} setMessage={setMessage} onSend={sendMessage} onReviewPlan={() => openModal('plan')} onConnectRepo={openRepo} onRetrySession={retrySession} onRetry={refreshLive} onRefreshEvents={refreshLive} onStartProject={() => navigate('start')} onReview={() => navigate('review')} onHome={() => navigate('home')} onRename={openRename} live={activeProject ? liveMedia : null} stopping={stopping} canStartWork={approvalRef.current !== null && approvalRef.current.projectId === activeProject?.projectId} onStopRun={runId => { void stopRun(runId) }} onStartWork={() => { void startWork() }} />}
    {location.screen === 'review' && <Review engineer={viewEngineer} projectName={projectName} status={liveStatus} auth={auth} notice={notice} projectId={activeProject?.projectId ?? null} evidence={evidence} onRefresh={refreshLive} onRetrySession={retrySession} onRetry={refreshLive} onStartProject={() => navigate('start')} onWorkspace={() => navigate('workspace')} onChecks={() => { navigate('workspace'); setWorkspaceTab('checks') }} onHome={() => navigate('home')} onRename={openRename} onReviewPlan={() => openModal('plan')} />}
    {notice && <div className={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.text}</span><button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}
    {modal && <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) closeModal() }}><div ref={dialogRef} className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      {modal === 'name' ? <form onSubmit={saveRename}><p className="eyebrow">YOUR ENGINEER</p><h2 id="modal-title">Give your engineer a name</h2><label className="field-label" htmlFor="engineer-name">Name</label><input ref={nameInputRef} id="engineer-name" autoComplete="off" maxLength={32} value={nameDraft} onChange={event => setNameDraft(event.target.value)} />{modalError && <p role="alert">{modalError}</p>}<div className="modal-actions"><Button type="button" onClick={() => setModal(null)}>Cancel</Button><Button kind="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save name'}</Button></div></form>
        : modal === 'repo' ? <form onSubmit={submitRepo}><p className="eyebrow">REPOSITORY</p><h2 id="modal-title">Connect a repository</h2><p>Connect a public GitHub repository, then start a call and ask Ranger to prepare it. The code loads into one VM and Trace indexes it.</p><label className="field-label" htmlFor="repo-url">Public GitHub URL or local checkout path</label><input id="repo-url" type="text" autoComplete="off" spellCheck={false} placeholder="https://github.com/owner/repo" value={repoDraft.url} onChange={event => setRepoDraft(draft => ({ ...draft, url: event.target.value }))} /><p className="small-muted">Use a public github.com URL without credentials. Local paths must be operator-approved checkouts on the Ranger server.</p><label className="field-label" htmlFor="repo-ref">Branch or tag</label><input id="repo-ref" autoComplete="off" value={repoDraft.ref} onChange={event => setRepoDraft(draft => ({ ...draft, ref: event.target.value }))} />{modalError && <p role="alert">{modalError}</p>}<div className="modal-actions"><Button type="button" onClick={() => setModal(null)}>Cancel</Button><Button kind="primary" type="submit" disabled={busy}>{busy ? 'Connecting…' : activeProject ? 'Connect repository' : 'Use repository'}</Button></div></form>
        : modal === 'manual' ? <form onSubmit={submitManualPlan}><p className="eyebrow">MANUAL PLAN</p><h2 id="modal-title">Write a plan by hand</h2><p>Your plan is saved as a new version and still needs approval.</p><label className="field-label" htmlFor="manual-items">Steps, one per line</label><textarea id="manual-items" rows={5} style={fieldStyle} value={planDraft.items} onChange={event => setPlanDraft(draft => ({ ...draft, items: event.target.value }))} /><label className="field-label" htmlFor="manual-criteria">Acceptance criteria, one per line</label><textarea id="manual-criteria" rows={4} style={fieldStyle} value={planDraft.criteria} onChange={event => setPlanDraft(draft => ({ ...draft, criteria: event.target.value }))} />{modalError && <p role="alert">{modalError}</p>}<div className="modal-actions"><Button type="button" onClick={() => setModal(null)}>Cancel</Button><Button kind="primary" type="submit" disabled={busy || !activeProject?.conversationId}>{busy ? 'Saving…' : 'Save manual plan'}</Button></div></form>
        : <LivePlanDialog review={planReview} busy={busy} modalError={modalError} blockers={executionBlockers(capabilityValue)} onClose={closeModal} onApprove={() => decidePlan(true)} onWriteNew={() => openModal('manual')} />}
    </div></div>}
  </div>
}

function LivePlanDialog({ review, busy, modalError, blockers, onClose, onApprove, onWriteNew }: { review: ReadState<ApiResult<PlanState>>; busy: boolean; modalError: string | null; blockers: string[]; onClose: () => void; onApprove: () => void; onWriteNew: () => void }) {
  if (review.state !== 'ready') return <><h2 id="modal-title">Loading the latest plan…</h2><p role="status">Checking for a new plan version before review.</p><Button onClick={onClose}>Close</Button></>
  if (!review.value.ok) return <><h2 id="modal-title">Plan unavailable</h2><p role="alert">{review.value.message}</p><p>Close and reopen Review plan to try again.</p><Button onClick={onClose}>Close</Button></>
  const { plan, approved } = review.value.data
  if (!plan) return <><p className="eyebrow">PLAN REVIEW</p><h2 id="modal-title">No plan yet</h2><p className="muted">No plan version is recorded. Ask Ranger on the call to draft a plan, or write one by hand. Every new version needs your review and approval.</p><div className="modal-actions"><Button onClick={onClose}>Close</Button><Button kind="primary" onClick={onWriteNew}>Write manual plan</Button></div></>
  return <><p className="eyebrow">PLAN REVIEW · VERSION {plan.version}</p><h2 id="modal-title">{approved ? 'Approved plan' : 'Review this plan'}</h2><p className="muted">Approving binds exactly this version and the scope below, then starts the run.</p>
    <div style={{ maxHeight: '42vh', overflowY: 'auto' }}>
      <p className="field-label">Steps</p><ul className="plan-list">{plan.items.map((item, i) => <li key={`${item}-${i}`}>{item}</li>)}</ul>
      <p className="field-label">Acceptance criteria</p><ul className="plan-list">{plan.acceptanceCriteria.length ? plan.acceptanceCriteria.map((item, i) => <li key={`${item}-${i}`}>{item}</li>) : <li>None recorded.</li>}</ul>
      <p className="field-label">Permitted scope</p><ul className="plan-list">{plan.permittedScope.length ? plan.permittedScope.map((item, i) => <li key={`${item}-${i}`}><code>{item}</code></li>) : <li>No scope is permitted by this plan.</li>}</ul>
    </div>
    {blockers.length > 0 && <p className="muted" role="status">Execution is blocked: {blockers.join(' ')}</p>}
    {modalError && <p role="alert">{modalError}</p>}
    <div className="modal-actions"><Button onClick={onClose}>Close</Button><Button disabled={busy} onClick={onWriteNew}>Write a new version</Button>{!approved && <Button kind="primary" disabled={busy} onClick={onApprove}>{busy ? 'Starting…' : 'Approve and start work'}</Button>}</div></>
}

function SessionStatus({ auth, onRetry }: { auth: Auth; onRetry: () => void }) {
  if (auth.state === 'checking') return <p className="small-muted" role="status">Opening a session…</p>
  if (auth.state === 'failed') return <div role="alert" className="detail-card"><p className="small-muted">Could not open a Ranger session: {auth.message}</p><Button onClick={onRetry}>Try again</Button></div>
  return null
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

function Landing({ onStart, onWorkspace }: { onStart: () => void; onWorkspace: () => void }) {
  return <main className="landing">
    <header className="site-header"><a href="/" onClick={event => { event.preventDefault(); window.history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')) }}><Brand /></a><nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><button onClick={onWorkspace}>Workspace</button><a href="#github">GitHub</a></nav><div className="header-actions"><Button onClick={onStart}>Meet your engineer</Button></div></header>
    <section className="hero"><div className="hero-title"><p className="eyebrow">YOUR AI FORWARD DEPLOYED ENGINEER</p><h1>Show the problem.<br />Build the fix.</h1><RangeMark enter /></div><div className="hero-copy"><p>A call, a shared screen, and an engineer who stays until it works.</p><div className="hero-actions"><Button kind="primary" onClick={onStart}>Start a project <span aria-hidden="true">↗</span></Button></div></div></section>
    <section className="stage-wrap" aria-label="Ranger workspace preview"><div className="stage-bg" /><div className="stage-card"><WorkspacePreview /></div><p className="stage-caption">A working session, with the plan and changes in view.</p></section>
    <WorkflowMotion />
    <section id="how-it-works" className="how-section"><div className="section-title"><p className="eyebrow">A PRACTICAL WAY TO WORK</p><h2>The context is in your head.<br />The work happens here.</h2><p>Show Ranger what you do. Build the part you wish existed.</p></div><div className="step-grid"><Step number="01" title="Talk it through" body="Share your screen and explain the messy bits. Ranger asks the questions a good engineer would." visual={<MiniWave />} /><Step number="02" title="Let it work" body="Review your plan, make a plan, and build in its own workspace. You can see every step." visual={<MiniTrace />} /><Step number="03" title="Try it together" body="Open the working app, review the changes, and ask for the next thing. The conversation carries on." visual={<MiniCheck />} /></div></section>
    <section className="closing-cta"><div><p className="eyebrow">START WITH A CONVERSATION</p><h2>Your next integration starts with a call.</h2><p>Give your engineer a name. Give it something worth solving.</p></div><Button kind="primary" onClick={onStart}>Meet your engineer <span aria-hidden="true">↗</span></Button></section>
    <footer className="site-footer"><Brand small /><div><a id="github" href="https://github.com/akshatcoder-hash/ranger" target="_blank" rel="noreferrer">GitHub ↗</a><a href="mailto:hello@ranger.local">Contact</a></div></footer>
  </main>
}

function Step({ number, title, body, visual }: { number: string; title: string; body: string; visual: React.ReactNode }) {
  return <article className="step-card"><div className="step-visual">{visual}</div><p className="step-number">{number} /</p><h3>{title}</h3><p>{body}</p></article>
}

function WorkspacePreview() {
  return <><div className="stage-preview-header"><Brand small /><span className="breadcrumbs">Projects <span>/</span> your-repository</span><StatusPill tone="gray">Preview</StatusPill></div><div className="stage-preview-body"><aside className="stage-rail" aria-hidden="true"><span>⌂</span><span>⌕</span><span>◷</span><span>▦</span></aside><div className="stage-chat"><h3>Ask about your code</h3><p className="small-muted">Paste a public GitHub repository to begin.</p><p className="speaker-label">YOU</p><p className="quote">“Where do we decide which discount applies at checkout?”</p><div className="speech-bubble">Answers come from the indexed repository, with the files they came from.</div><div className="plan-saved"><strong>Saved to the plan</strong><span>Changes wait for your approval.</span></div></div><div className="stage-work"><div className="stage-tabs"><span>Workspace</span><span>Changes</span><span>Checks</span></div><article className="detail-card"><h3>What happens after you paste a repository</h3><ol className="plan-list"><li>A VM is provisioned for the project</li><li>The repository is cloned into it</li><li>Trace indexes the code</li><li>You ask questions, review a plan, approve it, and watch it run</li></ol></article></div></div></>
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

function MiniWave() { return <div className="mini-wave-wrap"><StatusPill>Example call</StatusPill><div className="waveform" aria-label="Sample audio waveform">{Array.from({ length: 38 }, (_, i) => <i key={i} style={{ '--bar-height': `${8 + ((i * 17 + 7) % 25)}px` } as React.CSSProperties} />)}</div><p>“Let us approve the refund first.”</p></div> }
function MiniTrace() { return <div className="mini-trace"><strong>⌘ Example · order-service</strong>{['src/routes/orders.ts', 'src/policies/returns.ts', 'src/integrations/support.ts'].map((x, i) => <p key={x}><code>{x}</code><span>{i === 2 ? '+ New' : 'Read'}</span></p>)}</div> }
function MiniCheck() { return <div className="mini-check"><StatusPill>Example</StatusPill><div><strong>Return my order</strong><small>Order found. Reply drafted.</small></div><p>✓ Order lookup  ·  ✓ Approval rules</p></div> }

function Composer({ engineer, repoLabel, repoConnected, contextFiles, prompt, busy, auth, capabilities, voice, setPrompt, onContextFiles, onConnectRepo, onRetrySession, onRename, onSubmit, onStartCall, onCancel, onHome }: { engineer: string; repoLabel: string | null; repoConnected: boolean; contextFiles: string[]; prompt: string; busy: boolean; auth: Auth; capabilities: CapabilityState; voice: VoiceStatus; setPrompt: (value: string) => void; onContextFiles: (files: FileList | null) => void; onConnectRepo: () => void; onRetrySession: () => void; onRename: () => void; onSubmit: (event: FormEvent) => void; onStartCall: (event: FormEvent) => void; onCancel: () => void; onHome: () => void }) {
  const connected = auth.state === 'connected'
  const callBlocked = providerGate(capabilities.state, capabilities.state === 'ready' ? capabilities.value : null)
  return <main className="composer-page"><header className="composer-header"><button className="brand-button" onClick={onHome}><Brand /></button><div className="header-actions"><button className="header-link" onClick={onHome}>Your projects</button><button className="avatar" aria-label="Your profile">AS</button></div></header>
    <div className="composer-art" />
    <section className="composer-content"><p className="eyebrow">A NEW PROJECT</p><h1>What are we building?</h1><p className="composer-subtitle">Start with the problem. We’ll figure out the rest together.</p>
      <SessionStatus auth={auth} onRetry={onRetrySession} />
      {connected && <CapabilityStrip capabilities={capabilities} />}
      <form className="composer-card" onSubmit={onSubmit}><label className="sr-only" htmlFor="project-prompt">Describe the problem you want to solve</label><textarea id="project-prompt" autoFocus placeholder="I want to connect our support inbox to our order system…" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={2000} />
        <button type="button" className={`repo-row ${repoConnected ? 'repo-connected' : ''}`} onClick={onConnectRepo}><span className="repo-icon" aria-hidden="true">⌘</span><strong>{repoConnected && repoLabel ? repoLabel : 'Connect a repository'}</strong><span className="repo-state">{repoConnected ? 'Selected' : 'Paste a GitHub URL'}</span></button>
        <div className="composer-controls"><button className="attach-button" type="button" onClick={() => document.getElementById('context-upload')?.click()}><span aria-hidden="true">＋</span> Add context{contextFiles.length ? ` · ${contextFiles.length} selected` : ''}</button><input id="context-upload" className="sr-only" type="file" multiple onChange={event => onContextFiles(event.currentTarget.files)} />
          <div className="media-controls">{busy ? <Button type="button" onClick={onCancel}>Cancel</Button> : <><Button type="button" onClick={onStartCall} disabled={!connected || callBlocked !== null || voice.cleanup.phase !== 'idle'} title={callBlocked ?? undefined}>Start call</Button><Button kind="primary" type="submit" disabled={!prompt.trim() || !connected}>Send <span aria-hidden="true">↑</span></Button></>}</div>
        </div>
      </form>
      <p className="small-muted">Your repository prepares when the project is created, with or without a call. Prefer talking? Start a call without typing.</p>
      {voice.phase === 'starting' && <p role="status" className="small-muted">{voice.step === 'permission' ? 'Allow microphone access to start your call.' : 'Opening your project and connecting the call…'}</p>}
      {voice.error && <p role="alert" className="small-muted">{voice.error}</p>}
      {contextFiles.length > 0 && <p className="context-note">{contextFiles.join(' · ')} <span>Selected locally; not uploaded.</span></p>}
      <div className="suggestions"><Button onClick={() => setPrompt('Explain how this repository is structured and where the main logic lives.')}>Explain this repo</Button><Button onClick={() => setPrompt('Connect two tools I use every day and carry the right context between them.')}>Connect two tools</Button><Button onClick={() => setPrompt('Fix a workflow that keeps making us do the same thing by hand.')}>Fix a workflow</Button></div>
      <p className="engineer-label">Your engineer’s name is {engineer}. <button onClick={onRename}>Change name</button></p>
    </section>
  </main>
}

function LiveGate({ status, auth, onRetrySession, onRetry, onStartProject }: { status: LiveStatus; auth: Auth; onRetrySession: () => void; onRetry: () => void; onStartProject: () => void }) {
  if (status.kind === 'ok') return null
  if (status.kind === 'checking' || status.kind === 'session-failed') return <SessionStatus auth={auth} onRetry={onRetrySession} />
  if (status.kind === 'loading') return <p className="small-muted" role="status">Loading project…</p>
  if (status.kind === 'error') return <div role="alert"><p className="small-muted">Could not load this project: {status.message}</p><Button onClick={onRetry}>Try again</Button></div>
  return <div className="empty-conversation"><EmptyPlate /><h2>{status.kind === 'invalid' ? 'Project not found' : 'No project selected'}</h2><p>{status.kind === 'invalid' ? 'This address is not a Ranger project.' : 'Start a project to open its workspace.'}</p><Button kind="primary" onClick={onStartProject}>Start a project</Button></div>
}

function Workspace({ demoProjectId, engineer, projectName, project, status, auth, capabilities, eventFeed, workspaceView, evidence, tab, setTab, messages, message, busy, setMessage, onSend, onReviewPlan, onConnectRepo, onRetrySession, onRetry, onRefreshEvents, onStartProject, onReview, onHome, onRename, live, stopping, canStartWork, onStopRun, onStartWork }: { demoProjectId?: string; engineer: string; projectName: string; project: LiveProject | null; status: LiveStatus; auth: Auth; capabilities: CapabilityState; eventFeed: EventFeed; workspaceView: WorkspaceView; evidence: ReadState<ProjectEvidence>; tab: WorkspaceTab; setTab: (tab: WorkspaceTab) => void; messages: LiveProject['messages']; message: string; busy: boolean; setMessage: (value: string) => void; onSend: (event: FormEvent) => void; onReviewPlan: () => void; onConnectRepo: () => void; onRetrySession: () => void; onRetry: () => void; onRefreshEvents: () => void; onStartProject: () => void; onReview: () => void; onHome: () => void; onRename: () => void; live: LiveMedia | null; stopping: boolean; canStartWork: boolean; onStopRun: (runId: string) => void; onStartWork: () => void }) {
  const canMessage = status.kind === 'ok' && !!project?.conversationId
  const historyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const history = historyRef.current
    if (history) history.scrollTop = history.scrollHeight
  }, [messages.length, project?.conversationId])
  const gate = <LiveGate status={status} auth={auth} onRetrySession={onRetrySession} onRetry={onRetry} onStartProject={onStartProject} />
  return <main className="workspace-page">
    <header className="workspace-topbar"><button className="brand-button" onClick={onHome}><Brand /></button><span className="breadcrumbs">Projects <span>/</span> {projectName}</span><div className="topbar-right">{auth.state === 'connected' ? <StatusPill>Guest session</StatusPill> : <StatusPill tone="amber">No session</StatusPill>}</div></header>
    <div className="workspace-layout"><aside className="rail" aria-label="Workspace navigation"><button aria-label="Projects" onClick={onHome}>⌂</button><button aria-label="Search" onClick={() => {}}>⌕</button><button aria-label="History" onClick={() => {}}>◷</button><button aria-label="Connections" onClick={() => {}}>▦</button><button className="rail-avatar" onClick={onRename}>AS</button></aside>
      <section className="conversation-panel" aria-label="Conversation with your engineer"><div className="conversation-title"><span>{engineer}</span></div><h1>{projectName}</h1><p className="small-muted">{project ? (project.repositoryUrl ? `Repository: ${project.repositoryUrl}` : 'No repository connected') : ''}</p><hr />
        <div ref={historyRef} className="conversation-history" tabIndex={0} aria-label="Conversation history">
        {live && <LiveMediaPanel live={live} />}
        {status.kind !== 'ok' || !project ? gate
          : <>{messages.length ? <><p className="speaker-label">CONVERSATION</p>{messages.map((item, i) => <div className="message-bubble" data-role={item.role} key={i}><span className="message-author">{item.role === 'user' ? 'You' : item.role === 'agent' ? engineer : 'System'}</span>{item.content}</div>)}</> : <div className="empty-conversation"><EmptyPlate /><h2>No messages yet</h2><p>{project.conversationId ? 'Ask about the code or request a change. No call needed.' : 'This project has no conversation to write to.'}</p></div>}
            <ChatActivity
              events={eventFeed.projectId === project.projectId ? eventFeed.events : []}
              status={eventFeed.projectId === project.projectId ? eventFeed.status : 'idle'}
              error={eventFeed.projectId === project.projectId ? eventFeed.error : undefined}
              preparation={eventFeed.projectId === project.projectId ? eventFeed.preparation ?? latestPreparation(eventFeed.events) : null}
              run={evidence.state === 'ready' && evidence.value.projectId === project.projectId && evidence.value.runs.ok ? evidence.value.runs.data[0] ?? null : null}
              tools={evidence.state === 'ready' && evidence.value.projectId === project.projectId && evidence.value.tools?.ok ? evidence.value.tools.data : null}
              planVersion={project.plan?.version ?? null}
              approved={project.approved}
              canStartWork={canStartWork}
              busy={busy}
              stopping={stopping}
              onStopRun={onStopRun}
              onStartWork={onStartWork}
              onReviewPlan={onReviewPlan}
              onShowAll={() => setTab('workspace')}
              onRefresh={onRefreshEvents}
            />
            <div className="media-controls" style={{ marginTop: 10 }}>{project.projectId !== demoProjectId && <Button disabled={busy} onClick={onConnectRepo}>{project.repositoryUrl ? 'Change repository' : 'Connect repository'}</Button>}</div></>}
        </div>
        <form className="message-form" onSubmit={onSend}><label className="sr-only" htmlFor="workspace-message">Type a message</label><input id="workspace-message" placeholder={canMessage ? 'Ask about the code, or request a change…' : 'Messaging is unavailable'} disabled={!canMessage} value={message} onChange={event => setMessage(event.target.value)} /><button aria-label="Send message" disabled={!message.trim() || busy || !canMessage}>↑</button></form>
      </section>
      <section className="work-panel"><div className="workspace-controls"><div className="tab-list" role="tablist" aria-label="Project details" onKeyDown={event => tabKeydown(event, setTab, ['workspace', 'changes', 'checks'])}>{(['workspace', 'changes', 'checks'] as const).map(item => <button key={item} role="tab" id={`tab-${item}`} aria-selected={tab === item} aria-controls="workspace-tab-panel" tabIndex={tab === item ? 0 : -1} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div></div>
        <div id="workspace-tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="workspace-tab-panel">
          {tab === 'workspace' ? status.kind === 'ok' && project ? <LiveWorkspace project={project} capabilities={capabilities} eventFeed={eventFeed} workspaceView={workspaceView} evidence={evidence} onRefresh={onRefreshEvents} onReviewPlan={onReviewPlan} onReview={onReview} /> : <LiveEmpty title="No project loaded" detail="Open a project to see its repository, VM and preparation state." />
            : tab === 'changes' ? status.kind === 'ok' && project ? <LiveResults evidence={evidence} projectId={project.projectId} view="changes" onRefresh={onRefreshEvents} onReview={onReview} /> : gate
            : status.kind === 'ok' && project ? <LiveResults evidence={evidence} projectId={project.projectId} view="checks" onRefresh={onRefreshEvents} /> : gate}
        </div>
      </section>
    </div>
  </main>
}

function LiveWorkspace({ project, capabilities, eventFeed, workspaceView, evidence, onRefresh, onReviewPlan, onReview }: { project: LiveProject; capabilities: CapabilityState; eventFeed: EventFeed; workspaceView: WorkspaceView; evidence: ReadState<ProjectEvidence>; onRefresh: () => void; onReviewPlan: () => void; onReview: () => void }) {
  const sameProject = eventFeed.projectId === project.projectId
  const allEvents = sameProject ? eventFeed.events : []
  // A visitor's own conversation in the shared demo project starts a fresh view; a failed attempt from before it is not current state.
  const demoConversation = recallDemoConversation(project.projectId)
  const scoped = demoConversation !== undefined && demoConversation === project.conversationId
  const events = scoped ? eventsSinceConversation(allEvents, demoConversation) : allEvents
  const latest = sameProject ? eventFeed.preparation ?? latestPreparation(allEvents) : null
  const preparation = scoped ? latestPreparation(events) ?? (latest && latest.phase !== 'failed' ? latest : null) : latest
  const workspace = workspaceView.projectId === project.projectId ? workspaceView : { projectId: project.projectId, status: null }
  return <div style={{ display: 'grid', gap: 14 }}>
    <div className="workspace-providers" aria-label="Provider status"><CapabilityStrip capabilities={capabilities} /></div>
    <PreparationCard repositoryUrl={project.repositoryUrl} preparation={preparation} events={events} clock={sameProject ? eventFeed.clock : null} workspaceState={scoped ? workspace.status?.observedState ?? (workspace.error ? 'unavailable' : 'checking') : undefined} />
    <VmPanel key={project.projectId} projectId={project.projectId} workspace={workspace} onStopped={onRefresh} />
    <article className="detail-card"><h3>Plan and approval</h3><p className="small-muted">Ask for a change in the message box and draft a plan. Review its steps and scope, then approve it: approval starts the run.</p><Button onClick={onReviewPlan}>Review plan</Button></article>
    <LiveResults evidence={evidence} projectId={project.projectId} view="summary" onRefresh={onRefresh} onReview={onReview} />
  </div>
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
    {voice.phase === 'live' && <p className="small-muted" role="status">Your microphone is sending audio through Ranger to xAI. Audio isn’t recorded.{voice.responding ? ' Ranger is speaking.' : ''}</p>}
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
    {screen.phase === 'sharing' && <p className="small-muted" role="status">Ranger receives about one frame per second and inspects only when asked. It can’t record or control your screen. {screen.lastFrame ? `${screen.framesSent} sent, latest ${screen.lastFrame.width}×${screen.lastFrame.height} at ${time(screen.lastFrame.capturedAt)}.` : 'No frame has reached Ranger yet.'}{screen.framesDropped > 0 ? ` ${screen.framesDropped} skipped.` : ''}</p>}
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
        ? <><p className="small-muted">Ranger’s reading of the frame captured at {time(inspection.sourceTimestamp)} (frame {inspection.sourceFrameId}). {inspection.freshness === 'stale' ? 'Newer frames may be available. ' : ''}It can be wrong.</p><ul className="plan-list">{inspection.observations.map((item, i) => <li key={`${item.text}-${i}`}>{item.text} <small>({Math.round(item.uncertainty * 100)}% uncertain)</small></li>)}</ul></>
        : <p className="small-muted">No current frame was available ({inspection.freshness}), so nothing was inspected. Wait for the next frame and try again.</p>}
    </div>}
  </div>
}

function LiveEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className="live-empty"><EmptyPlate /><h2>{title}</h2><p>{detail}</p></div>
}

function tabKeydown(event: KeyboardEvent<HTMLDivElement>, setTab: (tab: WorkspaceTab) => void, tabs: WorkspaceTab[]) {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
  event.preventDefault(); const current = tabs.indexOf(document.activeElement?.id.replace('tab-', '') as WorkspaceTab)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  setTab(tabs[next]); requestAnimationFrame(() => document.getElementById(`tab-${tabs[next]}`)?.focus())
}

function Review({ engineer, projectName, status, auth, notice, projectId, evidence, onRefresh, onRetrySession, onRetry, onStartProject, onWorkspace, onChecks, onHome, onRename, onReviewPlan }: { engineer: string; projectName: string; status: LiveStatus; auth: Auth; notice: Notice | null; projectId: string | null; evidence: ReadState<ProjectEvidence>; onRefresh: () => void; onRetrySession: () => void; onRetry: () => void; onStartProject: () => void; onWorkspace: () => void; onChecks: () => void; onHome: () => void; onRename: () => void; onReviewPlan: () => void }) {
  return <main className="review-page"><header className="workspace-topbar"><button className="brand-button" onClick={onHome}><Brand /></button><span className="breadcrumbs">Projects <span>/</span> {projectName}</span><div className="topbar-right">{auth.state === 'connected' ? <StatusPill>Guest session</StatusPill> : <StatusPill tone="amber">No session</StatusPill>}<Button onClick={onWorkspace}>Open workspace</Button></div></header>
    <div className="review-layout"><aside className="review-sidebar"><p className="eyebrow">PROJECT</p><h2>{projectName}</h2><nav aria-label="Project views"><button onClick={onWorkspace}>Conversation</button><button disabled={status.kind !== 'ok'} onClick={onReviewPlan}>Plan</button><button className="active" aria-current="page">Changes</button><button onClick={onChecks}>Checks</button><button onClick={onWorkspace}>Workspace</button></nav><div className="review-engineer"><p>{engineer}</p><Button onClick={onRename}>Change name</Button><Button onClick={onWorkspace}>Open workspace</Button></div></aside>
      <section className="review-content"><div className="review-heading"><div><h1>Review changes</h1><p>Observed run state, workspace evidence and executed test commands.</p></div></div>
        <div className="live-review-empty">{status.kind === 'ok' && projectId ? <LiveResults evidence={evidence} projectId={projectId} view="review" onRefresh={onRefresh} /> : <LiveGate status={status} auth={auth} onRetrySession={onRetrySession} onRetry={onRetry} onStartProject={onStartProject} />}{notice && notice.kind !== 'error' && <p role="status">{notice.text}</p>}</div>
      </section>
    </div>
  </main>
}

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { rangerApi } from '../api'
import { MediaLifecycle, OperationEpoch } from './lifecycle'

type Screen = 'home' | 'start' | 'workspace' | 'review'
type Mode = 'live' | 'demo'
type WorkspaceTab = 'workspace' | 'changes' | 'checks'
type Notice = { kind: 'error' | 'info' | 'success'; text: string }

function readLocation() {
  const path = window.location.pathname.split('/').filter(Boolean)
  const screen: Screen = path[0] === 'start' ? 'start' : path[0] === 'workspace' ? 'workspace' : path[0] === 'review' ? 'review' : 'home'
  return { screen, projectId: path[1] || 'northstar-return-support', mode: new URLSearchParams(window.location.search).get('mode') === 'demo' ? 'demo' as const : 'live' as const }
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
  const [modal, setModal] = useState<'name' | 'plan' | null>(null)
  const [nameDraft, setNameDraft] = useState(engineer)
  const [repoConnected, setRepoConnected] = useState(false)
  const [contextFiles, setContextFiles] = useState<string[]>([])
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('workspace')
  const [approved, setApproved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [message, setMessage] = useState('')
  const [messages, setMessages] = useState<string[]>([])
  const [mediaState, setMediaState] = useState<'idle' | 'requesting' | 'active'>('idle')
  const [mediaLifecycle] = useState(() => new MediaLifecycle(id => {
    void rangerApi.endMediaSession(id, new AbortController().signal)
  }))
  const mediaApiControllerRef = useRef<AbortController | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const operationEpochRef = useRef(new OperationEpoch())
  const previousModeRef = useRef(location.mode)
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const demo = location.mode === 'demo'

  const invalidateRequest = useCallback(() => {
    operationEpochRef.current.invalidate()
    requestRef.current?.abort()
    requestRef.current = null
    setBusy(false)
  }, [])

  const clearMedia = useCallback(() => {
    mediaApiControllerRef.current?.abort()
    mediaApiControllerRef.current = null
    mediaLifecycle.release()
    setMediaState('idle')
  }, [mediaLifecycle])

  const navigate = useCallback((screen: Screen, mode: Mode = location.mode, projectId = location.projectId, replace = false) => {
    invalidateRequest()
    clearMedia()
    const path = screen === 'home' ? '/' : screen === 'start' ? '/start' : `/${screen}/${encodeURIComponent(projectId)}`
    const query = mode === 'demo' ? '?mode=demo' : ''
    window.history[replace ? 'replaceState' : 'pushState']({}, '', `${path}${query}`)
    setLocation(readLocation())
    setNotice(null)
    if (screen === 'workspace') setWorkspaceTab('workspace')
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  }, [clearMedia, invalidateRequest, location.mode, location.projectId])

  useEffect(() => {
    const onPop = () => {
      invalidateRequest()
      clearMedia()
      setLocation(readLocation())
      setNotice(null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [clearMedia, invalidateRequest])

  useEffect(() => {
    if (previousModeRef.current === location.mode) return
    previousModeRef.current = location.mode
    invalidateRequest()
    clearMedia()
    setRepoConnected(false); setContextFiles([]); setApproved(false); setMessages([]); setMediaState('idle'); setBusy(false)
  }, [clearMedia, invalidateRequest, location.mode])

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
    requestAnimationFrame(() => (modal === 'name' ? nameInputRef.current : dialogRef.current?.querySelector<HTMLElement>('button'))?.focus())
    return () => { document.removeEventListener('keydown', onKey); previous?.focus() }
  }, [modal])

  useEffect(() => () => {
    mediaApiControllerRef.current?.abort()
    mediaLifecycle.release()
    requestRef.current?.abort()
  }, [mediaLifecycle])

  const openRename = () => { setNameDraft(engineer); setModal('name') }
  const saveRename = (event: FormEvent) => {
    event.preventDefault()
    const clean = nameDraft.trim().slice(0, 32)
    if (clean) setEngineer(clean)
    setModal(null)
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
    invalidateRequest()
    const controller = new AbortController(); requestRef.current = controller
    const operation = operationEpochRef.current.begin()
    setBusy(true)
    const result = await rangerApi.createProject({ prompt: prompt.trim(), engineerName: engineer, repository: repoConnected ? 'northstar/support-inbox' : undefined }, controller.signal)
    if (!operationEpochRef.current.isCurrent(operation)) return
    requestRef.current = null
    setBusy(false)
    if (result.ok) navigate('workspace', 'live', result.data.projectId)
    else if (result.reason !== 'aborted') setNotice({ kind: 'error', text: result.message })
  }

  const connectRepo = () => {
    if (demo) { setRepoConnected(true); setNotice({ kind: 'info', text: 'Sample repository connected for this walkthrough.' }) }
    else setNotice({ kind: 'error', text: 'Repository connection is unavailable until the backend contract is provided.' })
  }

  const selectContextFiles = (files: FileList | null) => {
    const names = files ? Array.from(files, file => file.name) : []
    setContextFiles(names)
    if (names.length) setNotice({ kind: 'info', text: demo ? 'Files are selected locally for this walkthrough; they are not uploaded.' : 'Files are selected locally. The backend upload contract is not available yet.' })
  }

  const decidePlan = async (accept: boolean) => {
    if (busy || (requestRef.current && !requestRef.current.signal.aborted)) return
    if (demo) { setApproved(accept); setModal(null); setNotice({ kind: 'success', text: accept ? 'Sample plan approved for this walkthrough.' : 'Plan sent back for changes.' }); return }
    invalidateRequest(); const controller = new AbortController(); requestRef.current = controller
    const operation = operationEpochRef.current.begin()
    setBusy(true)
    const result = await rangerApi.decidePlan({ approved: accept, planId: 'current' }, controller.signal)
    if (!operationEpochRef.current.isCurrent(operation)) return
    requestRef.current = null
    setBusy(false)
    if (result.ok) { setApproved(result.data.accepted); setModal(null) }
    else if (result.reason !== 'aborted') setNotice({ kind: 'error', text: result.message })
  }

  const startMedia = async (kind: 'voice' | 'screen') => {
    if (busy || mediaLifecycle.phase !== 'idle') return
    if (demo) { setMediaState('active'); setNotice({ kind: 'info', text: `Sample ${kind === 'voice' ? 'call' : 'screen share'} shown. No media is being recorded.` }); return }
    const operation = mediaLifecycle.begin()
    if (operation === null) return
    setMediaState('requesting'); setNotice(null)
    try {
      const stream = kind === 'voice'
        ? await navigator.mediaDevices.getUserMedia({ audio: true })
        : await navigator.mediaDevices.getDisplayMedia({ video: true })
      if (!mediaLifecycle.attach(operation, stream)) return
      const onTrackEnded = () => {
        if (mediaLifecycle.release(operation)) {
          mediaApiControllerRef.current?.abort()
          mediaApiControllerRef.current = null
          setMediaState('idle')
        }
      }
      stream.getTracks().forEach(track => track.addEventListener('ended', onTrackEnded, { once: true }))
      if (!mediaLifecycle.isCurrent(operation)) return
      const controller = new AbortController()
      mediaApiControllerRef.current = controller
      const result = await rangerApi.startMediaSession({ kind, stream }, controller.signal)
      if (!mediaLifecycle.isCurrent(operation)) {
        if (result.ok) void rangerApi.endMediaSession(result.data.id, new AbortController().signal)
        return
      }
      mediaApiControllerRef.current = null
      if (!result.ok) {
        mediaLifecycle.release(operation)
        setMediaState('idle'); setNotice({ kind: 'error', text: result.message }); return
      }
      mediaLifecycle.setSession(operation, result.data.id)
      if (!mediaLifecycle.activate(operation)) return
      setMediaState('active')
    } catch (error) {
      if (!mediaLifecycle.isCurrent(operation)) return
      mediaApiControllerRef.current = null
      mediaLifecycle.release(operation); setMediaState('idle')
      const messageText = error instanceof DOMException && error.name === 'NotAllowedError' ? 'Permission was declined. You can try again when you are ready.' : 'Media could not be started in this browser.'
      setNotice({ kind: 'error', text: messageText })
    }
  }

  const stopMedia = () => {
    clearMedia(); setNotice({ kind: 'info', text: 'Media stopped.' })
  }

  const sendMessage = (event: FormEvent) => {
    event.preventDefault()
    const clean = message.trim()
    if (!clean || busy) return
    if (!demo) { setNotice({ kind: 'error', text: 'Messaging is unavailable until the backend contract is provided.' }); return }
    setMessages(items => [...items, clean]); setMessage('')
  }

  const cancelRequest = () => {
    invalidateRequest()
    if (mediaLifecycle.phase === 'requesting') clearMedia()
    setBusy(false); setNotice({ kind: 'info', text: 'Request cancelled.' })
  }

  return <div className="app-shell">
    {location.screen === 'home' && <Landing demo={demo} onStart={() => navigate('start')} onDemo={() => navigate('start', 'demo')} onWorkspace={() => navigate('workspace', demo ? 'demo' : 'live')} />}
    {location.screen === 'start' && <Composer demo={demo} engineer={engineer} repoConnected={repoConnected} contextFiles={contextFiles} prompt={prompt} busy={busy} notice={notice} setPrompt={setPrompt} onContextFiles={selectContextFiles} onConnectRepo={connectRepo} onRename={openRename} onStartCall={() => demo ? navigate('workspace', 'demo') : startMedia('voice')} onSubmit={createProject} onCancel={cancelRequest} onHome={() => navigate('home')} onDemo={() => navigate('start', 'demo')} />}
    {location.screen === 'workspace' && <Workspace demo={demo} engineer={engineer} tab={workspaceTab} setTab={setWorkspaceTab} approved={approved} mediaState={mediaState} messages={messages} message={message} setMessage={setMessage} onSend={sendMessage} onReviewPlan={() => setModal('plan')} onReview={() => navigate('review')} onHome={() => navigate('home')} onRename={openRename} onStartVoice={() => startMedia('voice')} onStartScreen={() => startMedia('screen')} onStopMedia={stopMedia} onCancel={cancelRequest} />}
    {location.screen === 'review' && <Review demo={demo} engineer={engineer} approved={approved} notice={notice} onWorkspace={() => navigate('workspace')} onHome={() => navigate('home')} onRename={openRename} onReviewPlan={() => setModal('plan')} />}
    {notice && <div className={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.text}</span><button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}
    {modal && <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) setModal(null) }}><div ref={dialogRef} className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      {modal === 'name' ? <form onSubmit={saveRename}><p className="eyebrow">YOUR ENGINEER</p><h2 id="modal-title">Give your engineer a name</h2><label className="field-label" htmlFor="engineer-name">Name</label><input ref={nameInputRef} id="engineer-name" autoComplete="off" maxLength={32} value={nameDraft} onChange={event => setNameDraft(event.target.value)} /><div className="modal-actions"><Button type="button" onClick={() => setModal(null)}>Cancel</Button><Button kind="primary" type="submit">Save name</Button></div></form>
        : <><p className="eyebrow">PLAN REVIEW</p><h2 id="modal-title">Before Ranger starts</h2><p className="muted">Review what will change. You can still talk through the plan before approving it.</p><ul className="plan-list"><li>Find the order behind each ticket</li><li>Apply the current return policy</li><li>Draft the customer reply</li><li>Ask before issuing a refund</li></ul><div className="modal-actions"><Button disabled={busy} onClick={() => decidePlan(false)}>Request changes</Button><Button kind="primary" disabled={busy} onClick={() => decidePlan(true)}>{busy ? 'Saving…' : 'Approve plan'}</Button></div></>}
    </div></div>}
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

function Composer({ demo, engineer, repoConnected, contextFiles, prompt, busy, notice, setPrompt, onContextFiles, onConnectRepo, onRename, onStartCall, onSubmit, onCancel, onHome, onDemo }: { demo: boolean; engineer: string; repoConnected: boolean; contextFiles: string[]; prompt: string; busy: boolean; notice: Notice | null; setPrompt: (value: string) => void; onContextFiles: (files: FileList | null) => void; onConnectRepo: () => void; onRename: () => void; onStartCall: () => void; onSubmit: (event: FormEvent) => void; onCancel: () => void; onHome: () => void; onDemo: () => void }) {
  return <main className="composer-page"><header className="composer-header"><button className="brand-button" onClick={onHome}><Brand /></button><div className="header-actions"><button className="header-link" onClick={onHome}>Your projects</button><button className="avatar" aria-label="Your profile">AS</button></div></header>
    <div className="composer-art" />{demo && <div className="composer-demo"><DemoTag /></div>}
    <section className="composer-content"><p className="eyebrow">A NEW PROJECT</p><h1>What are we building?</h1><p className="composer-subtitle">Start with the problem. We’ll figure out the rest together.</p>
      <form className="composer-card" onSubmit={onSubmit}><label className="sr-only" htmlFor="project-prompt">Describe the problem you want to solve</label><textarea id="project-prompt" autoFocus placeholder="I want to connect our support inbox to our order system…" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={2000} />
        <button type="button" className={`repo-row ${repoConnected ? 'repo-connected' : ''}`} onClick={onConnectRepo}><span className="repo-icon" aria-hidden="true">⌘</span><strong>{repoConnected ? 'northstar / support-inbox' : 'Connect a repository'}</strong><span className="repo-state">{repoConnected ? (demo ? 'Sample' : 'Connected') : 'Choose repo'}</span></button>
        <div className="composer-controls"><button className="attach-button" type="button" onClick={() => document.getElementById('context-upload')?.click()}><span aria-hidden="true">＋</span> Add context{contextFiles.length ? ` · ${contextFiles.length} selected` : ''}</button><input id="context-upload" className="sr-only" type="file" multiple onChange={event => onContextFiles(event.currentTarget.files)} />
          <div>{busy ? <Button type="button" onClick={onCancel}>Cancel</Button> : <><Button kind="primary" type="button" onClick={onStartCall}>Start a call ↗</Button><Button kind="secondary" type="submit" disabled={!prompt.trim()}>Send <span aria-hidden="true">↑</span></Button></>}</div>
        </div>
      </form>
      {contextFiles.length > 0 && <p className="context-note">{contextFiles.join(' · ')} <span>Selected locally; not uploaded.</span></p>}
      <div className="suggestions"><Button onClick={() => setPrompt('Connect two tools I use every day and carry the right context between them.')}>Connect two tools</Button><Button onClick={() => setPrompt('Fix a workflow that keeps making us do the same thing by hand.')}>Fix a workflow</Button><Button onClick={() => setPrompt('Show me your screen and I’ll walk through what I need.')}>Show you my screen</Button></div>
      <p className="engineer-label">Your engineer’s name is {engineer}. <button onClick={onRename}>Change name</button></p>
      <p className="live-note">{demo ? 'Sample walkthrough: actions stay in this browser.' : 'Live mode. Calls and project creation need the Ranger backend connection.'}</p>
      <button className="text-link demo-switch" onClick={onDemo}>{demo ? 'Switch to live mode' : 'Open sample walkthrough'}</button>
    </section>
  </main>
}

function Workspace({ demo, engineer, tab, setTab, approved, mediaState, messages, message, setMessage, onSend, onReviewPlan, onReview, onHome, onRename, onStartVoice, onStartScreen, onStopMedia, onCancel }: { demo: boolean; engineer: string; tab: WorkspaceTab; setTab: (tab: WorkspaceTab) => void; approved: boolean; mediaState: 'idle' | 'requesting' | 'active'; messages: string[]; message: string; setMessage: (value: string) => void; onSend: (event: FormEvent) => void; onReviewPlan: () => void; onReview: () => void; onHome: () => void; onRename: () => void; onStartVoice: () => void; onStartScreen: () => void; onStopMedia: () => void; onCancel: () => void }) {
  return <main className="workspace-page">
    <header className="workspace-topbar"><button className="brand-button" onClick={onHome}><Brand /></button><span className="breadcrumbs">Projects <span>/</span> Northstar <span>/</span> Order support</span><div className="topbar-right">{demo ? <DemoTag /> : <StatusPill tone="amber">Backend disconnected</StatusPill>}<Button>Share</Button></div></header>
    {demo && <div className="workspace-demo-strip"><DemoTag /><span>Sample conversation, repository, and change set. No real work has run.</span></div>}
    <div className="workspace-layout"><aside className="rail" aria-label="Workspace navigation"><button aria-label="Projects" onClick={onHome}>⌂</button><button aria-label="Search" onClick={() => {}}>⌕</button><button aria-label="History" onClick={() => {}}>◷</button><button aria-label="Connections" onClick={() => {}}>▦</button><button className="rail-avatar" onClick={onRename}>AS</button></aside>
      <section className="conversation-panel" aria-label="Conversation with your engineer"><div className="conversation-title"><span>{engineer}</span>{demo && <StatusPill>Sample call</StatusPill>}</div><h1>Order support</h1><p className="small-muted">Northstar / customer operations</p><hr />
        {demo ? <><VoiceCard mediaState={mediaState} onStartVoice={onStartVoice} onStartScreen={onStartScreen} onStopMedia={onStopMedia} /><p className="speaker-label">YOU</p><p className="quote">“Every morning we copy the order details here before replying.”</p><div className="speech-bubble"><p className="speaker-label">YOUR ENGINEER</p><p>I can connect those steps. Should refunds always wait for someone on your team?</p></div><p className="speaker-label">YOU</p><p className="quote">Yes. Draft the reply, but let us approve the refund.</p><button className="plan-saved" onClick={onReviewPlan}><strong>{approved ? 'Plan approved' : 'Saved to the plan'}</strong><span>Refunds need your approval. <u>Review plan</u></span></button>{messages.map((item, i) => <div className="message-bubble" key={`${item}-${i}`}>{item}</div>)}</> : <div className="empty-conversation"><span className="empty-icon">↗</span><h2>No conversation yet</h2><p>Start a call to share context with {engineer}. Your microphone is only requested when you choose to start.</p><Button kind="primary" onClick={onStartVoice}>Start a call</Button></div>}
        <div className="conversation-spacer" />
        <div className="media-controls">{mediaState === 'active' ? <Button onClick={onStopMedia}>End media</Button> : <><Button onClick={onStartVoice} disabled={mediaState === 'requesting'}>{mediaState === 'requesting' ? 'Waiting for permission…' : 'Start call'}</Button><Button onClick={onStartScreen} disabled={mediaState === 'requesting'}>Share screen</Button></>}{demo && mediaState === 'active' && <StatusPill>Sample</StatusPill>}</div>
        <form className="message-form" onSubmit={onSend}><label className="sr-only" htmlFor="workspace-message">Type a message</label><input id="workspace-message" placeholder="Or type a message…" value={message} onChange={event => setMessage(event.target.value)} /><button aria-label="Send message" disabled={!message.trim()}>↑</button></form>
      </section>
      <section className="work-panel"><div className="workspace-controls"><div className="tab-list" role="tablist" aria-label="Project details" onKeyDown={event => tabKeydown(event, setTab, ['workspace', 'changes', 'checks'])}>{(['workspace', 'changes', 'checks'] as const).map(item => <button key={item} role="tab" id={`tab-${item}`} aria-selected={tab === item} aria-controls="workspace-tab-panel" tabIndex={tab === item ? 0 : -1} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}{item === 'changes' && demo && <span className="tab-count">4</span>}</button>)}</div><div className="build-controls">{demo ? <StatusPill tone="violet">{tab === 'checks' ? 'Checks passed' : 'Building'}</StatusPill> : <StatusPill tone="gray">Waiting for backend</StatusPill>}<Button disabled={!demo} onClick={onCancel}>Pause</Button></div></div>
        <div id="workspace-tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="workspace-tab-panel">
          {tab === 'workspace' ? demo ? <SampleWorkspace onReview={onReview} /> : <LiveEmpty title="Working computer is not connected" detail="The workspace API and repository events are not configured yet. No files or checks are being reported as live." /> : tab === 'changes' ? demo ? <SampleChanges onReview={onReview} /> : <LiveEmpty title="No change set available" detail="Ranger has not reported any code changes. Connect the backend before reviewing a diff." /> : demo ? <SampleChecks onReview={onReview} /> : <LiveEmpty title="No checks have run" detail="Acceptance checks will appear here after the backend contract is connected." />}
        </div>
        <p className="work-footnote">{demo ? 'Sample activity for design review.' : 'Live activity will appear here when the backend is connected.'}</p>
      </section>
    </div>
  </main>
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
  return <div className="live-empty"><span className="empty-icon">⌁</span><h2>{title}</h2><p>{detail}</p><p className="muted">Try the labeled sample walkthrough to explore the interface.</p></div>
}

function tabKeydown(event: KeyboardEvent<HTMLDivElement>, setTab: (tab: WorkspaceTab) => void, tabs: WorkspaceTab[]) {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
  event.preventDefault(); const current = tabs.indexOf(document.activeElement?.id.replace('tab-', '') as WorkspaceTab)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  setTab(tabs[next]); requestAnimationFrame(() => document.getElementById(`tab-${tabs[next]}`)?.focus())
}

function Review({ demo, engineer, approved, notice, onWorkspace, onHome, onRename, onReviewPlan }: { demo: boolean; engineer: string; approved: boolean; notice: Notice | null; onWorkspace: () => void; onHome: () => void; onRename: () => void; onReviewPlan: () => void }) {
  return <main className="review-page"><header className="workspace-topbar"><button className="brand-button" onClick={onHome}><Brand /></button><span className="breadcrumbs">Projects <span>/</span> Northstar <span>/</span> Order support</span><div className="topbar-right">{demo ? <DemoTag /> : <StatusPill tone="amber">Backend disconnected</StatusPill>}<Button onClick={onWorkspace}>Open preview ↗</Button></div></header>
    <div className="review-layout"><aside className="review-sidebar"><p className="eyebrow">NORTHSTAR</p><h2>Order support</h2><nav aria-label="Project views"><button onClick={onWorkspace}>Conversation</button><button onClick={onReviewPlan}>Plan</button><button className="active" aria-current="page">Changes <span>4</span></button><button onClick={onWorkspace}>Checks</button><button onClick={onWorkspace}>Workspace</button></nav><div className="review-engineer"><p>{engineer}</p><Button onClick={onRename}>Change name</Button><Button onClick={onWorkspace}>Start a call</Button></div></aside>
      <section className="review-content"><div className="review-heading"><div>{demo && <p className="eyebrow">SAMPLE WALKTHROUGH</p>}<h1>{demo ? 'Your integration is ready.' : 'Review changes'}</h1><p>{demo ? 'Order lookup, reply drafts and a human check before every refund.' : 'No live changes are available until the backend reports a change set.'}</p></div><Button kind="primary" onClick={onWorkspace}>Try it now ↗</Button></div>
        {demo ? <><div className="checks-banner review-banner"><div><h2>All 6 checks passed</h2><p>Tested against the {approved ? 'plan you approved' : 'sample plan'}.</p></div><span className="review-summary">4 files changed</span><span className="review-summary">+128  −12</span></div><div className="review-cards"><article className="detail-card full-diff"><h3>What changed</h3><p className="file-path">src/integrations/order-support.ts</p><pre><span className="diff-context"> 18  const order = await orders.find(ticket.orderId);</span>{'\n'}<span className="diff-context"> 19  if (!order) return requestOrderDetails(ticket);</span>{'\n'}<span className="diff-context"> 20  </span>{'\n'}<span className="diff-add">+21  const policy = await policies.get("returns");</span>{'\n'}<span className="diff-add">+22  const reply = await draftReply(ticket, order, policy);</span>{'\n'}<span className="diff-add">+23  await tickets.saveDraft(ticket.id, reply);</span>{'\n'}<span className="diff-add">+24  </span>{'\n'}<span className="diff-add">+25  if (reply.refundRequested) {'{'}</span>{'\n'}<span className="diff-add">+26    await approvals.request({'{'}</span>{'\n'}<span className="diff-add">+27      ticketId: ticket.id,</span>{'\n'}<span className="diff-add">+28      orderId: order.id,</span>{'\n'}<span className="diff-add">+29      amount: order.total,</span>{'\n'}<span className="diff-add">+30    {'})'}</span>{'\n'}<span className="diff-add">+31  {'}}'}</span></pre></article><article className="detail-card plan-checks"><h3>Checked against your plan</h3>{[['Order found', 'The draft uses the right order.'], ['Order missing', 'Asks the customer for details.'], ['Duplicate ticket', 'Only one draft is created.'], ['Order service offline', 'Retries, then asks for help.'], ['Refund requested', 'Waits for human approval.'], ['Policy changed', 'Uses the latest return window.']].map(([title, sub]) => <p key={title}><strong>✓ {title}</strong><small>{sub}</small></p>)}</article></div><div className="change-question"><div><h3>Want to change anything?</h3><p>Talk it through or leave a note. Your engineer keeps the context.</p></div><Button onClick={onWorkspace}>Ask for a change</Button></div></> : <div className="live-review-empty"><LiveEmpty title="No changes to review" detail="The backend has not reported a diff or acceptance checks. This screen is kept empty until those results are available." />{notice && <p role="status">{notice.text}</p>}</div>}
      </section>
    </div>
  </main>
}

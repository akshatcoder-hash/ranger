import { useEffect, useRef, useState } from 'react'
import type { DesktopInput } from '../api'
import { Button } from './primitives'
import { vmInputQueue, vmPoint } from './vmScreen'

const KEYS: Record<string, string> = {
  Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Delete: 'Delete',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  Home: 'Home', End: 'End', PageUp: 'Page_Up', PageDown: 'Page_Down',
}

export function VmDesktop({ projectId, base64, interactive }: { projectId: string; base64: string; interactive: boolean }) {
  const [control, setControl] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const image = useRef<HTMLImageElement>(null)
  const send = useRef<(input: DesktopInput) => void>(() => {})
  const down = useRef<{ x: number; y: number; button: number } | null>(null)
  const click = useRef<{ input: DesktopInput; timer: ReturnType<typeof setTimeout> } | null>(null)
  const lastMove = useRef(0)
  const flushClick = () => {
    if (!click.current) return
    clearTimeout(click.current.timer)
    send.current(click.current.input)
    click.current = null
  }
  useEffect(() => {
    if (!control || !interactive) return
    const controller = new AbortController()
    send.current = vmInputQueue(projectId, controller.signal, message => { setError(message); setControl(false) })
    const release = () => setControl(false)
    const target = image.current
    const wheel = (event: WheelEvent) => {
      if (!target) return
      event.preventDefault()
      if (click.current) {
        clearTimeout(click.current.timer)
        send.current(click.current.input)
        click.current = null
      }
      send.current({ action: 'scroll', ...vmPoint(target, event.clientX, event.clientY), direction: event.deltaY < 0 ? 'up' : 'down', amount: 3 })
    }
    target?.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('blur', release)
    return () => {
      controller.abort()
      send.current = () => {}
      down.current = null
      if (click.current) clearTimeout(click.current.timer)
      click.current = null
      target?.removeEventListener('wheel', wheel)
      window.removeEventListener('blur', release)
    }
  }, [control, interactive, projectId])

  return <div onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControl(false) }}>
    {interactive && <div className="media-controls"><Button type="button" onClick={() => {
      setError(null)
      setControl(!control)
      if (!control) image.current?.focus()
    }}>{control ? 'Release control' : 'Control VM'}</Button>
      {control && <Button type="button" onClick={() => { flushClick(); send.current({ action: 'press', keys: ['Escape'] }) }}>Send Escape</Button>}
    </div>}
    {control && <p className="small-muted">Mouse and keyboard control active. Click, double-click, drag, scroll or type. Escape releases control. Screen refresh is not instant.</p>}
    {error && <p role="alert" className="small-muted">{error}</p>}
    <img ref={image} className="vm-shot" alt="VM desktop" src={`data:image/png;base64,${base64}`} draggable={false}
      tabIndex={interactive ? 0 : -1} role={control ? 'application' : undefined} aria-label={control ? 'Interactive VM desktop. Escape releases control.' : undefined}
      style={control ? { cursor: 'crosshair', touchAction: 'none', outline: '2px solid #4e8061' } : undefined}
      onContextMenu={event => { if (control) event.preventDefault() }}
      onPointerDown={event => {
        if (!control) return
        event.preventDefault()
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        down.current = { ...vmPoint(event.currentTarget, event.clientX, event.clientY), button: event.button }
      }}
      onPointerUp={event => {
        if (!control || !down.current) return
        const from = down.current
        down.current = null
        const to = vmPoint(event.currentTarget, event.clientX, event.clientY)
        if (Math.hypot(to.x - from.x, to.y - from.y) > 4 && from.button === 0) {
          flushClick()
          send.current({ action: 'drag', x: from.x, y: from.y, toX: to.x, toY: to.y })
        } else if (click.current?.input.action === 'click' && from.button === 0 && Math.hypot(click.current.input.x - to.x, click.current.input.y - to.y) < 4) {
          clearTimeout(click.current.timer)
          click.current = null
          send.current({ action: 'click', ...to, double: true })
        } else {
          flushClick()
          const input: DesktopInput = { action: 'click', ...to, button: from.button === 2 ? 'right' : from.button === 1 ? 'middle' : 'left' }
          click.current = { input, timer: setTimeout(flushClick, 250) }
        }
      }}
      onPointerCancel={() => { down.current = null }}
      onPointerMove={event => {
        if (!control || event.buttons || Date.now() - lastMove.current < 200) return
        lastMove.current = Date.now()
        send.current({ action: 'move', ...vmPoint(event.currentTarget, event.clientX, event.clientY) })
      }}
      onPaste={event => {
        if (!control) return
        event.preventDefault()
        const text = event.clipboardData.getData('text/plain')
        if (text.length > 2000) { setError('Paste at most 2000 characters at a time.'); return }
        if (text) { flushClick(); send.current({ action: 'type', text }) }
      }}
      onKeyDown={event => {
        if (!control || event.nativeEvent.isComposing) return
        if (event.key === 'Escape') { event.preventDefault(); setControl(false); return }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return
        const key = KEYS[event.key] ?? (/^F(?:[1-9]|1[0-2])$/.test(event.key) ? event.key : null)
        if (!key && Array.from(event.key).length !== 1) return
        event.preventDefault()
        flushClick()
        if (!key && !event.ctrlKey && !event.altKey && !event.metaKey) send.current({ action: 'type', text: event.key })
        else send.current({ action: 'press', keys: [
          ...(event.ctrlKey || event.metaKey ? ['ctrl'] : []), ...(event.altKey ? ['alt'] : []),
          ...(event.shiftKey ? ['shift'] : []), key ?? (event.key === ' ' ? 'space' : event.key.toLowerCase()),
        ] })
      }} />
  </div>
}

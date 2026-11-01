import { useState } from 'react'
import type { RunRecord, RunTool } from '../api'
import { Button } from './primitives'
import type { ActivityEvent } from './activity'
import type { PreparationStatus } from './liveHelpers'
import { activityHeadline, chatSteps, runIsActive } from './chatSteps'

const MARK: Record<string, string> = { good: '✓', bad: '✕', warn: '!', neutral: '·' }

type Props = {
  events: readonly ActivityEvent[]
  status: 'idle' | 'polling' | 'paused' | 'error'
  error?: string
  preparation: PreparationStatus | null
  run: RunRecord | null
  tools: readonly RunTool[] | null
  planVersion: number | null
  approved: boolean
  canStartWork: boolean
  busy: boolean
  stopping: boolean
  onStopRun: () => void
  onStartWork: () => void
  onReviewPlan: () => void
  onShowAll: () => void
  onRefresh: () => void
}

/**
 * What Ranger is doing, inside the conversation: one measured sentence, the
 * recorded steps of the latest run, and the controls that end or start work.
 */
export function ChatActivity({ events, status, error, preparation, run, tools, planVersion, approved, canStartWork, busy, stopping, onStopRun, onStartWork, onReviewPlan, onShowAll, onRefresh }: Props) {
  const [confirming, setConfirming] = useState(false)
  const headline = activityHeadline({ run, tools, preparation, busy })
  const steps = chatSteps({ events, tools })
  const active = runIsActive(run)
  const startable = approved && canStartWork && !active && !busy
  return <section className="chat-activity" aria-label="What Ranger is doing">
    <div className="chat-activity-head">
      <p className="chat-now" data-tone={headline.tone} role="status">{headline.title}</p>
      {active && !confirming && <Button onClick={() => setConfirming(true)} disabled={stopping}>Stop work</Button>}
    </div>
    {active && confirming && <div className="chat-confirm" role="group" aria-label="Stop this run">
      <p role="status">Stopping ends this run and destroys its VM. The plan and its approval stay, so you can start again.</p>
      <div className="chat-activity-actions">
        <Button kind="primary" onClick={() => { setConfirming(false); onStopRun() }} disabled={stopping}>{stopping ? 'Stopping…' : 'Stop work'}</Button>
        <Button onClick={() => setConfirming(false)}>Keep working</Button>
      </div>
    </div>}
    {steps.length > 0 && <ol className="chat-steps" aria-label="Recent steps">
      {steps.map(step => <li className="chat-step" data-tone={step.tone} key={step.key}>
        <span className="chat-step-mark" aria-hidden="true">{MARK[step.tone] ?? MARK.neutral}</span>
        <div><strong>{step.title}</strong>{step.detail && <span>{step.detail}</span>}</div>
      </li>)}
    </ol>}
    {status === 'error' && <p className="small-muted" role="alert">Live updates stopped: {error ?? 'the project feed is unavailable.'} <button className="text-link" onClick={onRefresh}>Refresh</button></p>}
    <div className="chat-activity-actions">
      {startable && <Button kind="primary" onClick={onStartWork}>Start work</Button>}
      {planVersion !== null && !approved && <Button onClick={onReviewPlan}>Review plan v{planVersion}</Button>}
      {steps.length > 0 && <button className="text-link" onClick={onShowAll}>Show full activity</button>}
    </div>
  </section>
}

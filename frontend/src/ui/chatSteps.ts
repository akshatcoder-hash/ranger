import type { RunRecord, RunTool } from '../api'
import { describeEvent, isNoisyEvent, type ActivityEvent, type ActivityTone } from './activity'
import type { PreparationStatus } from './liveHelpers'

/**
 * The chat's own activity lines. The project events say what happened at the
 * project level; the run's recorded tool outcomes say what Ranger is doing
 * line by line. Both are real backend records, never inferred progress.
 */
export type ChatStep = { key: string; title: string; detail?: string; tone: ActivityTone }

const TOOL_TITLE: Record<string, string> = {
  search_code: 'Searched the code index',
  inspect_file: 'Read a file',
  list_files: 'Listed files',
  edit_file: 'Edited a file',
  run_command: 'Ran a command',
  run_tests: 'Ran the checks',
  launch_app: 'Launched the app',
  collect_evidence: 'Collected evidence',
}

const statusText = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const numberText = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** One recorded tool outcome as a plain sentence with the arguments it actually used. */
export function describeTool(tool: RunTool): ChatStep {
  const result = tool.result ?? {}
  const path = statusText(result.path)
  const command = statusText(result.command)
  const exitCode = numberText(result.exitCode)
  const passed = tool.name === 'run_tests' && exitCode !== undefined ? exitCode === 0 : null
  const detail = [path, command, exitCode !== undefined ? `exit ${exitCode}` : undefined, tool.error]
    .filter((item): item is string => item !== undefined)
    .join(' · ')
  const tone: ActivityTone = tool.status === 'ok' ? (passed === false ? 'bad' : 'good') : tool.status === 'denied' ? 'warn' : 'bad'
  return {
    key: tool.callId,
    title: TOOL_TITLE[tool.name] ?? tool.name.replace(/[_-]+/g, ' '),
    ...(detail === '' ? {} : { detail }),
    tone,
  }
}

const MEANINGFUL_EVENT = /^(workspace\.preparation|workspace\.command\.|repository\.|plan\.|run\.state\.|run\.scope\.)/

function dedupe(steps: readonly ChatStep[]): ChatStep[] {
  return steps.filter((step, index) => index === 0 || step.title !== steps[index - 1]?.title || step.detail !== steps[index - 1]?.detail)
}

/** What the chat shows: the latest run's tool steps when they exist, otherwise recent project activity. */
export function chatSteps(input: { events: readonly ActivityEvent[]; tools: readonly RunTool[] | null; limit?: number }): ChatStep[] {
  const limit = input.limit ?? 6
  // The run's own state is the headline; repeating it as a step would show two
  // answers for the same thing. Steps carry what actually happened.
  const activitySteps = input.events
    .filter(event => !isNoisyEvent(event) && MEANINGFUL_EVENT.test(event.type) && event.type !== 'run.state.changed')
    .map(event => ({ key: event.eventId, ...describeEvent(event) }))
  const toolSteps = (input.tools ?? []).map(describeTool)
  return dedupe(toolSteps.length > 0 ? [...activitySteps.slice(-1), ...toolSteps] : activitySteps).slice(-limit)
}

export type ChatHeadline = { title: string; tone: ActivityTone }

const PHASE_HEADLINE: Record<PreparationStatus['phase'], string> = {
  queued: 'Workspace queued for preparation.',
  preparing: 'Preparing the VM and loading the repository.',
  indexing: 'Indexing the repository with Trace.',
  ready: 'Workspace ready.',
  failed: 'Preparation failed. Start a new project, or reconnect this repository.',
}

/** One honest sentence for what Ranger is doing now. */
export function activityHeadline(input: { run: RunRecord | null; tools: readonly RunTool[] | null; preparation: PreparationStatus | null; busy: boolean }): ChatHeadline {
  const { run, tools, preparation, busy } = input
  if (run !== null) {
    const last = tools !== null && tools.length > 0 ? tools[tools.length - 1] : undefined
    if (run.state === 'queued') return { title: 'Work is queued. Ranger starts in a moment.', tone: 'neutral' }
    if (run.state === 'running') {
      if (last === undefined) return { title: 'Ranger is working in the VM.', tone: 'neutral' }
      const step = describeTool(last)
      return { title: `Working: ${step.title}${step.detail === undefined ? '' : ` (${step.detail})`}.`, tone: 'neutral' }
    }
    if (run.state === 'succeeded') {
      const edits = (tools ?? []).filter(tool => tool.name === 'edit_file' && tool.result?.saved === true).length
      const checks = [...(tools ?? [])].reverse().find(tool => tool.name === 'run_tests')
      const exitCode = checks ? numberText(checks.result?.exitCode) : undefined
      const facts = [edits > 0 ? `Files edited: ${edits}` : null, exitCode !== undefined ? `checks exit ${exitCode}` : null].filter((item): item is string => item !== null)
      return { title: `Finished${facts.length > 0 ? `. ${facts.join(' · ')}` : ''}.`, tone: 'good' }
    }
    if (run.state === 'failed') return { title: `The run failed${run.failureCode ? ` (${run.failureCode})` : ''}. Start the work again to retry.`, tone: 'bad' }
    return { title: 'Work stopped. Nothing is running.', tone: 'warn' }
  }
  if (busy) return { title: 'Sending your message…', tone: 'neutral' }
  if (preparation !== null && preparation.phase !== 'ready') {
    return { title: PHASE_HEADLINE[preparation.phase], tone: preparation.phase === 'failed' ? 'bad' : 'neutral' }
  }
  return { title: 'Idle. Ask for a change to start work.', tone: 'neutral' }
}

/** A run holds the worker until it is queued, running or cancelled. */
export function runIsActive(run: RunRecord | null): boolean {
  return run !== null && (run.state === 'queued' || run.state === 'running')
}

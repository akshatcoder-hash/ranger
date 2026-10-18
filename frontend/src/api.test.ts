import { describe, expect, it } from 'vitest'
import { UnconfiguredRangerApi } from './api'

describe('UnconfiguredRangerApi', () => {
  it('reports the absent contract instead of claiming a project was created', async () => {
    const result = await new UnconfiguredRangerApi().createProject({ prompt: 'Fix a flow', engineerName: 'Ranger' }, new AbortController().signal)
    expect(result).toEqual({ ok: false, reason: 'contract_missing', message: 'The Ranger backend contract is not connected yet.' })
  })

  it('preserves cancellation as a distinct result', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await new UnconfiguredRangerApi().decidePlan({ approved: true, planId: 'current' }, controller.signal)
    expect(result).toMatchObject({ ok: false, reason: 'aborted' })
  })

  it('never invents media sessions while no backend contract is configured', async () => {
    const result = await new UnconfiguredRangerApi().startMediaSession({ kind: 'voice', stream: {} as MediaStream }, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, reason: 'contract_missing' })
  })
})

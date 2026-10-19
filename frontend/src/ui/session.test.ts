import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ApiResult } from '../api'
import { bootSession } from './session'

const signal = new AbortController().signal
const principal: ApiResult<{ principalId: string }> = { ok: true, data: { principalId: 'prin_guest' } }
const failure = (reason: 'unauthorized' | 'unavailable' | 'backend'): ApiResult<{ principalId: string }> => ({ ok: false, reason, message: reason })

describe('bootSession', () => {
  it('reuses an existing session without opening a new one', async () => {
    const api = { getSession: vi.fn(async () => principal), openAnonymousSession: vi.fn(async () => principal) }
    expect(await bootSession(api, signal)).toBe(principal)
    expect(api.openAnonymousSession).not.toHaveBeenCalled()
  })

  it('opens exactly one anonymous session when signed out', async () => {
    const api = { getSession: vi.fn(async () => failure('unauthorized')), openAnonymousSession: vi.fn(async () => principal) }
    expect(await bootSession(api, signal)).toBe(principal)
    expect(api.getSession).toHaveBeenCalledTimes(1)
    expect(api.openAnonymousSession).toHaveBeenCalledTimes(1)
  })

  it('reports a failed anonymous session instead of retrying', async () => {
    const api = { getSession: vi.fn(async () => failure('unauthorized')), openAnonymousSession: vi.fn(async () => failure('backend')) }
    expect(await bootSession(api, signal)).toMatchObject({ ok: false, reason: 'backend' })
    expect(api.openAnonymousSession).toHaveBeenCalledTimes(1)
  })

  it('does not mint a principal when the backend is merely unreachable', async () => {
    const api = { getSession: vi.fn(async () => failure('unavailable')), openAnonymousSession: vi.fn(async () => principal) }
    expect(await bootSession(api, signal)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(api.openAnonymousSession).not.toHaveBeenCalled()
  })
})

describe('one live product', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
  const sources = ['./App.tsx', './LiveVm.tsx', './liveHelpers.ts', '../api.ts'].map(read).join('\n')

  it('never asks for a credential and has no demo mode', () => {
    expect(sources).not.toMatch(/type="password"|Access credential|RANGER_BOOTSTRAP_TOKEN|normalizeCredential|connectSession|browser-sessions/)
    expect(sources).not.toMatch(/mode=demo|DEMO_PROJECT_ID|Explore demo|SampleWorkspace|DemoTag/)
  })

  it('no longer claims a remote repository only saves a reference', () => {
    expect(sources).not.toMatch(/don.t load files|does not load files|only a reference|Saved as a reference/)
  })
})

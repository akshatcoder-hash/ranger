import { describe, expect, it } from 'vitest'
import { eventsSinceConversation, matchesDemoProject, recallDemoConversation, rememberDemoConversation, repositoryKey } from './demoAccess'

const DEMO = { projectId: 'prj_6f5b65e6-e85d-4380-9b52-67c7a12fde4c', repositoryUrl: 'https://github.com/satnaing/shadcn-admin', ref: 'HEAD' }

describe('demo repository matching', () => {
  it('accepts the exact repository and ref, tolerating case, .git and a trailing slash', () => {
    expect(matchesDemoProject(DEMO, 'https://github.com/satnaing/shadcn-admin', 'HEAD')).toBe(true)
    expect(matchesDemoProject(DEMO, ' https://GitHub.com/SatNaing/shadcn-admin.git/ ', ' HEAD ')).toBe(true)
  })

  it('rejects other repositories, refs, credentials, local paths and a missing opt-in', () => {
    expect(matchesDemoProject(DEMO, 'https://github.com/satnaing/shadcn-admin', 'main')).toBe(false)
    expect(matchesDemoProject(DEMO, 'https://github.com/satnaing/other', 'HEAD')).toBe(false)
    expect(matchesDemoProject(DEMO, 'https://github.com/satnaing/shadcn-admin/tree/main', 'HEAD')).toBe(false)
    expect(matchesDemoProject(DEMO, 'https://token@github.com/satnaing/shadcn-admin', 'HEAD')).toBe(false)
    expect(matchesDemoProject(DEMO, 'https://github.com/satnaing/shadcn-admin?x=1', 'HEAD')).toBe(false)
    expect(matchesDemoProject(DEMO, 'http://github.com/satnaing/shadcn-admin', 'HEAD')).toBe(false)
    expect(matchesDemoProject(DEMO, 'https://github.com:444/satnaing/shadcn-admin', 'HEAD')).toBe(false)
    expect(matchesDemoProject(DEMO, '/srv/checkouts/shadcn-admin', 'HEAD')).toBe(false)
    expect(matchesDemoProject(undefined, 'https://github.com/satnaing/shadcn-admin', 'HEAD')).toBe(false)
    expect(repositoryKey('not a url')).toBeNull()
  })
})

describe('demo event view', () => {
  const events = [
    { sequence: 1, type: 'workspace.preparation.updated', data: { phase: 'failed' } },
    { sequence: 2, type: 'conversation.created', data: { conversationId: 'cnv_a' } },
    { sequence: 3, type: 'conversation.created', data: { conversationId: 'cnv_b' } },
    { sequence: 4, type: 'retrieval.search.completed', data: { durationMs: 5 } },
  ]

  it('starts at the visitor\'s conversation and keeps nothing older', () => {
    expect(eventsSinceConversation(events, 'cnv_b').map(event => event.sequence)).toEqual([3, 4])
  })

  it('is empty until the conversation event is seen instead of showing older history', () => {
    expect(eventsSinceConversation(events, 'cnv_missing')).toEqual([])
  })
})

describe('demo conversation memory', () => {
  const memory = () => {
    const data = new Map<string, string>()
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
  }

  it('remembers the conversation only for its own project', () => {
    const store = memory()
    rememberDemoConversation(DEMO.projectId, 'cnv_a', store)
    expect(recallDemoConversation(DEMO.projectId, store)).toBe('cnv_a')
    expect(recallDemoConversation('prj_other', store)).toBeUndefined()
    expect(recallDemoConversation(null, store)).toBeUndefined()
  })

  it('survives unavailable storage', () => {
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(() => rememberDemoConversation(DEMO.projectId, 'cnv_a', blocked)).not.toThrow()
    expect(recallDemoConversation(DEMO.projectId, blocked)).toBeUndefined()
  })
})

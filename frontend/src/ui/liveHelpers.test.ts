import { describe, expect, it } from 'vitest'
import { DEMO_PROJECT_ID, applyEventPage, executionBlockers, isLiveProjectId, latestPreparation, mergeEvents, parseLines, normalizeCredential, planCreateOutcome, projectViewEngineerName, validateRepositoryInput } from './liveHelpers'

describe('isLiveProjectId', () => {
  it('accepts backend project ids and rejects the demo id', () => {
    expect(isLiveProjectId('prj_0e2f6c9a-2222-4c3d-9f4e-2b7c5d1a3f10')).toBe(true)
    expect(isLiveProjectId(DEMO_PROJECT_ID)).toBe(false)
    expect(isLiveProjectId('prj_../x')).toBe(false)
    expect(isLiveProjectId(null)).toBe(false)
  })
})

describe('parseLines', () => {
  it('trims and drops blank lines', () => {
    expect(parseLines('  one \n\n two\n   \n')).toEqual(['one', 'two'])
  })
})

describe('mergeEvents', () => {
  const event = (n: number) => ({ eventId: `e${n}`, sequence: n, type: 't' })

  it('dedupes replayed events and keeps sequence order', () => {
    const first = mergeEvents([], [event(2), event(1)])
    const second = mergeEvents(first, [event(2), event(3)])
    expect(second.map(item => item.sequence)).toEqual([1, 2, 3])
  })

  it('returns the same array when nothing is new', () => {
    const first = mergeEvents([], [event(1)])
    expect(mergeEvents(first, [event(1)])).toBe(first)
  })
})

describe('executionBlockers', () => {
  it('names each missing provider and treats unknown capabilities as blocked', () => {
    expect(executionBlockers({ xai: false, instabox: false, trace: true })).toHaveLength(2)
    expect(executionBlockers({ xai: true, instabox: true, trace: false })).toEqual([])
    expect(executionBlockers(null)).toHaveLength(1)
  })
})

describe('validateRepositoryInput', () => {
  it('accepts https, an absolute local path and a hostless file URL', () => {
    expect(validateRepositoryInput('https://github.com/o/r', 'main')).toBeNull()
    expect(validateRepositoryInput('/srv/checkouts/customer', 'main')).toBeNull()
    expect(validateRepositoryInput('file:///srv/checkouts/customer', 'main')).toBeNull()
  })

  it('rejects a remote host, embedded credentials and other schemes', () => {
    expect(validateRepositoryInput('git@github.com:o/r.git', 'main')).not.toBeNull()
    expect(validateRepositoryInput('http://github.com/o/r', 'main')).not.toBeNull()
    expect(validateRepositoryInput('https://user:pw@github.com/o/r', 'main')).not.toBeNull()
    expect(validateRepositoryInput('https://token@github.com/o/r', 'main')).not.toBeNull()
    expect(validateRepositoryInput('file://files.example/repo', 'main')).not.toBeNull()
    expect(validateRepositoryInput('file://user:pw@localhost/repo', 'main')).not.toBeNull()
    expect(validateRepositoryInput('ssh://git@github.com/o/r.git', 'main')).not.toBeNull()
    expect(validateRepositoryInput('https://github.com/o/r', 'a b')).not.toBeNull()
    expect(validateRepositoryInput('https://github.com/o/r', '')).not.toBeNull()
  })
})

describe('latestPreparation', () => {
  const prep = (sequence: number, data: Record<string, unknown>) => ({ eventId: `e${sequence}`, sequence, type: 'workspace.preparation.updated', data })

  it('keeps the latest phase and only the timings the event actually carried', () => {
    const status = latestPreparation([
      prep(1, { jobId: 'job_1', phase: 'queued' }),
      prep(4, { jobId: 'job_1', phase: 'indexing', fileCount: 1280, indexElapsedMs: 840, elapsedMs: 2100, repositoryCommit: 'abc123' }),
      prep(2, { jobId: 'job_1', phase: 'preparing' }),
    ])
    expect(status).toEqual({ jobId: 'job_1', phase: 'indexing', fileCount: 1280, indexElapsedMs: 840, elapsedMs: 2100, repositoryCommit: 'abc123' })
    expect(latestPreparation([...[prep(4, { jobId: 'job_1', phase: 'indexing', fileCount: 1280, indexElapsedMs: 840 })], prep(5, { jobId: 'job_1', phase: 'ready' })]))
      .toEqual({ jobId: 'job_1', phase: 'ready', fileCount: 1280, indexElapsedMs: 840 })
  })

  it('does not invent ready and ignores another event type or a phase without a job', () => {
    expect(latestPreparation([{ sequence: 1, type: 'repository.connected', data: { phase: 'ready', jobId: 'job_1' } }])).toBeNull()
    expect(latestPreparation([prep(1, { phase: 'ready' })])).toBeNull()
    const ready = latestPreparation([prep(1, { jobId: 'job_1', phase: 'ready' })])
    expect(ready?.phase).toBe('ready')
    expect(ready?.fileCount).toBeUndefined()
  })

  it('isolates status to the events it is given', () => {
    const other = latestPreparation([prep(9, { jobId: 'job_other', phase: 'ready', fileCount: 3 })])
    const current = latestPreparation([prep(1, { jobId: 'job_current', phase: 'preparing' })])
    expect(other?.jobId).toBe('job_other')
    expect(current).toEqual({ jobId: 'job_current', phase: 'preparing' })
  })
})

describe('planCreateOutcome', () => {
  const id = 'prj_0e2f6c9a-2222-4c3d-9f4e-2b7c5d1a3f10'

  it('passes a full success through unchanged', () => {
    expect(planCreateOutcome({ ok: true, data: { projectId: id } })).toEqual({ kind: 'created', projectId: id })
  })

  it('recovers the id from a partial failure', () => {
    const message = `Project ${id} and conversation cnv_1a2b were created, but the initial message was not saved.`
    expect(planCreateOutcome({ ok: false, reason: 'partial', message })).toMatchObject({ kind: 'recovered', projectId: id, message })
  })

  it('recovers the id when the backend rejected a later step after the project was created', () => {
    const message = `Project ${id} was created, but the conversation was not saved. Request rejected.`
    expect(planCreateOutcome({ ok: false, reason: 'backend', message })).toMatchObject({ kind: 'recovered', projectId: id })
  })

  it('does not fabricate an id when none is named', () => {
    expect(planCreateOutcome({ ok: false, reason: 'backend', message: 'Request rejected.' })).toMatchObject({ kind: 'failed', reason: 'backend' })
    expect(planCreateOutcome({ ok: false, reason: 'partial', message: 'Conversation cnv_0e2f6c9a was created.' })).toMatchObject({ kind: 'failed' })
  })

  it('never recovers from an aborted request', () => {
    expect(planCreateOutcome({ ok: false, reason: 'aborted', message: `Request cancelled for ${id}.` })).toEqual({ kind: 'aborted' })
  })
})

describe('applyEventPage', () => {
  const event = (n: number) => ({ eventId: `e${n}`, sequence: n })

  it('follows hasMore across a page of only duplicates when the cursor advances', () => {
    const first = applyEventPage({ events: [], cursor: undefined }, { events: [event(1), event(2)], cursor: 'c2', hasMore: true })
    expect(first).toMatchObject({ fetchMore: true, state: { cursor: 'c2' } })
    const dupes = applyEventPage(first.state, { events: [event(1), event(2)], cursor: 'c3', hasMore: true })
    expect(dupes.state.events).toBe(first.state.events)
    expect(dupes).toMatchObject({ fetchMore: true, state: { cursor: 'c3' } })
    const last = applyEventPage(dupes.state, { events: [event(3)], cursor: 'c4', hasMore: false })
    expect(last.fetchMore).toBe(false)
    expect(last.state.events.map(item => item.sequence)).toEqual([1, 2, 3])
  })

  it('reports an explicit error when hasMore does not advance the cursor', () => {
    const stalled = applyEventPage({ events: [], cursor: 'c2' }, { events: [], cursor: 'c2', hasMore: true })
    expect(stalled.fetchMore).toBe(false)
    expect(stalled.error).toBeTruthy()
    expect(applyEventPage({ events: [], cursor: undefined }, { events: [], hasMore: true }).error).toBeTruthy()
  })

  it('keeps the previous cursor when a finished page carries none', () => {
    const done = applyEventPage({ events: [], cursor: 'c2' }, { events: [], hasMore: false })
    expect(done).toMatchObject({ fetchMore: false, state: { cursor: 'c2' } })
    expect(done.error).toBeUndefined()
  })
})

describe('normalizeCredential', () => {
  it('accepts a bare token and trims whitespace', () => {
    expect(normalizeCredential('  rng_abc123\n')).toBe('rng_abc123')
  })

  it('accepts the exact bootstrap file line', () => {
    expect(normalizeCredential('RANGER_BOOTSTRAP_TOKEN=rng_abc123\n')).toBe('rng_abc123')
    expect(normalizeCredential('  RANGER_BOOTSTRAP_TOKEN= rng_abc123  ')).toBe('rng_abc123')
  })

  it('rejects empty values, empty prefixed values and multi-part input', () => {
    expect(normalizeCredential('   ')).toBeNull()
    expect(normalizeCredential('RANGER_BOOTSTRAP_TOKEN=')).toBeNull()
    expect(normalizeCredential('RANGER_BOOTSTRAP_TOKEN=rng_a rng_b')).toBeNull()
    expect(normalizeCredential('rng_a\nOTHER=secret')).toBeNull()
  })

  it('does not extract tokens from other prefixes', () => {
    expect(normalizeCredential('export RANGER_BOOTSTRAP_TOKEN=rng_abc')).toBeNull()
    expect(normalizeCredential('ranger_bootstrap_token=rng_abc')).toBe('ranger_bootstrap_token=rng_abc')
  })
})

describe('projectViewEngineerName', () => {
  it('never leaks a previous project name when no project is loaded', () => {
    expect(projectViewEngineerName(false, 'BinLabeler', null)).toBe('Ranger')
    expect(projectViewEngineerName(false, 'BinLabeler', undefined)).toBe('Ranger')
    expect(projectViewEngineerName(false, 'draft', 'Loaded')).toBe('Loaded')
  })

  it('uses the local name in demo mode', () => {
    expect(projectViewEngineerName(true, 'Sample', null)).toBe('Sample')
  })
})

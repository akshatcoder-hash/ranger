import { describe, expect, it } from 'vitest'
import { advancePreparationClock, applyEventPage, averageIndexRate, executionBlockers, formatBytes, formatDuration, indexingRate, isProjectId, latestPreparation, mergeEvents, parseLines, planCreateOutcome, preparationIsActive, projectViewEngineerName, validateRepositoryInput } from './liveHelpers'

describe('isProjectId', () => {
  it('accepts backend project ids and rejects anything else', () => {
    expect(isProjectId('prj_0e2f6c9a-2222-4c3d-9f4e-2b7c5d1a3f10')).toBe(true)
    expect(isProjectId('northstar-return-support')).toBe(false)
    expect(isProjectId('prj_../x')).toBe(false)
    expect(isProjectId(null)).toBe(false)
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

  it('does not tell the user a remote URL is only a reference', () => {
    for (const bad of ['ssh://git@github.com/o/r.git', 'http://github.com/o/r', 'git@github.com:o/r.git', 'https://user:pw@github.com/o/r', '']) {
      expect(validateRepositoryInput(bad, 'main') ?? '').not.toMatch(/reference|does not load|don.t load/i)
    }
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

describe('projectViewEngineerName', () => {
  it('never leaks a previous project name when no project is loaded', () => {
    expect(projectViewEngineerName(null)).toBe('Ranger')
    expect(projectViewEngineerName(undefined)).toBe('Ranger')
    expect(projectViewEngineerName('Loaded')).toBe('Loaded')
  })
})

describe('preparation speeds', () => {
  const prep = (sequence: number, data: Record<string, unknown>) => ({ eventId: `e${sequence}`, sequence, type: 'workspace.preparation.updated', data })

  it('carries cloneElapsedMs only when an event reported it', () => {
    const ready = latestPreparation([
      prep(1, { jobId: 'job_1', phase: 'preparing' }),
      prep(2, { jobId: 'job_1', phase: 'indexing', cloneElapsedMs: 2400, fileCount: 10 }),
      prep(3, { jobId: 'job_1', phase: 'ready', indexElapsedMs: 800, elapsedMs: 3500, byteCount: 2048, repositoryCommit: 'abc123' }),
    ])
    expect(ready).toEqual({ jobId: 'job_1', phase: 'ready', cloneElapsedMs: 2400, fileCount: 10, indexElapsedMs: 800, elapsedMs: 3500, byteCount: 2048, repositoryCommit: 'abc123' })
    expect(latestPreparation([prep(1, { jobId: 'job_1', phase: 'ready' })])?.cloneElapsedMs).toBeUndefined()
    expect(latestPreparation([prep(1, { jobId: 'job_1', phase: 'ready', cloneElapsedMs: -5 })])?.cloneElapsedMs).toBeUndefined()
  })

  it('does not carry fields across jobs', () => {
    const status = latestPreparation([prep(1, { jobId: 'job_1', phase: 'ready', fileCount: 9 }), prep(2, { jobId: 'job_2', phase: 'queued' })])
    expect(status).toEqual({ jobId: 'job_2', phase: 'queued' })
  })

  it('treats queued, preparing and indexing as active and ready, failed and nothing as finished', () => {
    expect(preparationIsActive({ jobId: 'j', phase: 'queued' })).toBe(true)
    expect(preparationIsActive({ jobId: 'j', phase: 'preparing' })).toBe(true)
    expect(preparationIsActive({ jobId: 'j', phase: 'indexing' })).toBe(true)
    expect(preparationIsActive({ jobId: 'j', phase: 'ready' })).toBe(false)
    expect(preparationIsActive({ jobId: 'j', phase: 'failed' })).toBe(false)
    expect(preparationIsActive(null)).toBe(false)
  })

  it('computes files per second from the last two consecutive indexing events', () => {
    const events = [
      prep(1, { jobId: 'job_1', phase: 'preparing' }),
      prep(2, { jobId: 'job_1', phase: 'indexing', fileCount: 100, indexElapsedMs: 1000 }),
      prep(3, { jobId: 'job_1', phase: 'indexing', fileCount: 700, indexElapsedMs: 2000 }),
      prep(4, { jobId: 'job_1', phase: 'indexing', fileCount: 1300, indexElapsedMs: 4000 }),
    ]
    expect(indexingRate(events)).toBe(300)
  })

  it('falls back to a single event\'s own totals and never fabricates a rate', () => {
    expect(indexingRate([prep(1, { jobId: 'job_1', phase: 'indexing', fileCount: 500, indexElapsedMs: 500 })])).toBe(1000)
    expect(indexingRate([prep(1, { jobId: 'job_1', phase: 'indexing', fileCount: 500 })])).toBeNull()
    expect(indexingRate([prep(1, { jobId: 'job_1', phase: 'indexing', fileCount: 500, indexElapsedMs: 0 })])).toBeNull()
    expect(indexingRate([prep(1, { jobId: 'job_1', phase: 'preparing', elapsedMs: 900 })])).toBeNull()
    expect(indexingRate([])).toBeNull()
  })

  it('ignores indexing events from an earlier job', () => {
    const events = [
      prep(1, { jobId: 'job_old', phase: 'indexing', fileCount: 9000, indexElapsedMs: 1000 }),
      prep(2, { jobId: 'job_new', phase: 'indexing', fileCount: 50, indexElapsedMs: 500 }),
    ]
    expect(indexingRate(events)).toBe(100)
  })

  it('averages a finished index from its own totals only', () => {
    expect(averageIndexRate({ jobId: 'j', phase: 'ready', fileCount: 1280, indexElapsedMs: 640 })).toBe(2000)
    expect(averageIndexRate({ jobId: 'j', phase: 'ready', fileCount: 1280 })).toBeNull()
    expect(averageIndexRate({ jobId: 'j', phase: 'ready', fileCount: 0, indexElapsedMs: 0 })).toBeNull()
  })

  it('starts a client stopwatch per job and restarts the phase timer only when the phase changes', () => {
    const first = advancePreparationClock(null, { jobId: 'j1', phase: 'queued' }, 1000)
    expect(first).toEqual({ jobId: 'j1', phase: 'queued', jobStartedAt: 1000, phaseStartedAt: 1000 })
    expect(advancePreparationClock(first, { jobId: 'j1', phase: 'queued' }, 2000)).toBe(first)
    expect(advancePreparationClock(first, { jobId: 'j1', phase: 'indexing' }, 3000)).toEqual({ jobId: 'j1', phase: 'indexing', jobStartedAt: 1000, phaseStartedAt: 3000 })
    expect(advancePreparationClock(first, { jobId: 'j2', phase: 'queued' }, 4000)).toEqual({ jobId: 'j2', phase: 'queued', jobStartedAt: 4000, phaseStartedAt: 4000 })
    expect(advancePreparationClock(first, null, 5000)).toBeNull()
  })

  it('seeds a job first seen mid-flight from the elapsed time the backend already reported', () => {
    expect(advancePreparationClock(null, { jobId: 'j1', phase: 'indexing', elapsedMs: 2500 }, 10_000)).toEqual({ jobId: 'j1', phase: 'indexing', jobStartedAt: 7500, phaseStartedAt: 10_000 })
  })

  it('formats durations and sizes for a readout', () => {
    expect(formatDuration(840)).toBe('0.84 s')
    expect(formatDuration(1240)).toBe('1.2 s')
    expect(formatDuration(12_400)).toBe('12.4 s')
    expect(formatDuration(125_000)).toBe('2m 05s')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

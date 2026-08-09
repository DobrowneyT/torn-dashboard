// Version gate (#382). The reload-loop guard is the whole point of this
// module, so most of these cases are about NOT reloading.
import { describe, it, expect } from 'vitest'
import {
  RELOAD_MARK_KEY, GateAction,
  evaluateVersion, readMark, writeMark, clearMarkIfCurrent,
} from '../versionGate'

/** Frontend tests run in node, so storage is stubbed rather than jsdom's. */
function memStorage(initial = {}) {
  const data = { ...initial }
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v) },
    removeItem: (k) => { delete data[k] },
    _data: data,
  }
}

/** Storage that throws on everything — private mode, or disabled. */
const hostileStorage = {
  getItem() { throw new Error('denied') },
  setItem() { throw new Error('denied') },
  removeItem() { throw new Error('denied') },
}

describe('evaluateVersion', () => {
  it('does nothing when the versions agree', () => {
    expect(evaluateVersion({ running: '3.17.2', serving: '3.17.2', mark: null }))
      .toMatchObject({ action: GateAction.NONE })
  })

  it('reloads on a genuine mismatch', () => {
    expect(evaluateVersion({ running: '3.16.0', serving: '3.17.2', mark: null }))
      .toMatchObject({ action: GateAction.RELOAD, version: '3.17.2' })
  })

  it('reloads on a ROLLBACK too, not just a newer version', () => {
    // Rolling production back is exactly when everyone must move, and a
    // "newer than" comparison would leave every open tab on the bad build.
    expect(evaluateVersion({ running: '3.17.2', serving: '3.16.0', mark: null }))
      .toMatchObject({ action: GateAction.RELOAD, version: '3.16.0' })
  })

  it('REFUSES to reload twice for the same server version', () => {
    // The loop guard. We already reloaded aiming at 3.17.2 and are still not
    // on it, so reloading is not the thing that fixes this.
    expect(evaluateVersion({ running: '3.16.0', serving: '3.17.2', mark: '3.17.2' }))
      .toMatchObject({ action: GateAction.NOTIFY, reason: 'reload-did-not-take' })
  })

  it('reloads again once the server moves to a version we have not tried', () => {
    // A stale mark must not suppress updates forever — the next deploy is a
    // new target and deserves its own attempt.
    expect(evaluateVersion({ running: '3.16.0', serving: '3.18.0', mark: '3.17.2' }))
      .toMatchObject({ action: GateAction.RELOAD, version: '3.18.0' })
  })

  it('notifies instead of reloading when a reload would lose work', () => {
    expect(evaluateVersion({ running: '3.16.0', serving: '3.17.2', mark: null, canReload: false }))
      .toMatchObject({ action: GateAction.NOTIFY, reason: 'unsafe-to-reload' })
  })

  it('treats a missing version as no information, never as a mismatch', () => {
    // An API that failed to answer, or a dev bundle with nothing baked in.
    // Reloading on this would refresh the board every poll while the API is
    // down — during the exact incident when people need it most.
    for (const bad of [null, undefined, '', '   ']) {
      expect(evaluateVersion({ running: '3.17.2', serving: bad, mark: null }).action).toBe(GateAction.NONE)
      expect(evaluateVersion({ running: bad, serving: '3.17.2', mark: null }).action).toBe(GateAction.NONE)
    }
  })

  it('ignores surrounding whitespace rather than reloading over it', () => {
    // VERSION is read from a file; a trailing newline must not read as a new
    // release and reload every client on every poll.
    expect(evaluateVersion({ running: '3.17.2\n', serving: ' 3.17.2 ', mark: null }).action)
      .toBe(GateAction.NONE)
  })
})

describe('the reload mark', () => {
  it('round-trips through storage', () => {
    const s = memStorage()
    expect(writeMark(s, '3.17.2')).toBe(true)
    expect(s._data[RELOAD_MARK_KEY]).toBe('3.17.2')
    expect(readMark(s)).toBe('3.17.2')
  })

  it('reads as absent when there is none', () => {
    expect(readMark(memStorage())).toBeNull()
    expect(readMark(undefined)).toBeNull()
  })

  it('survives storage being unavailable', () => {
    // Private mode. Reading falls back to "no mark" so a single reload is
    // still allowed…
    expect(readMark(hostileStorage)).toBeNull()
    // …but writing REPORTS FAILURE, so the caller knows it cannot guarantee
    // the guard and must not reload. Reloading blind here is precisely the
    // infinite loop this module exists to prevent.
    expect(writeMark(hostileStorage, '3.17.2')).toBe(false)
  })

  it('clears once running and serving agree', () => {
    // Otherwise a tab that legitimately reloaded onto 3.17.2 keeps that mark,
    // and a later rollback TO 3.17.2 would find it already "tried".
    const s = memStorage({ [RELOAD_MARK_KEY]: '3.17.2' })
    expect(clearMarkIfCurrent(s, { running: '3.17.2', serving: '3.17.2' })).toBe(true)
    expect(readMark(s)).toBeNull()
  })

  it('keeps the mark while they still differ', () => {
    const s = memStorage({ [RELOAD_MARK_KEY]: '3.17.2' })
    expect(clearMarkIfCurrent(s, { running: '3.16.0', serving: '3.17.2' })).toBe(false)
    expect(readMark(s)).toBe('3.17.2')
  })

  it('does not fall over when clearing against unusable storage', () => {
    expect(clearMarkIfCurrent(hostileStorage, { running: '3.17.2', serving: '3.17.2' })).toBe(false)
  })
})

describe('the loop it is built to prevent', () => {
  it('a deploy that never takes settles into notifying, not spinning', () => {
    // Simulate the nightmare: the server says 3.18.0, but this tab keeps
    // coming back as 3.16.0 (a proxy or service worker serving the old
    // document). Reloading must happen once and then stop.
    const storage = memStorage()
    let reloads = 0

    for (let poll = 0; poll < 20; poll++) {
      const decision = evaluateVersion({
        running: '3.16.0',
        serving: '3.18.0',
        mark: readMark(storage),
      })
      if (decision.action === GateAction.RELOAD) {
        // The real call site's ordering: record, then reload.
        if (writeMark(storage, decision.version)) reloads += 1
      }
    }

    expect(reloads).toBe(1)
  })

  it('a successful deploy reloads exactly once and then goes quiet', () => {
    const storage = memStorage()
    let running = '3.16.0'
    let reloads = 0

    for (let poll = 0; poll < 10; poll++) {
      const decision = evaluateVersion({ running, serving: '3.18.0', mark: readMark(storage) })
      if (decision.action === GateAction.RELOAD && writeMark(storage, decision.version)) {
        reloads += 1
        running = '3.18.0'          // the reload worked
      }
      clearMarkIfCurrent(storage, { running, serving: '3.18.0' })
    }

    expect(reloads).toBe(1)
    // And the mark is tidied up, so a future rollback to 3.18.0 is not blocked.
    expect(readMark(storage)).toBeNull()
  })

  it('never reloads while the API is failing to report a version', () => {
    const storage = memStorage()
    let reloads = 0
    for (let poll = 0; poll < 10; poll++) {
      const d = evaluateVersion({ running: '3.16.0', serving: null, mark: readMark(storage) })
      if (d.action === GateAction.RELOAD) reloads += 1
    }
    expect(reloads).toBe(0)
  })
})

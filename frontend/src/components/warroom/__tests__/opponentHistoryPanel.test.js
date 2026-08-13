// Regression guard for the "Loading history…" hang (#398).
//
// The panel spun forever against a perfectly healthy, fully indexed endpoint.
// The cause was not the query — it was the fetch effect depending on the state
// it writes:
//
//   useEffect(() => {
//     if (... || state.loading) return
//     setState({ loading: true })          // ← changes a dependency
//     fetch().then(r => { if (!cancelled) setState(...) })
//     return () => { cancelled = true }    // ← cleanup runs on the re-render
//   }, [open, opponentId, state.data, state.loading])
//
// setState changes `state.loading`, React re-runs the effect, which first runs
// the PREVIOUS cleanup and sets `cancelled = true` on the request already in
// flight. The guard then blocks a replacement. The response arrives, sees
// `cancelled`, and discards itself. Terminal spinner, no error, no clue.
//
// This repo has no component renderer, so this pins the shape of the source in
// the same spirit as the #140 `new Date` scanner: a cheap static check for a
// mistake that is expensive and silent at runtime.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, '..', 'OpponentHistoryPanel.jsx'), 'utf8')

/** Every useEffect dependency array in the file, as raw text. */
function dependencyArrays(source) {
  const out = []
  for (const m of source.matchAll(/useEffect\(/g)) {
    // Walk to the matching close paren, then take the last [...] before it.
    let depth = 1
    let i = m.index + m[0].length
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
    }
    const body = source.slice(m.index, i)
    const deps = /,\s*(\[[^[\]]*\])\s*\)\s*$/.exec(body)
    if (deps) out.push(deps[1])
  }
  return out
}

describe('OpponentHistoryPanel effect wiring', () => {
  it('finds the effects to check', () => {
    // If this drops to zero the checks below pass vacuously, which would be the
    // worst outcome: a guard that silently stops guarding.
    expect(dependencyArrays(SOURCE).length).toBeGreaterThanOrEqual(2)
  })

  it('no effect depends on the request state it sets', () => {
    // ⚠️ The actual bug. `state.loading` or `state.data` in a dependency array
    // of an effect that calls setState on them re-triggers the effect, and the
    // cleanup kills the in-flight request.
    for (const deps of dependencyArrays(SOURCE)) {
      expect(deps, `dependency array ${deps}`).not.toMatch(/state\.(loading|data|error)/)
    }
  })

  it('tracks the in-flight opponent in a ref, not in state', () => {
    // A ref does not re-render, so it cannot re-trigger the effect that reads it.
    expect(SOURCE).toMatch(/const requestedFor = useRef\(/)
    expect(SOURCE).toMatch(/requestedFor\.current === opponentId/)
  })

  it('every path out of the request clears the spinner', () => {
    // success, failure and timeout must each end in loading: false. A spinner
    // with no terminal state cannot be told apart from a broken server.
    const setStates = [...SOURCE.matchAll(/setState\(\{[\s\S]*?\}\)/g)].map((m) => m[0])
    const loadingTrue = setStates.filter((s) => /loading:\s*true/.test(s))
    const loadingFalse = setStates.filter((s) => /loading:\s*false/.test(s))
    expect(loadingTrue).toHaveLength(1)
    // idle reset, success, error, timeout
    expect(loadingFalse.length).toBeGreaterThanOrEqual(4)
  })

  it('has a timeout, so a stuck request surfaces as an error', () => {
    expect(SOURCE).toMatch(/REQUEST_TIMEOUT_MS/)
    expect(SOURCE).toMatch(/Timed out loading history/)
  })

  it('resets the ref on failure so reopening retries', () => {
    // Without this a failed first attempt would be permanent for the session:
    // the ref still names the opponent, so the guard blocks every retry.
    const failurePaths = SOURCE.match(/requestedFor\.current = null/g) ?? []
    // opponent-change reset, timeout, catch
    expect(failurePaths.length).toBeGreaterThanOrEqual(3)
  })
})

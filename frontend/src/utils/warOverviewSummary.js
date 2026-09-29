// The War Overview's windowed summary (#0025, reworked 2026-09-28).
//
// ⚠️ **The summary must describe the GRAPH, not the war.** It used to count
// every attack in the time window regardless of which factions were ticked, so
// filtering the plot down to one opponent left the numbers underneath it
// unchanged — two things on one screen disagreeing, with nothing to say which
// was right. MonChoon: *"That summary is not updated dynamically if we adjust
// the filter. Can we change that so it's reflecting the summary of what's
// shown on the graph?"*
//
// ⚠️ **Revives are deliberately NOT faction-filtered.** Being revived by a
// stranger is not something you choose, the reviver is almost never the
// faction you are warring, and the filter exists to answer "who am I fighting".
// Leaving revivers in it did two bad things at once: it padded the checkbox
// list with every faction that ever revived anyone, and — because an unticked
// faction contributes no trace — filtering to the opponent silently emptied the
// revives panel entirely. That is why the faction view appeared to have no
// revives chart while the member view did.
import { WIN_RESULTS, LOSS_RESULTS, ASSIST_RESULT } from './warPayoutCalculations'

// ⚠️ `Special` counts as an attack HERE but is excluded from the exported
// WIN_RESULTS, because every payout path tests that set directly. This is a
// display classifier, not a payout one — see the note on that export.
const TIMELINE_WIN_RESULTS = new Set([...WIN_RESULTS, 'Special'])

/** 'attack' | 'assist' | 'loss' | null — one definition for plot and summary. */
export function classifyEventType(result) {
  if (!result) return null
  if (result === ASSIST_RESULT) return 'assist'
  if (TIMELINE_WIN_RESULTS.has(result)) return 'attack'
  if (LOSS_RESULTS.has(result)) return 'loss'
  return null
}

const emptyBucket = () => ({ attack: 0, assist: 0, loss: 0, total: 0 })

/**
 * The id used for a player who is in no faction.
 *
 * ⚠️ **`0`, not null, and it is a REAL entry in the filter.** Faction-less
 * players were rendered as an unfilterable `(no faction)` bar — you could
 * narrow the plot to one opponent and still be looking at 113k rows you never
 * asked for, with no checkbox to turn them off. `Number(null)` is already 0 and
 * no real faction has that id, so it doubles as the sentinel for free.
 */
export const NO_FACTION_ID = 0
export const NO_FACTION_NAME = '(no faction)'

/** Normalise any faction reference — null, undefined, string — to a number. */
export const factionKey = (fid) => Number(fid) || NO_FACTION_ID

/** Torn reports a revive as 'success' or 'failure'. */
export const REVIVE_SUCCESS = 'success'
export const REVIVE_FAILURE = 'failure'
export const reviveOutcome = (r) =>
  String(r?.result ?? '').toLowerCase() === REVIVE_FAILURE ? REVIVE_FAILURE : REVIVE_SUCCESS

/**
 * Count what the plot is currently showing.
 *
 * `mode` is 'faction' (our whole faction) or 'member' (one member).
 * `selectedFactionIds` is a Set, or null meaning "all".
 *
 * ⚠️ `total` counts every attack in scope, including results this classifier
 * does not recognise — so the three named columns can sum to less than it.
 * That is the honest shape: a result type Torn adds later is visible as a gap
 * rather than silently filed under "loss".
 */
export function summariseWindow({
  attacks = [], revives = [], fromTs, toTs,
  ourFactionId, selectedFactionIds = null, mode = 'faction', memberId = null,
}) {
  const inWindow = (ts) => ts >= fromTs && ts <= toTs
  // ⚠️ Through `factionKey`, so a null faction tests as 0 — the id the
  // "(no faction)" checkbox uses. Comparing the raw value would make that
  // checkbox inert, which is the bug it exists to fix.
  const picked = (fid) => selectedFactionIds == null || selectedFactionIds.has(factionKey(fid))

  const outgoing = emptyBucket()
  const incoming = emptyBucket()

  for (const a of attacks) {
    if (!inWindow(a.started)) continue
    const type = classifyEventType(a.result)

    const isOurs = mode === 'member'
      ? a.attacker_id === memberId
      : Number(a.attacker_faction_id) === Number(ourFactionId)
    // ⚠️ The OTHER side decides whether this event is on the graph: an attack
    // we made is plotted against whoever we hit. Testing our own faction would
    // make the filter a no-op for outgoing rows.
    if (isOurs && picked(a.defender_faction_id)) {
      outgoing.total += 1
      if (type) outgoing[type] += 1
    }

    const isAgainstUs = mode === 'member'
      ? a.defender_id === memberId
      : Number(a.defender_faction_id) === Number(ourFactionId)
    if (isAgainstUs && picked(a.attacker_faction_id)) {
      incoming.total += 1
      if (type) incoming[type] += 1
    }
  }

  // ⚠️ No `picked()` here, on purpose — see the note at the top of the file.
  //
  // ⚠️ Split by outcome: a failed revive cost somebody a slot and left the
  // target in hospital, so counting it alongside the successes overstates how
  // much help actually arrived.
  const revStats = { success: 0, failure: 0, total: 0 }
  for (const r of revives) {
    if (!inWindow(r.timestamp)) continue
    const mine = mode === 'member'
      ? r.target_id === memberId
      : Number(r.target_faction_id) === Number(ourFactionId)
    if (!mine) continue
    revStats[reviveOutcome(r)] += 1
    revStats.total += 1
  }

  return { fromTs, toTs, outgoing, incoming, revives: revStats }
}

/**
 * Ordering rules for the War Room delta merge (#371).
 *
 * The board is fed by TWO transports at once. The WebSocket pushes rows as the
 * ticker writes them, and `pollNow()` fires a REST delta after every write a
 * user makes — a dibs claim, a release, a note. Both land in the same map.
 *
 * Until now that map was written by ARRIVAL ORDER: whichever response came back
 * last won. That is fine while only one transport is talking, and wrong the
 * moment they overlap:
 *
 *   1. A dibs click fires a REST delta.
 *   2. The server reads the roster — member X is still `Hospital`.
 *   3. The ticker writes X as `Okay` and the socket pushes it. Applied.
 *   4. The REST response, in flight since step 2, arrives carrying the OLD
 *      `Hospital` row. Applied on top. X flips back.
 *
 * X then stays wrong until its next write, and flips again on the next race —
 * which is why it reads as flickering rather than a one-off glitch, and why it
 * clusters around hospital exits: that is exactly when people are clicking.
 *
 * The fix is to make the merge care about the row's version rather than when it
 * happened to arrive. Every row carries `updated_at`; a row older than the one
 * already held is dropped.
 */
import { parseDbTime } from './time'

/**
 * Should `incoming` replace `existing`?
 *
 * Uses `>=` rather than `>` so a re-sent identical row still applies. Re-sends
 * are routine: the delta endpoint reads `server_now` BEFORE it reads the rows,
 * so the watermark it hands back always lags the data slightly. That ordering
 * is the safe one — it re-sends rather than missing a write — but it does mean
 * the same row arrives repeatedly, and dropping equal timestamps would discard
 * a genuine same-millisecond update.
 */
export function isAtLeastAsNew(incoming, existing) {
  if (!existing) return true
  const a = parseDbTime(incoming?.updated_at)
  const b = parseDbTime(existing?.updated_at)
  // Unparseable either side: fall back to accepting, which is the behaviour
  // that existed before this guard. Silently dropping rows we cannot version
  // would be a worse failure than the flicker.
  if (!a || !b) return true
  return a.getTime() >= b.getTime()
}

/**
 * Merge delta rows into a keyed map, newest-wins.
 *
 * Tombstones are KEPT in the map rather than deleted, and filtered out at
 * publish time. Deleting would throw away the one thing that lets us reject a
 * stale row for that member — with no entry to compare against, an in-flight
 * response carrying their pre-tombstone row would resurrect them onto the
 * board, and nothing would remove them again because the tombstone is only
 * written once.
 */
export function mergeVersionedRows(map, rows, keyField) {
  for (const row of rows ?? []) {
    const key = row?.[keyField]
    if (key == null) continue
    if (!isAtLeastAsNew(row, map.get(key))) continue
    map.set(key, row)
  }
  return map
}

/** Live rows from a merged map — tombstones dropped. */
export function liveRows(map) {
  return Array.from(map.values()).filter((r) => !r?.deleted_at)
}

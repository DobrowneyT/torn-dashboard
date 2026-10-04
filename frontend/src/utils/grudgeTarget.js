/**
 * Read a Torn user id out of whatever somebody pasted (#889).
 *
 * ⚠️ Mirrors `server/src/grudges.ts#parseTargetId` deliberately. The server is
 * the authority — this copy exists only so the form can say "that is not a
 * profile link" while you type, rather than after a round trip. The two are
 * pinned to the same cases by tests on both sides; if they ever disagree, the
 * server wins and the form has merely been optimistic.
 */
export function parseTargetId(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) return raw
  // ⚠️ Case-insensitive, and not anchored: links in the wild carry other
  // params on either side of XID.
  const xid = raw.match(/[?&]XID=(\d+)/i)
  if (xid) return xid[1]
  const path = raw.match(/profiles(?:\.php)?\/(\d+)/i)
  if (path) return path[1]
  return null
}

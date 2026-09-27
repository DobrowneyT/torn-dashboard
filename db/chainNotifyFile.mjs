/**
 * Wire Chain Watch's push-a-redraw socket into `deploy/docker-compose.override.yml`
 * for the production fleet (#785 follow-up).
 *
 * ⚠️ **Production never got this.** `deploy/docker-compose.dev.yml` has carried
 * `CHAIN_NOTIFY_SOCKET` and the bind mount since #785, because staging is one
 * `server` service in a file that is checked in. Production is five `api-<slug>`
 * services in a file that is generated per tenant and lives only on the box —
 * so nothing in the repo could add it, and the first faction pointed at its
 * real dashboard would quietly fall back to the five-minute poll. Nobody
 * notices a board that is merely late.
 *
 * ⚠️ **The directory is mounted, never the socket file.** The bot creates and
 * deletes the socket; bind-mounting the file leaves the container holding the
 * old inode after a bot restart, which is a push that silently stops working —
 * the exact failure the dev compose file already carries a comment about.
 *
 * ⚠️ **Entirely optional, on both ends.** Unset `CHAIN_NOTIFY_DIR`, or a bot
 * that is not listening, means the board updates on its poll interval as
 * before. Nothing here may become required (`:?`), or a tenant that has
 * nothing to do with Chain Watch fails to start.
 *
 * Kept separate from the CLI so it can be tested without a deploy directory —
 * the split `db/fleetTokenFile.mjs` and `db/adminEnvFile.mjs` both use.
 */

/** The env var the server reads, and the comment introducing it. */
export const NOTIFY_VAR = 'CHAIN_NOTIFY_SOCKET'

/** Where the socket appears INSIDE the container. Fixed: the server reads this path. */
export const CONTAINER_DIR = '/run/chain-notify'

/** The host directory, via an env var so a box without one mounts nothing real. */
export const HOST_DIR_VAR = 'CHAIN_NOTIFY_DIR'

const ENV_LINES = [
  '      # ⚠️ Push a redraw to the Discord bot when a sign-up changes, over a',
  '      # bind-mounted unix socket. A container cannot reach the host\'s',
  '      # 127.0.0.1, and binding 0.0.0.0 would put a control channel for a',
  '      # process holding a Discord token on the public internet.',
  '      #',
  '      # ⚠️ Optional on both ends: unset, or the bot not listening, means the',
  '      # board updates on its poll interval as before.',
  '      #',
  `      # ⚠️ Derived from \${${HOST_DIR_VAR}} with :+ so ONE variable turns this`,
  '      # on. Two — a directory and a path inside the container — is two ways to',
  '      # get it half-configured: a socket path set with nothing mounted at it',
  '      # fails on every sign-up, silently, in a fire-and-forget POST.',
  `      ${NOTIFY_VAR}: \${${HOST_DIR_VAR}:+${CONTAINER_DIR}/notify.sock}`,
]

const VOLUME_LINES = [
  '    volumes:',
  '      # The DIRECTORY, not the socket: the bot creates and deletes the file,',
  '      # and a bind mount of a file that is replaced leaves the container',
  '      # holding the old inode — a push that stops working after a restart.',
  `      - \${${HOST_DIR_VAR}:-/tmp/chain-notify-unused}:${CONTAINER_DIR}`,
]

/** The mount entry alone, for appending to a `volumes:` block that already exists. */
const MOUNT_LINE = VOLUME_LINES[VOLUME_LINES.length - 1]

const SERVICE_RE = /^ {2}([A-Za-z0-9_.-]+):\s*$/

/**
 * Where each `api-<slug>` service's lines begin and end (end exclusive).
 *
 * ⚠️ Two passes rather than one, unlike `setOverrideTokens`. This inserts in
 * two places per service — inside `environment:` and at service level — and
 * deciding the second while still walking the first is how an insert lands
 * inside the block above it.
 */
function serviceRanges(lines) {
  const ranges = new Map()
  let slug = null
  let start = 0
  const close = (end) => { if (slug !== null) ranges.set(slug, { start, end }) }
  lines.forEach((line, i) => {
    const m = SERVICE_RE.exec(line)
    if (!m) return
    close(i)
    const api = /^api-(.+)$/.exec(m[1])
    slug = api ? api[1] : null
    start = i
  })
  close(lines.length)
  return ranges
}

/** The half-open range of a block opened by `header` at 4-space indent. */
function blockRange(lines, { start, end }, header) {
  const open = lines.findIndex(
    (line, i) => i >= start && i < end && new RegExp(`^ {4}${header}:\\s*$`).test(line))
  if (open === -1) return null
  let close = open + 1
  while (close < end && (lines[close].trim() === '' || /^ {5,}/.test(lines[close]))) close += 1
  // ⚠️ Back off over trailing blank lines. Inserting after them puts the new
  // key outside the block it belongs to, where compose reads it as a sibling
  // of the service itself.
  while (close > open + 1 && lines[close - 1].trim() === '') close -= 1
  return { open, close }
}

/**
 * Add the notify socket to each named `api-<slug>` service.
 *
 * Returns `{ text, wired, already, missing }`. `missing` is slugs with no
 * matching service — which the caller must treat as a failure, not a warning:
 * that tenant silently keeps the poll-only behaviour while the others look fine.
 *
 * ⚠️ Comments, ordering and unrelated services survive byte-for-byte. This file
 * is generated by appending and then hand-edited for years; a rewriter that
 * reformatted it would make every future diff unreadable.
 */
export function setOverrideChainNotify(text, slugs) {
  const lines = text.split('\n')
  const ranges = serviceRanges(lines)
  const wanted = [...new Set(slugs)]
  const missing = wanted.filter((s) => !ranges.has(s))
  if (missing.length > 0) return { text, wired: [], already: [], missing }

  const inserts = []            // { at, lines }
  const wired = []
  const already = []

  for (const slug of wanted) {
    const range = ranges.get(slug)
    const body = lines.slice(range.start, range.end)
    const hasEnv = body.some((l) => new RegExp(`^ {6}${NOTIFY_VAR}:`).test(l))
    const hasMount = body.some((l) => l.includes(`:${CONTAINER_DIR}`))
    if (hasEnv && hasMount) { already.push(slug); continue }

    if (!hasEnv) {
      const env = blockRange(lines, range, 'environment')
      if (env === null) {
        // No environment block at all — nothing sane to append to, and
        // inventing one risks putting it in the wrong place.
        missing.push(slug)
        continue
      }
      inserts.push({ at: env.close, lines: ENV_LINES })
    }
    if (!hasMount) {
      const volumes = blockRange(lines, range, 'volumes')
      inserts.push(volumes === null
        // ⚠️ After `environment:`, not at the end of the service. A service
        // here ends with `healthcheck:`, whose own nested keys are indented
        // deeper — appending there would land the mount inside it.
        ? { at: blockRange(lines, range, 'environment').close, lines: VOLUME_LINES }
        : { at: volumes.close, lines: [MOUNT_LINE] })
    }
    wired.push(slug)
  }

  if (missing.length > 0) return { text, wired: [], already: [], missing }

  // ⚠️ Group by index FIRST. A service with no `volumes:` block gets both
  // insertions at the same line, and splicing them one after another puts the
  // second one ABOVE the first — which drops the env key inside the volumes
  // list, where it is not even valid YAML. Concatenating in push order is the
  // only thing that keeps `environment:` before `volumes:`.
  const byIndex = new Map()
  for (const { at, lines: added } of inserts) {
    byIndex.set(at, [...(byIndex.get(at) ?? []), ...added])
  }
  // ⚠️ Bottom-up, or every insert shifts the ones below it.
  for (const at of [...byIndex.keys()].sort((a, b) => b - a)) {
    lines.splice(at, 0, ...byIndex.get(at))
  }

  return { text: lines.join('\n'), wired, already, missing }
}

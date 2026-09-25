// Telling the Discord bot the board changed (#785 follow-up).
//
// The bot polls every `board_refresh_seconds` (default 300). That is fine for
// the chain counter and travel state, and far too slow for a sign-up: somebody
// clicks a slot and then stares at an unchanged board wondering whether it
// worked. This nudges the bot so the board redraws within seconds.
//
// ⚠️ **A unix socket, not a TCP port, and that is the whole security story.**
// A container cannot reach the host's 127.0.0.1 — its traffic arrives via the
// bridge gateway — so the obvious "listen on localhost" does not work, and the
// obvious fix for THAT is binding 0.0.0.0, which on a VPS puts a control
// channel for a bot holding a Discord token and five tenant bearers on the
// public internet. A bind-mounted socket has no port, needs no firewall rule,
// and carries no credential that could leak.
//
// ⚠️ **Fire and forget, and it must stay that way.** A member clicking "sign
// up" must never see an error, or wait, because a Discord bot is down or its
// socket is missing. Every failure here is swallowed; the bot's own polling is
// the backstop, so the worst case is the board being up to five minutes stale —
// exactly where we were before this existed.
import { request } from 'node:http'

/** Absent disables the whole thing, on both sides. */
const SOCKET = process.env.CHAIN_NOTIFY_SOCKET || ''

/**
 * ⚠️ Short. This runs inside a request the member is waiting on — even though
 * nothing awaits it, a socket that accepts and then hangs would pin a handle
 * per sign-up. Seconds, not tens of seconds.
 */
const TIMEOUT_MS = 2000

export function notifyEnabled(): boolean {
  return SOCKET.length > 0
}

/**
 * Nudge the bot that `slug`'s board is out of date.
 *
 * Never throws, never rejects, and is not worth awaiting. Callers use
 * `void notifyBoardChanged(slug)`.
 */
export async function notifyBoardChanged(slug: string): Promise<void> {
  if (!SOCKET) return
  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    try {
      const body = JSON.stringify({ slug })
      const req = request({
        socketPath: SOCKET,
        path: '/changed',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: TIMEOUT_MS,
      }, (res) => {
        // ⚠️ Drain. An undrained response keeps the socket open, and this runs
        // on every sign-up for as long as the event lasts.
        res.resume()
        res.on('end', finish)
        res.on('error', finish)
      })
      req.on('error', finish)          // no bot listening: entirely normal
      req.on('timeout', () => { req.destroy(); finish() })
      req.end(body)
    } catch {
      finish()
    }
  })
}

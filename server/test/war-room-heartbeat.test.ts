// War-room socket keepalive (#487 follow-up).
//
// ⚠️ The bug this covers is invisible in every unit test and obvious in
// production. nginx gives an idle upstream `proxy_read_timeout 300s`
// (deploy/nginx/default.conf) and then tears the tunnel down. The hub only
// writes when the ticker broadcasts, and the ticker is war-gated — with no war
// on it never fires. So every socket sat silent, was killed at five minutes,
// and every client reconnected on that cycle logging a connection error.
// Observed in the access log on 2026-08-17: successive 101s exactly 5m02s
// apart, from the dashboard and the #487 userscript alike.
//
// The heartbeat is what keeps the tunnel warm, so it is worth a real socket
// rather than a spy: these tests watch actual protocol-level ping frames.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let token: string

// ⚠️ Not tighter than this. These are real timers on a real socket, running
// alongside the rest of the suite; a window measured in tens of milliseconds
// makes the test a coin flip on a loaded machine rather than a check of the
// heartbeat. Slow and certain beats fast and flaky.
const HEARTBEAT_MS = 100

beforeAll(async () => {
  stack = await startTestStack(undefined, {}, { warRoomHeartbeatMs: HEARTBEAT_MS })
  const key = 'HEARTBEATKEY1300'
  stack.torn.addKey(key, { id: '1300', factionId: TEST_FACTION.tornFactionId })
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  expect(res.status).toBe(200)
  token = ((await res.json()) as { token: string }).token
}, 30000)

afterAll(async () => {
  await stack?.close()
})

function wsUrl() {
  return `${stack.baseUrl.replace('http', 'ws')}/api/war-room/ws?token=${token}`
}

/** Resolves on the socket's first ping, or rejects if none arrives in time. */
function firstPing(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ping within the window')), timeoutMs)
    ws.on('ping', () => { clearTimeout(timer); resolve() })
  })
}

describe('war-room socket heartbeat', () => {
  it('⚠️ pings an idle socket, so nginx never sees an idle upstream', async () => {
    const ws = new WebSocket(wsUrl())
    await new Promise((resolve) => ws.on('open', resolve))
    // Nothing is broadcast in this test — that is the point. A quiet war room
    // is the state the socket used to die in.
    await expect(firstPing(ws, HEARTBEAT_MS * 30)).resolves.toBeUndefined()
    ws.close()
  })

  it('keeps pinging rather than doing it once at connect', async () => {
    const ws = new WebSocket(wsUrl())
    await new Promise((resolve) => ws.on('open', resolve))
    let pings = 0
    ws.on('ping', () => { pings++ })
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS * 8))
    // A single ping would keep a connection alive for exactly one timeout
    // window and then let it die on the next — the bug, moved later.
    expect(pings).toBeGreaterThan(1)
    ws.close()
  })

  it('⚠️ drops a client that stops answering instead of broadcasting into a void', async () => {
    // autoPong off makes this socket look like a peer that has gone away — a
    // slept laptop, a dropped network — without waiting for a real one.
    const ws = new WebSocket(wsUrl(), { autoPong: false })
    await new Promise((resolve) => ws.on('open', resolve))
    expect(stack.warRoomHub?.clientCount()).toBeGreaterThan(0)

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && (stack.warRoomHub?.clientCount() ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS))
    }
    expect(stack.warRoomHub?.clientCount()).toBe(0)
    ws.terminate()
  })

  it('a live client survives indefinitely', async () => {
    // The mirror of the test above: the reaper must not collect a healthy
    // socket, which is a far worse failure than leaving a dead one behind.
    const ws = new WebSocket(wsUrl())
    await new Promise((resolve) => ws.on('open', resolve))
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS * 10))
    expect(stack.warRoomHub?.clientCount()).toBeGreaterThan(0)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })
})

#!/usr/bin/env node
// WebSocket client swarm for the #116 stress test. Logs N clients into each
// stress tenant (every login enrolls its synthetic key into that tenant's
// pool through the normal auth path), opens the war-room delta stream, and
// reports connect success, frame throughput, and broadcast latency
// (client receipt time − the delta's server_now; keep operator and server
// clocks NTP-synced and read percentiles, not absolutes).
//
// Usage:
//   node deploy/stress/ws-swarm.mjs \
//     --tenant 990001=https://stress1.example.com \
//     --tenant 990002=https://stress2.example.com \
//     --clients 400 --duration 120
//
// Clients are split evenly across tenants. Member indexes start at 1
// (index 0 is the tenant's leader, reserved for enable-war.mjs).
import { makeStressKey } from './mock-torn.mjs'
import { summarize, parseServerTimestamp } from './stats.mjs'

const WebSocketImpl =
  globalThis.WebSocket ?? (await import('ws')).WebSocket

function parseArgs(argv) {
  const args = { tenants: [], clients: 400, duration: 120, ramp: 25 }
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]
    const val = argv[++i]
    if (flag === '--tenant') {
      const [factionId, url] = val.split('=', 2)
      if (!factionId || !url) throw new Error(`--tenant expects <factionId>=<baseUrl>, got: ${val}`)
      args.tenants.push({ factionId: Number(factionId), url: url.replace(/\/$/, '') })
    } else if (flag === '--clients') args.clients = Number(val)
    else if (flag === '--duration') args.duration = Number(val)
    else if (flag === '--ramp') args.ramp = Number(val)
    else throw new Error(`Unknown flag: ${flag}`)
  }
  if (args.tenants.length === 0) throw new Error('At least one --tenant <factionId>=<baseUrl> is required')
  return args
}

async function login(tenant, memberIndex) {
  const key = makeStressKey(tenant.factionId, memberIndex)
  const res = await fetch(`${tenant.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  if (!res.ok) throw new Error(`login ${res.status}: ${(await res.text()).slice(0, 120)}`)
  const { token } = await res.json()
  return token
}

function connectClient(tenant, token, stats, endAt) {
  return new Promise((resolve) => {
    const wsUrl = `${tenant.url.replace(/^http/, 'ws')}/api/war-room/ws?token=${encodeURIComponent(token)}`
    const ws = new WebSocketImpl(wsUrl)
    let opened = false
    ws.onopen = () => {
      opened = true
      stats.connected++
      resolve(true)
    }
    ws.onmessage = (event) => {
      const raw = typeof event.data === 'string' ? event.data : event.data.toString()
      stats.frames++
      stats.bytes += raw.length
      if (raw.startsWith('{"type":"delta"')) {
        try {
          const serverNow = parseServerTimestamp(JSON.parse(raw).server_now)
          if (Number.isFinite(serverNow)) stats.latencies.push(Date.now() - serverNow)
          else stats.unparsedServerNow = (stats.unparsedServerNow ?? 0) + 1
        } catch { /* count the frame, skip the sample */ }
      }
    }
    ws.onerror = () => { if (!opened) { stats.connectFailures++; resolve(false) } }
    ws.onclose = () => {
      if (!opened) { stats.connectFailures++; resolve(false) }
      else if (Date.now() < endAt) stats.drops++
    }
    stats.sockets.push(ws)
  })
}

async function main() {
  const args = parseArgs(process.argv)
  const perTenant = Math.ceil(args.clients / args.tenants.length)
  const endAt = Date.now() + args.duration * 1000
  console.log(
    `swarm: ${args.clients} clients over ${args.tenants.length} tenant(s) ` +
    `(${perTenant}/tenant), ${args.duration}s run, ramp ${args.ramp} logins in flight`
  )

  const tenantStats = args.tenants.map((t) => ({
    tenant: t,
    connected: 0, connectFailures: 0, loginFailures: 0, drops: 0,
    frames: 0, bytes: 0, latencies: [], sockets: [],
  }))

  // Ramped connect: a work queue with `ramp` workers.
  const jobs = []
  for (let i = 0; i < args.tenants.length; i++) {
    for (let c = 1; c <= perTenant; c++) jobs.push({ stats: tenantStats[i], memberIndex: c })
  }
  let cursor = 0
  const started = Date.now()
  await Promise.all(
    Array.from({ length: args.ramp }, async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++]
        try {
          const token = await login(job.stats.tenant, job.memberIndex)
          await connectClient(job.stats.tenant, token, job.stats, endAt)
        } catch (err) {
          job.stats.loginFailures++
          if (job.stats.loginFailures <= 3) console.error(`login failed (${job.stats.tenant.url}): ${err.message}`)
        }
      }
    })
  )
  console.log(`connected ${tenantStats.reduce((a, s) => a + s.connected, 0)}/${args.clients} in ${((Date.now() - started) / 1000).toFixed(1)}s — measuring…`)

  const heartbeat = setInterval(() => {
    const total = tenantStats.reduce((a, s) => a + s.frames, 0)
    console.log(`  t+${((Date.now() - started) / 1000) | 0}s: ${total} frames total`)
  }, 15_000)

  await new Promise((r) => setTimeout(r, Math.max(0, endAt - Date.now())))
  clearInterval(heartbeat)
  for (const s of tenantStats) for (const ws of s.sockets) { try { ws.close() } catch { /* already down */ } }

  const measuredSec = args.duration
  const report = tenantStats.map((s) => ({
    tenant: s.tenant.url,
    faction: s.tenant.factionId,
    clients_target: perTenant,
    connected: s.connected,
    login_failures: s.loginFailures,
    connect_failures: s.connectFailures,
    drops: s.drops,
    frames: s.frames,
    frames_per_sec: +(s.frames / measuredSec).toFixed(1),
    megabytes: +(s.bytes / 1e6).toFixed(2),
    unparsed_server_now: s.unparsedServerNow ?? 0,
    latency_ms: summarize(s.latencies),
  }))
  const allLat = summarize(tenantStats.flatMap((s) => s.latencies))
  const totals = {
    connected: report.reduce((a, r) => a + r.connected, 0),
    frames: report.reduce((a, r) => a + r.frames, 0),
    megabytes: +report.reduce((a, r) => a + r.megabytes, 0).toFixed(2),
    drops: report.reduce((a, r) => a + r.drops, 0),
    latency_ms: allLat,
  }
  console.log('\n=== swarm report ===')
  console.log(JSON.stringify({ tenants: report, totals }, null, 2))
  if (totals.connected === 0) process.exitCode = 1
}

await main()

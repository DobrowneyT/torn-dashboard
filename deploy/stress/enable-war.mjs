#!/usr/bin/env node
// One-shot war-room enable for a stress tenant (#116). Logs in as the
// tenant's leader (stress member index 0 — create the tenant with that
// member id as --leader so it holds the leadership role), points the war
// room at a mock "enemy" faction, and baselines member state. After this
// the in-process ticker polls the mock at 1 Hz and broadcasts real deltas.
//
// Usage:
//   node deploy/stress/enable-war.mjs \
//     --base https://stress1.example.com --faction 990001 --enemy 990101
import { makeStressKey } from './mock-torn.mjs'

function arg(flag) {
  const i = process.argv.indexOf(flag)
  if (i === -1 || i + 1 >= process.argv.length) throw new Error(`${flag} is required`)
  return process.argv[i + 1]
}

const base = arg('--base').replace(/\/$/, '')
const factionId = Number(arg('--faction'))
const enemyId = Number(arg('--enemy'))

const loginRes = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ apiKey: makeStressKey(factionId, 0) }),
})
if (!loginRes.ok) throw new Error(`leader login failed (${loginRes.status}): ${await loginRes.text()}`)
const { token } = await loginRes.json()
const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` }

const cfgRes = await fetch(`${base}/api/war-room/config`, {
  method: 'PUT',
  headers: auth,
  body: JSON.stringify({ enabled: true, auto_managed: false, faction_id: enemyId }),
})
if (!cfgRes.ok) throw new Error(`config save failed (${cfgRes.status}): ${await cfgRes.text()}`)

const fetchRes = await fetch(`${base}/api/war-room/fetch-members`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ faction_id: enemyId }),
})
if (!fetchRes.ok) throw new Error(`baseline fetch failed (${fetchRes.status}): ${await fetchRes.text()}`)
const baseline = await fetchRes.json()

console.log(`war room enabled on ${base}: enemy ${enemyId}, ${baseline.members_synced} member states baselined — ticker is live`)

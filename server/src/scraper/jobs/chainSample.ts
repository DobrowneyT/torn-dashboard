// #774 — an append-only record of what the chain was doing.
//
// ⚠️ This deliberately does NOT reuse the War Room's chain poller, and the
// reasons compound:
//
//   1. It only runs during a WAR. warRoomTicker returns early on `!cfg.enabled`
//      and again on `!cfg.faction_id` — "no opponent faction set". A Halloween
//      chain has no opponent, and switching the War Room on to borrow its
//      poller would turn on revive alerts, dibs sweeps, surge detection and
//      roster polling as collateral for a fortnight.
//
//   2. `war_room_chain_v2` is a SINGLETON (CHECK (id = 1)). Every poll
//      overwrites the last, so the chain's end is a moment somebody had to
//      catch rather than a fact that can be read back afterwards — and the
//      payout needs exactly that fact, hours later. A restart or a deploy at
//      the wrong second loses it for good.
//
//   3. It polls every 5 seconds by default, forced faster near expiry. Over a
//      twelve-day event that is ~200,000 Torn calls on the shared pool.
//
// ⚠️ Four minutes is enough BECAUSE PAYOUT IS HOURLY. A detection error only
// changes what anybody is paid when the chain dies within four minutes of an
// hour boundary. We are not trying to watch the timer; we are trying to be
// right about which hour it died in.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { absTimer } from '../../warRoomChain.js'

export async function chainSampleJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const us = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
  const factionId = us.rows[0]?.torn_faction_id
  if (!factionId) return { rows: 0, details: { skipped: 'no faction id configured' } }

  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  const data = await client.fetch(`/v2/faction/${factionId}/chain`, claimed.key)
  const chain = data?.chain ?? {}
  const nowEpoch = Math.floor(Date.now() / 1000)

  // Torn sends `timeout`/`cooldown` as RELATIVE seconds; stored absolute, the
  // same conversion warRoomChain.ts does, so the two series are comparable.
  const { rows } = await db.query(
    `INSERT INTO chain_samples (chain_current, chain_timeout, chain_cooldown)
     VALUES ($1, $2, $3) RETURNING id`,
    [chain.current ?? null, absTimer(chain.timeout, nowEpoch), absTimer(chain.cooldown, nowEpoch)],
  )

  return {
    rows: rows.length,
    details: {
      chain: chain.current ?? null,
      // A cooldown means the chain is over. Surfaced in the run log so an
      // operator can see the transition without querying the table.
      in_cooldown: Number(chain.cooldown ?? 0) > 0,
    },
  }
}

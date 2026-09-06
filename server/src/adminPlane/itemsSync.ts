/**
 * The fleet item catalogue sync (#609 slice 7).
 *
 * ⚠️ One of exactly TWO jobs the #608 audit found movable, and the organising
 * question was never "is this data Torn-global" but ***can ONE API key fetch
 * it***. `/v2/torn/items` is public, so the admin container's single key
 * suffices; the other eighteen scraper jobs are faction-scoped and need keys
 * this box will never have.
 *
 * ⚠️ **The danger here is silence, not failure.** Centralising trades five-fold
 * redundancy for one key: today each tenant fetches from its own hourly
 * re-verified pool (#309) and survives any single key dying. Fed by one key,
 * prices quietly stop updating and every faction keeps valuing payouts off a
 * stale table — the same decay that ran unnoticed for months in July
 * (#123/#124). Nothing in this file can fix that; the mitigations live in the
 * tenant, which adopts these rows only while `items_synced_at` is fresh and
 * otherwise falls back to its own pool. What this file must do is never make
 * the timestamp lie.
 */
import type pg from 'pg'

export const TORN_ITEMS_PATH = '/v2/torn/items?cat=All&sort=ASC'
const TIMEOUT_MS = 30_000

/**
 * ⚠️ **The floor that stops a truncated response from being stamped fresh.**
 *
 * Torn's catalogue runs to several thousand items. A response carrying a
 * handful is not a small catalogue — it is a partial read, a changed shape, or
 * an error body that happened to parse. Writing those rows and stamping
 * `items_synced_at` would tell every tenant the prices are current while the
 * table holds almost nothing, which is worse than the outage it came from:
 * unpriced would at least be visible. Below this the sync fails and the
 * previous timestamp stands, so tenants keep using their own pools.
 */
export const MIN_PLAUSIBLE_ITEMS = 100

export interface ItemsSyncResult {
  rows: number
  syncedAt: string
}

export interface ItemsSyncDeps {
  db: pg.Pool
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

interface TornItem {
  id?: number
  name?: string
  description?: string | null
  effect?: string | null
  type?: string | null
  sub_type?: string | null
  circulation?: number | null
  is_tradable?: boolean | null
  image?: string | null
  value?: { market_price?: number; sell_price?: number; buy_price?: number }
}

export async function fetchItems(deps: ItemsSyncDeps): Promise<TornItem[]> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const base = deps.baseUrl ?? 'https://api.torn.com'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${base}${TORN_ITEMS_PATH}`, {
      headers: { authorization: `ApiKey ${deps.apiKey}` },
      signal: controller.signal,
    })
    const body = (await res.json()) as { items?: TornItem[]; error?: { code?: number; error?: string } }
    // ⚠️ Torn answers 200 with an error BODY. Trusting the status code would
    // read `{"error":{"code":2,"error":"Incorrect key"}}` as an empty catalogue.
    if (body.error) throw new Error(`Torn error ${body.error.code ?? '?'}: ${body.error.error ?? 'unknown'}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return Array.isArray(body.items) ? body.items : []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch and upsert, then stamp `fleet_meta.items_synced_at`.
 *
 * ⚠️ The stamp is the LAST thing written, inside the same transaction as the
 * rows. It is the only signal a tenant has that these prices can be trusted, so
 * a crash halfway must leave the previous timestamp standing rather than a
 * fresh timestamp over a half-written table.
 */
export async function syncFleetItems(deps: ItemsSyncDeps): Promise<ItemsSyncResult> {
  const items = await fetchItems(deps)
  if (items.length < MIN_PLAUSIBLE_ITEMS) {
    throw new Error(
      `Refusing to publish ${items.length} items — below the ${MIN_PLAUSIBLE_ITEMS} floor, ` +
      `which means a partial read rather than a small catalogue. Previous prices stand.`
    )
  }

  const syncedAt = new Date(deps.now?.() ?? Date.now()).toISOString()
  const client = await deps.db.connect()
  try {
    await client.query('BEGIN')
    let rows = 0
    for (const it of items) {
      if (it.id == null) continue
      const value = it.value ?? {}
      await client.query(
        `INSERT INTO items (id, name, description, effect, type, sub_type, market_price,
                            sell_price, buy_price, circulation, is_tradable, image_url, last_updated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description, effect = EXCLUDED.effect,
           type = EXCLUDED.type, sub_type = EXCLUDED.sub_type, market_price = EXCLUDED.market_price,
           sell_price = EXCLUDED.sell_price, buy_price = EXCLUDED.buy_price,
           circulation = EXCLUDED.circulation, is_tradable = EXCLUDED.is_tradable,
           image_url = EXCLUDED.image_url, last_updated = EXCLUDED.last_updated`,
        [
          it.id, it.name ?? `Item ${it.id}`, it.description ?? null, it.effect ?? null,
          it.type ?? null, it.sub_type ?? null, value.market_price ?? 0, value.sell_price ?? 0,
          value.buy_price ?? 0, it.circulation ?? null, it.is_tradable ?? null, it.image ?? null,
          syncedAt,
        ]
      )
      rows += 1
    }
    await client.query(
      'UPDATE fleet_meta SET items_synced_at = $1, updated_at = now() WHERE id = 1',
      [syncedAt]
    )
    await client.query('COMMIT')
    return { rows, syncedAt }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * How stale the fleet copy may get before the control plane refreshes it.
 *
 * ⚠️ **This must be comfortably SHORTER than `ITEMS_STALE_AFTER_MS` (6h) in
 * globalDb.ts, and the first draft of this file got it wrong by setting them
 * equal.** With both at six hours the copy would reach the freshness boundary
 * at the exact moment the next refresh was due, so every tenant would spend the
 * tail of each cycle seeing "stale" and quietly falling back to its own key
 * pool. The feature would then cost one Torn call per faction and save nothing,
 * while appearing to work — the worst kind of failure, because everything keeps
 * running.
 *
 * Two hours leaves room for two consecutive failed refreshes before any tenant
 * notices, and the third failure is the one worth noticing.
 */
export const ITEMS_SYNC_INTERVAL_MS = 2 * 60 * 60 * 1000

/**
 * How often to check whether a refresh is due.
 *
 * ⚠️ Much shorter than the interval on purpose. `items_synced_at` IS the
 * last-SUCCESS marker — there is no separate attempt bookkeeping — so a failed
 * sync simply leaves it alone and the next tick retries. At fifteen minutes a
 * transient Torn outage costs one retry cycle and recovers long before the
 * six-hour freshness window closes, while a persistent failure costs 96 calls a
 * day against a limit of 100 a minute.
 */
export const ITEMS_CHECK_INTERVAL_MS = 15 * 60 * 1000

export interface ItemsSyncHandle {
  stop(): void
}

/**
 * Refresh the fleet catalogue when it is due, forever.
 *
 * ⚠️ Never throws, like the monitor loop: a sync failure must not take down the
 * process that is also serving the status page saying prices are stale.
 */
export function startItemsSync(
  deps: ItemsSyncDeps,
  checkMs = ITEMS_CHECK_INTERVAL_MS,
  intervalMs = ITEMS_SYNC_INTERVAL_MS
): ItemsSyncHandle {
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  const tick = async () => {
    try {
      const due = await itemsSyncIsDue(deps, intervalMs)
      if (due) {
        const r = await syncFleetItems(deps)
        console.log(`[items] published ${r.rows} items to the fleet at ${r.syncedAt}`)
      }
    } catch (e) {
      console.error(`[items] sync failed, previous prices stand: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (!stopped) timer = setTimeout(tick, checkMs)
    }
  }

  void tick()
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

export async function itemsSyncIsDue(deps: ItemsSyncDeps, intervalMs = ITEMS_SYNC_INTERVAL_MS): Promise<boolean> {
  // ⚠️ Formatted in SQL, for the reason spelled out in globalDb.ts: db.ts
  // installs a process-wide timestamptz parser, so an unformatted read comes
  // back as `2026-09-06T07:00:00-05` — which Date.parse rejects, making `age`
  // NaN and this function answer "due" on every single tick, forever.
  const res = await deps.db.query(
    `SELECT to_char(items_synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS items_synced_at
       FROM fleet_meta WHERE id = 1`
  )
  const at = res.rows[0]?.items_synced_at
  // ⚠️ NULL means never synced, which IS due — the opposite of the reading
  // elsewhere in this codebase, where a null items_synced_at means "not in
  // service" and must not raise an alert. Here the control plane is the thing
  // putting it into service, so null is exactly the state to act on.
  if (!at) return true
  const age = (deps.now?.() ?? Date.now()) - Date.parse(String(at))
  // An unreadable timestamp reads as due: refreshing needlessly costs one API
  // call, while never refreshing costs the fleet its prices.
  return !Number.isFinite(age) || age >= intervalMs
}

// Faction armory (#542): shared between the cron job (inventorySync.ts) and
// the manual POST /api/inventory/sync (leadership.ts), which is the whole
// point — the two used to duplicate this mapping and stay in sync only by a
// comment.
//
// v2 `faction/inventory` needs one call per `cat`, paginated to
// `_metadata.total` (100/page); v1 returned everything in one call under
// eight top-level arrays. It also returns one row per stack-and-borrower
// rather than one row per item type — the same item id can appear many
// times with different `uids`/`loaned` — so the totals `inventory_items`
// expects (quantity, loaned, available) have to be aggregated back up.
//
// `loaned_to` is stored as structured JSON ({member_id, member_name, amount}[]),
// not a flattened string — v1's per-borrower amount doesn't survive a
// comma-join, and the UI needs the amount to show "who has how many", not
// just who. member_name comes straight from Torn, so display never depends
// on a client-side id->name lookup succeeding.
export const INVENTORY_CATEGORIES = [
  'weapons', 'armor', 'temporary', 'medical', 'consumables', 'drugs', 'boosters', 'utilities', 'loot',
]

interface RawInventoryItem {
  id: number | string
  name?: string | null
  type?: string | null
  amount?: number | null
  loaned?: { id: number | string; name?: string | null } | null
  category: string
}

export interface LoanedTo {
  member_id: string
  member_name: string
  amount: number
}

export interface InventoryRow {
  id: string
  name: string
  quantity: number
  available: number
  loaned: number
  loaned_to: LoanedTo[] | null
  api_type: string | null
  category: string
}

async function fetchInventoryCategory(
  fetchJson: (query: string) => Promise<any>,
  category: string
): Promise<RawInventoryItem[]> {
  const items: RawInventoryItem[] = []
  let offset = 0
  for (;;) {
    const data = await fetchJson(`cat=${category}&limit=100&offset=${offset}`)
    const page: any[] = Array.isArray(data?.inventory) ? data.inventory : []
    for (const item of page) items.push({ ...item, category })
    offset += page.length
    const total = Number(data?._metadata?.total)
    if (page.length === 0 || (Number.isFinite(total) && offset >= total)) break
  }
  return items
}

/** `fetchJson` receives just the querystring (`cat=...&limit=...&offset=...`); each call site supplies its own transport (rate-limited client vs. a raw fetch). */
export async function fetchFactionInventoryV2(
  fetchJson: (query: string) => Promise<any>
): Promise<RawInventoryItem[]> {
  const all: RawInventoryItem[] = []
  for (const category of INVENTORY_CATEGORIES) {
    all.push(...await fetchInventoryCategory(fetchJson, category))
  }
  return all
}

export function aggregateInventoryRows(rawItems: RawInventoryItem[]): InventoryRow[] {
  const byId = new Map<string, {
    name: string; quantity: number; loaned: number
    // member_id -> { name, amount } — a member can appear in more than one
    // stack of the same item (multiple loan events), so amounts accumulate
    // rather than the last write winning.
    borrowers: Map<string, { name: string; amount: number }>
    api_type: string | null; category: string
  }>()
  for (const item of rawItems) {
    const id = String(item.id)
    let row = byId.get(id)
    if (!row) {
      row = { name: item.name || `Item ${item.id}`, quantity: 0, loaned: 0, borrowers: new Map(), api_type: item.type || null, category: item.category }
      byId.set(id, row)
    }
    const amount = Number(item.amount) || 0
    row.quantity += amount
    if (item.loaned) {
      row.loaned += amount
      const memberId = String(item.loaned.id)
      const existing = row.borrowers.get(memberId)
      const name = item.loaned.name || memberId
      row.borrowers.set(memberId, { name, amount: (existing?.amount || 0) + amount })
    }
  }
  return [...byId.entries()].map(([id, row]) => ({
    id, name: row.name, quantity: row.quantity, available: row.quantity - row.loaned,
    loaned: row.loaned,
    loaned_to: row.borrowers.size > 0
      ? [...row.borrowers.entries()].map(([member_id, b]) => ({ member_id, member_name: b.name, amount: b.amount }))
      : null,
    api_type: row.api_type, category: row.category,
  }))
}

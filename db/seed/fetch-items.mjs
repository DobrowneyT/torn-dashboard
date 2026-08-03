// Regenerates items.json (the game-global Torn item catalog seed) from the
// Torn API v2. Run from the repo root so dotenv finds .env:
//   node db/seed/fetch-items.mjs
// Prices go stale quickly; the items scraper refreshes them after first boot,
// so regenerating this seed is only needed when Torn adds new items.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

const key = process.env.TORN_SEED_API_KEY ?? process.env.VITE_TORN_API_KEY
if (!key) {
  console.error('Set TORN_SEED_API_KEY (or VITE_TORN_API_KEY) in the environment')
  process.exit(1)
}

const res = await fetch(`https://api.torn.com/v2/torn/items?key=${encodeURIComponent(key)}`)
if (!res.ok) {
  console.error(`Torn API HTTP ${res.status}: ${await res.text()}`)
  process.exit(1)
}
const data = await res.json()
if (data.error) {
  console.error('Torn API error:', data.error)
  process.exit(1)
}

const rows = data.items.map((i) => ({
  id: i.id,
  name: i.name,
  description: i.description,
  effect: i.effect,
  type: i.type,
  sub_type: i.sub_type,
  market_price: i.value?.market_price ?? null,
  sell_price: i.value?.sell_price ?? null,
  buy_price: i.value?.buy_price ?? null,
  circulation: i.circulation,
  is_tradable: i.is_tradable,
  image_url: i.image,
}))

const out = join(dirname(fileURLToPath(import.meta.url)), 'items.json')
writeFileSync(out, JSON.stringify(rows))
console.log(`Wrote ${rows.length} items to ${out}`)

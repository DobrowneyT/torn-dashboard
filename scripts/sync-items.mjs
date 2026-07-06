// Maintenance script: sync the Torn item catalogue into the `items` table.
//
// SERVER-SIDE ONLY. This uses the Supabase service_role key, which bypasses RLS
// and must NEVER reach the browser. That's why this file lives outside src/
// (nothing Vite can bundle) and reads its secrets from process.env — loaded
// from .env by dotenv — instead of importing src/config.js.
//
// Required env (use NON-VITE names so `vite build` can never inline them):
//   SUPABASE_URL              (falls back to VITE_SUPABASE_URL — the URL is public)
//   SUPABASE_SERVICE_ROLE_KEY (secret — server-side only)
//   TORN_API_KEY              (a Torn key with item access — server-side only)
//
// Run with:  npm run sync:items
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const TORN_API_KEY = process.env.TORN_API_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !TORN_API_KEY) {
  console.error(
    'Missing env. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and TORN_API_KEY ' +
    '(non-VITE names) in your .env before running sync:items.'
  )
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

async function syncItems() {
  console.log('Fetching all items from Torn API...')

  const response = await fetch(
    `https://api.torn.com/v2/torn/items?cat=All&sort=ASC&key=${TORN_API_KEY}`
  )

  if (!response.ok) {
    throw new Error(`API request failed: ${response.statusText}`)
  }

  const data = await response.json()

  if (!data.items || data.items.length === 0) {
    console.log('No items returned from API')
    return
  }

  console.log(`Received ${data.items.length} items from API`)

  const itemsToUpsert = data.items.map(item => ({
    id: item.id,
    name: item.name,
    description: item.description,
    effect: item.effect,
    type: item.type,
    sub_type: item.sub_type,
    market_price: item.value?.market_price || 0,
    sell_price: item.value?.sell_price || 0,
    buy_price: item.value?.buy_price || 0,
    circulation: item.circulation,
    is_tradable: item.is_tradable,
    image_url: item.image,
    last_updated: new Date().toISOString(),
  }))

  // Upsert in batches of 500
  const batchSize = 500
  for (let i = 0; i < itemsToUpsert.length; i += batchSize) {
    const batch = itemsToUpsert.slice(i, i + batchSize)

    const { error } = await supabase
      .from('items')
      .upsert(batch, { onConflict: 'id' })

    if (error) {
      console.error(`Error upserting batch ${i / batchSize + 1}:`, error)
      throw error
    }

    console.log(`Upserted batch ${i / batchSize + 1} of ${Math.ceil(itemsToUpsert.length / batchSize)}`)
  }

  console.log(`Successfully synced ${itemsToUpsert.length} items`)
}

syncItems().catch(err => {
  console.error(err)
  process.exit(1)
})

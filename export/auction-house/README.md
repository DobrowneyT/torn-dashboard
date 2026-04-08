# Torn City Auction House Scraper

Scrapes historical auction house listings for weapons and armor from the Torn City API and stores them in Supabase.

## Project Structure

```
auction-house/
  scripts/
    ah_listing_by_itemid.py   # Main scraper (single item or bulk)
    utils/
      torn_api.py             # Torn City API wrapper
      supabase_manager.py     # Supabase storage backend
      json_storage.py         # Local JSON storage backend
  tests/
    test_json_ah_listings.py  # Test scraper with JSON storage
    test_sql_ah_listings.py   # Test scraper with Supabase storage (bulk, all items)
  src/
    AhView.jsx                # React frontend component
```

## Environment Variables

```bash
TORN_API_KEY=your_torn_api_key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_service_role_key   # Use service_role key, NOT anon key
```

## Database Setup

### 1. Check existing table schemas (run in Supabase SQL editor)

```sql
SELECT
    c.column_name,
    c.data_type,
    c.character_maximum_length,
    c.is_nullable,
    c.column_default
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name IN ('auction_listings', 'current_owners')
ORDER BY c.table_name, c.ordinal_position;
```

To generate a full CREATE TABLE statement from an existing table:

```sql
SELECT 'CREATE TABLE ' || table_name || ' (' ||
    string_agg(
        column_name || ' ' || data_type ||
        CASE WHEN character_maximum_length IS NOT NULL
             THEN '(' || character_maximum_length || ')'
             ELSE '' END ||
        CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END,
        ', ' ORDER BY ordinal_position
    ) || ');'
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('auction_listings', 'current_owners')
GROUP BY table_name;
```

### 2. Recreate tables (based on schema at time of export)

```sql
-- Auction house historical sales
CREATE TABLE public.auction_listings (
    auction_id      BIGINT PRIMARY KEY,
    item_id         INTEGER,
    item_uid        BIGINT,
    item_name       TEXT NOT NULL DEFAULT 'Unknown',
    item_type       TEXT NOT NULL DEFAULT 'Unknown',
    item_sub_type   TEXT,
    seller_id       INTEGER,
    seller_name     TEXT NOT NULL DEFAULT 'Unknown',
    buyer_id        INTEGER,
    buyer_name      TEXT NOT NULL DEFAULT 'Unknown',
    timestamp       BIGINT NOT NULL,
    price           BIGINT DEFAULT 0,
    bids            INTEGER DEFAULT 0,
    item_stats      JSONB,
    item_bonuses    JSONB,
    item_rarity     TEXT,
    full_listing    JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auction_listings_item_id   ON public.auction_listings (item_id);
CREATE INDEX IF NOT EXISTS idx_auction_listings_timestamp ON public.auction_listings (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_auction_listings_seller_id ON public.auction_listings (seller_id);

-- Current market owners (derived/aggregated view table)
CREATE TABLE public.current_owners (
    -- Run the schema inspection SQL above to get exact column definitions
    -- This table was populated separately and its exact schema should be
    -- verified from the source Supabase project before recreating
);
```

> **Note:** Run the schema inspection SQL above against your old Supabase project first to get the exact `current_owners` column definitions before recreating it.

### 3. RLS Policies

```sql
-- Enable RLS
ALTER TABLE public.auction_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.current_owners ENABLE ROW LEVEL SECURITY;

-- Allow public read access
CREATE POLICY "auction_listings_select" ON public.auction_listings
    FOR SELECT TO anon USING (true);

CREATE POLICY "current_owners_select" ON public.current_owners
    FOR SELECT TO anon USING (true);

-- Writes go through service role key (bypasses RLS) — no insert policy needed
```

## Usage

### Single item (JSON storage)
```bash
python scripts/ah_listing_by_itemid.py --item-id 27 --from-ts 1577858400
```

### Single item (Supabase)
```bash
python scripts/ah_listing_by_itemid.py --item-id 27 --storage supabase
```

### Bulk scrape all weapons + armor (Supabase)
Edit `ITEM_IDS` in `tests/test_sql_ah_listings.py` then:
```bash
python tests/test_sql_ah_listings.py
```

## Item Categories Scraped

- Melee weapons
- Primary weapons (rifles, etc.)
- Secondary weapons (pistols, etc.)
- Armor

See `ITEM_IDS` list in `tests/test_sql_ah_listings.py` for the full set.

## Frontend

`src/AhView.jsx` is a React component using `@supabase/supabase-js` and Tailwind CSS.
Wire it into your app:

```jsx
import AhView from './AhView'
// Add a tab/route pointing to <AhView />
```

Reads from `auction_listings` and `current_owners` via the Supabase anon key (public read).

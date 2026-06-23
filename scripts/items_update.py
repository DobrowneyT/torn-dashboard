#!/usr/bin/env python3
"""
Fetch the full Torn items catalog and upsert into the `items` table.

Runs as part of the daily scrapers workflow. Keeps market_price / sell_price
fresh so OC payout enrichment can look up current values (and sell-price
overrides for items in config.useSellPriceItemIds).
"""

import logging
import os
import sys
from datetime import datetime, timezone

import requests
from supabase import create_client

from utils.key_pool import claim_next_api_key

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
)
logger = logging.getLogger(__name__)

CHUNK_SIZE = 500


def chunked(lst, size):
    for i in range(0, len(lst), size):
        yield lst[i:i + size]


def fetch_items(api_key: str) -> list:
    url = f"https://api.torn.com/v2/torn/items?cat=All&sort=ASC&key={api_key}&comment=Forge_Items_Sync"
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, dict) and data.get('error'):
        raise RuntimeError(f"Torn API error: {data['error']}")
    items = data.get('items') or []
    logger.info(f"Fetched {len(items)} items from Torn API")
    return items


def transform(items: list) -> list:
    now = datetime.now(timezone.utc).isoformat()
    rows = []
    for it in items:
        if it.get('id') is None:
            continue
        value = it.get('value') or {}
        rows.append({
            'id': it['id'],
            'name': it.get('name') or f"Item {it['id']}",
            'description': it.get('description'),
            'effect': it.get('effect'),
            'type': it.get('type'),
            'sub_type': it.get('sub_type'),
            'market_price': value.get('market_price') or 0,
            'sell_price': value.get('sell_price') or 0,
            'buy_price': value.get('buy_price') or 0,
            'circulation': it.get('circulation'),
            'is_tradable': it.get('is_tradable'),
            'image_url': it.get('image'),
            'last_updated': now,
        })
    return rows


def main() -> int:
    supabase_url = os.environ.get('VITE_SUPABASE_URL')
    supabase_key = os.environ.get('VITE_SUPABASE_SERVICE_ROLE_KEY')

    if not supabase_url or not supabase_key:
        logger.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_ROLE_KEY")
        return 1

    # Items catalog is public, so any consented key works (Recruits included).
    api_key = claim_next_api_key(faction_only=False)

    client = create_client(supabase_url, supabase_key)

    items = fetch_items(api_key)
    rows = transform(items)
    if not rows:
        logger.warning("No items to upsert")
        return 0

    total = 0
    chunks = list(chunked(rows, CHUNK_SIZE))
    for i, chunk in enumerate(chunks, 1):
        client.table('items').upsert(chunk, on_conflict='id').execute()
        total += len(chunk)
        logger.info(f"Upserted items chunk {i}/{len(chunks)} ({len(chunk)} records)")

    logger.info(f"✓ items sync complete: {total} rows")
    return 0


if __name__ == '__main__':
    sys.exit(main())

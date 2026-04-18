#!/usr/bin/env python3
"""
Local backfill script for member_daily_stats.

Run this locally before the first GitHub Actions push to populate the last
30 days of personalstats for all current members. After this, the daily
scraper only needs to fetch today's snapshot (+ backfill for any new members
who joined since the last run).

Usage:
    python scripts/backfill_member_stats.py

Requires env vars: VITE_TORN_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_SERVICE_ROLE_KEY
"""

import os
import sys
import json
import logging
from pathlib import Path
from datetime import datetime, timedelta, date
from typing import Dict, List, Set

from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
for env_path in (SCRIPT_DIR / ".env", SCRIPT_DIR.parent / ".env"):
    if env_path.exists():
        load_dotenv(env_path)

sys.path.insert(0, str(SCRIPT_DIR))

from utils.torn_api import TornAPIError, create_torn_api
from supabase import create_client, Client

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

BACKFILL_DAYS = 30
CHUNK_SIZE = 100

# Timestamp offset: 01:00 UTC (3600s) — matches the daily cron schedule
SNAPSHOT_OFFSET_SECONDS = 3600

# Max stats per V2 API call
V2_MAX_STATS_PER_CALL = 10


def load_stat_names() -> List[str]:
    """Load the flat list of stat names from config/personalstats.json."""
    config_path = SCRIPT_DIR / 'config' / 'personalstats.json'
    with open(config_path) as f:
        config = json.load(f)
    stats = []
    for key, value in config.items():
        if isinstance(value, list):
            stats.extend(value)
    return stats


def chunk_stats(stats: List[str], size: int = V2_MAX_STATS_PER_CALL) -> List[str]:
    """Split a flat stat list into comma-separated groups of `size`."""
    return [','.join(stats[i:i + size]) for i in range(0, len(stats), size)]


def fetch_personalstats_v2(api, member_id: str, stat_groups: List[str], timestamp: int) -> dict | None:
    """
    Fetch personalstats via V2 API for a specific timestamp.

    Makes one call per stat group, merges the array responses
    into a flat {name: value} dict.
    """
    merged = {}
    for group in stat_groups:
        url = f"{api.BASE_URL}/user/{member_id}/personalstats"
        try:
            data = api._make_request(url, params={
                'stat': group,
                'timestamp': str(timestamp),
                'key': api.api_key,
            })
            if data and 'personalstats' in data:
                for entry in data['personalstats']:
                    merged[entry['name']] = entry['value']
        except TornAPIError as e:
            logger.warning(f"V2 stats failed for {member_id} group [{group[:30]}…]: {e}")
    return merged if merged else None


def main():

    api = create_torn_api()

    supabase_url = os.environ.get('VITE_SUPABASE_URL')
    supabase_key = os.environ.get('VITE_SUPABASE_SERVICE_ROLE_KEY')
    if not supabase_url or not supabase_key:
        raise ValueError("Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_ROLE_KEY")

    sb: Client = create_client(supabase_url, supabase_key)

    # Load stats config and build runtime chunks
    all_stats = load_stat_names()
    stat_groups = chunk_stats(all_stats)

    today = date.today()
    today_str = today.isoformat()

    # Target dates: last 30 days (excluding today — daily scraper handles today)
    target_dates = set()
    for i in range(1, BACKFILL_DAYS + 1):
        target_dates.add((today - timedelta(days=i)).isoformat())

    logger.info("=" * 60)
    logger.info("Member Stats Backfill (local)")
    logger.info(f"Today: {today_str}  |  Backfilling {BACKFILL_DAYS} days")
    logger.info(f"Tracking {len(all_stats)} stats  |  {len(stat_groups)} API calls per member per day")
    logger.info("=" * 60)

    # 1. Get current members
    members = sb.table('members') \
        .select('member_id, member_name') \
        .eq('is_current', True) \
        .execute().data or []
    logger.info(f"Found {len(members)} current members")

    if not members:
        logger.warning("No current members — exiting")
        return

    # 2. Per-member: check existing dates and calculate missing days
    total_missing = 0
    member_missing: List[tuple] = []  # (member_dict, [missing_date_strs])
    logger.info("Checking existing data per member...")
    for m in members:
        mid = str(m['member_id'])
        resp = sb.table('member_daily_stats') \
            .select('snapshot_date') \
            .eq('member_id', mid) \
            .execute()
        existing = {row['snapshot_date'] for row in (resp.data or [])}
        missing = sorted(target_dates - existing)
        if missing:
            member_missing.append((m, missing))
            total_missing += len(missing)

    if total_missing == 0:
        logger.info("All members already have 30 days of data — nothing to do")
        return

    api_calls_needed = total_missing * len(stat_groups)
    logger.info(f"{len(member_missing)} members need backfill, {total_missing} member-days")
    logger.info(f"API calls needed: {api_calls_needed} ({len(stat_groups)} per day)")
    est_minutes = (api_calls_needed * 0.6) / 60
    logger.info(f"Estimated time: ~{est_minutes:.0f} minutes (at 0.6s per call)")

    # 3. Backfill
    records = []
    days_fetched = 0

    for mi, (m, missing_dates) in enumerate(member_missing, 1):
        mid = str(m['member_id'])
        name = m.get('member_name', mid)
        logger.info(f"\n[{mi}/{len(member_missing)}] {name} ({mid}): {len(missing_dates)} missing days")

        for di, d_str in enumerate(missing_dates, 1):
            d = date.fromisoformat(d_str)
            ts = int(datetime.combine(d, datetime.min.time()).timestamp()) + SNAPSHOT_OFFSET_SECONDS

            stats = fetch_personalstats_v2(api, mid, stat_groups, ts)
            days_fetched += 1

            if stats:
                records.append({
                    'member_id': mid,
                    'snapshot_date': d_str,
                    'personalstats': stats,
                    'api_version': 'v2',
                })
            else:
                logger.warning(f"  {d_str}: no data")

            # Upsert in chunks to avoid losing progress on interruption
            if len(records) >= CHUNK_SIZE:
                _upsert_chunk(sb, records)
                records = []

            if days_fetched % 20 == 0:
                logger.info(f"  Progress: {days_fetched}/{total_missing} member-days")

    # Final upsert
    if records:
        _upsert_chunk(sb, records)

    logger.info("\n" + "=" * 60)
    logger.info("BACKFILL COMPLETE")
    logger.info(f"Member-days fetched: {days_fetched}")
    logger.info(f"Members filled:      {len(member_missing)}")
    logger.info("=" * 60)


def _upsert_chunk(sb: Client, records: list):
    try:
        sb.table('member_daily_stats').upsert(
            records,
            on_conflict='member_id,snapshot_date'
        ).execute()
        logger.info(f"  Upserted {len(records)} records")
    except Exception as e:
        logger.error(f"  Upsert failed: {e}")


if __name__ == '__main__':
    main()

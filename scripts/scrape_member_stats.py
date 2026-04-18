#!/usr/bin/env python3
"""
Member Daily Stats Scraper

Collects two kinds of data and writes them to the member_daily_stats table:

1. Personal stats — per-member via V2 API with specific stat selections.
   - Current day: /v2/user/{id}/personalstats?stat=...  (no timestamp = now)
   - Backfill (missing days in last 30): same endpoint with &timestamp={ts}
   - Stats loaded from config/personalstats.json, chunked into groups of 10 at runtime.
   - Response is an array [{name, value, timestamp}] converted to flat dict.

2. Gym contributions — faction-level, 4 API calls total.
   - /v2/faction/contributors?stat={stat}&cat=current  for gymstrength/gymspeed/gymdexterity/gymdefense
   - These have NO historical lookback, so they accumulate day by day.

Flow:
  1. Fetch all current members from Supabase (is_current = true)
  2. Check which dates each member already has in member_daily_stats
  3. For each member, identify missing days in the last 30 days
  4. Backfill missing days via V2 API with timestamp parameter
  5. Fetch today's V2 snapshot for ALL current members
  6. Fetch gym contributions (4 faction calls) → merge into today's rows
  7. Upsert everything to Supabase
"""

import os
import sys
import json
import logging
from datetime import datetime, timedelta, date
from typing import Dict, List, Set

# Add parent directory to path so we can import from utils
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from utils.torn_api import TornAPI, TornAPIError, create_torn_api
from supabase import create_client, Client

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

BACKFILL_DAYS = 30

# Timestamp offset: 01:00 UTC (3600s) — matches the daily cron schedule
SNAPSHOT_OFFSET_SECONDS = 3600

# Max stats per V2 API call
V2_MAX_STATS_PER_CALL = 10

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def load_stat_names() -> list:
    """Load the flat list of stat names from config/personalstats.json."""
    config_path = os.path.join(SCRIPT_DIR, 'config', 'personalstats.json')
    with open(config_path) as f:
        config = json.load(f)
    stats = []
    for key, value in config.items():
        if isinstance(value, list):
            stats.extend(value)
    return stats


def chunk_stats(stats: list, size: int = V2_MAX_STATS_PER_CALL) -> list:
    """Split a flat stat list into comma-separated groups of `size`."""
    return [','.join(stats[i:i + size]) for i in range(0, len(stats), size)]


GYM_STATS = ['gymstrength', 'gymspeed', 'gymdexterity', 'gymdefense']
GYM_COLUMN_MAP = {
    'gymstrength': 'gym_strength',
    'gymspeed': 'gym_speed',
    'gymdexterity': 'gym_dexterity',
    'gymdefense': 'gym_defense',
}


class MemberStatsScraper:
    def __init__(self):
        self.api = create_torn_api()

        supabase_url = os.environ.get('VITE_SUPABASE_URL')
        supabase_key = os.environ.get('VITE_SUPABASE_SERVICE_ROLE_KEY')
        if not supabase_url or not supabase_key:
            raise ValueError("Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_ROLE_KEY")

        self.supabase: Client = create_client(supabase_url, supabase_key)

    # ─── Data fetchers ────────────────────────────────────────────────────────

    def fetch_personalstats_v2(self, member_id: str, stat_groups: list, timestamp: int = None) -> dict | None:
        """
        Fetch personalstats via V2 API with specific stat selections.

        Makes one call per stat group, merges the array responses
        into a flat {name: value} dict.

        Args:
            member_id: Torn member ID
            stat_groups: List of comma-separated stat group strings
            timestamp: Optional Unix timestamp for historical lookback
        """
        merged = {}
        for group in stat_groups:
            url = f"{self.api.BASE_URL}/user/{member_id}/personalstats"
            params = {'stat': group, 'key': self.api.api_key}
            if timestamp:
                params['timestamp'] = str(timestamp)
            try:
                data = self.api._make_request(url, params)
                if data and 'personalstats' in data:
                    for entry in data['personalstats']:
                        merged[entry['name']] = entry['value']
            except TornAPIError as e:
                logger.warning(f"V2 stats failed for {member_id} group [{group[:30]}…]: {e}")
        return merged if merged else None

    def fetch_gym_contributors(self, stat: str) -> list | None:
        """Fetch faction gym contributors for a single stat."""
        url = f"{self.api.BASE_URL}/faction/contributors"
        try:
            data = self.api._make_request(url, params={
                'stat': stat,
                'cat': 'current',
                'key': self.api.api_key,
            })
            if data and 'contributors' in data:
                return data['contributors']
            return None
        except TornAPIError as e:
            logger.warning(f"Gym contributors failed for {stat}: {e}")
            return None

    # ─── Main logic ───────────────────────────────────────────────────────────

    def get_current_members(self) -> List[Dict]:
        """Get all current faction members from Supabase."""
        resp = self.supabase.table('members') \
            .select('member_id, member_name') \
            .eq('is_current', True) \
            .execute()
        return resp.data or []

    def get_member_snapshot_dates(self, member_id: str) -> Set[str]:
        """
        Returns set of snapshot_date strings for a single member.
        """
        resp = self.supabase.table('member_daily_stats') \
            .select('snapshot_date') \
            .eq('member_id', member_id) \
            .execute()
        return {row['snapshot_date'] for row in (resp.data or [])}

    def run(self):
        today = date.today()
        today_str = today.isoformat()

        # Load stats config and build runtime chunks
        all_stats = load_stat_names()
        stat_groups = chunk_stats(all_stats)

        logger.info("=" * 60)
        logger.info("Member Daily Stats Scraper")
        logger.info(f"Today: {today_str}")
        logger.info(f"Tracking {len(all_stats)} stats  |  {len(stat_groups)} API calls per member")
        logger.info("=" * 60)

        # 1. Get current members
        members = self.get_current_members()
        logger.info(f"Found {len(members)} current faction members")

        if not members:
            logger.warning("No current members found — exiting")
            return

        # 2. Build the full set of dates we want covered (last 30 days, excluding today)
        target_dates = set()
        for i in range(1, BACKFILL_DAYS + 1):
            target_dates.add((today - timedelta(days=i)).isoformat())

        records_to_upsert = []
        total_backfill_calls = 0

        # 3. Backfill missing days for each member
        logger.info(f"\n--- Backfill: checking {BACKFILL_DAYS} days for {len(members)} members ---")
        for mi, m in enumerate(members, 1):
            mid = str(m['member_id'])
            name = m.get('member_name', mid)
            member_existing = self.get_member_snapshot_dates(mid)

            missing_dates = sorted(target_dates - member_existing)

            if not missing_dates:
                continue

            logger.info(f"  [{mi}/{len(members)}] {name} ({mid}): {len(missing_dates)} missing days")

            for d_str in missing_dates:
                d = date.fromisoformat(d_str)
                ts = int(datetime.combine(d, datetime.min.time()).timestamp()) + SNAPSHOT_OFFSET_SECONDS
                stats = self.fetch_personalstats_v2(mid, stat_groups, timestamp=ts)
                total_backfill_calls += 1

                if stats:
                    records_to_upsert.append({
                        'member_id': mid,
                        'snapshot_date': d_str,
                        'personalstats': stats,
                        'api_version': 'v2',
                    })
                else:
                    logger.warning(f"    No V2 data for {name} on {d_str}")

        logger.info(f"Backfill complete: {total_backfill_calls} member-days, {len(records_to_upsert)} records")

        # 5. Current stats: V2 call for ALL members (today's snapshot, no timestamp)
        logger.info(f"\n--- Current stats: fetching V2 personalstats for {len(members)} members ---")
        for i, m in enumerate(members, 1):
            mid = str(m['member_id'])
            name = m.get('member_name', mid)
            logger.info(f"  Current {i}/{len(members)}: {name} ({mid})")

            stats = self.fetch_personalstats_v2(mid, stat_groups)
            if stats:
                records_to_upsert.append({
                    'member_id': mid,
                    'snapshot_date': today_str,
                    'personalstats': stats,
                    'api_version': 'v2',
                })
            else:
                logger.warning(f"  No V2 data for {name} ({mid})")

        # 6. Gym contributions: 4 faction calls
        logger.info(f"\n--- Gym contributions: 4 faction calls ---")
        gym_data: Dict[str, Dict[str, int]] = {}  # {member_id: {column: value}}

        for stat in GYM_STATS:
            col = GYM_COLUMN_MAP[stat]
            logger.info(f"  Fetching {stat}...")
            contributors = self.fetch_gym_contributors(stat)
            if not contributors:
                logger.warning(f"  Failed to fetch {stat}")
                continue

            for entry in contributors:
                mid = str(entry['id'])
                if mid not in gym_data:
                    gym_data[mid] = {}
                gym_data[mid][col] = entry.get('value', 0)

            logger.info(f"  {stat}: {len(contributors)} members")

        # Merge gym data into today's records
        today_member_ids = {r['member_id'] for r in records_to_upsert if r['snapshot_date'] == today_str}
        for record in records_to_upsert:
            if record['snapshot_date'] == today_str and record['member_id'] in gym_data:
                record.update(gym_data[record['member_id']])

        # For members who had gym data but no personalstats (shouldn't happen, but just in case)
        for mid, gym_values in gym_data.items():
            if mid not in today_member_ids:
                record = {
                    'member_id': mid,
                    'snapshot_date': today_str,
                    **gym_values,
                }
                records_to_upsert.append(record)

        # 7. Upsert to Supabase
        logger.info(f"\n--- Upserting {len(records_to_upsert)} records to member_daily_stats ---")
        if records_to_upsert:
            CHUNK_SIZE = 100
            total_upserted = 0
            for i in range(0, len(records_to_upsert), CHUNK_SIZE):
                chunk = records_to_upsert[i:i + CHUNK_SIZE]
                try:
                    self.supabase.table('member_daily_stats').upsert(
                        chunk,
                        on_conflict='member_id,snapshot_date'
                    ).execute()
                    total_upserted += len(chunk)
                    logger.info(f"  Upserted chunk {i // CHUNK_SIZE + 1}: {len(chunk)} records")
                except Exception as e:
                    logger.error(f"  Upsert failed for chunk {i // CHUNK_SIZE + 1}: {e}")

            logger.info(f"Total upserted: {total_upserted}")
        else:
            logger.info("Nothing to upsert")

        # Summary
        backfill_count = sum(1 for r in records_to_upsert if r['snapshot_date'] != today_str)
        today_count = sum(1 for r in records_to_upsert if r['snapshot_date'] == today_str)
        gym_count = len(gym_data)

        logger.info("\n" + "=" * 60)
        logger.info("SUMMARY")
        logger.info("=" * 60)
        logger.info(f"Members processed:   {len(members)}")
        logger.info(f"Backfill rows:       {backfill_count} ({total_backfill_calls} API calls)")
        logger.info(f"Today rows:          {today_count}")
        logger.info(f"Gym data for:        {gym_count} members")
        logger.info(f"Total API calls:     ~{total_backfill_calls * len(stat_groups) + len(members) * len(stat_groups) + 4}")
        logger.info("=" * 60)


def main():
    try:
        scraper = MemberStatsScraper()
        scraper.run()
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == '__main__':
    main()

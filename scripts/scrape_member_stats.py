#!/usr/bin/env python3
"""
Member Daily Stats Scraper

Collects two kinds of data and writes them to the member_daily_stats table:

1. Personal stats — per-member via Torn API.
   - Current day: V2 /v2/user/{id}/personalstats?cat=all
   - Backfill (missing days in last 30): V1 /user/{id}?selections=personalstats&timestamp={ts}
     The V1 API supports a `timestamp` parameter that returns stats as they were at that point.

2. Gym contributions — faction-level, 4 API calls total.
   - /v2/faction/contributors?stat={stat}&cat=current  for gymstrength/gymspeed/gymdexterity/gymdefense
   - These have NO historical lookback, so they accumulate day by day.

Flow:
  1. Fetch all current members from Supabase (is_current = true)
  2. Check which dates each member already has in member_daily_stats
  3. For each member, identify missing days in the last 30 days
  4. Backfill missing days via V1 API with timestamp parameter
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

V1_BASE = "https://api.torn.com"

BACKFILL_DAYS = 30

# V1 requires explicit stat keys or the endpoint returns nothing
V1_STATS = ','.join([
    'attackswon', 'attackslost', 'defendswon', 'defendslost',
    'organisedcrimes', 'revives', 'itemsused', 'energydrinkused',
    'nerverefills', 'bountiescollected', 'useractivity',
    'xantaken', 'refills', 'alcoholused', 'boostersused',
    'statenhancersused', 'attacksassisted', 'rankedwarhits',
])

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

    def fetch_personalstats_v2(self, member_id: str) -> dict | None:
        """Fetch current personalstats via V2 API."""
        url = f"{self.api.BASE_URL}/user/{member_id}/personalstats"
        try:
            data = self.api._make_request(url, params={'cat': 'all', 'key': self.api.api_key})
            return data
        except TornAPIError as e:
            logger.warning(f"V2 personalstats failed for {member_id}: {e}")
            return None

    def fetch_personalstats_v1_historical(self, member_id: str, timestamp: int) -> dict | None:
        """Fetch historical personalstats via V1 API with timestamp parameter."""
        url = f"{V1_BASE}/user/{member_id}"
        try:
            data = self.api._make_request(url, params={
                'selections': 'personalstats',
                'stat': V1_STATS,
                'timestamp': str(timestamp),
                'key': self.api.api_key,
            })
            if data and 'personalstats' in data:
                return data['personalstats']
            return None
        except TornAPIError as e:
            logger.warning(f"V1 historical stats failed for {member_id} @ {timestamp}: {e}")
            return None

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

        logger.info("=" * 60)
        logger.info("Member Daily Stats Scraper")
        logger.info(f"Today: {today_str}")
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
                # Use noon UTC of the target date as the timestamp
                ts = int(datetime.combine(d, datetime.min.time()).timestamp()) + 43200
                stats = self.fetch_personalstats_v1_historical(mid, ts)
                total_backfill_calls += 1

                if stats:
                    records_to_upsert.append({
                        'member_id': mid,
                        'snapshot_date': d_str,
                        'personalstats': stats,
                        'api_version': 'v1',
                    })
                else:
                    logger.warning(f"    No V1 data for {name} on {d_str}")

        logger.info(f"Backfill complete: {total_backfill_calls} API calls, {len(records_to_upsert)} records")

        # 5. Current stats: V2 call for ALL members (today's snapshot)
        logger.info(f"\n--- Current stats: fetching V2 personalstats for {len(members)} members ---")
        for i, m in enumerate(members, 1):
            mid = str(m['member_id'])
            name = m.get('member_name', mid)
            logger.info(f"  Current {i}/{len(members)}: {name} ({mid})")

            data = self.fetch_personalstats_v2(mid)
            if data and 'personalstats' in data:
                records_to_upsert.append({
                    'member_id': mid,
                    'snapshot_date': today_str,
                    'personalstats': data['personalstats'],
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
        logger.info(f"Total API calls:     ~{total_backfill_calls + len(members) + 4}")
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

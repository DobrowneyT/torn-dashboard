#!/usr/bin/env python3
"""
Member Daily Stats Scraper

Collects two kinds of data and writes them to the member_daily_stats table:

1. Personal stats — per-member via Torn API.
   - Current: V2 /v2/user/{id}/personalstats?cat=all
   - 30-day backfill (new members only): V1 /user/{id}?selections=personalstats&timestamp={30d_ago}
     The V1 API supports a `timestamp` parameter that returns stats as they were at that point.

2. Gym contributions — faction-level, 4 API calls total.
   - /v2/faction/contributors?stat={stat}&cat=current  for gymstrength/gymspeed/gymdexterity/gymdefense
   - These have NO historical lookback, so they accumulate day by day.

Flow:
  1. Fetch all current members from Supabase (is_current = true)
  2. Check which members already have rows in member_daily_stats (to decide backfill)
  3. For members with NO existing rows: call V1 with timestamp=30d_ago → store as backfill
  4. For ALL current members: call V2 for today's snapshot
  5. Fetch gym contributions (4 faction calls) → merge into today's rows
  6. Upsert everything to Supabase
"""

import os
import sys
import json
import time
import logging
import requests
from datetime import datetime, timedelta, date
from typing import Dict, List, Optional, Set

from supabase import create_client, Client

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Rate limiting
RATE_LIMIT_DELAY = 0.6  # seconds between API calls

# Torn API base URLs
V1_BASE = "https://api.torn.com"
V2_BASE = "https://api.torn.com/v2"

BACKFILL_DAYS = 30

GYM_STATS = ['gymstrength', 'gymspeed', 'gymdexterity', 'gymdefense']
GYM_COLUMN_MAP = {
    'gymstrength': 'gym_strength',
    'gymspeed': 'gym_speed',
    'gymdexterity': 'gym_dexterity',
    'gymdefense': 'gym_defense',
}


class MemberStatsScraper:
    def __init__(self):
        self.api_key = os.environ.get('TORN_API_KEY')
        if not self.api_key:
            raise ValueError("TORN_API_KEY environment variable is required")

        supabase_url = os.environ.get('VITE_SUPABASE_URL')
        supabase_key = os.environ.get('VITE_SUPABASE_SERVICE_ROLE_KEY')
        if not supabase_url or not supabase_key:
            raise ValueError("Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_ROLE_KEY")

        self.supabase: Client = create_client(supabase_url, supabase_key)
        self.session = requests.Session()
        self.last_request_time = 0.0

    def _rate_limit(self):
        elapsed = time.time() - self.last_request_time
        if elapsed < RATE_LIMIT_DELAY:
            time.sleep(RATE_LIMIT_DELAY - elapsed)
        self.last_request_time = time.time()

    def _api_get(self, url: str, params: Dict = None) -> Optional[Dict]:
        """Make a rate-limited GET request. Returns None on error."""
        self._rate_limit()
        try:
            resp = self.session.get(url, params=params, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            if 'error' in data:
                code = data['error'].get('code')
                msg = data['error'].get('error', 'Unknown')
                logger.warning(f"API error {code}: {msg} — URL: {url}")
                return None
            return data
        except Exception as e:
            logger.error(f"Request failed: {e} — URL: {url}")
            return None

    # ─── Data fetchers ────────────────────────────────────────────────────────

    def fetch_personalstats_v2(self, member_id: str) -> Optional[Dict]:
        """Fetch current personalstats via V2 API."""
        url = f"{V2_BASE}/user/{member_id}/personalstats"
        return self._api_get(url, params={'cat': 'all', 'key': self.api_key})

    def fetch_personalstats_v1_historical(self, member_id: str, timestamp: int) -> Optional[Dict]:
        """Fetch historical personalstats via V1 API with timestamp parameter."""
        url = f"{V1_BASE}/user/{member_id}"
        data = self._api_get(url, params={
            'selections': 'personalstats',
            'timestamp': str(timestamp),
            'key': self.api_key,
        })
        if data and 'personalstats' in data:
            return data['personalstats']
        return None

    def fetch_gym_contributors(self, stat: str) -> Optional[List[Dict]]:
        """Fetch faction gym contributors for a single stat."""
        url = f"{V2_BASE}/faction/contributors"
        data = self._api_get(url, params={
            'stat': stat,
            'cat': 'current',
            'key': self.api_key,
        })
        if data and 'contributors' in data:
            return data['contributors']
        return None

    # ─── Main logic ───────────────────────────────────────────────────────────

    def get_current_members(self) -> List[Dict]:
        """Get all current faction members from Supabase."""
        resp = self.supabase.table('members') \
            .select('member_id, member_name') \
            .eq('is_current', True) \
            .execute()
        return resp.data or []

    def get_existing_snapshot_dates(self) -> Dict[str, Set[str]]:
        """
        Returns {member_id: set of snapshot_date strings} for all rows in member_daily_stats.
        Used to decide who needs a backfill.
        """
        resp = self.supabase.table('member_daily_stats') \
            .select('member_id, snapshot_date') \
            .execute()
        result: Dict[str, Set[str]] = {}
        for row in (resp.data or []):
            mid = str(row['member_id'])
            result.setdefault(mid, set()).add(row['snapshot_date'])
        return result

    def run(self):
        today = date.today()
        today_str = today.isoformat()
        backfill_date = today - timedelta(days=BACKFILL_DAYS)
        backfill_date_str = backfill_date.isoformat()
        backfill_timestamp = int(
            datetime.combine(backfill_date, datetime.min.time()).timestamp()
        )

        logger.info("="*60)
        logger.info("Member Daily Stats Scraper")
        logger.info(f"Today: {today_str}  |  Backfill target: {backfill_date_str}")
        logger.info("="*60)

        # 1. Get current members
        members = self.get_current_members()
        logger.info(f"Found {len(members)} current faction members")

        if not members:
            logger.warning("No current members found — exiting")
            return

        # 2. Check who already has data (for backfill decision)
        existing = self.get_existing_snapshot_dates()
        needs_backfill = [
            m for m in members if str(m['member_id']) not in existing
        ]
        logger.info(f"{len(needs_backfill)} members need 30-day backfill")

        records_to_upsert = []

        # 3. Backfill: V1 historical call for new members
        if needs_backfill:
            logger.info(f"\n--- Backfill: fetching {BACKFILL_DAYS}-day-old stats for {len(needs_backfill)} members ---")
            for i, m in enumerate(needs_backfill, 1):
                mid = str(m['member_id'])
                name = m.get('member_name', mid)
                logger.info(f"  Backfill {i}/{len(needs_backfill)}: {name} ({mid})")

                stats = self.fetch_personalstats_v1_historical(mid, backfill_timestamp)
                if stats:
                    records_to_upsert.append({
                        'member_id': mid,
                        'snapshot_date': backfill_date_str,
                        'personalstats': json.dumps(stats),
                        'api_version': 'v1',
                    })
                else:
                    logger.warning(f"  No V1 data for {name} ({mid}) — skipping backfill")

        # 4. Current stats: V2 call for ALL members
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
                    'personalstats': json.dumps(data['personalstats']),
                    'api_version': 'v2',
                })
            else:
                logger.warning(f"  No V2 data for {name} ({mid})")

        # 5. Gym contributions: 4 faction calls
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

        # 6. Upsert to Supabase
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
        backfill_count = sum(1 for r in records_to_upsert if r['snapshot_date'] == backfill_date_str)
        today_count = sum(1 for r in records_to_upsert if r['snapshot_date'] == today_str)
        gym_count = sum(1 for mid in gym_data)

        logger.info("\n" + "="*60)
        logger.info("SUMMARY")
        logger.info("="*60)
        logger.info(f"Members processed:   {len(members)}")
        logger.info(f"Backfill rows:       {backfill_count}")
        logger.info(f"Today rows:          {today_count}")
        logger.info(f"Gym data for:        {gym_count} members")
        logger.info(f"Total API calls:     ~{len(needs_backfill) + len(members) + 4}")
        logger.info("="*60)


def main():
    try:
        scraper = MemberStatsScraper()
        scraper.run()
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Member Daily Stats Scraper (Phase 2 refactor)

Collects three kinds of data and writes them to the member_daily_stats table:

1. Personal stats — per-member via V2 API with `cat=all` (one call per member
   replacing the previous 3-call chunked approach for ~25 named stats).
   - Current day: /v2/user/{id}/personalstats?cat=all  (no timestamp = now)
   - Backfill (missing days in last 30): same endpoint with &timestamp={ts}
   - Stored as-is in the `personalstats` jsonb column.

2. Profile — per-member via /v2/user/{id}/profile?striptags=true (today only,
   no historical equivalent). Yields the compliance fields we need:
     - donator_status ("Subscriber" / "Donator" / null)
     - property.name  (e.g. "Private Island" — use .name, not .id)
   Stored full in the `profile` jsonb column; denormalised to `is_donator`
   and `property_name` for easy filtering. `last_action.timestamp` is also
   copied to `last_action_timestamp` for the same reason.

3. Gym contributions — faction-level, 5 API calls total.
   - /v2/faction/contributors?stat={stat}&cat=current  for
     gymstrength / gymspeed / gymdexterity / gymdefense / gymenergy
   - No historical lookback, so they accumulate day by day.

API calls per scraper run:
  - 1 personalstats + 1 profile per member = 2 × N_members for today
  - 1 personalstats per (member × missing_day) for backfill
  - 5 faction calls for gym
"""

import os
import sys
import logging
from datetime import datetime, timedelta, date
from typing import Dict, List, Set

# Add parent directory to path so we can import from utils
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from utils.torn_api import TornAPI, TornAPIError, create_torn_api  # noqa: F401
from supabase import create_client, Client

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

BACKFILL_DAYS = 30

# Timestamp offset: 01:00 UTC (3600s) — matches the daily cron schedule
SNAPSHOT_OFFSET_SECONDS = 3600

GYM_STATS = ['gymstrength', 'gymspeed', 'gymdexterity', 'gymdefense', 'gymenergy']
GYM_COLUMN_MAP = {
    'gymstrength':  'gym_strength',
    'gymspeed':     'gym_speed',
    'gymdexterity': 'gym_dexterity',
    'gymdefense':   'gym_defense',
    'gymenergy':    'gym_energy',
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

    def fetch_personalstats_all(self, member_id: str, timestamp: int = None) -> dict | None:
        """
        Fetch the full personalstats response via `cat=all`. Returns the nested
        dict under the `personalstats` key (the new shape going forward), or
        None on error.
        """
        try:
            data = self.api.get_personalstats_all(int(member_id), timestamp=timestamp)
            return data.get('personalstats') if data else None
        except TornAPIError as e:
            ts_note = f" @ ts={timestamp}" if timestamp else ""
            logger.warning(f"personalstats?cat=all failed for {member_id}{ts_note}: {e}")
            return None

    def fetch_profile(self, member_id: str) -> dict | None:
        """Fetch /user/{id}/profile. Returns the nested `profile` dict or None."""
        try:
            data = self.api.get_user_profile(int(member_id))
            return data.get('profile') if data else None
        except TornAPIError as e:
            logger.warning(f"profile failed for {member_id}: {e}")
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
        """Returns set of snapshot_date strings for a single member."""
        resp = self.supabase.table('member_daily_stats') \
            .select('snapshot_date') \
            .eq('member_id', member_id) \
            .execute()
        return {row['snapshot_date'] for row in (resp.data or [])}

    def build_record(self, member_id: str, snapshot_date: str, personalstats: dict,
                     profile: dict = None, gym: dict = None) -> dict:
        """
        Assemble a member_daily_stats row. `profile` is only included for the
        today snapshot (we don't have historical profiles). Denormalises the
        compliance fields into explicit columns so the Member Overview can
        filter without jsonb-path lookups.
        """
        record: Dict = {
            'member_id':     member_id,
            'snapshot_date': snapshot_date,
            'personalstats': personalstats,
            'api_version':   'v2-all',
        }
        if profile:
            record['profile'] = profile
            # Compliance denormalisations
            record['is_donator']     = profile.get('donator_status') is not None
            prop = profile.get('property') or {}
            record['property_name']  = prop.get('name')
            la = profile.get('last_action') or {}
            record['last_action_timestamp'] = la.get('timestamp')
        if gym:
            record.update(gym)
        return record

    def run(self):
        today = date.today()
        today_str = today.isoformat()

        logger.info("=" * 60)
        logger.info("Member Daily Stats Scraper (cat=all + profile)")
        logger.info(f"Today: {today_str}")
        logger.info("=" * 60)

        # 1. Current members
        members = self.get_current_members()
        logger.info(f"Found {len(members)} current faction members")
        if not members:
            logger.warning("No current members found — exiting")
            return

        # 2. Target dates for backfill (last 30 days, excluding today)
        target_dates = set()
        for i in range(1, BACKFILL_DAYS + 1):
            target_dates.add((today - timedelta(days=i)).isoformat())

        records_to_upsert: List[dict] = []
        total_backfill_calls = 0

        # 3. Backfill missing days (personalstats only — no historical profile)
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
                stats = self.fetch_personalstats_all(mid, timestamp=ts)
                total_backfill_calls += 1

                if stats:
                    records_to_upsert.append(self.build_record(mid, d_str, stats))
                else:
                    logger.warning(f"    No personalstats for {name} on {d_str}")

        logger.info(f"Backfill complete: {total_backfill_calls} member-days, "
                    f"{len(records_to_upsert)} records so far")

        # 4. Today: personalstats + profile per member
        logger.info(f"\n--- Today: personalstats + profile for {len(members)} members ---")
        for i, m in enumerate(members, 1):
            mid = str(m['member_id'])
            name = m.get('member_name', mid)
            logger.info(f"  Today {i}/{len(members)}: {name} ({mid})")

            stats = self.fetch_personalstats_all(mid)
            profile = self.fetch_profile(mid)
            if stats:
                records_to_upsert.append(self.build_record(mid, today_str, stats, profile=profile))
            else:
                logger.warning(f"  No personalstats for {name} ({mid})")

        # 5. Gym contributions (5 faction calls)
        logger.info(f"\n--- Gym contributions: {len(GYM_STATS)} faction calls ---")
        gym_data: Dict[str, Dict[str, int]] = {}
        for stat in GYM_STATS:
            col = GYM_COLUMN_MAP[stat]
            logger.info(f"  Fetching {stat}...")
            contributors = self.fetch_gym_contributors(stat)
            if not contributors:
                logger.warning(f"  Failed to fetch {stat}")
                continue
            for entry in contributors:
                mid = str(entry['id'])
                gym_data.setdefault(mid, {})[col] = entry.get('value', 0)
            logger.info(f"  {stat}: {len(contributors)} members")

        # Merge today's gym data into today's records
        today_member_ids = {r['member_id'] for r in records_to_upsert if r['snapshot_date'] == today_str}
        for record in records_to_upsert:
            if record['snapshot_date'] == today_str and record['member_id'] in gym_data:
                record.update(gym_data[record['member_id']])

        # Add gym-only rows for members who somehow lack personalstats today
        for mid, gym_values in gym_data.items():
            if mid not in today_member_ids:
                records_to_upsert.append({
                    'member_id':     mid,
                    'snapshot_date': today_str,
                    **gym_values,
                })

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
        backfill_count = sum(1 for r in records_to_upsert if r['snapshot_date'] != today_str)
        today_count = sum(1 for r in records_to_upsert if r['snapshot_date'] == today_str)
        total_calls = total_backfill_calls + 2 * len(members) + len(GYM_STATS)

        logger.info("\n" + "=" * 60)
        logger.info("SUMMARY")
        logger.info("=" * 60)
        logger.info(f"Members processed:   {len(members)}")
        logger.info(f"Backfill rows:       {backfill_count} ({total_backfill_calls} personalstats calls)")
        logger.info(f"Today rows:          {today_count}")
        logger.info(f"Gym data for:        {len(gym_data)} members")
        logger.info(f"Total API calls:     {total_calls}  "
                    f"(was ~3 × N + backfill × 3 + 5 in old version)")
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

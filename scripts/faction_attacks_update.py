"""
Faction Attacks Update Script
Fetches ALL faction attacks daily (both outgoing and incoming) using an
incremental cursor. Attacks are stored without a war_id — war windows are
applied dynamically at query time using ranked_wars.start_at / end_at.

Data flow:
  Torn API → data/faction_attacks_database.json
           → sync_to_supabase.py attacks → Supabase faction_attacks table

Pagination:
  GET /v2/faction/attacks?limit=100&sort=DESC&to={cursor}
  Cursor starts at last stored attack's `started` timestamp.
  Each page moves the cursor backward: cursor = min(started) - 1
  Stop when < 100 results returned (end of history for that window).
"""

import os
import sys
import logging
from typing import Dict, List, Optional
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.utils.json_storage import JSONStorageManager
from scripts.utils.torn_api import TornAPI, TornAPIError

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

FACTION_ID = int(os.environ.get('VITE_FACTION_ID', '10739'))

# How far back to go on the very first run (90 days)
INITIAL_LOOKBACK_DAYS = 90


class FactionAttacksUpdater:
    """Daily incremental scraper for all faction attacks."""

    def __init__(self):
        testing_mode = os.environ.get('TESTING_MODE') == 'true'
        self.storage = JSONStorageManager(data_dir='data', auto_commit=not testing_mode)

        self.api_key = os.environ.get('TORN_API_KEY')
        if not self.api_key:
            raise ValueError("TORN_API_KEY environment variable not set")

        self.api = TornAPI(self.api_key)
        logger.info("Faction Attacks Updater initialized")

    # ------------------------------------------------------------------
    # Storage
    # ------------------------------------------------------------------

    def _load_database(self) -> Dict:
        db = self.storage.read_json('faction_attacks_database.json')
        if not db:
            db = {
                'attacks': {},          # keyed by str(attack_id)
                'metadata': {
                    'last_updated': None,
                    'newest_started': None,  # highest started timestamp stored
                    'oldest_started': None,  # lowest started timestamp stored
                    'total_attacks': 0,
                }
            }
        return db

    def _save_database(self, db: Dict):
        attacks = db['attacks']
        if attacks:
            started_values = [a['started'] for a in attacks.values() if a.get('started')]
            db['metadata']['newest_started'] = max(started_values) if started_values else None
            db['metadata']['oldest_started'] = min(started_values) if started_values else None
            db['metadata']['total_attacks'] = len(attacks)
        db['metadata']['last_updated'] = datetime.utcnow().isoformat()
        self.storage.write_json(
            'faction_attacks_database.json', db,
            create_backup=False,
            commit_message="Update faction attacks data"
        )

    # ------------------------------------------------------------------
    # API fetcher
    # ------------------------------------------------------------------

    def _fetch_attacks_page(self, to_timestamp: int) -> List[Dict]:
        """Fetch one page of faction attacks ending at `to_timestamp` (DESC sort)."""
        try:
            response = self.api.get_faction_attacks(
                from_timestamp=None,
                to_timestamp=to_timestamp,
                limit=100,
                sort='DESC'
            )
            return response.get('attacks', [])
        except TornAPIError as e:
            logger.error(f"API error fetching attacks (to={to_timestamp}): {e}")
            return []

    def _normalize_attack(self, raw: Dict) -> Dict:
        """Map raw attack API dict → storage schema."""
        attacker = raw.get('attacker') or {}
        defender = raw.get('defender') or {}
        mods = raw.get('modifiers', {})

        attacker_faction = attacker.get('faction') or {}
        defender_faction = defender.get('faction') or {}

        attacker_faction_id = attacker_faction.get('id')
        defender_faction_id = defender_faction.get('id')

        return {
            'attack_id': raw['id'],
            'started': raw.get('started'),
            'ended': raw.get('ended'),
            'attacker_id': attacker.get('id'),
            'attacker_name': attacker.get('name'),
            'attacker_faction_id': attacker_faction_id,
            'defender_id': defender.get('id'),
            'defender_name': defender.get('name'),
            'defender_faction_id': defender_faction_id,
            'result': raw.get('result'),
            'respect_gain': raw.get('respect_gain', 0),
            'chain': raw.get('chain', 0),
            'is_ranked_war': raw.get('is_ranked_war', False),
            'fair_fight': mods.get('fair_fight', 1),
            'war_modifier': mods.get('war', 1),
            'chain_modifier': mods.get('chain', 1),
            'warlord_modifier': mods.get('warlord', 1),
            # True when our faction was the defender (incoming attack)
            'is_incoming': defender_faction_id == FACTION_ID,
        }

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    def update_attacks(self) -> Dict:
        """
        Incremental update:
        - Start cursor at newest_started timestamp (or INITIAL_LOOKBACK_DAYS ago)
        - Page backward (DESC) until we hit an attack we already have
        - Merge new attacks into the database

        Returns summary stats.
        """
        db = self._load_database()
        existing = db['attacks']

        stats = {
            'new_attacks': 0,
            'pages_fetched': 0,
            'errors': 0,
        }

        # Determine starting cursor
        newest_stored = db['metadata'].get('newest_started')
        if newest_stored:
            # Start just ahead of our newest stored attack so we capture anything newer
            start_cursor = int(newest_stored) + 1
            # We want attacks from start_cursor onward, but the API uses `to` for DESC.
            # Fetch from "now" downward and stop when we reach attacks we already have.
            import time as _time
            current_to = int(_time.time())
        else:
            # First run: go back INITIAL_LOOKBACK_DAYS
            import time as _time
            lookback = INITIAL_LOOKBACK_DAYS * 24 * 3600
            start_cursor = int(_time.time()) - lookback
            current_to = int(_time.time())

        logger.info(f"Fetching attacks from {start_cursor} to {current_to} (newest stored: {newest_stored})")

        page = 1
        stop_early = False

        while not stop_early:
            raw_attacks = self._fetch_attacks_page(current_to)
            stats['pages_fetched'] += 1

            if not raw_attacks:
                logger.info(f"  Page {page}: empty response, stopping")
                break

            new_this_page = 0
            oldest_on_page = current_to

            for raw in raw_attacks:
                aid = str(raw.get('id'))
                started = raw.get('started', 0)

                if started < oldest_on_page:
                    oldest_on_page = started

                # Once we pass the cursor boundary, stop pagination after this page
                if started < start_cursor:
                    stop_early = True
                    # Don't break — finish processing this page so we don't miss
                    # attacks on the same page that are newer than start_cursor
                    continue

                # Skip already-stored attacks (overlap at page boundaries)
                if aid in existing:
                    continue

                existing[aid] = self._normalize_attack(raw)
                new_this_page += 1

            stats['new_attacks'] += new_this_page
            logger.info(f"  Page {page}: {len(raw_attacks)} raw, {new_this_page} new "
                        f"(oldest started={oldest_on_page})")

            if len(raw_attacks) < 100:
                break  # Last page

            # Advance cursor backward
            current_to = oldest_on_page - 1
            page += 1

            # Safety limit
            if page > 200:
                logger.warning("Hit 200-page safety limit, stopping")
                break

        db['attacks'] = existing
        self._save_database(db)

        logger.info(
            f"Attacks update complete: {stats['new_attacks']} new attacks "
            f"({stats['pages_fetched']} pages fetched)"
        )
        return stats


def main():
    try:
        updater = FactionAttacksUpdater()
        stats = updater.update_attacks()
        logger.info(f"Final stats: {stats}")
    except Exception as e:
        logger.error(f"Faction attacks update failed: {e}", exc_info=True)
        sys.exit(1)


if __name__ == '__main__':
    main()

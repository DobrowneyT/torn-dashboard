"""
War Data Update Script
Fetches ranked war list and war reports (member contributions + rewards).
Attack data is now scraped separately by faction_attacks_update.py and
linked to wars at query time via timestamp window.

Data flow:
  Torn API → data/war_database.json (wars + contributions)
           → sync_to_supabase.py wars → Supabase tables
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

FACTION_ID = os.environ.get('VITE_FACTION_ID', '10739')


class WarDataUpdater:
    """Fetch and update ranked war list + war reports from Torn API."""

    def __init__(self):
        testing_mode = os.environ.get('TESTING_MODE') == 'true'
        self.storage = JSONStorageManager(data_dir='data', auto_commit=not testing_mode)

        self.api_key = os.environ.get('TORN_API_KEY')
        if not self.api_key:
            raise ValueError("TORN_API_KEY environment variable not set")

        self.api = TornAPI(self.api_key)
        logger.info("War Data Updater initialized")

    # ------------------------------------------------------------------
    # Storage helpers
    # ------------------------------------------------------------------

    def _load_war_database(self) -> Dict:
        db = self.storage.read_json('war_database.json')
        if not db:
            db = {
                'wars': {},          # keyed by str(war_id)
                'contributions': {}, # keyed by str(war_id), value = list of member dicts
                'metadata': {'last_updated': None}
            }
        return db

    def _save_war_database(self, db: Dict):
        db['metadata']['last_updated'] = datetime.utcnow().isoformat()
        self.storage.write_json('war_database.json', db,
                                create_backup=True,
                                commit_message="Update war data")

    # ------------------------------------------------------------------
    # API fetchers
    # ------------------------------------------------------------------

    def _fetch_all_ranked_wars(self) -> List[Dict]:
        """Paginate through /v2/faction/{id}/rankedwars until exhausted."""
        all_wars = []
        offset = 0

        logger.info("Fetching ranked wars list (paginated)...")
        while True:
            response = self.api.get_ranked_wars(faction_id=FACTION_ID, offset=offset, limit=100)
            wars = response.get('rankedwars', [])
            if not wars:
                break

            all_wars.extend(wars)
            logger.info(f"  Fetched {len(wars)} wars (offset={offset}, total={len(all_wars)})")

            next_link = response.get('_metadata', {}).get('links', {}).get('next')
            if not next_link or len(wars) < 100:
                break
            offset += 100

        logger.info(f"Total ranked wars found: {len(all_wars)}")
        return all_wars

    # Torn API error codes that mean the report will never be accessible.
    # Transient codes (5=too many requests, 16=maintenance, 17=simultaneous) are NOT listed
    # here — the API wrapper retries error 5 automatically; others retry on the next run.
    PERMANENT_API_ERROR_CODES = {'2', '7', '13', '14'}

    def _fetch_war_report(self, war_id: int) -> tuple:
        """
        Fetch the war report for a specific war ID.

        Returns:
            (report_dict, is_permanent_failure)
            report_dict is None on any failure.
            is_permanent_failure is True when the API error is non-retryable
            (e.g. war too old, wrong ID) — the caller should mark the war
            report_unavailable so future runs skip it.
        """
        try:
            response = self.api.get_ranked_war_report(war_id)
            return response.get('rankedwarreport'), False
        except TornAPIError as e:
            error_str = str(e)
            is_permanent = any(
                f"API Error {code}:" in error_str
                for code in self.PERMANENT_API_ERROR_CODES
            )
            if is_permanent:
                logger.warning(f"War {war_id} report permanently unavailable: {e}")
            else:
                logger.error(f"Failed to fetch war report for war {war_id}: {e}")
            return None, is_permanent

    # ------------------------------------------------------------------
    # Data normalizers
    # ------------------------------------------------------------------

    def _normalize_war(self, raw: Dict, faction_id: str) -> Dict:
        """Map raw API war dict → storage schema."""
        factions = raw.get('factions', [])
        our = next((f for f in factions if str(f['id']) == faction_id), None)
        opponent = next((f for f in factions if str(f['id']) != faction_id), None)

        return {
            'id': raw['id'],
            'start_at': raw.get('start', 0),
            'end_at': raw.get('end', 0) or None,
            'opponent_id': opponent['id'] if opponent else None,
            'opponent_name': opponent['name'] if opponent else None,
            'our_score': our['score'] if our else 0,
            'opponent_score': opponent['score'] if opponent else 0,
            'target': raw.get('target'),
            'winner_faction_id': raw.get('winner'),
            'forfeit': False,
            'is_termed': False,   # manual flag, never overwritten by scraper
            'rewards_items': None,  # filled from war report
            'rank_before': None,
            'rank_after': None,
            # Scraper progress flag (not synced to Supabase)
            'report_fetched': False,
        }

    def _apply_war_report(self, war_entry: Dict, report: Dict, faction_id: str):
        """Merge war report data into an existing war entry (in-place)."""
        factions = report.get('factions', [])
        our = next((f for f in factions if str(f['id']) == faction_id), None)

        if our:
            rewards = our.get('rewards', {})
            war_entry['rewards_items'] = rewards.get('items', [])
            rank = our.get('rank', {})
            war_entry['rank_before'] = rank.get('before')
            war_entry['rank_after'] = rank.get('after')
            war_entry['forfeit'] = report.get('forfeit', False)
            war_entry['our_score'] = our.get('score', war_entry['our_score'])

        war_entry['report_fetched'] = True

    def _extract_contributions(self, report: Dict) -> List[Dict]:
        """Extract per-member contribution records from war report."""
        contributions = []
        war_id = report.get('id')
        for faction in report.get('factions', []):
            faction_id = faction.get('id')
            for member in faction.get('members', []):
                contributions.append({
                    'war_id': war_id,
                    'member_id': member['id'],
                    'member_name': member.get('name'),
                    'level': member.get('level'),
                    'attacks': member.get('attacks', 0),
                    'score': member.get('score', 0),
                    'faction_id': faction_id,
                })
        return contributions

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    def update_all_wars(self) -> Dict:
        """
        Full update cycle:
        1. Fetch all ranked wars (paginated)
        2. For completed wars without a report: fetch war report + contributions
        3. Save war_database.json
        Returns summary stats.
        """
        war_db = self._load_war_database()

        stats = {
            'wars_seen': 0,
            'wars_new': 0,
            'reports_fetched': 0,
            'errors': 0,
        }

        # Step 1: Fetch all ranked wars
        raw_wars = self._fetch_all_ranked_wars()
        stats['wars_seen'] = len(raw_wars)

        for raw in raw_wars:
            war_id = str(raw['id'])
            existing = war_db['wars'].get(war_id)

            if not existing:
                war_db['wars'][war_id] = self._normalize_war(raw, FACTION_ID)
                stats['wars_new'] += 1
            else:
                # Update live scores and end timestamp (may change for ongoing wars)
                factions = raw.get('factions', [])
                our = next((f for f in factions if str(f['id']) == FACTION_ID), None)
                opp = next((f for f in factions if str(f['id']) != FACTION_ID), None)
                if our:
                    existing['our_score'] = our.get('score', existing['our_score'])
                if opp:
                    existing['opponent_score'] = opp.get('score', existing['opponent_score'])
                existing['end_at'] = raw.get('end') or None
                existing['winner_faction_id'] = raw.get('winner')

        # Step 2: Fetch war reports for completed wars that don't have one yet
        for war_id, war_entry in war_db['wars'].items():
            end_at = war_entry.get('end_at')
            if not end_at or end_at == 0:
                continue  # War still ongoing
            if war_entry.get('report_fetched'):
                continue  # Already have it
            if war_entry.get('report_unavailable'):
                continue  # Permanently failed — skip forever

            logger.info(f"Fetching war report for war {war_id}...")
            report, is_permanent = self._fetch_war_report(int(war_id))
            if report:
                self._apply_war_report(war_entry, report, FACTION_ID)
                contributions = self._extract_contributions(report)
                war_db['contributions'][war_id] = contributions
                stats['reports_fetched'] += 1
                logger.info(f"  → {len(contributions)} member contributions stored")
            else:
                if is_permanent:
                    war_entry['report_unavailable'] = True
                    stats['reports_unavailable'] = stats.get('reports_unavailable', 0) + 1
                else:
                    stats['errors'] += 1

        self._save_war_database(war_db)

        logger.info(
            f"Update complete: {stats['wars_seen']} wars seen, "
            f"{stats['wars_new']} new, "
            f"{stats['reports_fetched']} reports fetched, "
            f"{stats.get('reports_unavailable', 0)} permanently unavailable, "
            f"{stats['errors']} transient errors"
        )
        return stats


def main():
    try:
        updater = WarDataUpdater()
        stats = updater.update_all_wars()
        logger.info(f"Final stats: {stats}")
    except Exception as e:
        logger.error(f"War data update failed: {e}", exc_info=True)
        sys.exit(1)


if __name__ == '__main__':
    main()

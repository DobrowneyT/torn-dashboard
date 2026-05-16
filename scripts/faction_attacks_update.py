"""
Faction Attacks Update Script
Fetches ALL faction attacks using incremental ASC forward pagination,
mirroring the same pattern as daily_crime_update.py.

Pagination:
  GET /v2/faction/attacks?limit=100&sort=ASC&from={cursor}
  Cursor starts at newest stored attack's `started` timestamp (or 0 on first run).
  Each full page advances the cursor: cursor = last_attack_on_page.started
  Stop when < 100 results are returned.

Data flow:
  Torn API → data/faction_attacks_database.json
           → sync_to_supabase.py attacks → Supabase faction_attacks table
"""

import os
import re
import sys
import logging
from typing import Dict, List, Optional, Tuple
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

# Chunk settings — once a file reaches this size a new numbered file is started.
DB_BASE_NAME = 'faction_attacks_database'
CHUNK_LIMIT_MB = 25



class FactionAttacksUpdater:
    """Daily incremental scraper for all faction attacks."""

    def __init__(self):
        testing_mode = os.environ.get('TESTING_MODE') == 'true'
        self.storage = JSONStorageManager(data_dir='data', auto_commit=not testing_mode)

        self.api_key = os.environ.get('TORN_API_KEY')
        if not self.api_key:
            raise ValueError("TORN_API_KEY environment variable not set")

        self.api = TornAPI(self.api_key)
        self._current_chunk_file: Optional[str] = None
        logger.info("Faction Attacks Updater initialized")

    # ------------------------------------------------------------------
    # Storage / chunking
    # ------------------------------------------------------------------

    def _find_latest_chunk(self) -> Tuple[Path, int]:
        """
        Scan data/ for faction_attacks_database_N.json files and return the
        path and chunk number of the highest-numbered one.

        If only the legacy un-numbered file exists it is renamed to _1 first.
        If no files exist at all, returns the path for chunk 1 (not yet created).
        """
        data_dir = Path('data')
        chunks: Dict[int, Path] = {}

        for f in data_dir.glob(f'{DB_BASE_NAME}_*.json'):
            m = re.search(r'_(\d+)\.json$', f.name)
            if m:
                chunks[int(m.group(1))] = f

        if not chunks:
            legacy = data_dir / f'{DB_BASE_NAME}.json'
            if legacy.exists():
                new_path = data_dir / f'{DB_BASE_NAME}_1.json'
                legacy.rename(new_path)
                logger.info(f"Renamed legacy {legacy.name} → {new_path.name}")
                chunks[1] = new_path

        if not chunks:
            # First-ever run
            return data_dir / f'{DB_BASE_NAME}_1.json', 1

        latest_num = max(chunks)
        return chunks[latest_num], latest_num

    def _load_database(self) -> Dict:
        latest_path, chunk_num = self._find_latest_chunk()

        # If the latest chunk already exceeds the size limit, start a new one.
        # Copy the newest_started cursor so the API fetch resumes correctly.
        if latest_path.exists():
            size_mb = latest_path.stat().st_size / (1024 * 1024)
            if size_mb >= CHUNK_LIMIT_MB:
                prev_db = self.storage.read_json(latest_path.name) or {}
                newest_started = prev_db.get('metadata', {}).get('newest_started')
                chunk_num += 1
                latest_path = Path('data') / f'{DB_BASE_NAME}_{chunk_num}.json'
                logger.info(
                    f"Previous chunk was {size_mb:.1f} MB (≥ {CHUNK_LIMIT_MB} MB) "
                    f"— starting {latest_path.name}"
                )
                self._current_chunk_file = latest_path.name
                return {
                    'attacks': {},
                    'metadata': {
                        'last_updated': None,
                        'newest_started': newest_started,
                        'total_attacks': 0,
                        'chunk': chunk_num,
                    }
                }

        self._current_chunk_file = latest_path.name
        db = self.storage.read_json(latest_path.name)
        if not db:
            db = {
                'attacks': {},
                'metadata': {
                    'last_updated': None,
                    'newest_started': None,
                    'total_attacks': 0,
                    'chunk': chunk_num,
                }
            }
        return db

    def _save_database(self, db: Dict):
        attacks = db['attacks']
        if attacks:
            started_values = [a['started'] for a in attacks.values() if a.get('started')]
            db['metadata']['newest_started'] = max(started_values) if started_values else None
            db['metadata']['total_attacks'] = len(attacks)
        db['metadata']['last_updated'] = datetime.utcnow().isoformat()
        self.storage.write_json(
            self._current_chunk_file, db,
            create_backup=False,
            commit_message="Update faction attacks data"
        )

    # ------------------------------------------------------------------
    # API fetcher
    # ------------------------------------------------------------------

    def _fetch_attacks_page(self, from_timestamp: int) -> List[Dict]:
        """Fetch one page of faction attacks starting at from_timestamp (ASC sort).
        Raises TornAPIError on failure so the caller can retry."""
        response = self.api.get_faction_attacks(
            from_timestamp=from_timestamp,
            limit=100,
            sort='ASC'
        )
        return response.get('attacks', [])

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
        Incremental forward update (ASC):
        - Start cursor at newest_started timestamp (or 0 on first run)
        - Page forward until < 100 results are returned
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

        # Start from the newest stored attack's timestamp (inclusive overlap is
        # handled by the existing-ID check below). On first run use 0.
        newest_stored = db['metadata'].get('newest_started')
        current_from = int(newest_stored) if newest_stored else 0

        logger.info(f"Fetching attacks from {current_from} (newest stored: {newest_stored})")

        page = 1

        while True:
            try:
                raw_attacks = self._fetch_attacks_page(current_from)
            except TornAPIError as e:
                logger.error(f"  Page {page}: fetch failed after retries: {e} — saving progress and aborting")
                stats['errors'] += 1
                db['attacks'] = existing
                self._save_database(db)
                logger.info(f"Final stats: {stats}")
                sys.exit(1)

            stats['pages_fetched'] += 1

            if not raw_attacks:
                logger.info(f"  Page {page}: no attacks returned, stopping")
                break

            new_this_page = 0
            for raw in raw_attacks:
                aid = str(raw.get('id'))
                if aid in existing:
                    continue  # already stored (overlap at page boundary)
                existing[aid] = self._normalize_attack(raw)
                new_this_page += 1

            last_started = raw_attacks[-1].get('started', current_from)
            stats['new_attacks'] += new_this_page
            logger.info(f"  Page {page}: {len(raw_attacks)} raw, {new_this_page} new "
                        f"(last started={last_started})")

            if len(raw_attacks) < 100:
                break  # reached the end

            # Advance cursor to last attack's started timestamp
            current_from = last_started
            page += 1

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

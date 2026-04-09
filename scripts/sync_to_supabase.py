#!/usr/bin/env python3
"""
Sync JSON data files to Supabase database
Handles both CPR data and Crimes data

Uses bulk batch upserts for performance:
- Collects all records into arrays first
- Upserts in configurable chunk sizes (default 500)
- Reduces HTTP requests from hundreds to a handful
"""

import os
import re
import sys
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional
from supabase import create_client, Client

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Max records per upsert call to stay within payload limits
CHUNK_SIZE = 500


def chunked(lst, size):
    """Yield successive chunks from a list."""
    for i in range(0, len(lst), size):
        yield lst[i:i + size]


class SupabaseSync:
    """Sync JSON data to Supabase database"""

    def __init__(self):
        self.supabase_url = os.environ.get('VITE_SUPABASE_URL')
        self.supabase_key = os.environ.get('VITE_SUPABASE_SERVICE_ROLE_KEY')

        if not self.supabase_url or not self.supabase_key:
            raise ValueError("Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_ROLE_KEY environment variables")

        self.client: Client = create_client(self.supabase_url, self.supabase_key)
        logger.info("Supabase client initialized")

    def _bulk_upsert(self, table: str, records: list, on_conflict: str) -> int:
        """
        Bulk upsert records in chunks.

        Args:
            table: Table name
            records: List of record dicts
            on_conflict: Conflict column(s) for upsert

        Returns:
            Number of records successfully upserted
        """
        if not records:
            return 0

        total = 0
        chunks = list(chunked(records, CHUNK_SIZE))

        for i, chunk in enumerate(chunks):
            try:
                self.client.table(table).upsert(
                    chunk,
                    on_conflict=on_conflict
                ).execute()
                total += len(chunk)
                if len(chunks) > 1:
                    logger.info(f"  {table}: chunk {i+1}/{len(chunks)} ({len(chunk)} records)")
            except Exception as e:
                logger.error(f"  {table}: chunk {i+1} failed: {e}")

        return total

    def sync_cpr_data(self, json_path: str) -> dict:
        """
        Sync CPR data from JSON to Supabase using bulk upserts.

        Collects all member records and CPR records into arrays,
        then upserts each in bulk (2 HTTP requests instead of hundreds).
        """
        logger.info(f"Reading CPR data from {json_path}")

        with open(json_path, 'r') as f:
            data = json.load(f)

        if 'members' not in data:
            raise ValueError("Invalid CPR data format - missing 'members' object")

        now = datetime.now().isoformat()
        all_members = []
        all_cpr_records = []
        errors = []

        # Phase 1: Collect all records into arrays
        for member_id, member_data in data['members'].items():
            try:
                last_scraped = member_data.get('last_scraped', '')
                last_scraped_value = last_scraped if last_scraped and last_scraped.strip() else None

                all_members.append({
                    'member_id': member_id,
                    'member_name': member_data.get('name', f'Member {member_id}'),
                    'tier': member_data.get('tier', -1),
                    'last_scraped': last_scraped_value,
                    'updated_at': now
                })

                cpr_by_role = member_data.get('cpr_by_role', {})
                for level, roles in cpr_by_role.items():
                    for role, cpr in roles.items():
                        if isinstance(cpr, (int, float)):
                            all_cpr_records.append({
                                'member_id': member_id,
                                'difficulty_level': int(level),
                                'role_name': role,
                                'cpr_value': float(cpr),
                                'updated_at': now
                            })

            except Exception as e:
                error_msg = f"Error processing member {member_id}: {str(e)}"
                logger.error(error_msg)
                errors.append(error_msg)

        logger.info(f"Collected {len(all_members)} members, {len(all_cpr_records)} CPR records")

        # Phase 2: Bulk upsert
        members_count = self._bulk_upsert('members', all_members, 'member_id')
        cpr_count = self._bulk_upsert('member_cpr', all_cpr_records, 'member_id,difficulty_level,role_name')

        result = {
            'type': 'CPR',
            'members_synced': members_count,
            'cpr_records_synced': cpr_count,
            'errors': errors
        }

        logger.info(f"CPR sync complete: {members_count} members, {cpr_count} CPR records")
        if errors:
            logger.warning(f"{len(errors)} errors occurred")

        return result

    def sync_crimes_data(self, json_path: str) -> dict:
        """
        Sync Crimes data from JSON to Supabase using bulk upserts.

        Collects all crime, slot, reward item, and required item records
        into arrays, then upserts each table in bulk.
        Previous: ~1,586 HTTP requests (793 crimes + 793 slot batches)
        Now: ~8 HTTP requests (4 tables x ~2 chunks each)
        """
        logger.info(f"Reading crimes data from {json_path}")

        with open(json_path, 'r') as f:
            data = json.load(f)

        if 'crimes' not in data:
            raise ValueError("Invalid crimes data format - missing 'crimes' object")

        now = datetime.now().isoformat()
        all_crimes = []
        all_slots = []
        all_reward_items = []
        all_required_items = []
        errors = []

        # Phase 1: Collect all records into arrays
        for crime_id, crime_data in data['crimes'].items():
            try:
                # Safely extract rewards
                rewards = crime_data.get('rewards') or {}

                all_crimes.append({
                    'crime_id': crime_id,
                    'name': crime_data.get('name', 'Unknown'),
                    'difficulty': crime_data.get('difficulty', 1),
                    'status': crime_data.get('status', 'Unknown'),
                    'previous_crime_id': str(crime_data.get('previous_crime_id')) if crime_data.get('previous_crime_id') else None,
                    'created_at': crime_data.get('created_at'),
                    'planning_at': crime_data.get('planning_at'),
                    'executed_at': crime_data.get('executed_at'),
                    'ready_at': crime_data.get('ready_at'),
                    'expired_at': crime_data.get('expired_at'),
                    'total_slots': crime_data.get('total_slots', 0),
                    'filled_slots': crime_data.get('filled_slots', 0),
                    'rewards_money': rewards.get('money', 0),
                    'rewards_respect': rewards.get('respect', 0),
                    'rewards_items': json.dumps(rewards.get('items', [])) if rewards.get('items') else None,
                    'last_updated': crime_data.get('last_updated'),
                    'first_seen': crime_data.get('first_seen'),
                    'updated_at': now
                })

                # Collect slots
                slots = crime_data.get('slots', [])
                for slot in slots:
                    user = slot.get('user') or {}
                    item_req = slot.get('item_requirement') or {}
                    _pi = slot.get('position_info') or {}
                    item_outcome = user.get('item_outcome') or {}

                    all_slots.append({
                        'crime_id': crime_id,
                        'position': slot.get('position'),
                        'position_id': _pi.get('id') or slot.get('position_id'),
                        'position_number': _pi.get('number') or slot.get('position_number'),
                        'checkpoint_pass_rate': slot.get('checkpoint_pass_rate'),
                        'user_id': str(user.get('id')) if user.get('id') else None,
                        'user_name': user.get('name'),
                        'joined_at': user.get('joined_at'),
                        'user_outcome': user.get('outcome'),
                        'user_progress': user.get('progress'),
                        'item_requirement_id': str(item_req.get('id')) if item_req.get('id') else None,
                        'item_requirement_name': item_req.get('name'),
                        'item_requirement_is_reusable': item_req.get('is_reusable', False) if item_req else False,
                        'item_requirement_is_available': item_req.get('is_available', False) if item_req else False,
                        'item_outcome_id': str(item_outcome.get('item_id')) if item_outcome.get('item_id') else None,
                        'item_outcome_outcome': item_outcome.get('outcome'),
                        'updated_at': now
                    })

                    # Collect required items (items needed for crime slots)
                    if item_req.get('id'):
                        was_consumed = item_outcome.get('outcome') in ('used', 'lost') if item_outcome.get('outcome') else False
                        all_required_items.append({
                            'crime_id': crime_id,
                            'position': slot.get('position'),
                            'position_id': _pi.get('id') or slot.get('position_id'),
                            'position_number': _pi.get('number') or slot.get('position_number'),
                            'item_id': str(item_req['id']),
                            'item_name': item_req.get('name'),
                            'is_reusable': item_req.get('is_reusable', False),
                            'is_available': item_req.get('is_available', False),
                            'user_id': str(user.get('id')) if user.get('id') else None,
                            'outcome_owned_by': item_outcome.get('owned_by'),
                            'outcome_item_id': str(item_outcome.get('item_id')) if item_outcome.get('item_id') else None,
                            'outcome_item_uid': str(item_outcome.get('item_uid')) if item_outcome.get('item_uid') else None,
                            'outcome': item_outcome.get('outcome'),
                            'was_consumed': was_consumed,
                            'unit_value': 0,
                            'created_at': now,
                            'updated_at': now
                        })

                # Collect reward items
                reward_items = rewards.get('items', [])
                for reward_item in reward_items:
                    item_id = reward_item.get('id')
                    if not item_id:
                        continue
                    all_reward_items.append({
                        'crime_id': crime_id,
                        'item_id': str(item_id),
                        'item_name': reward_item.get('name'),
                        'quantity': reward_item.get('quantity', 1),
                        'unit_value': 0,
                        'total_value': 0,
                        'created_at': now,
                        'updated_at': now
                    })

            except Exception as e:
                error_msg = f"Error processing crime {crime_id}: {str(e)}"
                logger.error(error_msg)
                errors.append(error_msg)

        logger.info(f"Collected {len(all_crimes)} crimes, {len(all_slots)} slots, "
                     f"{len(all_reward_items)} reward items, {len(all_required_items)} required items")

        # Phase 2: Bulk upsert all tables
        crimes_count = self._bulk_upsert('crimes', all_crimes, 'crime_id')
        slots_count = self._bulk_upsert('crime_slots', all_slots, 'crime_id,position_id')
        reward_count = self._bulk_upsert('crime_reward_items', all_reward_items, 'crime_id,item_id')
        required_count = self._bulk_upsert('crime_required_items', all_required_items, 'crime_id,position_id')

        result = {
            'type': 'Crimes',
            'crimes_synced': crimes_count,
            'slots_synced': slots_count,
            'reward_items_synced': reward_count,
            'required_items_synced': required_count,
            'errors': errors
        }

        logger.info(f"Crimes sync complete: {crimes_count} crimes, {slots_count} slots, "
                     f"{reward_count} reward items, {required_count} required items")
        if errors:
            logger.warning(f"{len(errors)} errors occurred")

        return result


    def sync_war_data(self, json_path: str) -> dict:
        """
        Sync war list and member contributions from war_database.json to Supabase.

        - ranked_wars: one row per war (upsert on id)
        - war_member_contributions: one row per (war_id, member_id) pair (upsert on war_id,member_id)

        Scraper flags (report_fetched, attacks_fetched) are NOT synced to Supabase.
        """
        logger.info(f"Reading war data from {json_path}")

        with open(json_path, 'r') as f:
            data = json.load(f)

        wars = data.get('wars', {})
        contributions_by_war = data.get('contributions', {})

        all_wars = []
        all_contributions = []
        errors = []

        import json as json_lib  # for JSONB serialization

        for war_id, war in wars.items():
            try:
                rewards_items = war.get('rewards_items')
                all_wars.append({
                    'id': war['id'],
                    'start_at': war.get('start_at'),
                    'end_at': war.get('end_at'),
                    'opponent_id': war.get('opponent_id'),
                    'opponent_name': war.get('opponent_name'),
                    'our_score': war.get('our_score', 0),
                    'opponent_score': war.get('opponent_score', 0),
                    'target': war.get('target'),
                    'winner_faction_id': war.get('winner_faction_id'),
                    'forfeit': war.get('forfeit', False),
                    'is_termed': war.get('is_termed', False),
                    'rewards_items': json_lib.dumps(rewards_items) if rewards_items else None,
                    'rank_before': war.get('rank_before'),
                    'rank_after': war.get('rank_after'),
                })
            except Exception as e:
                errors.append(f"War {war_id}: {e}")
                logger.error(f"Error processing war {war_id}: {e}")

        for war_id, members in contributions_by_war.items():
            for member in members:
                try:
                    all_contributions.append({
                        'war_id': int(war_id),
                        'member_id': member['member_id'],
                        'member_name': member.get('member_name'),
                        'level': member.get('level'),
                        'attacks': member.get('attacks', 0),
                        'score': member.get('score', 0),
                        'faction_id': member.get('faction_id'),
                    })
                except Exception as e:
                    errors.append(f"Contribution war={war_id} member={member.get('member_id')}: {e}")
                    logger.error(f"Error processing contribution: {e}")

        logger.info(f"Collected {len(all_wars)} wars, {len(all_contributions)} contributions")

        wars_count = self._bulk_upsert('ranked_wars', all_wars, 'id')
        contributions_count = self._bulk_upsert('war_member_contributions', all_contributions, 'war_id,member_id')

        result = {
            'type': 'Wars',
            'wars_synced': wars_count,
            'contributions_synced': contributions_count,
            'errors': errors,
        }
        logger.info(f"War sync complete: {wars_count} wars, {contributions_count} contributions")
        return result

    def _find_latest_attacks_chunk(self, base_path: str) -> Optional[str]:
        """
        Given the legacy base path (e.g. 'data/faction_attacks_database.json'),
        find the latest numbered chunk file (faction_attacks_database_N.json).
        Falls back to base_path itself if no numbered chunks exist.
        Returns None when no file is found at all.
        """
        data_dir = Path(base_path).parent
        base_stem = Path(base_path).stem  # 'faction_attacks_database'

        chunks: Dict[int, Path] = {}
        for f in data_dir.glob(f'{base_stem}_*.json'):
            m = re.search(r'_(\d+)\.json$', f.name)
            if m:
                chunks[int(m.group(1))] = f

        if chunks:
            return str(chunks[max(chunks)])
        if os.path.exists(base_path):
            return base_path
        return None

    def sync_faction_attacks(self, json_path: str) -> dict:
        """
        Sync faction attacks from the latest chunk file to Supabase.

        Only the latest chunk is synced — older chunks are already in Supabase
        from previous runs (upsert is idempotent, but skipping them avoids
        re-reading and re-upserting hundreds of thousands of unchanged rows).

        Attacks have no war_id — war windows are applied dynamically at query time
        using ranked_wars.start_at / end_at.
        """
        resolved = self._find_latest_attacks_chunk(json_path)
        if not resolved:
            logger.warning(f"No faction attacks file found at {json_path}")
            return {'type': 'Faction Attacks', 'attacks_synced': 0, 'errors': []}

        logger.info(f"Reading faction attacks from {resolved}")

        with open(resolved, 'r') as f:
            data = json.load(f)

        attacks_dict = data.get('attacks', {})
        all_attacks = []
        errors = []

        for attack_id, attack in attacks_dict.items():
            try:
                all_attacks.append({
                    'attack_id': attack['attack_id'],
                    'started': attack.get('started'),
                    'ended': attack.get('ended'),
                    'attacker_id': attack.get('attacker_id'),
                    'attacker_name': attack.get('attacker_name'),
                    'attacker_faction_id': attack.get('attacker_faction_id'),
                    'defender_id': attack.get('defender_id'),
                    'defender_name': attack.get('defender_name'),
                    'defender_faction_id': attack.get('defender_faction_id'),
                    'result': attack.get('result'),
                    'respect_gain': attack.get('respect_gain', 0),
                    'chain': attack.get('chain', 0),
                    'is_ranked_war': attack.get('is_ranked_war', False),
                    'fair_fight': attack.get('fair_fight', 1),
                    'war_modifier': attack.get('war_modifier', 1),
                    'chain_modifier': attack.get('chain_modifier', 1),
                    'warlord_modifier': attack.get('warlord_modifier', 1),
                    'is_incoming': attack.get('is_incoming', False),
                })
            except Exception as e:
                errors.append(f"Attack {attack.get('attack_id')}: {e}")
                logger.error(f"Error processing attack: {e}")

        logger.info(f"Collected {len(all_attacks)} faction attacks")
        attacks_count = self._bulk_upsert('faction_attacks', all_attacks, 'attack_id')

        result = {
            'type': 'Faction Attacks',
            'attacks_synced': attacks_count,
            'errors': errors,
        }
        logger.info(f"Faction attacks sync complete: {attacks_count} attacks")
        return result


def main():
    """Main entry point"""
    if len(sys.argv) < 2:
        print("Usage: python sync_to_supabase.py [cpr|crimes|wars|attacks|all]")
        sys.exit(1)

    sync_type = sys.argv[1].lower()

    try:
        syncer = SupabaseSync()
        results = []

        if sync_type in ['cpr', 'all']:
            cpr_path = 'data/cpr_database.json'
            if os.path.exists(cpr_path):
                logger.info("=== Syncing CPR Data ===")
                result = syncer.sync_cpr_data(cpr_path)
                results.append(result)
            else:
                logger.warning(f"CPR data file not found: {cpr_path}")

        if sync_type in ['crimes', 'all']:
            crimes_path = 'data/crimes_database.json'
            if os.path.exists(crimes_path):
                logger.info("=== Syncing Crimes Data ===")
                result = syncer.sync_crimes_data(crimes_path)
                results.append(result)
            else:
                logger.warning(f"Crimes data file not found: {crimes_path}")

        if sync_type in ['wars', 'all']:
            war_path = 'data/war_database.json'
            if os.path.exists(war_path):
                logger.info("=== Syncing War Data ===")
                result = syncer.sync_war_data(war_path)
                results.append(result)
            else:
                logger.warning(f"War data file not found: {war_path}")

        if sync_type in ['attacks', 'all']:
            attacks_path = 'data/faction_attacks_database.json'
            resolved_attacks = syncer._find_latest_attacks_chunk(attacks_path)
            if resolved_attacks:
                logger.info("=== Syncing Faction Attacks ===")
                result = syncer.sync_faction_attacks(attacks_path)
                results.append(result)
            else:
                logger.warning(f"No faction attacks chunk files found in data/")

        # Print summary
        logger.info("\n=== Sync Summary ===")
        for result in results:
            logger.info(f"{result['type']}:")
            if result['type'] == 'CPR':
                logger.info(f"  Members synced: {result['members_synced']}")
                logger.info(f"  CPR records synced: {result['cpr_records_synced']}")
            elif result['type'] == 'Wars':
                logger.info(f"  Wars synced: {result['wars_synced']}")
                logger.info(f"  Contributions synced: {result['contributions_synced']}")
            elif result['type'] == 'Faction Attacks':
                logger.info(f"  Attacks synced: {result['attacks_synced']}")
            else:
                logger.info(f"  Crimes synced: {result['crimes_synced']}")
                logger.info(f"  Slots synced: {result['slots_synced']}")
                logger.info(f"  Reward items synced: {result.get('reward_items_synced', 0)}")
                logger.info(f"  Required items synced: {result.get('required_items_synced', 0)}")

            if result['errors']:
                logger.info(f"  Errors: {len(result['errors'])}")

        # Exit with error if there were any errors
        total_errors = sum(len(r['errors']) for r in results)
        if total_errors > 0:
            logger.error(f"Sync completed with {total_errors} errors")
            sys.exit(1)
        else:
            logger.info("All data synced successfully")
            sys.exit(0)

    except Exception as e:
        logger.error(f"Fatal error: {str(e)}", exc_info=True)
        sys.exit(1)


if __name__ == '__main__':
    main()
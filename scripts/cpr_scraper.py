"""
CPR Data Scraper for Torn City OC System
Scrapes CPR requirements from available crime slots for all members with API keys
Now includes integrated tier management with upgrade-only logic
"""

import os
import sys
import json
import logging
import time
from typing import Dict, List, Optional, Tuple
from datetime import datetime
from pathlib import Path

try:
    from supabase import create_client, Client as SupabaseClient
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.utils.json_storage import JSONStorageManager
from scripts.assign_tiers import TierAssignment

SKIP_GOOGLE_SHEETS = os.environ.get('SKIP_GOOGLE_SHEETS', '').lower() in ('true', '1', 'yes')
from scripts.utils.torn_api import TornAPI, TornAPIError

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class CPRScraper:
    """Scrape CPR requirements from Torn API for faction members"""
    
    def __init__(self):
        """Initialize the CPR scraper"""
        self.storage = JSONStorageManager(data_dir='data', auto_commit=True)
        self.sheets = None
        if not SKIP_GOOGLE_SHEETS:
            from scripts.utils.google_sheets import GoogleSheetsManager
            self.sheets = GoogleSheetsManager()
        else:
            logger.info("Google Sheets integration SKIPPED (SKIP_GOOGLE_SHEETS=true)")

        # Set up Supabase client for has_cpr_key updates and web-submitted keys
        self.supabase = None
        if SUPABASE_AVAILABLE:
            supabase_url = os.environ.get('VITE_SUPABASE_URL')
            supabase_key = os.environ.get('VITE_SUPABASE_SERVICE_ROLE_KEY')
            if supabase_url and supabase_key:
                self.supabase = create_client(supabase_url, supabase_key)
                logger.info("Supabase client initialized for CPR key sync")
            else:
                logger.warning("Supabase env vars missing — has_cpr_key will not be updated")
        else:
            logger.warning("supabase-py not installed — has_cpr_key will not be updated")

        self.member_api_keys = self._load_api_keys()

        logger.info("CPR Scraper initialized")
        logger.info(f"Found API keys for {len(self.member_api_keys)} members")
    
    def _load_api_keys(self) -> Dict[str, str]:
        """
        Load member API keys from:
          1. MEMBER_API_KEYS GitHub Secret (JSON dict of member_id -> api_key)
          2. Supabase member_secrets table (keys submitted via the website,
             stored encrypted; service-role-only access, decrypted via the
             get_member_cpr_key SECURITY DEFINER RPC)

        Both sources are merged; Supabase takes precedence for the same member_id.
        Keys are then validated against current faction membership.

        Returns:
            Dictionary mapping member IDs to API keys (only for current faction members)
        """
        # Source 1: GitHub Secret
        api_keys_json = os.environ.get('MEMBER_API_KEYS', '{}')
        try:
            all_api_keys = json.loads(api_keys_json)
            logger.info(f"Loaded {len(all_api_keys)} API keys from MEMBER_API_KEYS secret")
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse MEMBER_API_KEYS: {e}")
            all_api_keys = {}

        # Source 2: Supabase member_secrets table (web-submitted keys, stored encrypted)
        if self.supabase:
            cpr_secret = os.environ.get('CPR_KEY_SECRET')
            if not cpr_secret:
                logger.warning("CPR_KEY_SECRET not set — cannot decrypt Supabase cpr_api_keys")
            else:
                try:
                    # Fetch member IDs that have a CPR key in member_secrets.
                    # We probe the cached `has_cpr_key` boolean on members
                    # (kept in sync by a trigger on member_secrets) rather than
                    # reading the encrypted column directly, which now lives in
                    # the service-role-only member_secrets table.
                    resp = self.supabase.table('members').select('member_id').eq('has_cpr_key', True).execute()
                    member_ids_with_key = [str(row['member_id']) for row in (resp.data or [])]
                    logger.info(f"Found {len(member_ids_with_key)} members with a cpr_api_key in Supabase")

                    supabase_keys = {}
                    for mid in member_ids_with_key:
                        try:
                            dec = self.supabase.rpc('get_member_cpr_key', {
                                'p_member_id': mid,
                                'p_secret': cpr_secret,
                            }).execute()
                            if dec.data:
                                supabase_keys[mid] = dec.data
                        except Exception as e:
                            logger.warning(f"Could not decrypt key for member {mid}: {e}")

                    logger.info(f"Decrypted {len(supabase_keys)} API keys from Supabase")
                    # Supabase takes precedence over the legacy MEMBER_API_KEYS secret
                    all_api_keys.update(supabase_keys)
                except Exception as e:
                    logger.warning(f"Could not load Supabase cpr_api_keys: {e}")

        try:
            # Get current faction members to validate against
            torn_api_key = os.environ.get('TORN_API_KEY')
            if not torn_api_key:
                logger.error("TORN_API_KEY not found - cannot validate faction membership")
                return all_api_keys

            api = TornAPI(torn_api_key)
            faction_response = api.get_faction_members()
            current_members = {str(m['id']): m['name'] for m in faction_response.get('members', [])}

            # Sync members to Supabase (same as the "Sync Members" button on the website)
            if self.supabase and current_members:
                self._sync_members_to_supabase(current_members)

            # Filter API keys to only current faction members
            valid_api_keys = {}
            removed_members = []

            for member_id, api_key in all_api_keys.items():
                if member_id in current_members:
                    valid_api_keys[member_id] = api_key
                else:
                    removed_members.append(member_id)

            if removed_members:
                logger.warning(f"Filtered out {len(removed_members)} API keys for non-faction members: {removed_members}")

            logger.info(f"Validated {len(valid_api_keys)} API keys for current faction members")
            return valid_api_keys

        except Exception as e:
            logger.error(f"Error validating API keys: {e}")
            return all_api_keys  # Fallback to unfiltered keys if validation fails
    
    def _sync_members_to_supabase(self, current_members: Dict[str, str]):
        """
        Sync faction members to the Supabase `members` table.
        Mirrors the handleSyncMembers Edge Function logic:
        1. Mark all existing members as is_current=false
        2. Upsert current faction members with is_current=true
        """
        try:
            now = datetime.utcnow().isoformat()

            # Step 1: Mark all current members as not current
            self.supabase.table('members').update({
                'is_current': False,
                'last_seen': now
            }).eq('is_current', True).execute()

            # Step 2: Upsert current faction members
            records = [
                {
                    'member_id': mid,
                    'member_name': name,
                    'is_current': True,
                    'last_seen': now,
                    'updated_at': now,
                }
                for mid, name in current_members.items()
            ]

            # Batch upsert in chunks of 100
            for i in range(0, len(records), 100):
                chunk = records[i:i + 100]
                self.supabase.table('members').upsert(
                    chunk, on_conflict='member_id'
                ).execute()

            logger.info(f"Synced {len(records)} faction members to Supabase")
        except Exception as e:
            logger.warning(f"Member sync failed (non-fatal): {e}")

    def _fetch_available_crimes(self, api_key: str, member_id: str) -> Optional[Dict]:
        """
        Fetch the key owner's CPR via the user/organizedcrimes selection.

        As of the 2026-06-01 deprecation, `faction` -> `crimes` reports the key
        owner's CPR for empty Recruiting slots as 0, so the old faction empty-slot
        trick no longer works. `user/organizedcrimes` returns empty slots for
        Recruiting crimes with the KEY OWNER's checkpoint_pass_rate instead.

        The response is keyed `organizedcrimes`; we normalise it to the
        `{'crimes': [...]}` shape the extractors already expect (every slot is
        empty, so they attribute each slot's CPR to this member).

        Args:
            api_key: Member's API key
            member_id: Member ID (for logging)

        Returns:
            Crimes data (normalised) or None if failed
        """
        try:
            api = TornAPI(api_key)

            result = api.get_user_organized_crimes(comment="TNL Forge CPR Scraper")

            crimes = result.get('organizedcrimes', [])
            logger.info(f"Member {member_id}: Fetched {len(crimes)} recruiting crimes (user/organizedcrimes)")
            # Normalise to the shape the CPR extractors expect.
            return {'crimes': crimes}

        except TornAPIError as e:
            logger.warning(f"Member {member_id}: API error - {e}")
            logger.warning(f"Member {member_id}: Skipping CPR update (existing data unchanged)")
            return None
        except Exception as e:
            logger.error(f"Member {member_id}: Unexpected error - {e}")
            return None

    def _invalidate_cpr_key(self, member_id: str):
        """Clear the CPR key for a member when it's found to be invalid.

        Routes through set_member_cpr_key with a null raw key — the SECURITY
        DEFINER function deletes the member_secrets row, and the trigger on
        member_secrets flips members.has_cpr_key back to false.
        """
        if not self.supabase:
            return
        cpr_secret = os.environ.get('CPR_KEY_SECRET')
        if not cpr_secret:
            logger.warning(f"Member {member_id}: CPR_KEY_SECRET not set — cannot clear key")
            return
        try:
            self.supabase.rpc('set_member_cpr_key', {
                'p_member_id': str(member_id),
                'p_raw_key': None,
                'p_secret': cpr_secret,
            }).execute()
            logger.info(f"Member {member_id}: cpr_api_key cleared (invalid/expired)")
        except Exception as e:
            logger.warning(f"Member {member_id}: failed to clear cpr_api_key: {e}")

    # ─────────────────────────────────────────────────────────────────────────
    # CPR v2 helpers  (crime-name + position-label keyed, separate from v1)
    # ─────────────────────────────────────────────────────────────────────────

    def _fetch_all_rows(self, table: str, columns: str) -> List[Dict]:
        """Read every row from a table, paging past PostgREST's 1000-row cap."""
        rows: List[Dict] = []
        page, SIZE = 0, 1000
        while True:
            resp = self.supabase.table(table).select(columns).range(page * SIZE, page * SIZE + SIZE - 1).execute()
            batch = resp.data or []
            rows.extend(batch)
            if len(batch) < SIZE:
                break
            page += 1
        return rows

    def _bulk_upsert_db(self, table: str, records: List[Dict], on_conflict: str) -> int:
        """Chunked upsert to Supabase. Returns rows sent."""
        if not records:
            return 0
        total = 0
        for i in range(0, len(records), 500):
            chunk = records[i:i + 500]
            self.supabase.table(table).upsert(chunk, on_conflict=on_conflict).execute()
            total += len(chunk)
        return total

    def _load_cpr_v2_from_db(self) -> Dict:
        """
        Reconstruct the in-memory CPR v2 structure from Supabase. This is the
        single source of truth now — no JSON baseline. Shape matches what
        _merge_cpr_v2 / TierAssignment expect:
          { 'crime_types': {name: {difficulty, first_seen, positions:{label:id}}},
            'member_cpr':  {member_id: {crime: {position: {cpr_value, ...}}}} }
        """
        v2 = {'crime_types': {}, 'member_cpr': {}, 'metadata': {'version': '2.0'}}
        if not self.supabase:
            logger.warning("No Supabase client — starting from an empty v2 baseline")
            return v2

        for t in self._fetch_all_rows('oc_crime_types', 'name,difficulty,first_seen_at'):
            v2['crime_types'][t['name']] = {
                'difficulty': t.get('difficulty'),
                'first_seen': t.get('first_seen_at'),
                'positions': {},
            }
        for p in self._fetch_all_rows('oc_crime_positions', 'crime_name,position_label,position_id'):
            ct = v2['crime_types'].setdefault(p['crime_name'], {'difficulty': None, 'first_seen': None, 'positions': {}})
            ct['positions'][p['position_label']] = p.get('position_id')

        rows = self._fetch_all_rows(
            'member_cpr_v2',
            'member_id,crime_name,position_label,cpr_value,observation_count,first_seen_at,last_seen_at'
        )
        for r in rows:
            mc = v2['member_cpr'].setdefault(str(r['member_id']), {})
            cc = mc.setdefault(r['crime_name'], {})
            cc[r['position_label']] = {
                'cpr_value': float(r['cpr_value']),
                'observation_count': int(r.get('observation_count') or 1),
                'first_seen_at': r.get('first_seen_at'),
                'last_seen_at': r.get('last_seen_at'),
            }
        logger.info(
            f"Loaded v2 baseline from DB: {len(v2['member_cpr'])} members, "
            f"{len(v2['crime_types'])} crime types, {len(rows)} CPR rows"
        )
        return v2

    def _save_cpr_v2_to_db(self, v2_data: Dict, touched_members: set) -> None:
        """
        Upsert the v2 data back to Supabase. Crime types/positions are tiny so
        they're upserted wholesale; member CPR rows are upserted only for members
        touched this run (optimization).
        """
        if not self.supabase:
            logger.warning("No Supabase client — skipping v2 DB save")
            return
        now = datetime.now().isoformat()

        ct_records = [
            {'name': name, 'difficulty': info.get('difficulty'), 'first_seen_at': info.get('first_seen') or now}
            for name, info in v2_data['crime_types'].items()
        ]
        pos_records = [
            {'crime_name': name, 'position_label': label, 'position_id': pid}
            for name, info in v2_data['crime_types'].items()
            for label, pid in info.get('positions', {}).items()
        ]
        cpr_records = []
        for mid in touched_members:
            for cname, positions in v2_data['member_cpr'].get(mid, {}).items():
                difficulty = v2_data['crime_types'].get(cname, {}).get('difficulty')
                for label, rec in positions.items():
                    cpr_records.append({
                        'member_id': mid, 'crime_name': cname, 'position_label': label,
                        'difficulty': difficulty, 'cpr_value': float(rec['cpr_value']),
                        'observation_count': int(rec.get('observation_count', 1)),
                        'first_seen_at': rec.get('first_seen_at') or now,
                        'last_seen_at': rec.get('last_seen_at') or now,
                    })

        self._bulk_upsert_db('oc_crime_types', ct_records, 'name')
        self._bulk_upsert_db('oc_crime_positions', pos_records, 'crime_name,position_label')
        n = self._bulk_upsert_db('member_cpr_v2', cpr_records, 'member_id,crime_name,position_label')
        logger.info(
            f"Saved v2 to DB: {len(ct_records)} crime types, {len(pos_records)} positions, "
            f"{n} CPR rows for {len(touched_members)} touched members"
        )

    def _save_tiers_to_db(self, current_members: Dict[str, str], assignments: Dict) -> None:
        """
        Write each current member's freshly-computed tier straight to the members
        table (always-apply — downgrades allowed). Members with no v2 CPR data get
        Tier 0 (manual review), never -1. Only `tier`/name/timestamps are written,
        so manual `tier_override` and other columns are preserved.
        """
        if not self.supabase:
            logger.warning("No Supabase client — skipping tier DB save")
            return
        now = datetime.now().isoformat()
        records = [
            {
                'member_id': mid,
                'member_name': name,
                'tier': (assignments.get(mid) or {}).get('tier', 0),
                'last_scraped': now,
                'updated_at': now,
            }
            for mid, name in current_members.items()
        ]
        n = self._bulk_upsert_db('members', records, 'member_id')
        logger.info(f"Saved tiers to DB for {n} members (always-apply, Tier 0 = no data)")

    def _extract_cpr_v2_from_crimes(
        self,
        crimes_data: Dict,
        member_id_context: Optional[str] = None
    ) -> List[Dict]:
        """
        Extract CPR entries for the v2 (crime-name keyed) database.

        Attribution rules:
          - Filled slot  (user != null)  → CPR belongs to that user regardless of key used.
          - Empty slot   (user == null)  → CPR belongs to member_id_context (i.e. the member
            whose personal API key was used for this request).  If member_id_context is None
            (faction key) there is no owner to attribute to, so empty slots are skipped.

        Returns a list of dicts, each with:
            member_id, crime_name, difficulty, position_label, position_id, cpr_value
        """
        entries: List[Dict] = []

        if not crimes_data or 'crimes' not in crimes_data:
            return entries

        for crime in crimes_data['crimes']:
            crime_name = crime.get('name', 'Unknown')
            difficulty = crime.get('difficulty')

            for slot in crime.get('slots', []):
                cpr = slot.get('checkpoint_pass_rate')
                if cpr is None:
                    continue

                position_info = slot.get('position_info') or {}
                position_label = position_info.get('label') or slot.get('position', 'Unknown')
                position_id = position_info.get('id') or slot.get('position_id')

                user_data = slot.get('user')
                if user_data and user_data.get('id'):
                    attributed_to = str(user_data['id'])
                elif member_id_context is not None:
                    attributed_to = member_id_context
                else:
                    continue  # faction key + empty slot → no attribution possible

                entries.append({
                    'member_id': attributed_to,
                    'crime_name': crime_name,
                    'difficulty': difficulty,
                    'position_label': position_label,
                    'position_id': position_id,
                    'cpr_value': cpr,
                })

        return entries

    def _merge_cpr_v2(self, v2_data: Dict, entries: List[Dict]) -> int:
        """
        Merge a list of CPR v2 entries into v2_data in-place.

        For each entry:
          - Registers the crime type and position if not already known.
          - If the member already has a value for that crime+position: increments
            observation_count and updates cpr_value + last_seen_at.
          - Otherwise creates a new record.

        Returns the number of new-or-updated records.
        """
        now = datetime.now().isoformat()
        changed = 0

        for entry in entries:
            crime_name = entry['crime_name']
            difficulty = entry['difficulty']
            position_label = entry['position_label']
            position_id = entry.get('position_id')
            member_id = entry['member_id']
            cpr_value = entry['cpr_value']

            # ── Register crime type ──────────────────────────────────────────
            if crime_name not in v2_data['crime_types']:
                v2_data['crime_types'][crime_name] = {
                    'difficulty': difficulty,
                    'first_seen': now,
                    'positions': {}
                }
                logger.info(f"CPR v2: New crime type registered — '{crime_name}' (difficulty {difficulty})")

            crime_entry = v2_data['crime_types'][crime_name]

            # ── Register position ────────────────────────────────────────────
            if position_label not in crime_entry['positions']:
                crime_entry['positions'][position_label] = position_id
                logger.debug(f"CPR v2: New position '{position_label}' registered for '{crime_name}'")

            # ── Upsert member CPR ────────────────────────────────────────────
            member_crimes = v2_data['member_cpr'].setdefault(member_id, {})
            crime_cprs = member_crimes.setdefault(crime_name, {})

            if position_label in crime_cprs:
                existing = crime_cprs[position_label]
                old_value = existing['cpr_value']
                existing['cpr_value'] = cpr_value
                existing['observation_count'] = existing.get('observation_count', 1) + 1
                existing['last_seen_at'] = now
                if cpr_value != old_value:
                    direction = "↑" if cpr_value > old_value else "↓"
                    logger.info(
                        f"CPR v2: Member {member_id} '{crime_name}' {position_label} "
                        f"= {cpr_value} {direction} (was {old_value}, "
                        f"obs #{existing['observation_count']})"
                    )
            else:
                crime_cprs[position_label] = {
                    'cpr_value': cpr_value,
                    'observation_count': 1,
                    'first_seen_at': now,
                    'last_seen_at': now,
                }
                logger.info(
                    f"CPR v2: Member {member_id} '{crime_name}' {position_label} = {cpr_value} (NEW)"
                )

            changed += 1

        return changed

    def scrape_member(
        self,
        member_id: str,
        api_key: str,
        member_name: str,
        v2_data: Dict,
        touched: set,
    ) -> Tuple[bool, int, Optional[str]]:
        """
        Scrape a single member's CPR via user/organizedcrimes and merge into the
        in-memory v2 structure. Empty slots carry the key owner's CPR, so every
        returned slot is attributed to this member.

        Returns (success, records_merged, error_message).
        """
        logger.info(f"Starting scrape for {member_name} ({member_id})")

        crimes_data = self._fetch_available_crimes(api_key, member_id)
        if crimes_data is None:
            return False, 0, "API fetch failed - key may be invalid or expired"

        v2_entries = self._extract_cpr_v2_from_crimes(crimes_data, member_id_context=member_id)
        touched.update(e['member_id'] for e in v2_entries)
        updates = self._merge_cpr_v2(v2_data, v2_entries)

        logger.info(f"Member {member_name} ({member_id}): {updates} CPR records merged")
        return True, updates, None

    def scrape_all_members(self) -> Optional[Tuple[Dict, Dict, set]]:
        """
        DB-native multi-stage CPR scrape (v2 only):
          1. Load the CPR v2 baseline from Supabase (no JSON).
          2. Fetch the current faction roster from Torn.
          3. Faction available-crimes scan → filled-slot CPR for any slotted member.
          4. Per-member user/organizedcrimes scan → the key owner's CPR.

        Returns (v2_data, current_members, touched_members), or None on fatal error.
        """
        logger.info("Starting multi-stage CPR scrape (DB-native, v2 only)")

        v2_data = self._load_cpr_v2_from_db()
        touched: set = set()

        torn_api_key = os.environ.get('TORN_API_KEY')
        if not torn_api_key:
            logger.error("TORN_API_KEY not found - cannot fetch current faction members")
            return None

        api = TornAPI(torn_api_key)

        # STAGE 1: current faction roster
        logger.info("\n" + "="*70)
        logger.info("STAGE 1: Fetching current faction members")
        logger.info("="*70)
        try:
            faction_response = api.get_faction_members()
            current_members = {str(m['id']): m['name'] for m in faction_response.get('members', [])}
            logger.info(f"Retrieved {len(current_members)} current faction members")
        except Exception as e:
            logger.error(f"Failed to fetch faction members: {e}")
            return None

        # STAGE 2: faction available-crimes filled-slot scan → v2
        logger.info("\n" + "="*70)
        logger.info("STAGE 2: Faction available-crimes filled-slot scan")
        logger.info("="*70)
        try:
            crimes_response = api.get_faction_crimes(
                category="available",
                filters="created_at",
                offset=0,
                sort="DESC",
                comment="TNL Forge CPR Scraper - Available Crimes Scan"
            )
            v2_entries = self._extract_cpr_v2_from_crimes(crimes_response, member_id_context=None)
            touched.update(e['member_id'] for e in v2_entries)
            merged = self._merge_cpr_v2(v2_data, v2_entries)
            logger.info(f"Stage 2 complete: {merged} filled-slot CPR records merged ({len(touched)} members touched)")
        except Exception as e:
            logger.error(f"Failed faction available-crimes scan: {e}")
            logger.warning("Continuing with individual member scrapes...")

        # STAGE 3: per-member user/organizedcrimes (key owner CPR)
        logger.info("\n" + "="*70)
        logger.info(f"STAGE 3: Scraping {len(self.member_api_keys)} members with API keys")
        logger.info("="*70)

        stats = {'successful_scrapes': 0, 'failed_scrapes': 0, 'total_updates': 0}
        for i, (member_id, api_key) in enumerate(self.member_api_keys.items(), 1):
            member_name = current_members.get(member_id, f"Member_{member_id}")
            logger.info(f"Processing {i}/{len(self.member_api_keys)}: {member_name} ({member_id})")
            try:
                success, updates, error_msg = self.scrape_member(member_id, api_key, member_name, v2_data, touched)
                if success:
                    stats['successful_scrapes'] += 1
                    stats['total_updates'] += updates
                else:
                    stats['failed_scrapes'] += 1
                    # Key failed — null it out so the dashboard shows red and member re-submits
                    self._invalidate_cpr_key(member_id)
            except Exception as e:
                logger.error(f"Member {member_name} ({member_id}): Unexpected error - {e}")
                stats['failed_scrapes'] += 1
                self._invalidate_cpr_key(member_id)
            if i < len(self.member_api_keys):
                time.sleep(0.01)

        logger.info("\n" + "="*70)
        logger.info("CPR SCRAPE SUMMARY")
        logger.info("="*70)
        logger.info(f"Stage 3 - Successful API key scrapes: {stats['successful_scrapes']}")
        logger.info(f"Stage 3 - Failed (key invalidated): {stats['failed_scrapes']}")
        logger.info(f"Stage 3 - Total CPR records merged: {stats['total_updates']}")
        logger.info(f"Members touched this run: {len(touched)}")
        logger.info("="*70)

        self._log_members_missing_key(current_members)

        return v2_data, current_members, touched

    def _log_members_missing_key(self, current_members: Dict[str, str]) -> None:
        """Informational: list current members with no CPR scraper key (from Supabase)."""
        members_missing_key = []
        if self.supabase:
            try:
                resp = self.supabase.table('members') \
                    .select('member_id, member_name') \
                    .eq('is_current', True) \
                    .eq('has_cpr_key', False) \
                    .execute()
                members_missing_key = sorted(
                    [(str(row['member_id']), row.get('member_name') or str(row['member_id'])) for row in (resp.data or [])],
                    key=lambda x: x[1].lower()
                )
            except Exception as e:
                logger.warning(f"Could not query Supabase for missing-key list: {e}")

        logger.info("\n" + "="*70)
        if members_missing_key:
            logger.info(f"MEMBERS WITHOUT A CPR SCRAPER KEY ({len(members_missing_key)} of {len(current_members)})")
            logger.info("="*70)
            for mid, name in members_missing_key:
                logger.info(f"  {name} [{mid}]")
        else:
            logger.info("✓ All current faction members have a CPR scraper key (or none missing).")
        logger.info("="*70)

def print_faction_tier_summary(assignments: Dict, current_members: Dict[str, str]) -> None:
    """Print tier distribution for current faction members from fresh assignments."""
    tier_distribution: Dict[int, list] = {}
    for mid, name in current_members.items():
        tier = (assignments.get(mid) or {}).get('tier', 0)
        tier_distribution.setdefault(tier, []).append((name, mid))

    logger.info("\n" + "="*60)
    logger.info("CURRENT FACTION MEMBER TIER DISTRIBUTION")
    logger.info("="*60)
    logger.info(f"Total current faction members: {len(current_members)}")
    logger.info("")
    for tier in [0] + list(range(1, 7)):
        members = tier_distribution.get(tier, [])
        if not members:
            continue
        label = "⚠️  Tier 0 (NEEDS MANUAL REVIEW)" if tier == 0 else f"Tier {tier}"
        logger.info(f"  {label}: {len(members)} members")
        for name, mid in sorted(members):
            logger.info(f"    - {name} [{mid}]")
    logger.info("="*60)


def main():
    """Main execution: DB-native CPR scrape (v2) + always-apply tier assignment."""
    logger.info("="*60)
    logger.info("Starting CPR Scraper (DB-native, v2) with Tier Assignment")
    logger.info("="*60)

    try:
        scraper = CPRScraper()

        # Step 1: Scrape CPR into the in-memory v2 structure (baseline from DB).
        result = scraper.scrape_all_members()
        if not result:
            logger.error("Scrape aborted (no roster) — nothing written.")
            sys.exit(1)
        v2_data, current_members, touched = result

        # Step 2: Compute tiers from the fresh v2 data (always-apply; no upgrade-only).
        logger.info("\nRunning tier assignment algorithm...")
        assignments = {}
        try:
            tier_system = TierAssignment(
                member_cpr=v2_data['member_cpr'],
                crime_types=v2_data['crime_types'],
            )
            assignments = tier_system.generate_tier_assignments()
        except Exception as e:
            logger.error(f"Tier assignment failed: {e}")
            import traceback
            traceback.print_exc()

        # Step 3: Persist to Supabase (CPR v2 for touched members + every member's tier).
        try:
            scraper._save_cpr_v2_to_db(v2_data, touched)
        except Exception as e:
            logger.error(f"Saving CPR v2 to DB failed: {e}")
        try:
            scraper._save_tiers_to_db(current_members, assignments)
        except Exception as e:
            logger.error(f"Saving tiers to DB failed: {e}")

        print_faction_tier_summary(assignments, current_members)
        logger.info("\n✓ CPR scrape and tier assignment completed successfully!")

    except Exception as e:
        logger.error(f"Fatal error in CPR scraper: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
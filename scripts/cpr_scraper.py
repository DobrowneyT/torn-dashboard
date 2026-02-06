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

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.utils.json_storage import JSONStorageManager
from scripts.utils.google_sheets import GoogleSheetsManager
from scripts.utils.torn_api import TornAPI, TornAPIError
from scripts.utils.gist_updater import update_gist

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
        self.sheets = GoogleSheetsManager()
        self.member_api_keys = self._load_api_keys()
        
        logger.info("CPR Scraper initialized")
        logger.info(f"Found API keys for {len(self.member_api_keys)} members")
    
    def _load_api_keys(self) -> Dict[str, str]:
        """
        Load member API keys from environment variable and validate against current faction
        
        Expected format in GitHub Secret MEMBER_API_KEYS:
        {
            "member_id_1": "api_key_1",
            "member_id_2": "api_key_2"
        }
        
        Returns:
            Dictionary mapping member IDs to API keys (only for current faction members)
        """
        api_keys_json = os.environ.get('MEMBER_API_KEYS', '{}')
        
        try:
            all_api_keys = json.loads(api_keys_json)
            logger.info(f"Loaded {len(all_api_keys)} API keys from secrets")
            
            # Get current faction members to validate against
            torn_api_key = os.environ.get('TORN_API_KEY')
            if not torn_api_key:
                logger.error("TORN_API_KEY not found - cannot validate faction membership")
                return all_api_keys
            
            api = TornAPI(torn_api_key)
            faction_response = api.get_faction_members()
            current_members = {str(m['id']): m['name'] for m in faction_response.get('members', [])}
            
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
            
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse MEMBER_API_KEYS: {e}")
            return {}
        except Exception as e:
            logger.error(f"Error validating API keys: {e}")
            return all_api_keys  # Fallback to unfiltered keys if validation fails
    
    def _load_cpr_database(self) -> Dict:
        """
        Load the CPR database from storage
        Now includes tier data for each member
        """
        cpr_data = self.storage.read_json('cpr_database.json')
        
        if not cpr_data:
            # Initialize if doesn't exist
            cpr_data = {
                'members': {},
                'metadata': {
                    'last_updated': datetime.now().isoformat(),
                    'total_members': 0,
                    'version': '2.0'  # Updated version for tier integration
                }
            }
            self.storage.write_json('cpr_database.json', cpr_data, create_backup=False)
        
        return cpr_data
    
    def _save_cpr_database(self, cpr_data: Dict):
        """Save the CPR database to storage with sorted difficulty levels"""
        cpr_data['metadata']['last_updated'] = datetime.now().isoformat()
        cpr_data['metadata']['total_members'] = len(cpr_data.get('members', {}))
        cpr_data['metadata']['version'] = '2.0'
        
        # Sort difficulty levels numerically for all members (if not already)
        for member_id in cpr_data.get('members', {}):
            if 'cpr_by_role' in cpr_data['members'][member_id]:
                sorted_cpr = {}
                for level in sorted(cpr_data['members'][member_id]['cpr_by_role'].keys(), key=int):
                    sorted_cpr[level] = cpr_data['members'][member_id]['cpr_by_role'][level]
                cpr_data['members'][member_id]['cpr_by_role'] = sorted_cpr
        
        self.storage.write_json(
            'cpr_database.json',
            cpr_data,
            create_backup=True,
            commit_message="Update CPR database and tiers"
        )
        logger.info("CPR database with tiers saved")
    
    def _fetch_available_crimes(self, api_key: str, member_id: str) -> Optional[Dict]:
        """
        Fetch available crimes from Torn API with error handling
        
        Args:
            api_key: Member's API key
            member_id: Member ID (for logging)
            
        Returns:
            Crimes data or None if failed
        """
        try:
            api = TornAPI(api_key)
            
            # Get available crimes sorted by creation date
            result = api.get_faction_crimes(
                category="available",
                filters="created_at",
                offset=0,
                sort="DESC",
                comment="TNL Forge CPR Scraper"
            )
            
            crimes = result.get('crimes', [])
            logger.info(f"Member {member_id}: Fetched {len(crimes)} available crimes")
            return result
            
        except TornAPIError as e:
            logger.warning(f"Member {member_id}: API error - {e}")
            logger.warning(f"Member {member_id}: Skipping CPR update (existing data unchanged)")
            return None
        except Exception as e:
            logger.error(f"Member {member_id}: Unexpected error - {e}")
            return None

    def _extract_cpr_from_crimes(self, crimes_data: Dict, member_id: str) -> Dict[str, Dict[str, int]]:
        """
        Extract CPR requirements from empty slots in crimes
        
        Args:
            crimes_data: Raw crimes data from API
            member_id: Member ID (for logging)
            
        Returns:
            Dictionary: {difficulty_level: {position: cpr_value}}
        """
        cpr_by_level = {}
        
        if not crimes_data or 'crimes' not in crimes_data:
            return cpr_by_level
        
        for crime in crimes_data['crimes']:
            difficulty = str(crime['difficulty'])
            crime_name = crime.get('name', 'Unknown')
            
            if difficulty not in cpr_by_level:
                cpr_by_level[difficulty] = {}
            
            # Check all slots for empty positions
            for slot in crime.get('slots', []):
                # Only process empty slots (user is null)
                if slot.get('user') is None:
                    position = slot.get('position', 'Unknown')
                    cpr = slot.get('checkpoint_pass_rate', 0)
                    
                    # Take highest CPR seen for this position/level
                    current_cpr = cpr_by_level[difficulty].get(position, 0)
                    if cpr > current_cpr:
                        cpr_by_level[difficulty][position] = cpr
                        logger.debug(f"Member {member_id}: {crime_name} Lvl {difficulty} - {position} = {cpr} CPR")
        
        return cpr_by_level

    def _update_member_cpr(self, cpr_data: Dict, member_id: str, member_name: str, new_cpr: Dict[str, Dict[str, int]]) -> int:
        """
        Update a member's CPR data (API data is always source of truth)
        
        IMPORTANT: This always reconstructs the member dict to ensure consistent ordering:
        1. name (always updated from sync)
        2. tier (preserved from existing data, defaults to -1 for new members)
        3. cpr_by_role (merged - keeps old roles, updates/adds new ones, SORTED by difficulty)
        4. last_scraped (always updated)
        5. tier_last_updated (preserved from existing data)
        
        Args:
            cpr_data: Full CPR database
            member_id: Member ID (as string)
            member_name: Member name (from faction sync)
            new_cpr: New CPR data from API scrape
            
        Returns:
            Number of updates made
        """
        updates = 0
        
        # Get existing member data or create empty structure
        existing_member = cpr_data['members'].get(member_id, {})
        existing_cpr = existing_member.get('cpr_by_role', {})
        existing_tier = existing_member.get('tier', -1)
        existing_tier_updated = existing_member.get('tier_last_updated', '')
        
        # Merge CPR data: keep all existing roles, update/add new ones
        merged_cpr = {}
        
        # First, copy all existing CPR data
        for level, roles in existing_cpr.items():
            merged_cpr[level] = roles.copy()
        
        # Then update with new data
        for level, roles in new_cpr.items():
            if level not in merged_cpr:
                merged_cpr[level] = {}
            
            for role, new_value in roles.items():
                old_value = merged_cpr[level].get(role, 0)
                
                if new_value != old_value:
                    merged_cpr[level][role] = new_value
                    updates += 1
                    
                    if old_value == 0:
                        logger.info(f"Member {member_name} ({member_id}): NEW - Lvl {level} {role} = {new_value}")
                    else:
                        direction = "↑" if new_value > old_value else "↓"
                        logger.info(f"Member {member_name} ({member_id}): UPDATE - Lvl {level} {role} = {new_value} {direction} (was {old_value})")
        
        # Sort the merged CPR by difficulty level (numerically)
        sorted_cpr = {}
        for level in sorted(merged_cpr.keys(), key=int):
            sorted_cpr[level] = merged_cpr[level]
        
        # Reconstruct member dict with consistent ordering INCLUDING tier
        cpr_data['members'][member_id] = {
            'name': member_name,  # Always use current name from faction sync
            'tier': existing_tier,  # Preserve existing tier (updated separately by tier assignment)
            'cpr_by_role': sorted_cpr,  # Now sorted by difficulty
            'last_scraped': datetime.now().isoformat(),
            'tier_last_updated': existing_tier_updated  # Preserve tier update timestamp
        }
        
        return updates

    def scrape_member(self, member_id: str, api_key: str, member_name: str, cpr_data: Dict) -> Tuple[bool, int, Optional[str]]:
        """
        Scrape CPR data for a single member
        
        Args:
            member_id: Member ID
            api_key: Member's API key
            member_name: Member name
            cpr_data: CPR database to update
            
        Returns:
            Tuple of (success, updates_count, error_message)
        """
        logger.info(f"Starting scrape for {member_name} ({member_id})")
        
        # Fetch available crimes
        crimes_data = self._fetch_available_crimes(api_key, member_id)
        
        if crimes_data is None:
            return True, 0, "API fetch failed - existing data unchanged"
        
        # Extract CPR requirements
        new_cpr = self._extract_cpr_from_crimes(crimes_data, member_id)
        
        if not new_cpr:
            logger.warning(f"Member {member_name} ({member_id}): No empty slots found in available crimes")
            return True, 0, "No empty slots available"
        
        # Update member's CPR data
        updates = self._update_member_cpr(cpr_data, member_id, member_name, new_cpr)
        
        logger.info(f"Member {member_name} ({member_id}): Scrape complete - {updates} updates made")
        return True, updates, None

    def scrape_all_members(self) -> Dict:
        """
        Scrape CPR data for all members with API keys
        
        Returns:
            CPR database with updated data
        """
        logger.info(f"Starting CPR scrape for {len(self.member_api_keys)} members with validated API keys")
        
        # Load existing CPR database (includes tier data)
        cpr_data = self._load_cpr_database()
        
        # Get current faction members for name lookup
        torn_api_key = os.environ.get('TORN_API_KEY')
        current_members = {}
        if torn_api_key:
            try:
                api = TornAPI(torn_api_key)
                faction_response = api.get_faction_members()
                current_members = {str(m['id']): m['name'] for m in faction_response.get('members', [])}
                logger.info(f"Retrieved {len(current_members)} current faction members for name lookup")
            except Exception as e:
                logger.warning(f"Could not fetch faction members for name lookup: {e}")
        
        # Stats tracking
        stats = {
            'successful_scrapes': 0,
            'failed_scrapes': 0,
            'total_updates': 0,
            'members_scraped': []
        }
        
        # Scrape each member with valid API key
        for i, (member_id, api_key) in enumerate(self.member_api_keys.items(), 1):
            # Get member name from current faction members, fall back to CPR database, then to ID
            if member_id in current_members:
                member_name = current_members[member_id]
            else:
                member_name = cpr_data.get('members', {}).get(member_id, {}).get('name', f"Member_{member_id}")
            
            logger.info(f"Processing {i}/{len(self.member_api_keys)}: {member_name} ({member_id})")
            
            try:
                success, updates, error_msg = self.scrape_member(member_id, api_key, member_name, cpr_data)
                
                if success:
                    stats['successful_scrapes'] += 1
                    stats['total_updates'] += updates
                    stats['members_scraped'].append(member_id)
                else:
                    stats['failed_scrapes'] += 1
                
            except Exception as e:
                logger.error(f"Member {member_name} ({member_id}): Unexpected error - {e}")
                stats['failed_scrapes'] += 1
            
            # Rate limiting
            if i < len(self.member_api_keys):
                time.sleep(0.01)
        
        # Save the updated CPR database
        self._save_cpr_database(cpr_data)
        
        logger.info("="*70)
        logger.info(f"CPR scrape complete: {stats['successful_scrapes']} successful, {stats['total_updates']} updates")
        logger.info("="*70)
        
        return cpr_data
    
    def update_member_tiers(self, cpr_data: Dict, new_tier_assignments: Dict) -> Dict:
        """
        Update member tiers with upgrade-only logic
        
        Args:
            cpr_data: CPR database with existing tier data
            new_tier_assignments: New tier assignments from tier assignment algorithm
            
        Returns:
            Dictionary of tier changes made
        
        Logic:
        - If new tier is BETTER (lower number) than existing tier → UPGRADE
        - If new tier is WORSE (higher number) or EQUAL → KEEP existing tier
        - Tier -1 is special case (no data) and can be upgraded to any tier
        """
        tier_changes = {
            'promoted': [],
            'unchanged': [],
            'upgrade_rejected': []
        }
        
        logger.info("\n" + "="*70)
        logger.info("TIER UPDATE PROCESSING (Upgrade-Only Logic)")
        logger.info("="*70)
        
        for member_id, new_assignment in new_tier_assignments.items():
            if member_id not in cpr_data['members']:
                logger.warning(f"Member {member_id} not in CPR database, skipping tier update")
                continue
            
            member_data = cpr_data['members'][member_id]
            member_name = member_data['name']
            existing_tier = member_data.get('tier', -1)
            new_tier = new_assignment['tier']
            
            # Determine if we should update
            should_update = False
            reason = ""
            
            if existing_tier == -1:
                # Member has no tier yet (new member or no data)
                should_update = True
                reason = "New tier assignment (was pending)"
            elif new_tier < existing_tier:
                # New tier is better (lower number) - UPGRADE
                should_update = True
                reason = f"Promotion: Tier {existing_tier} → {new_tier}"
            elif new_tier == existing_tier:
                # Same tier - keep existing
                should_update = False
                reason = f"Unchanged: Tier {existing_tier}"
            else:
                # New tier is worse (higher number) - REJECT
                should_update = False
                reason = f"Upgrade rejected: Would downgrade from Tier {existing_tier} to Tier {new_tier}"
            
            if should_update:
                member_data['tier'] = new_tier
                member_data['tier_last_updated'] = datetime.now().isoformat()
                
                if existing_tier != -1 and new_tier < existing_tier:
                    tier_changes['promoted'].append({
                        'member_id': member_id,
                        'name': member_name,
                        'old_tier': existing_tier,
                        'new_tier': new_tier,
                        'reason': reason
                    })
                    logger.info(f"✓ {member_name} ({member_id}): {reason}")
                else:
                    tier_changes['unchanged'].append({
                        'member_id': member_id,
                        'name': member_name,
                        'tier': new_tier
                    })
                    logger.info(f"✓ {member_name} ({member_id}): {reason}")
            else:
                tier_changes['upgrade_rejected'].append({
                    'member_id': member_id,
                    'name': member_name,
                    'existing_tier': existing_tier,
                    'proposed_tier': new_tier,
                    'reason': reason
                })
                logger.info(f"⊗ {member_name} ({member_id}): {reason}")
        
        # Print summary
        logger.info("\n" + "="*70)
        logger.info("TIER UPDATE SUMMARY")
        logger.info("="*70)
        logger.info(f"Promotions: {len(tier_changes['promoted'])}")
        logger.info(f"Unchanged: {len(tier_changes['unchanged'])}")
        logger.info(f"Upgrades rejected (would downgrade): {len(tier_changes['upgrade_rejected'])}")
        logger.info("="*70 + "\n")
        
        return tier_changes


def main():
    """Main execution function"""
    logger.info("="*60)
    logger.info("Starting Enhanced CPR Scraper with Tier Management")
    logger.info("="*60)

    try:
        # Initialize scraper
        scraper = CPRScraper()
        
        # Step 1: Scrape CPR data (also loads existing tier data)
        cpr_data = scraper.scrape_all_members()
        
        # Step 2: Run tier assignment algorithm
        logger.info("\nRunning tier assignment algorithm...")
        try:
            from scripts.assign_tiers import TierAssignment
            tier_system = TierAssignment()
            
            # Generate new tier assignments based on CPR data
            new_tier_assignments = tier_system.generate_tier_assignments()
            
            # Step 3: Update tiers with upgrade-only logic
            tier_changes = scraper.update_member_tiers(cpr_data, new_tier_assignments)
            
            # Step 4: Save updated database (now with new tiers)
            scraper._save_cpr_database(cpr_data)
            
            # Step 5: Update Google Sheets
            logger.info("\nUpdating Google Sheets...")
            try:
                # Update CPR scores
                cpr_scores = {}
                for member_id, member_data in cpr_data['members'].items():
                    all_cprs = []
                    for level, roles in member_data.get('cpr_by_role', {}).items():
                        all_cprs.extend(roles.values())
                    
                    avg_cpr = round(sum(all_cprs) / len(all_cprs), 2) if all_cprs else 0
                    
                    cpr_scores[member_id] = {
                        'average_cpr': avg_cpr,
                        'cpr_by_difficulty': member_data.get('cpr_by_role', {})
                    }
                
                scraper.sheets.update_member_cpr_scores(cpr_scores)
                
                # Update tier data (extract tier assignments)
                tier_data = {}
                for member_id, member_data in cpr_data['members'].items():
                    tier_data[member_id] = {
                        'tier': member_data.get('tier', -1),
                        'previous_tier': member_data.get('tier', -1),  # We don't track this in new system
                        'changed': False,  # Already processed
                        'total_crimes': 0,  # Not stored in CPR data
                        'requirements_met': 0,
                        'requirements_needed': 0,
                        'manual_override': False,
                        'assignment_method': 'upgrade_only',
                        'last_updated': member_data.get('tier_last_updated', '')
                    }
                
                scraper.sheets.update_member_tier_data(tier_data)
                logger.info("✓ Google Sheets updated successfully")
                
            except Exception as e:
                logger.error(f"Error updating Google Sheets: {e}")
            
            # Step 6: Update GitHub Gist
            logger.info("\nUpdating public GitHub Gist...")
            try:
                update_gist()
                logger.info("✓ Gist updated successfully")
            except Exception as e:
                logger.error(f"Gist update failed: {e}")
            
            logger.info("\n✓ CPR scrape and tier management completed successfully!")
            
        except Exception as e:
            logger.error(f"Tier assignment failed: {e}")
            import traceback
            traceback.print_exc()
            # Don't exit - CPR scrape was successful
        
    except Exception as e:
        logger.error(f"Fatal error in CPR scraper: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
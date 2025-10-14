"""
CPR Data Scraper for Torn City OC System
Scrapes CPR requirements from available crime slots for all members with API keys
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
        Load member API keys from environment variable
        
        Expected format in GitHub Secret MEMBER_API_KEYS:
        {
            "member_id_1": "api_key_1",
            "member_id_2": "api_key_2"
        }
        
        Returns:
            Dictionary mapping member IDs to API keys
        """
        api_keys_json = os.environ.get('MEMBER_API_KEYS', '{}')
        
        try:
            api_keys = json.loads(api_keys_json)
            logger.info(f"Loaded API keys for {len(api_keys)} members")
            return api_keys
            
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse MEMBER_API_KEYS: {e}")
            return {}
    
    def _load_cpr_database(self) -> Dict:
        """Load the CPR database from storage"""
        cpr_data = self.storage.read_json('cpr_database.json')
        
        if not cpr_data:
            # Initialize if doesn't exist
            cpr_data = {
                'members': {},
                'metadata': {
                    'last_updated': datetime.now().isoformat(),
                    'total_members': 0,
                    'version': '1.0'
                }
            }
            self.storage.write_json('cpr_database.json', cpr_data, create_backup=False)
        
        return cpr_data
    
    def _save_cpr_database(self, cpr_data: Dict):
        """Save the CPR database to storage"""
        cpr_data['metadata']['last_updated'] = datetime.now().isoformat()
        cpr_data['metadata']['total_members'] = len(cpr_data.get('members', {}))
        
        self.storage.write_json(
            'cpr_database.json',
            cpr_data,
            create_backup=True,
            commit_message="Update CPR database from scrape"
        )
        logger.info("CPR database saved")
    
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
                        logger.info(f"Member {member_id}: {crime_name} Lvl {difficulty} - {position} = {cpr} CPR")
        
        return cpr_by_level

    def _update_member_cpr(self, cpr_data: Dict, member_id: str, member_name: str, new_cpr: Dict[str, Dict[str, int]]) -> int:
        """
        Update a member's CPR data (API data is always source of truth)
        
        IMPORTANT: This always reconstructs the member dict to ensure consistent ordering:
        1. name (always updated from sync)
        2. cpr_by_role (merged - keeps old roles, updates/adds new ones, SORTED by difficulty)
        3. last_scraped (always updated)
        
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
        
        # Reconstruct member dict with consistent ordering (no redundant member_id field)
        cpr_data['members'][member_id] = {
            'name': member_name,  # Always use current name from faction sync
            'cpr_by_role': sorted_cpr,  # Now sorted by difficulty
            'last_scraped': datetime.now().isoformat()
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
            error_msg = "Invalid API key or API error - data unchanged"
            logger.warning(f"Member {member_name} ({member_id}): {error_msg}")
            return True, 0, error_msg
        
        # Extract CPR requirements
        new_cpr = self._extract_cpr_from_crimes(crimes_data, member_id)
        
        if not new_cpr:
            logger.warning(f"Member {member_name} ({member_id}): No empty slots found in available crimes")
            return True, 0, "No empty slots available"
        
        # Update member's CPR data
        updates = self._update_member_cpr(cpr_data, member_id, member_name, new_cpr)
        
        logger.info(f"Member {member_name} ({member_id}): Scrape complete - {updates} updates made")
        return True, updates, None

    def scrape_all_members(self, member_names: Dict[str, str] = None) -> Dict[str, any]:
        """
        Scrape CPR data for all members with API keys
        
        Args:
            member_names: Dictionary mapping member_id -> member_name from faction sync
        
        Returns:
            Summary statistics
        """
        if not self.member_api_keys:
            logger.error("No member API keys configured")
            return {
                'success': False,
                'error': 'No member API keys configured'
            }
        
        logger.info(f"Starting CPR scrape for {len(self.member_api_keys)} members")
        
        # Use provided member names or default to empty dict
        if member_names is None:
            logger.warning("No member names provided - using member IDs only")
            member_names = {}
        
        # Load CPR database
        cpr_data = self._load_cpr_database()
        
        # Stats tracking
        stats = {
            'total_members': len(self.member_api_keys),
            'successful': 0,
            'failed': 0,
            'skipped_invalid_key': 0,
            'skipped_not_in_faction': 0,
            'total_updates': 0,
            'members_scraped': [],
            'members_with_errors': {},
            'members_failed': [],
            'members_not_in_faction': []
        }
        
        # Scrape each member
        for i, (member_id, api_key) in enumerate(self.member_api_keys.items(), 1):
            # Check if member is still in faction
            if member_id not in member_names:
                logger.warning(f"Member {member_id}: Not found in faction roster - skipping")
                stats['skipped_not_in_faction'] += 1
                stats['members_not_in_faction'].append(member_id)
                continue
            
            member_name = member_names[member_id]
            logger.info(f"Processing {i}/{stats['total_members']}: {member_name} ({member_id})")
            
            try:
                success, updates, error_msg = self.scrape_member(member_id, api_key, member_name, cpr_data)
                
                if success:
                    stats['successful'] += 1
                    stats['total_updates'] += updates
                    stats['members_scraped'].append(member_id)
                    
                    if error_msg:
                        stats['members_with_errors'][member_id] = error_msg
                        if 'Invalid API key' in error_msg:
                            stats['skipped_invalid_key'] += 1
                else:
                    stats['failed'] += 1
                    stats['members_failed'].append(member_id)
                
            except Exception as e:
                logger.error(f"Member {member_name} ({member_id}): Unexpected error - {e}")
                stats['failed'] += 1
                stats['members_failed'].append(member_id)
                stats['members_with_errors'][member_id] = str(e)
            
            # Rate limiting
            if i < stats['total_members']:
                time.sleep(0.01)

        stats['success'] = stats['successful'] > 0
        return stats
        
        # Save updated CPR database
    def _save_cpr_database(self, cpr_data: Dict):
        """Save the CPR database to storage with sorted difficulty levels"""
        cpr_data['metadata']['last_updated'] = datetime.now().isoformat()
        cpr_data['metadata']['total_members'] = len(cpr_data.get('members', {}))
        
        # Sort difficulty levels numerically for all members
        for member_id in cpr_data.get('members', {}):
            if 'cpr_by_role' in cpr_data['members'][member_id]:
                sorted_cpr = {}
                # Sort keys numerically (convert to int for sorting)
                for level in sorted(cpr_data['members'][member_id]['cpr_by_role'].keys(), key=int):
                    sorted_cpr[level] = cpr_data['members'][member_id]['cpr_by_role'][level]
                cpr_data['members'][member_id]['cpr_by_role'] = sorted_cpr
        
        self.storage.write_json(
            'cpr_database.json',
            cpr_data,
            create_backup=True,
            commit_message="Update CPR database from scrape"
        )
        logger.info("CPR database saved with sorted difficulty levels")

    def _update_sheets_with_cpr(self, cpr_data: Dict):
        """
        Update Google Sheets with CPR scores in Members sheet column C
        
        Args:
            cpr_data: Full CPR database
        """
        logger.info("Updating Google Sheets with CPR scores...")
        
        # Prepare CPR score data by member_id
        cpr_scores = {}
        
        for member_id, member_info in cpr_data.get('members', {}).items():
            # Calculate average CPR across all roles/levels
            all_cprs = []
            for level, roles in member_info.get('cpr_by_role', {}).items():
                all_cprs.extend(roles.values())
            
            avg_cpr = round(sum(all_cprs) / len(all_cprs), 2) if all_cprs else 0
            
            cpr_scores[member_id] = {
                'average_cpr': avg_cpr,
                'cpr_by_difficulty': member_info.get('cpr_by_role', {})
            }
        
        # Update Members sheet using new method
        if cpr_scores:
            self.sheets.update_member_cpr_scores(cpr_scores)
            logger.info(f"✓ Updated CPR scores for {len(cpr_scores)} members in Google Sheets")


def main():
    """Main execution function"""
    logger.info("="*60)
    logger.info("Starting CPR Scraper")
    logger.info("="*60)

    # Sync members first and get member names
    sheets = GoogleSheetsManager()
    api_key = os.environ.get('TORN_API_KEY')
    if not api_key:
        raise ValueError("TORN_API_KEY environment variable not set")
    
    logger.info("Syncing faction members...")
    member_names = sheets.sync_faction_members(api_key)
    logger.info(f"Received {len(member_names)} member names from sync")
    
    try:
        # Initialize scraper
        scraper = CPRScraper()
        
        # Check if we should scrape a specific member
        member_filter = os.environ.get('MEMBER_FILTER', '').strip()
        
        if member_filter:
            logger.info(f"Scraping specific member: {member_filter}")
            
            if member_filter not in scraper.member_api_keys:
                logger.error(f"Member ID {member_filter} not found in API keys")
                logger.info(f"Available member IDs: {list(scraper.member_api_keys.keys())}")
                sys.exit(1)
            
            # Check if member is in faction
            if member_filter not in member_names:
                logger.error(f"Member {member_filter} not found in faction roster - cannot scrape")
                sys.exit(1)
            
            # Get member name from synced data
            member_name = member_names[member_filter]
            
            cpr_data = scraper._load_cpr_database()
            success, updates, error_msg = scraper.scrape_member(
                member_filter,
                scraper.member_api_keys[member_filter],
                member_name,
                cpr_data
            )
            
            if success:
                scraper._save_cpr_database(cpr_data)
                
                # Update Google Sheets with CPR data
                try:
                    scraper._update_sheets_with_cpr(cpr_data)
                except Exception as e:
                    logger.error(f"Failed to update Google Sheets: {e}")
                
                if error_msg:
                    logger.warning(f"Completed with warning: {error_msg}")
                else:
                    logger.info(f"Successfully scraped {member_name} ({member_filter}) - {updates} updates")
            else:
                logger.error(f"Failed to scrape member {member_filter}")
                sys.exit(1)
        else:
            # Scrape all members - pass member_names from sync
            stats = scraper.scrape_all_members(member_names)
            
            if stats.get('success'):

                scraper._save_cpr_database(stats)
                
                # Update Google Sheets with CPR data
                try:
                    scraper._update_sheets_with_cpr(stats)
                except Exception as e:
                    logger.error(f"Failed to update Google Sheets: {e}")
                
                if error_msg:
                    logger.warning(f"Completed with warning: {error_msg}")
                else:
                    # Log summary
                    logger.info("="*60)
                    logger.info("CPR Scrape Summary:")
                    logger.info(f"  Total members: {stats['total_members']}")
                    logger.info(f"  Successful: {stats['successful']}")
                    logger.info(f"  Failed: {stats['failed']}")
                    logger.info(f"  Skipped (not in faction): {stats['skipped_not_in_faction']}")
                    logger.info(f"  Skipped (invalid key): {stats['skipped_invalid_key']}")
                    logger.info(f"  Total updates: {stats['total_updates']}")
                    logger.info("="*60)

            else:
                logger.error("Scrape failed")
                sys.exit(1)
            
            # Don't fail if some members had invalid keys or weren't in faction
            if stats['failed'] > 0 and stats['successful'] == 0:
                logger.error("All member scrapes failed")
                sys.exit(1)
        
        logger.info("CPR scraper completed successfully")

        # Automatically assign tiers based on new CPR data
        logger.info("\nAuto-assigning tiers based on CPR data...")
        try:
            from scripts.assign_tiers import TierAssignment
            tier_system = TierAssignment()
            assignments = tier_system.generate_tier_assignments()
            tier_system.save_tier_assignments(assignments)
            tier_system.update_google_sheets(assignments)
            logger.info("✓ Tiers assigned successfully")
        except Exception as e:
            logger.error(f"Tier assignment failed: {e}")
            # Don't exit - CPR scrape was successful
        
        # Update GitHub Gist with CPR database
        logger.info("\nUpdating public GitHub Gist...")
        try:
            update_gist()
        except Exception as e:
            logger.error(f"Gist update failed: {e}")
            # Don't exit - CPR scrape was successful
        
    except Exception as e:
        logger.error(f"Fatal error in CPR scraper: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
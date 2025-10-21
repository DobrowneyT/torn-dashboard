# """
# CPR Data Scraper for Torn City OC System
# Scrapes CPR requirements from available crime slots for all members with API keys
# """

# import os
# import sys
# import json
# import logging
# import time
# from typing import Dict, List, Optional, Tuple
# from datetime import datetime
# from pathlib import Path

# # Add project root to path
# sys.path.insert(0, str(Path(__file__).parent.parent))

# from scripts.utils.json_storage import JSONStorageManager
# from scripts.utils.google_sheets import GoogleSheetsManager
# from scripts.utils.torn_api import TornAPI, TornAPIError
# from scripts.utils.gist_updater import update_gist

# # Set up logging
# logging.basicConfig(
#     level=logging.INFO,
#     format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
# )
# logger = logging.getLogger(__name__)


# class CPRScraper:
#     """Scrape CPR requirements from Torn API for faction members"""
    
#     def __init__(self):
#         """Initialize the CPR scraper"""
#         self.storage = JSONStorageManager(data_dir='data', auto_commit=True)
#         self.sheets = GoogleSheetsManager()
#         self.member_api_keys = self._load_api_keys()
        
#         logger.info("CPR Scraper initialized")
#         logger.info(f"Found API keys for {len(self.member_api_keys)} members")
    
#     def _load_api_keys(self) -> Dict[str, str]:
#         """
#         Load member API keys from environment variable
        
#         Expected format in GitHub Secret MEMBER_API_KEYS:
#         {
#             "member_id_1": "api_key_1",
#             "member_id_2": "api_key_2"
#         }
        
#         Returns:
#             Dictionary mapping member IDs to API keys
#         """
#         api_keys_json = os.environ.get('MEMBER_API_KEYS', '{}')
        
#         try:
#             api_keys = json.loads(api_keys_json)
#             logger.info(f"Loaded API keys for {len(api_keys)} members")
#             return api_keys
            
#         except json.JSONDecodeError as e:
#             logger.error(f"Failed to parse MEMBER_API_KEYS: {e}")
#             return {}
    
#     def _load_cpr_database(self) -> Dict:
#         """Load the CPR database from storage"""
#         cpr_data = self.storage.read_json('cpr_database.json')
        
#         if not cpr_data:
#             # Initialize if doesn't exist
#             cpr_data = {
#                 'members': {},
#                 'metadata': {
#                     'last_updated': datetime.now().isoformat(),
#                     'total_members': 0,
#                     'version': '1.0'
#                 }
#             }
#             self.storage.write_json('cpr_database.json', cpr_data, create_backup=False)
        
#         return cpr_data
    
#     def _save_cpr_database(self, cpr_data: Dict):
#         """Save the CPR database to storage"""
#         cpr_data['metadata']['last_updated'] = datetime.now().isoformat()
#         cpr_data['metadata']['total_members'] = len(cpr_data.get('members', {}))
        
#         self.storage.write_json(
#             'cpr_database.json',
#             cpr_data,
#             create_backup=True,
#             commit_message="Update CPR database from scrape"
#         )
#         logger.info("CPR database saved")
    
#     def _fetch_available_crimes(self, api_key: str, member_id: str) -> Optional[Dict]:
#         """
#         Fetch available crimes from Torn API with error handling
        
#         Args:
#             api_key: Member's API key
#             member_id: Member ID (for logging)
            
#         Returns:
#             Crimes data or None if failed
#         """
#         try:
#             api = TornAPI(api_key)
            
#             # Get available crimes sorted by creation date
#             result = api.get_faction_crimes(
#                 category="available",
#                 filters="created_at",
#                 offset=0,
#                 sort="DESC",
#                 comment="TNL Forge CPR Scraper"
#             )
            
#             crimes = result.get('crimes', [])
#             logger.info(f"Member {member_id}: Fetched {len(crimes)} available crimes")
#             return result
            
#         except TornAPIError as e:
#             logger.warning(f"Member {member_id}: API error - {e}")
#             logger.warning(f"Member {member_id}: Skipping CPR update (existing data unchanged)")
#             return None
#         except Exception as e:
#             logger.error(f"Member {member_id}: Unexpected error - {e}")
#             return None

#     def _extract_cpr_from_crimes(self, crimes_data: Dict, member_id: str) -> Dict[str, Dict[str, int]]:
#         """
#         Extract CPR requirements from empty slots in crimes
        
#         Args:
#             crimes_data: Raw crimes data from API
#             member_id: Member ID (for logging)
            
#         Returns:
#             Dictionary: {difficulty_level: {position: cpr_value}}
#         """
#         cpr_by_level = {}
        
#         if not crimes_data or 'crimes' not in crimes_data:
#             return cpr_by_level
        
#         for crime in crimes_data['crimes']:
#             difficulty = str(crime['difficulty'])
#             crime_name = crime.get('name', 'Unknown')
            
#             if difficulty not in cpr_by_level:
#                 cpr_by_level[difficulty] = {}
            
#             # Check all slots for empty positions
#             for slot in crime.get('slots', []):
#                 # Only process empty slots (user is null)
#                 if slot.get('user') is None:
#                     position = slot.get('position', 'Unknown')
#                     cpr = slot.get('checkpoint_pass_rate', 0)
                    
#                     # Take highest CPR seen for this position/level
#                     current_cpr = cpr_by_level[difficulty].get(position, 0)
#                     if cpr > current_cpr:
#                         cpr_by_level[difficulty][position] = cpr
#                         logger.info(f"Member {member_id}: {crime_name} Lvl {difficulty} - {position} = {cpr} CPR")
        
#         return cpr_by_level

#     def _update_member_cpr(self, cpr_data: Dict, member_id: str, member_name: str, new_cpr: Dict[str, Dict[str, int]]) -> int:
#         """
#         Update a member's CPR data (API data is always source of truth)
        
#         IMPORTANT: This always reconstructs the member dict to ensure consistent ordering:
#         1. name (always updated from sync)
#         2. cpr_by_role (merged - keeps old roles, updates/adds new ones, SORTED by difficulty)
#         3. last_scraped (always updated)
        
#         Args:
#             cpr_data: Full CPR database
#             member_id: Member ID (as string)
#             member_name: Member name (from faction sync)
#             new_cpr: New CPR data from API scrape
            
#         Returns:
#             Number of updates made
#         """
#         updates = 0
        
#         # Get existing member data or create empty structure
#         existing_member = cpr_data['members'].get(member_id, {})
#         existing_cpr = existing_member.get('cpr_by_role', {})
        
#         # Merge CPR data: keep all existing roles, update/add new ones
#         merged_cpr = {}
        
#         # First, copy all existing CPR data
#         for level, roles in existing_cpr.items():
#             merged_cpr[level] = roles.copy()
        
#         # Then update with new data
#         for level, roles in new_cpr.items():
#             if level not in merged_cpr:
#                 merged_cpr[level] = {}
            
#             for role, new_value in roles.items():
#                 old_value = merged_cpr[level].get(role, 0)
                
#                 if new_value != old_value:
#                     merged_cpr[level][role] = new_value
#                     updates += 1
                    
#                     if old_value == 0:
#                         logger.info(f"Member {member_name} ({member_id}): NEW - Lvl {level} {role} = {new_value}")
#                     else:
#                         direction = "↑" if new_value > old_value else "↓"
#                         logger.info(f"Member {member_name} ({member_id}): UPDATE - Lvl {level} {role} = {new_value} {direction} (was {old_value})")
        
#         # Sort the merged CPR by difficulty level (numerically)
#         sorted_cpr = {}
#         for level in sorted(merged_cpr.keys(), key=int):
#             sorted_cpr[level] = merged_cpr[level]
        
#         # Reconstruct member dict with consistent ordering (no redundant member_id field)
#         cpr_data['members'][member_id] = {
#             'name': member_name,  # Always use current name from faction sync
#             'cpr_by_role': sorted_cpr,  # Now sorted by difficulty
#             'last_scraped': datetime.now().isoformat()
#         }
        
#         return updates

#     def scrape_member(self, member_id: str, api_key: str, member_name: str, cpr_data: Dict) -> Tuple[bool, int, Optional[str]]:
#         """
#         Scrape CPR data for a single member
        
#         Args:
#             member_id: Member ID
#             api_key: Member's API key
#             member_name: Member name
#             cpr_data: CPR database to update
            
#         Returns:
#             Tuple of (success, updates_count, error_message)
#         """
#         logger.info(f"Starting scrape for {member_name} ({member_id})")
        
#         # Fetch available crimes
#         crimes_data = self._fetch_available_crimes(api_key, member_id)
        
#         if crimes_data is None:
#             error_msg = "Invalid API key or API error - data unchanged"
#             logger.warning(f"Member {member_name} ({member_id}): {error_msg}")
#             return True, 0, error_msg
        
#         # Extract CPR requirements
#         new_cpr = self._extract_cpr_from_crimes(crimes_data, member_id)
        
#         if not new_cpr:
#             logger.warning(f"Member {member_name} ({member_id}): No empty slots found in available crimes")
#             return True, 0, "No empty slots available"
        
#         # Update member's CPR data
#         updates = self._update_member_cpr(cpr_data, member_id, member_name, new_cpr)
        
#         logger.info(f"Member {member_name} ({member_id}): Scrape complete - {updates} updates made")
#         return True, updates, None

#     def scrape_all_members(self, member_names: Dict[str, str] = None) -> Dict[str, any]:
#         """
#         Scrape CPR data for all members with API keys
        
#         Args:
#             member_names: Dictionary mapping member_id -> member_name from faction sync
        
#         Returns:
#             Summary statistics
#         """
#         if not self.member_api_keys:
#             logger.error("No member API keys configured")
#             return {
#                 'success': False,
#                 'error': 'No member API keys configured'
#             }
        
#         logger.info(f"Starting CPR scrape for {len(self.member_api_keys)} members")
        
#         # Use provided member names or default to empty dict
#         if member_names is None:
#             logger.warning("No member names provided - using member IDs only")
#             member_names = {}
        
#         # Load CPR database
#         cpr_data = self._load_cpr_database()
        
#         # Stats tracking
#         stats = {
#             'total_members': len(self.member_api_keys),
#             'successful': 0,
#             'failed': 0,
#             'skipped_invalid_key': 0,
#             'skipped_not_in_faction': 0,
#             'total_updates': 0,
#             'members_scraped': [],
#             'members_with_errors': {},
#             'members_failed': [],
#             'members_not_in_faction': [],
#             'members_invalid_key': []  # Add this to track invalid keys separately
#         }
        
#         # Scrape each member
#         for i, (member_id, api_key) in enumerate(self.member_api_keys.items(), 1):
#             # Check if member is still in faction
#             if member_id not in member_names:
#                 logger.warning(f"Member {member_id}: Not found in faction roster - skipping")
#                 stats['skipped_not_in_faction'] += 1
#                 stats['members_not_in_faction'].append(member_id)
#                 continue
            
#             member_name = member_names[member_id]
#             logger.info(f"Processing {i}/{stats['total_members']}: {member_name} ({member_id})")
            
#             try:
#                 success, updates, error_msg = self.scrape_member(member_id, api_key, member_name, cpr_data)
                
#                 if success:
#                     stats['successful'] += 1
#                     stats['total_updates'] += updates
#                     stats['members_scraped'].append(member_id)
                    
#                     if error_msg:
#                         stats['members_with_errors'][member_id] = error_msg
#                         if 'Invalid API key' in error_msg:
#                             stats['skipped_invalid_key'] += 1
#                             stats['members_invalid_key'].append(member_id)
#                 else:
#                     stats['failed'] += 1
#                     stats['members_failed'].append(member_id)
                
#             except Exception as e:
#                 logger.error(f"Member {member_name} ({member_id}): Unexpected error - {e}")
#                 stats['failed'] += 1
#                 stats['members_failed'].append(member_id)
#                 stats['members_with_errors'][member_id] = str(e)
            
#             # Rate limiting
#             if i < stats['total_members']:
#                 time.sleep(0.01)
        
#         # Save the CPR database if any successful scrapes
#         if stats['successful'] > 0:
#             self._save_cpr_database(cpr_data)
            
#             # Update Google Sheets
#             try:
#                 self._update_sheets_with_cpr(cpr_data)
#             except Exception as e:
#                 logger.error(f"Failed to update Google Sheets: {e}")
        
#         # ✅ ENHANCED LOGGING SUMMARY
#         logger.info("="*70)
#         logger.info("CPR SCRAPE SUMMARY")
#         logger.info("="*70)
#         logger.info(f"  Total members with API keys: {stats['total_members']}")
#         logger.info(f"  ✓ Successfully scraped: {stats['successful']}")
#         logger.info(f"  ✗ Failed: {stats['failed']}")
#         logger.info(f"  ⊘ Skipped (not in faction): {stats['skipped_not_in_faction']}")
#         logger.info(f"  ⊘ Skipped (invalid key): {stats['skipped_invalid_key']}")
#         logger.info(f"  Total CPR updates: {stats['total_updates']}")
#         logger.info("")
        
#         # Members not in faction (have keys but left faction)
#         if stats['members_not_in_faction']:
#             logger.warning("⚠️  MEMBERS NOT IN FACTION (have API keys but not in roster):")
#             for member_id in stats['members_not_in_faction']:
#                 # Try to get name from cpr_data if they were previously scraped
#                 old_name = cpr_data.get('members', {}).get(member_id, {}).get('name', 'Unknown')
#                 logger.warning(f"    • {old_name} [{member_id}]")
#             logger.info("")
        
#         # Members with invalid API keys
#         if stats['members_invalid_key']:
#             logger.warning("🔑 MEMBERS WITH INVALID API KEYS:")
#             for member_id in stats['members_invalid_key']:
#                 member_name = member_names.get(member_id, 'Unknown')
#                 error = stats['members_with_errors'].get(member_id, 'Invalid API key')
#                 logger.warning(f"    • {member_name} [{member_id}] - {error}")
#             logger.info("")
        
#         # Members who failed for other reasons
#         if stats['members_failed']:
#             logger.error("❌ MEMBERS THAT FAILED TO SCRAPE:")
#             for member_id in stats['members_failed']:
#                 member_name = member_names.get(member_id, 'Unknown')
#                 error = stats['members_with_errors'].get(member_id, 'Unknown error')
#                 logger.error(f"    • {member_name} [{member_id}] - {error}")
#             logger.info("")
        
#         # Members in faction but missing API keys (reverse lookup)
#         members_without_keys = []
#         for member_id, member_name in member_names.items():
#             if member_id not in self.member_api_keys:
#                 members_without_keys.append((member_id, member_name))
        
#         if members_without_keys:
#             logger.warning("📝 MEMBERS IN FACTION WITHOUT API KEYS:")
#             logger.warning(f"    Total: {len(members_without_keys)} members")
#             # Sort by name for easier reading
#             for member_id, member_name in sorted(members_without_keys, key=lambda x: x[1]):
#                 logger.warning(f"    • {member_name} [{member_id}]")
#             logger.info("")
#             logger.warning("    💡 TIP: Request API keys from these members and add to MEMBER_API_KEYS secret")
#             logger.info("")
        
#         # Success summary
#         if stats['successful'] > 0:
#             logger.info(f"✓ Successfully updated CPR data for {stats['successful']} members")
#             if stats['total_updates'] > 0:
#                 logger.info(f"✓ Total CPR values updated/added: {stats['total_updates']}")
#             else:
#                 logger.info("  (No new CPR changes detected)")
        
#         logger.info("="*70)
        
#         # Set success flag
#         stats['success'] = stats['successful'] > 0
        
#         return stats
        
#         # Save updated CPR database
#     def _save_cpr_database(self, cpr_data: Dict):
#         """Save the CPR database to storage with sorted difficulty levels"""
#         cpr_data['metadata']['last_updated'] = datetime.now().isoformat()
#         cpr_data['metadata']['total_members'] = len(cpr_data.get('members', {}))
        
#         # Sort difficulty levels numerically for all members
#         for member_id in cpr_data.get('members', {}):
#             if 'cpr_by_role' in cpr_data['members'][member_id]:
#                 sorted_cpr = {}
#                 # Sort keys numerically (convert to int for sorting)
#                 for level in sorted(cpr_data['members'][member_id]['cpr_by_role'].keys(), key=int):
#                     sorted_cpr[level] = cpr_data['members'][member_id]['cpr_by_role'][level]
#                 cpr_data['members'][member_id]['cpr_by_role'] = sorted_cpr
        
#         self.storage.write_json(
#             'cpr_database.json',
#             cpr_data,
#             create_backup=True,
#             commit_message="Update CPR database from scrape"
#         )
#         logger.info("CPR database saved with sorted difficulty levels")

#     def _update_sheets_with_cpr(self, cpr_data: Dict):
#         """
#         Update Google Sheets with CPR scores in Members sheet column C
        
#         Args:
#             cpr_data: Full CPR database
#         """
#         logger.info("Updating Google Sheets with CPR scores...")
        
#         # Prepare CPR score data by member_id
#         cpr_scores = {}
        
#         for member_id, member_info in cpr_data.get('members', {}).items():
#             # Calculate average CPR across all roles/levels
#             all_cprs = []
#             for level, roles in member_info.get('cpr_by_role', {}).items():
#                 all_cprs.extend(roles.values())
            
#             avg_cpr = round(sum(all_cprs) / len(all_cprs), 2) if all_cprs else 0
            
#             cpr_scores[member_id] = {
#                 'average_cpr': avg_cpr,
#                 'cpr_by_difficulty': member_info.get('cpr_by_role', {})
#             }
        
#         # Update Members sheet using new method
#         if cpr_scores:
#             self.sheets.update_member_cpr_scores(cpr_scores)
#             logger.info(f"✓ Updated CPR scores for {len(cpr_scores)} members in Google Sheets")


# def main():
#     """Main execution function"""
#     logger.info("="*60)
#     logger.info("Starting CPR Scraper")
#     logger.info("="*60)

#     # Sync members first and get member names
#     sheets = GoogleSheetsManager()
#     api_key = os.environ.get('TORN_API_KEY')
#     if not api_key:
#         raise ValueError("TORN_API_KEY environment variable not set")
    
#     logger.info("Syncing faction members...")
#     member_names = sheets.sync_faction_members(api_key)
#     logger.info(f"Received {len(member_names)} member names from sync")
    
#     try:
#         # Initialize scraper
#         scraper = CPRScraper()
        
#         # Check if we should scrape a specific member
#         member_filter = os.environ.get('MEMBER_FILTER', '').strip()
        
#         if member_filter:
#             logger.info(f"Scraping specific member: {member_filter}")
            
#             if member_filter not in scraper.member_api_keys:
#                 logger.error(f"Member ID {member_filter} not found in API keys")
#                 logger.info(f"Available member IDs: {list(scraper.member_api_keys.keys())}")
#                 sys.exit(1)
            
#             # Check if member is in faction
#             if member_filter not in member_names:
#                 logger.error(f"Member {member_filter} not found in faction roster - cannot scrape")
#                 sys.exit(1)
            
#             # Get member name from synced data
#             member_name = member_names[member_filter]
            
#             cpr_data = scraper._load_cpr_database()
#             success, updates, error_msg = scraper.scrape_member(
#                 member_filter,
#                 scraper.member_api_keys[member_filter],
#                 member_name,
#                 cpr_data
#             )
            
#             if success:
#                 scraper._save_cpr_database(cpr_data)
                
#                 # Update Google Sheets with CPR data
#                 try:
#                     scraper._update_sheets_with_cpr(cpr_data)
#                 except Exception as e:
#                     logger.error(f"Failed to update Google Sheets: {e}")
                
#                 if error_msg:
#                     logger.warning(f"Completed with warning: {error_msg}")
#                 else:
#                     logger.info(f"Successfully scraped {member_name} ({member_filter}) - {updates} updates")
#             else:
#                 logger.error(f"Failed to scrape member {member_filter}")
#                 sys.exit(1)
#         else:
#             # Scrape all members - pass member_names from sync
#             stats = scraper.scrape_all_members(member_names)
            
#             if not stats.get('success'):
#                 logger.error("Scrape failed")
#                 sys.exit(1)
            
#             # Don't fail if some members had invalid keys or weren't in faction
#             if stats['failed'] > 0 and stats['successful'] == 0:
#                 logger.error("All member scrapes failed")
#                 sys.exit(1)
        
#         logger.info("CPR scraper completed successfully")

#         # Automatically assign tiers based on new CPR data
#         logger.info("\nAuto-assigning tiers based on CPR data...")
#         try:
#             from scripts.assign_tiers import TierAssignment
#             tier_system = TierAssignment()
#             assignments = tier_system.generate_tier_assignments()
#             tier_system.save_tier_assignments(assignments)
#             tier_system.update_google_sheets(assignments)
#             logger.info("✓ Tiers assigned successfully")
#         except Exception as e:
#             logger.error(f"Tier assignment failed: {e}")
#             # Don't exit - CPR scrape was successful
        
#         # Update GitHub Gist with CPR database
#         logger.info("\nUpdating public GitHub Gist...")
#         try:
#             update_gist()
#         except Exception as e:
#             logger.error(f"Gist update failed: {e}")
#             # Don't exit - CPR scrape was successful
        
#     except Exception as e:
#         logger.error(f"Fatal error in CPR scraper: {e}")
#         import traceback
#         traceback.print_exc()
#         sys.exit(1)


# if __name__ == "__main__":
#     main()



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
    
    def _create_member_skeleton(self, member_id: str, member_name: str) -> Dict:
        """
        Create a skeleton member structure with all difficulty levels
        
        Args:
            member_id: Member ID
            member_name: Member name
            
        Returns:
            Dictionary with skeleton structure for a member
        """
        return {
            'name': member_name,
            'cpr_by_role': {
                '1': {},
                '2': {},
                '3': {},
                '4': {},
                '5': {},
                '6': {},
                '7': {},
                '8': {},
                '9': {},
                '10': {}
            },
            'last_scraped': ''
        }
    
    def _build_skeleton_database(self, current_members: Dict[str, str]) -> Dict:
        """
        Build skeleton database for all current faction members
        
        Args:
            current_members: Dictionary mapping member_id -> member_name
            
        Returns:
            Skeleton database with all current members
        """
        skeleton_db = {
            'members': {},
            'metadata': {
                'last_updated': datetime.now().isoformat(),
                'total_members': len(current_members),
                'version': '1.0'
            }
        }
        
        for member_id, member_name in current_members.items():
            skeleton_db['members'][member_id] = self._create_member_skeleton(member_id, member_name)
        
        logger.info(f"Built skeleton database for {len(current_members)} current members")
        return skeleton_db
    
    def _merge_existing_data(self, skeleton_db: Dict, existing_db: Dict) -> Dict:
        """
        Merge existing CPR data into skeleton database
        
        Args:
            skeleton_db: Skeleton database with current members
            existing_db: Existing CPR database
            
        Returns:
            Merged database
        """
        existing_members = existing_db.get('members', {})
        
        # Track members for logging
        updated_count = 0
        new_count = 0
        historical_count = 0
        
        # Update skeleton members with existing data
        for member_id, skeleton_member in skeleton_db['members'].items():
            if member_id in existing_members:
                existing_member = existing_members[member_id]
                
                # Merge CPR data - preserve all existing data
                for level in ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']:
                    existing_roles = existing_member.get('cpr_by_role', {}).get(level, {})
                    if existing_roles:
                        skeleton_member['cpr_by_role'][level] = existing_roles.copy()
                
                # Update metadata
                skeleton_member['last_scraped'] = existing_member.get('last_scraped', '')
                
                updated_count += 1
            else:
                new_count += 1
        
        # Append historical data for members no longer in faction
        for member_id, existing_member in existing_members.items():
            if member_id not in skeleton_db['members']:
                skeleton_db['members'][member_id] = existing_member.copy()
                historical_count += 1
        
        logger.info(f"Data merge complete: {updated_count} existing, {new_count} new, {historical_count} historical members")
        return skeleton_db
    
    def _categorize_api_keys(self, current_members: Dict[str, str]) -> Tuple[Dict, List, List]:
        """
        Categorize API keys into valid, missing, and invalid categories
        
        Args:
            current_members: Dictionary of current faction members
            
        Returns:
            Tuple of (valid_keys, members_without_keys, keys_for_non_members)
        """
        valid_keys = {}
        members_without_keys = []
        keys_for_non_members = []
        
        # Filter keys to only current members
        for member_id, api_key in self.member_api_keys.items():
            if member_id in current_members:
                valid_keys[member_id] = api_key
            else:
                keys_for_non_members.append(member_id)
        
        # Find members without API keys
        for member_id in current_members:
            if member_id not in self.member_api_keys:
                members_without_keys.append(member_id)
        
        logger.info(f"API key categorization: {len(valid_keys)} valid, {len(members_without_keys)} missing, {len(keys_for_non_members)} non-members")
        return valid_keys, members_without_keys, keys_for_non_members
    
    def _fetch_available_crimes(self, api_key: str, member_id: str) -> Optional[Dict]:
        """
        Fetch available crimes from Torn API with error handling
        
        Args:
            api_key: Member's API key
            member_id: Member ID (for logging)
            
        Returns:
            Crimes data or None if failed (with error stored)
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
            # Return None but let caller handle error logging
            raise Exception(f"API error: {str(e)}")
        except Exception as e:
            raise Exception(f"Unexpected error: {str(e)}")

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
        Update a member's CPR data (API data updates existing data)
        
        Args:
            cpr_data: Full CPR database
            member_id: Member ID (as string)
            member_name: Member name (from faction sync)
            new_cpr: New CPR data from API scrape
            
        Returns:
            Number of updates made
        """
        updates = 0
        
        # Get existing member data
        if member_id not in cpr_data['members']:
            logger.warning(f"Member {member_id} not found in database during update")
            return 0
        
        member_data = cpr_data['members'][member_id]
        existing_cpr = member_data.get('cpr_by_role', {})
        
        # Update with new data
        for level, roles in new_cpr.items():
            if level not in existing_cpr:
                existing_cpr[level] = {}
            
            for role, new_value in roles.items():
                old_value = existing_cpr[level].get(role, 0)
                
                if new_value != old_value:
                    existing_cpr[level][role] = new_value
                    updates += 1
                    
                    if old_value == 0:
                        logger.info(f"Member {member_name} ({member_id}): NEW - Lvl {level} {role} = {new_value}")
                    else:
                        direction = "↑" if new_value > old_value else "↓"
                        logger.info(f"Member {member_name} ({member_id}): UPDATE - Lvl {level} {role} = {new_value} {direction} (was {old_value})")
        
        # Update metadata
        member_data['name'] = member_name  # Always use current name
        member_data['last_scraped'] = datetime.now().isoformat()
        
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
        
        try:
            # Fetch available crimes
            crimes_data = self._fetch_available_crimes(api_key, member_id)
            
            if crimes_data is None:
                return False, 0, "No crimes data returned"
            
            # Extract CPR requirements
            new_cpr = self._extract_cpr_from_crimes(crimes_data, member_id)
            
            if not new_cpr:
                logger.warning(f"Member {member_name} ({member_id}): No empty slots found in available crimes")
                return True, 0, "No empty slots available"
            
            # Update member's CPR data
            updates = self._update_member_cpr(cpr_data, member_id, member_name, new_cpr)
            
            logger.info(f"Member {member_name} ({member_id}): Scrape complete - {updates} updates made")
            return True, updates, None
            
        except Exception as e:
            error_msg = str(e)
            logger.warning(f"Member {member_name} ({member_id}): {error_msg}")
            return False, 0, error_msg

    def scrape_all_members(self, current_members: Dict[str, str]) -> Dict:
        """
        Scrape CPR data for all members with API keys
        
        Args:
            current_members: Dictionary mapping member_id -> member_name from faction sync
        
        Returns:
            Summary statistics
        """
        logger.info(f"Starting CPR scrape for {len(current_members)} current faction members")
        
        # Step 1: Build skeleton database for all current members
        skeleton_db = self._build_skeleton_database(current_members)
        
        # Step 2: Load existing CPR database
        existing_db = self.storage.read_json('cpr_database.json')
        if not existing_db:
            existing_db = {'members': {}, 'metadata': {}}
        
        # Step 3: Merge existing data into skeleton
        cpr_data = self._merge_existing_data(skeleton_db, existing_db)
        
        # Step 4: Categorize API keys
        valid_keys, members_without_keys, keys_for_non_members = self._categorize_api_keys(current_members)
        
        # Stats tracking
        stats = {
            'total_current_members': len(current_members),
            'members_with_keys': len(valid_keys),
            'members_without_keys': len(members_without_keys),
            'keys_for_non_members': len(keys_for_non_members),
            'successful_scrapes': 0,
            'failed_scrapes': 0,
            'total_updates': 0,
            'members_scraped': [],
            'members_with_errors': {},
            'members_without_keys_list': members_without_keys,
            'keys_for_non_members_list': keys_for_non_members
        }
        
        # Step 5: Scrape each member with valid API key
        for i, (member_id, api_key) in enumerate(valid_keys.items(), 1):
            member_name = current_members[member_id]
            logger.info(f"Processing {i}/{len(valid_keys)}: {member_name} ({member_id})")
            
            try:
                success, updates, error_msg = self.scrape_member(member_id, api_key, member_name, cpr_data)
                
                if success:
                    stats['successful_scrapes'] += 1
                    stats['total_updates'] += updates
                    stats['members_scraped'].append(member_id)
                    
                    if error_msg:
                        # Successful but with warnings (e.g., no empty slots)
                        stats['members_with_errors'][member_id] = {
                            'name': member_name,
                            'error': error_msg
                        }
                else:
                    stats['failed_scrapes'] += 1
                    stats['members_with_errors'][member_id] = {
                        'name': member_name,
                        'error': error_msg
                    }
                
            except Exception as e:
                logger.error(f"Member {member_name} ({member_id}): Unexpected error - {e}")
                stats['failed_scrapes'] += 1
                stats['members_with_errors'][member_id] = {
                    'name': member_name,
                    'error': str(e)
                }
            
            # Rate limiting
            if i < len(valid_keys):
                time.sleep(0.01)
        
        # Step 6: Save the merged CPR database
        self._save_cpr_database(cpr_data)
        
        # Step 7: Update Google Sheets with current members only
        try:
            self._update_sheets_with_cpr(cpr_data, current_members)
        except Exception as e:
            logger.error(f"Failed to update Google Sheets: {e}")
        
        # Print comprehensive summary
        self._print_summary(stats, current_members, cpr_data)
        
        stats['success'] = True
        return stats
    
    def _print_summary(self, stats: Dict, current_members: Dict[str, str], cpr_data: Dict):
        """Print comprehensive summary of scrape results"""
        logger.info("="*70)
        logger.info("CPR SCRAPE SUMMARY")
        logger.info("="*70)
        logger.info(f"  Total current faction members: {stats['total_current_members']}")
        logger.info(f"  ✓ Members with valid API keys: {stats['members_with_keys']}")
        logger.info(f"  ✓ Successfully scraped: {stats['successful_scrapes']}")
        logger.info(f"  ✗ Failed to scrape: {stats['failed_scrapes']}")
        logger.info(f"  Total CPR updates: {stats['total_updates']}")
        logger.info("")
        
        # Members without API keys
        if stats['members_without_keys_list']:
            logger.warning("📝 CURRENT MEMBERS WITHOUT API KEYS:")
            logger.warning(f"    Total: {len(stats['members_without_keys_list'])} members")
            for member_id in sorted(stats['members_without_keys_list'], 
                                   key=lambda x: current_members.get(x, '')):
                member_name = current_members.get(member_id, 'Unknown')
                logger.warning(f"    • {member_name} [{member_id}]")
            logger.info("")
            logger.warning("    💡 TIP: Request API keys from these members and add to MEMBER_API_KEYS secret")
            logger.info("")
        
        # API keys for non-members
        if stats['keys_for_non_members_list']:
            logger.warning("⚠️  API KEYS FOR NON-MEMBERS (have keys but not in faction):")
            for member_id in stats['keys_for_non_members_list']:
                # Try to get name from cpr_data if they were previously scraped
                old_name = cpr_data.get('members', {}).get(member_id, {}).get('name', 'Unknown')
                logger.warning(f"    • {old_name} [{member_id}]")
            logger.info("")
        
        # Members with errors during scrape
        if stats['members_with_errors']:
            logger.warning("⚠️  MEMBERS WITH ERRORS DURING SCRAPE:")
            for member_id, error_info in stats['members_with_errors'].items():
                member_name = error_info['name']
                error = error_info['error']
                logger.warning(f"    • {member_name} [{member_id}] - {error}")
            logger.info("")
        
        # Success summary
        if stats['successful_scrapes'] > 0:
            logger.info(f"✓ Successfully updated CPR data for {stats['successful_scrapes']} members")
            if stats['total_updates'] > 0:
                logger.info(f"✓ Total CPR values updated/added: {stats['total_updates']}")
            else:
                logger.info("  (No new CPR changes detected)")
        
        logger.info("="*70)
    
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

    def _update_sheets_with_cpr(self, cpr_data: Dict, current_members: Dict[str, str]):
        """
        Update Google Sheets with CPR scores for CURRENT MEMBERS ONLY
        
        Args:
            cpr_data: Full CPR database (includes historical data)
            current_members: Dictionary of current faction members only
        """
        logger.info("Updating Google Sheets with CPR scores for current members...")
        
        # Prepare CPR score data ONLY for current members
        cpr_scores = {}
        
        for member_id in current_members:
            if member_id not in cpr_data.get('members', {}):
                continue
                
            member_info = cpr_data['members'][member_id]
            
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
            logger.info(f"✓ Updated CPR scores for {len(cpr_scores)} current members in Google Sheets")


def main():
    """Main execution function"""
    logger.info("="*60)
    logger.info("Starting CPR Scraper")
    logger.info("="*60)

    # Step 1: Sync faction members to get current roster
    sheets = GoogleSheetsManager()
    api_key = os.environ.get('TORN_API_KEY')
    if not api_key:
        raise ValueError("TORN_API_KEY environment variable not set")
    
    logger.info("Syncing faction members...")
    current_members = sheets.sync_faction_members(api_key)
    logger.info(f"Received {len(current_members)} current faction members")
    
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
            if member_filter not in current_members:
                logger.error(f"Member {member_filter} not found in faction roster - cannot scrape")
                sys.exit(1)
            
            # Build skeleton for single member
            single_member_dict = {member_filter: current_members[member_filter]}
            skeleton_db = scraper._build_skeleton_database(single_member_dict)
            
            # Merge with existing data
            existing_db = scraper.storage.read_json('cpr_database.json')
            if not existing_db:
                existing_db = {'members': {}, 'metadata': {}}
            
            cpr_data = scraper._merge_existing_data(skeleton_db, existing_db)
            
            # Scrape the member
            member_name = current_members[member_filter]
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
                    scraper._update_sheets_with_cpr(cpr_data, single_member_dict)
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
            # Scrape all members
            stats = scraper.scrape_all_members(current_members)
            
            if not stats.get('success'):
                logger.error("Scrape failed")
                sys.exit(1)
        
        logger.info("CPR scraper completed successfully")

        # Automatically assign tiers based on new CPR data (CURRENT MEMBERS ONLY)
        logger.info("\nAuto-assigning tiers based on CPR data...")
        try:
            from scripts.assign_tiers import TierAssignment
            tier_system = TierAssignment()
            
            # Generate assignments for all members in CPR database
            all_assignments = tier_system.generate_tier_assignments()
            
            # Filter to only current members for tier assignment
            current_assignments = {}
            for member_id, assignment_data in all_assignments.items():
                if member_id in current_members:
                    current_assignments[member_id] = assignment_data
                else:
                    # Keep historical assignments in storage but don't update sheets
                    logger.debug(f"Skipping tier for non-current member: {member_id}")
            
            # Save all assignments (including historical)
            tier_system.save_tier_assignments(all_assignments)
            
            # Update sheets with ONLY current members
            tier_system.update_google_sheets(current_assignments)
            
            logger.info(f"✓ Tiers assigned for {len(current_assignments)} current members")
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
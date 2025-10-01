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
            "member_name_1": "api_key_1",
            "member_name_2": "api_key_2"
        }
        
        Returns:
            Dictionary mapping member names to API keys
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
    
    def _fetch_available_crimes(self, api_key: str, member_name: str) -> Optional[Dict]:
        """
        Fetch available crimes from Torn API with error handling for invalid keys
        
        Args:
            api_key: Member's API key
            member_name: Member name (for logging)
            
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
            logger.info(f"{member_name}: Fetched {len(crimes)} available crimes")
            return result
            
        except TornAPIError as e:
            # Log error but don't raise - continue with other members
            logger.warning(f"{member_name}: API key invalid or API error - {e}")
            logger.warning(f"{member_name}: Skipping CPR update (existing data unchanged)")
            return None
        except Exception as e:
            logger.error(f"{member_name}: Unexpected error fetching crimes - {e}")
            return None
    
    def _extract_cpr_from_crimes(self, crimes_data: Dict, member_name: str) -> Dict[str, Dict[str, int]]:
        """
        Extract CPR requirements from empty slots in crimes
        
        Args:
            crimes_data: Raw crimes data from API
            member_name: Member name (for logging)
            
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
                        logger.info(f"{member_name}: {crime_name} Lvl {difficulty} - {position} = {cpr} CPR")
        
        return cpr_by_level
    
    def _update_member_cpr(self, cpr_data: Dict, member_name: str, new_cpr: Dict[str, Dict[str, int]]) -> int:
        """
        Update a member's CPR data (API data is always source of truth)
        
        Args:
            cpr_data: Full CPR database
            member_name: Member name
            new_cpr: New CPR data from API
            
        Returns:
            Number of updates made
        """
        # Initialize member if doesn't exist
        if member_name not in cpr_data['members']:
            cpr_data['members'][member_name] = {
                'name': member_name,
                'cpr_by_role': {},
                'last_scraped': None
            }
        
        member = cpr_data['members'][member_name]
        
        if 'cpr_by_role' not in member:
            member['cpr_by_role'] = {}
        
        updates = 0
        
        # Update with new data (API is always source of truth)
        for level, roles in new_cpr.items():
            if level not in member['cpr_by_role']:
                member['cpr_by_role'][level] = {}
            
            for role, new_value in roles.items():
                old_value = member['cpr_by_role'][level].get(role, 0)
                
                # Always update with API value
                if new_value != old_value:
                    member['cpr_by_role'][level][role] = new_value
                    updates += 1
                    
                    if old_value == 0:
                        logger.info(f"{member_name}: NEW - Lvl {level} {role} = {new_value}")
                    else:
                        direction = "↑" if new_value > old_value else "↓"
                        logger.info(f"{member_name}: UPDATE - Lvl {level} {role} = {new_value} {direction} (was {old_value})")
        
        # Update last scraped timestamp
        member['last_scraped'] = datetime.now().isoformat()
        
        return updates
    
    def scrape_member(self, member_name: str, api_key: str, cpr_data: Dict) -> Tuple[bool, int, Optional[str]]:
        """
        Scrape CPR data for a single member
        
        Args:
            member_name: Member name
            api_key: Member's API key
            cpr_data: CPR database to update
            
        Returns:
            Tuple of (success, updates_count, error_message)
        """
        logger.info(f"Starting scrape for {member_name}")
        
        # Fetch available crimes
        crimes_data = self._fetch_available_crimes(api_key, member_name)
        
        if crimes_data is None:
            # API key invalid or error - return error but mark as "handled"
            error_msg = "Invalid API key or API error - data unchanged"
            logger.warning(f"{member_name}: {error_msg}")
            return True, 0, error_msg  # True = handled gracefully, not a fatal error
        
        # Extract CPR requirements
        new_cpr = self._extract_cpr_from_crimes(crimes_data, member_name)
        
        if not new_cpr:
            logger.warning(f"{member_name}: No empty slots found in available crimes")
            return True, 0, "No empty slots available"
        
        # Update member's CPR data
        updates = self._update_member_cpr(cpr_data, member_name, new_cpr)
        
        logger.info(f"{member_name}: Scrape complete - {updates} updates made")
        return True, updates, None
    
    def scrape_all_members(self) -> Dict[str, any]:
        """
        Scrape CPR data for all members with API keys
        
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
        
        # Load CPR database
        cpr_data = self._load_cpr_database()
        
        # Stats tracking
        stats = {
            'total_members': len(self.member_api_keys),
            'successful': 0,
            'failed': 0,
            'skipped_invalid_key': 0,
            'total_updates': 0,
            'members_scraped': [],
            'members_with_errors': {},
            'members_failed': []
        }
        
        # Scrape each member
        for i, (member_name, api_key) in enumerate(self.member_api_keys.items(), 1):
            logger.info(f"Processing {i}/{stats['total_members']}: {member_name}")
            
            try:
                success, updates, error_msg = self.scrape_member(member_name, api_key, cpr_data)
                
                if success:
                    stats['successful'] += 1
                    stats['total_updates'] += updates
                    stats['members_scraped'].append(member_name)
                    
                    if error_msg:
                        # Handled error (e.g., invalid API key)
                        stats['members_with_errors'][member_name] = error_msg
                        if 'Invalid API key' in error_msg:
                            stats['skipped_invalid_key'] += 1
                else:
                    stats['failed'] += 1
                    stats['members_failed'].append(member_name)
                
            except Exception as e:
                logger.error(f"{member_name}: Unexpected error - {e}")
                stats['failed'] += 1
                stats['members_failed'].append(member_name)
                stats['members_with_errors'][member_name] = str(e)
            
            # Rate limiting - wait between requests
            if i < stats['total_members']:
                time.sleep(1.5)
        
        # Save updated CPR database
        self._save_cpr_database(cpr_data)
        
        # Update Google Sheets with new CPR data
        try:
            self._update_sheets_with_cpr(cpr_data)
        except Exception as e:
            logger.error(f"Failed to update Google Sheets: {e}")
        
        # Log summary
        logger.info("="*60)
        logger.info("CPR Scrape Summary:")
        logger.info(f"  Total members: {stats['total_members']}")
        logger.info(f"  Successful: {stats['successful']}")
        logger.info(f"  Failed: {stats['failed']}")
        logger.info(f"  Skipped (invalid key): {stats['skipped_invalid_key']}")
        logger.info(f"  Total updates: {stats['total_updates']}")
        
        if stats['members_with_errors']:
            logger.info("  Members with issues:")
            for member, error in stats['members_with_errors'].items():
                logger.info(f"    - {member}: {error}")
        
        logger.info("="*60)
        
        stats['success'] = True
        return stats
    
    def _update_sheets_with_cpr(self, cpr_data: Dict):
        """
        Update Google Sheets with current CPR data
        
        Args:
            cpr_data: Full CPR database
        """
        logger.info("Updating Google Sheets with CPR data")
        
        # Prepare member data for sheets
        members_list = []
        for member_name, member_info in cpr_data.get('members', {}).items():
            # Calculate average CPR across all roles/levels as a simple metric
            all_cprs = []
            for level, roles in member_info.get('cpr_by_role', {}).items():
                all_cprs.extend(roles.values())
            
            avg_cpr = round(sum(all_cprs) / len(all_cprs), 1) if all_cprs else 0
            
            # Determine tier based on CPR (adjust thresholds as needed)
            if avg_cpr >= 20:
                tier = "Tier 3"
            elif avg_cpr >= 10:
                tier = "Tier 2"
            else:
                tier = "Tier 1"
            
            members_list.append({
                'member_id': member_info.get('torn_id', ''),
                'name': member_name,
                'tier': tier,
                'cpr': avg_cpr,
                'status': 'Active'
            })
        
        # Update Members sheet
        if members_list:
            self.sheets.update_members(members_list)
            logger.info(f"Updated {len(members_list)} members in Google Sheets")


def main():
    """Main execution function"""
    logger.info("="*60)
    logger.info("Starting CPR Scraper")
    logger.info("="*60)

    # Sync members first
    sheets = GoogleSheetsManager()
    api_key = os.environ.get('TORN_API_KEY')
    
    logger.info("Syncing faction members...")
    sheets.sync_faction_members(api_key)
    
    try:
        # Initialize scraper
        scraper = CPRScraper()
        
        # Check if we should scrape a specific member
        member_filter = os.environ.get('MEMBER_FILTER', '').strip()
        
        if member_filter:
            logger.info(f"Scraping specific member: {member_filter}")
            
            if member_filter not in scraper.member_api_keys:
                logger.error(f"Member {member_filter} not found in API keys")
                sys.exit(1)
            
            cpr_data = scraper._load_cpr_database()
            success, updates, error_msg = scraper.scrape_member(
                member_filter,
                scraper.member_api_keys[member_filter],
                cpr_data
            )
            
            if success:
                scraper._save_cpr_database(cpr_data)
                if error_msg:
                    logger.warning(f"Completed with warning: {error_msg}")
                else:
                    logger.info(f"Successfully scraped {member_filter} - {updates} updates")
            else:
                logger.error(f"Failed to scrape {member_filter}")
                sys.exit(1)
        else:
            # Scrape all members
            stats = scraper.scrape_all_members()
            
            if not stats.get('success'):
                logger.error("Scrape failed")
                sys.exit(1)
            
            # Note: We don't fail if some members had invalid keys
            # as long as we successfully processed others
            if stats['failed'] > 0 and stats['successful'] == 0:
                logger.error("All member scrapes failed")
                sys.exit(1)
        
        logger.info("CPR scraper completed successfully")
        
    except Exception as e:
        logger.error(f"Fatal error in CPR scraper: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
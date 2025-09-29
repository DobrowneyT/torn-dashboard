"""
Daily Crime Data Update Script
Fetches all faction crimes and updates the database with status changes
"""

import os
import sys
import logging
from typing import Dict, List, Optional, Set
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


class CrimeDataUpdater:
    """Update crime database with latest data from Torn API"""
    
    def __init__(self):
        """Initialize the crime updater"""
        self.storage = JSONStorageManager(data_dir='data', auto_commit=True)
        self.sheets = GoogleSheetsManager()
        
        # Get API key
        self.api_key = os.environ.get('TORN_API_KEY')
        if not self.api_key:
            raise ValueError("TORN_API_KEY environment variable not set")
        
        self.api = TornAPI(self.api_key)
        
        logger.info("Crime Data Updater initialized")
    
    def _load_crimes_database(self) -> Dict:
        """Load the crimes database from storage"""
        crimes_data = self.storage.read_json('crimes_database.json')
        
        if not crimes_data:
            # Initialize if doesn't exist
            crimes_data = {
                'crimes': {},  # Keyed by crime ID for fast lookups
                'metadata': {
                    'last_updated': datetime.now().isoformat(),
                    'total_crimes': 0,
                    'last_processed_id': None,
                    'version': '1.0'
                }
            }
            self.storage.write_json('crimes_database.json', crimes_data, create_backup=False)
        
        return crimes_data
    
    def _save_crimes_database(self, crimes_data: Dict):
        """Save the crimes database to storage"""
        crimes_data['metadata']['last_updated'] = datetime.now().isoformat()
        crimes_data['metadata']['total_crimes'] = len(crimes_data.get('crimes', {}))
        
        self.storage.write_json(
            'crimes_database.json',
            crimes_data,
            create_backup=True,
            commit_message="Update crimes database from daily scrape"
        )
        logger.info("Crimes database saved")
    
    def _fetch_all_crimes(self) -> List[Dict]:
        """
        Fetch all faction crimes from API
        
        Returns:
            List of all crimes
        """
        logger.info("Fetching all faction crimes...")
        
        try:
            # Get all crimes (all categories to capture everything)
            all_crimes = []
            
            # Categories to fetch
            categories = ['available', 'planning', 'executing', 'completed', 'failed']
            
            for category in categories:
                logger.info(f"Fetching {category} crimes...")
                
                result = self.api.get_faction_crimes(
                    category=category,
                    filters="created_at",
                    sort="DESC"
                )
                
                crimes = result.get('crimes', [])
                all_crimes.extend(crimes)
                logger.info(f"  Found {len(crimes)} {category} crimes")
            
            # Remove duplicates by crime ID
            unique_crimes = {crime['id']: crime for crime in all_crimes}
            logger.info(f"Total unique crimes fetched: {len(unique_crimes)}")
            
            return list(unique_crimes.values())
            
        except TornAPIError as e:
            logger.error(f"API error fetching crimes: {e}")
            raise
        except Exception as e:
            logger.error(f"Unexpected error fetching crimes: {e}")
            raise
    
    def _normalize_crime_data(self, crime: Dict) -> Dict:
        """
        Normalize crime data for storage
        
        Args:
            crime: Raw crime data from API
            
        Returns:
            Normalized crime data
        """
        # Extract participant IDs and their positions
        participants = []
        for slot in crime.get('slots', []):
            if slot.get('user'):
                participants.append({
                    'user_id': slot['user']['id'],
                    'position': slot['position'],
                    'position_id': slot['position_id'],
                    'joined_at': slot['user'].get('joined_at'),
                    'progress': slot['user'].get('progress', 0),
                    'outcome': slot['user'].get('outcome'),
                    'item_outcome': slot['user'].get('item_outcome')
                })
        
        # Calculate slot statistics
        total_slots = len(crime.get('slots', []))
        filled_slots = sum(1 for slot in crime.get('slots', []) if slot.get('user'))
        
        # Normalize the crime data
        normalized = {
            'id': crime['id'],
            'name': crime.get('name', 'Unknown'),
            'difficulty': crime.get('difficulty', 0),
            'status': crime.get('status', 'Unknown'),
            'previous_crime_id': crime.get('previous_crime_id'),
            
            # Timestamps
            'created_at': crime.get('created_at'),
            'planning_at': crime.get('planning_at'),
            'executed_at': crime.get('executed_at'),
            'ready_at': crime.get('ready_at'),
            'expired_at': crime.get('expired_at'),
            
            # Slot information
            'total_slots': total_slots,
            'filled_slots': filled_slots,
            'slots': crime.get('slots', []),
            
            # Participants summary
            'participants': participants,
            'participant_ids': [p['user_id'] for p in participants],
            
            # Rewards (if completed)
            'rewards': crime.get('rewards'),
            
            # Metadata
            'last_updated': datetime.now().isoformat(),
            'first_seen': None  # Will be set on first insert
        }
        
        return normalized
    
    def _update_crime(self, crimes_db: Dict, crime: Dict) -> tuple[bool, str]:
        """
        Update or insert a crime in the database
        
        Args:
            crimes_db: Crimes database
            crime: Normalized crime data
            
        Returns:
            Tuple of (is_new, action_description)
        """
        crime_id = str(crime['id'])
        
        if crime_id in crimes_db['crimes']:
            # Existing crime - check for changes
            existing = crimes_db['crimes'][crime_id]
            
            changes = []
            
            # Check status change
            if existing['status'] != crime['status']:
                changes.append(f"status: {existing['status']} → {crime['status']}")
                existing['status'] = crime['status']
            
            # Check slot fills
            if existing['filled_slots'] != crime['filled_slots']:
                changes.append(f"slots: {existing['filled_slots']}/{existing['total_slots']} → {crime['filled_slots']}/{crime['total_slots']}")
                existing['filled_slots'] = crime['filled_slots']
            
            # Check for new participants
            existing_ids = set(existing.get('participant_ids', []))
            new_ids = set(crime['participant_ids'])
            newly_joined = new_ids - existing_ids
            
            if newly_joined:
                changes.append(f"new participants: {', '.join(map(str, newly_joined))}")
            
            # Update timestamps if they changed
            if crime['executed_at'] and not existing['executed_at']:
                changes.append(f"executed at {crime['executed_at']}")
                existing['executed_at'] = crime['executed_at']
            
            # Always update full data
            existing.update({
                'slots': crime['slots'],
                'participants': crime['participants'],
                'participant_ids': crime['participant_ids'],
                'planning_at': crime['planning_at'],
                'ready_at': crime['ready_at'],
                'rewards': crime['rewards'],
                'last_updated': crime['last_updated']
            })
            
            if changes:
                action = f"Updated: {', '.join(changes)}"
                return False, action
            else:
                return False, "No changes"
        else:
            # New crime
            crime['first_seen'] = datetime.now().isoformat()
            crimes_db['crimes'][crime_id] = crime
            return True, "New crime added"
    
    def update_all_crimes(self) -> Dict:
        """
        Main update function - fetch and update all crimes
        
        Returns:
            Statistics about the update
        """
        logger.info("="*60)
        logger.info("Starting Daily Crime Update")
        logger.info("="*60)
        
        # Load existing database
        crimes_db = self._load_crimes_database()
        
        # Fetch all current crimes
        api_crimes = self._fetch_all_crimes()
        
        if not api_crimes:
            logger.warning("No crimes fetched from API")
            return {
                'success': False,
                'error': 'No crimes fetched'
            }
        
        # Statistics
        stats = {
            'total_fetched': len(api_crimes),
            'new_crimes': 0,
            'updated_crimes': 0,
            'unchanged_crimes': 0,
            'status_changes': {},
            'new_participants': 0
        }
        
        # Process each crime
        for crime in api_crimes:
            normalized = self._normalize_crime_data(crime)
            is_new, action = self._update_crime(crimes_db, normalized)
            
            if is_new:
                stats['new_crimes'] += 1
                logger.info(f"Crime {normalized['id']}: {action} - {normalized['name']} (Lvl {normalized['difficulty']})")
            elif "Updated" in action:
                stats['updated_crimes'] += 1
                logger.info(f"Crime {normalized['id']}: {action}")
            else:
                stats['unchanged_crimes'] += 1
            
            # Track status distribution
            status = normalized['status']
            stats['status_changes'][status] = stats['status_changes'].get(status, 0) + 1
        
        # Save updated database
        self._save_crimes_database(crimes_db)
        
        # Update Google Sheets
        try:
            self._update_sheets_with_crimes(crimes_db, stats)
        except Exception as e:
            logger.error(f"Failed to update Google Sheets: {e}")
        
        # Log summary
        logger.info("="*60)
        logger.info("Daily Crime Update Summary:")
        logger.info(f"  Total crimes in database: {len(crimes_db['crimes'])}")
        logger.info(f"  New crimes: {stats['new_crimes']}")
        logger.info(f"  Updated crimes: {stats['updated_crimes']}")
        logger.info(f"  Unchanged crimes: {stats['unchanged_crimes']}")
        logger.info(f"  Status distribution:")
        for status, count in stats['status_changes'].items():
            logger.info(f"    {status}: {count}")
        logger.info("="*60)
        
        stats['success'] = True
        stats['total_crimes'] = len(crimes_db['crimes'])
        
        return stats
    
    def _update_sheets_with_crimes(self, crimes_db: Dict, stats: Dict):
        """
        Update Google Sheets with crime data
        
        Args:
            crimes_db: Full crimes database
            stats: Update statistics
        """
        logger.info("Updating Google Sheets with crime data")
        
        # Update dashboard with summary stats
        dashboard_stats = {
            'total_crimes': len(crimes_db['crimes']),
            'pending_crimes': sum(1 for c in crimes_db['crimes'].values() 
                                 if c['status'] in ['Recruiting', 'available']),
            'completed_this_week': self._count_recent_completions(crimes_db),
            'active_members': len(self._get_active_member_ids(crimes_db))
        }
        
        self.sheets.update_dashboard_stats(dashboard_stats)
        
        # Update pending crimes list
        pending_crimes = [
            c for c in crimes_db['crimes'].values() 
            if c['status'] in ['Recruiting', 'available', 'Planning']
        ]
        # Sort by creation date (most recent first)
        pending_crimes.sort(key=lambda x: x.get('created_at', 0), reverse=True)
        
        self.sheets.update_dashboard_pending_crimes(pending_crimes[:50])
        
        # Write full crime log to Crime_Log sheet
        self._write_crime_log_sheet(crimes_db)
        
        logger.info("Google Sheets updated successfully")
    
    def _count_recent_completions(self, crimes_db: Dict, days: int = 7) -> int:
        """Count crimes completed in the last N days"""
        from datetime import datetime, timedelta
        
        cutoff = datetime.now().timestamp() - (days * 24 * 60 * 60)
        
        count = 0
        for crime in crimes_db['crimes'].values():
            if crime.get('executed_at') and crime['executed_at'] > cutoff:
                if crime['status'] in ['Successful', 'Failed']:
                    count += 1
        
        return count
    
    def _get_active_member_ids(self, crimes_db: Dict) -> Set[int]:
        """Get set of unique member IDs from all crimes"""
        member_ids = set()
        
        for crime in crimes_db['crimes'].values():
            member_ids.update(crime.get('participant_ids', []))
        
        return member_ids
    
    def _write_crime_log_sheet(self, crimes_db: Dict):
        """Write comprehensive crime log to Google Sheets"""
        logger.info("Writing crime log to Google Sheets")
        
        # Sort crimes by creation date (newest first)
        all_crimes = sorted(
            crimes_db['crimes'].values(),
            key=lambda x: x.get('created_at', 0),
            reverse=True
        )
        
        # Prepare data for sheets
        crime_rows = []
        for crime in all_crimes:
            # Format timestamps
            created = datetime.fromtimestamp(crime['created_at']).strftime('%Y-%m-%d %H:%M') if crime['created_at'] else ''
            executed = datetime.fromtimestamp(crime['executed_at']).strftime('%Y-%m-%d %H:%M') if crime.get('executed_at') else ''
            
            # Get participant names/IDs
            participants_str = ', '.join(str(p['user_id']) for p in crime.get('participants', []))
            
            crime_rows.append([
                crime['id'],
                crime['name'],
                crime['difficulty'],
                crime['status'],
                f"{crime['filled_slots']}/{crime['total_slots']}",
                created,
                executed,
                participants_str[:100]  # Truncate if too long
            ])
        
        # Write to Crime_Log sheet
        self.sheets.write_crime_log(crime_rows)
        
        logger.info(f"Wrote {len(crime_rows)} crimes to Crime_Log sheet")


def main():
    """Main execution function"""
    try:
        updater = CrimeDataUpdater()
        stats = updater.update_all_crimes()
        
        if not stats.get('success'):
            logger.error("Crime update failed")
            sys.exit(1)
        
        logger.info("Daily crime update completed successfully")
        
    except Exception as e:
        logger.error(f"Fatal error in crime updater: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
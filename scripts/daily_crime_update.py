"""
Daily Crime Data Update Script
Fetches all faction crimes and updates the database with status changes
Uses batch updates for efficient Google Sheets writing
"""

import os
import sys
import logging
from typing import Dict, List, Optional, Set
from datetime import datetime
from pathlib import Path
import pandas as pd

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
    
    FIRST_CRIME_ID = 778107  # Your faction's first crime ID for reference
    
    def __init__(self):
        """Initialize the crime updater"""
        testing_mode = os.environ.get('TESTING_MODE') == 'true'
        self.storage = JSONStorageManager(data_dir='data', auto_commit=not testing_mode)
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
                'crimes': {},  # Dictionary keyed by crime ID
                'metadata': {
                    'last_updated': datetime.now().isoformat(),
                    'total_crimes': 0,
                    'last_processed_id': None,
                    'oldest_incomplete_timestamp': None,
                    'version': '1.0'
                }
            }
            self.storage.write_json('crimes_database.json', crimes_data, create_backup=False)
        else:
            # Fix if crimes is a list instead of dict (migration)
            if isinstance(crimes_data.get('crimes'), list):
                logger.warning("Converting crimes list to dictionary format")
                old_crimes = crimes_data['crimes']
                crimes_data['crimes'] = {str(c['id']): c for c in old_crimes if 'id' in c}
                self.storage.write_json('crimes_database.json', crimes_data, create_backup=True)
        
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
    
    def _get_fetch_start_timestamp(self, crimes_db: Dict) -> Optional[int]:
        """
        Determine the timestamp to start fetching from
        
        For first run: None (fetch from beginning)
        For subsequent runs: timestamp of oldest incomplete crime (or one before it)
        
        Returns:
            Timestamp to start from, or None to start from beginning
        """
        if not crimes_db['crimes']:
            # Empty database - fetch everything from the beginning
            logger.info("Empty database detected - will fetch all historical crimes")
            return None
        
        # Find the oldest crime that isn't completed yet
        # This includes crimes in "Recruiting", "Planning", or any other incomplete state
        incomplete_crimes = []
        
        for crime in crimes_db['crimes'].values():
            # A crime is incomplete if it hasn't executed yet
            if not crime.get('executed_at'):
                incomplete_crimes.append(crime)
        
        if incomplete_crimes:
            # Sort by created_at to find the oldest
            incomplete_crimes.sort(key=lambda c: c.get('created_at', 0))
            oldest = incomplete_crimes[0]
            
            logger.info(f"Found {len(incomplete_crimes)} incomplete crimes")
            logger.info(f"Oldest incomplete: Crime {oldest['id']} created at {oldest['created_at']}")
            
            # Use this timestamp to start fetching
            # This ensures we update all crimes from this point forward
            return oldest['created_at']
        else:
            # All crimes are complete - use the newest crime's timestamp
            # to check for any new crimes spawned since last update
            all_crimes = list(crimes_db['crimes'].values())
            if all_crimes:
                all_crimes.sort(key=lambda c: c.get('created_at', 0), reverse=True)
                newest = all_crimes[0]
                logger.info(f"All crimes complete - checking for new crimes after {newest['id']}")
                return newest['created_at']
            else:
                return None
    
    def _fetch_crimes_paginated(self, from_timestamp: Optional[int] = None) -> List[Dict]:
        """
        Fetch all crimes with pagination, starting from a given timestamp
        
        Pagination logic:
        1. Fetch crimes starting from 'from_timestamp' (or 0 if None)
        2. If we get exactly 100 crimes, make another call using the last crime's timestamp
        3. Continue until we get < 100 crimes (that's the definitive end signal)
        
        Args:
            from_timestamp: Starting timestamp (None = from beginning)
            
        Returns:
            List of all fetched crimes
        """
        all_crimes = []
        current_from = from_timestamp if from_timestamp is not None else 0
        page = 1
        last_page_crime_ids = set()
        
        while True:
            logger.info(f"Fetching page {page} (from_timestamp: {current_from if current_from > 0 else 'beginning'})...")
            
            try:
                result = self.api.get_faction_crimes(
                    category="all",
                    filters="created_at",
                    from_timestamp=current_from,
                    sort="ASC"
                )
                
                crimes = result.get('crimes', [])
                
                if not crimes:
                    logger.info("No crimes returned - reached end")
                    break
                
                logger.info(f"  Fetched {len(crimes)} crimes (IDs: {crimes[0]['id']} to {crimes[-1]['id']})")
                
                # Verify overlap with previous page (except first page)
                if page > 1:
                    current_page_ids = {c['id'] for c in crimes}
                    overlap = last_page_crime_ids & current_page_ids
                    if overlap:
                        logger.info(f"  Verified overlap: {len(overlap)} crime(s) from previous page")
                    else:
                        logger.warning(f"  No overlap detected - possible gap between pages!")
                
                # Track crimes we've already seen to avoid duplicates
                existing_ids = {c['id'] for c in all_crimes}
                new_crimes = [c for c in crimes if c['id'] not in existing_ids]
                duplicates = len(crimes) - len(new_crimes)
                
                all_crimes.extend(new_crimes)
                logger.info(f"  Added {len(new_crimes)} new crimes, {duplicates} duplicates (total: {len(all_crimes)})")
                
                # CRITICAL: Only stop when we get less than 100 crimes
                # If we got exactly 100, there might be more - keep going
                if len(crimes) < 100:
                    logger.info(f"Received {len(crimes)} crimes (< 100) - reached end")
                    break
                
                # Got 100 crimes - prepare for next page
                logger.info(f"Received 100 crimes - fetching next page")
                
                # Store current page's crime IDs for overlap verification
                last_page_crime_ids = {c['id'] for c in crimes}
                
                # Update from_timestamp to the last crime's created_at for next page
                last_crime = crimes[-1]
                current_from = last_crime['created_at']
                logger.info(f"  Next page will start from timestamp: {current_from}")
                
                page += 1
                
            except TornAPIError as e:
                logger.error(f"API error on page {page}: {e}")
                raise
            except Exception as e:
                logger.error(f"Unexpected error on page {page}: {e}")
                raise
        
        logger.info(f"Pagination complete: fetched {len(all_crimes)} total crimes across {page} page(s)")
        
        # Final verification - check for gaps in crime IDs
        if all_crimes:
            crime_ids = sorted([c['id'] for c in all_crimes])
            first_id, last_id = crime_ids[0], crime_ids[-1]
            expected_range = last_id - first_id + 1
            actual_count = len(crime_ids)
            
            if expected_range != actual_count:
                missing_count = expected_range - actual_count
                logger.warning(f"Crime ID gaps detected: expected {expected_range}, got {actual_count} ({missing_count} missing)")
            else:
                logger.info(f"Crime ID range verified: {first_id} to {last_id} ({actual_count} crimes)")
        
        return all_crimes
    
    def _normalize_crime_data(self, crime: Dict) -> Dict:
        """
        Normalize crime data for storage (OPTIMIZED - removes redundant data)
        
        Args:
            crime: Raw crime data from API
            
        Returns:
            Normalized crime data
        """
        # Calculate slot statistics
        total_slots = len(crime.get('slots', []))
        filled_slots = sum(1 for slot in crime.get('slots', []) if slot.get('user'))
        
        # Extract participant IDs directly from slots (no separate participants list)
        participant_ids = [
            slot['user']['id'] 
            for slot in crime.get('slots', []) 
            if slot.get('user')
        ]
        
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
            'slots': crime.get('slots', []),  # Keep full slots data (contains all participant info)
            
            # Participant IDs (for quick lookup)
            'participant_ids': participant_ids,
            
            # Rewards (if completed)
            'rewards': crime.get('rewards'),
            
            # Metadata
            'last_updated': datetime.now().isoformat(),
            'first_seen': None  # Will be set on first insert
        }
        
        return normalized
    
    def _update_crime(self, crimes_db: Dict, crime: Dict) -> tuple[bool, str]:
        """
        Update or insert a crime in the database (OPTIMIZED)
        
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
        
        # Determine where to start fetching from
        start_timestamp = self._get_fetch_start_timestamp(crimes_db)
        
        if start_timestamp:
            logger.info(f"Fetching crimes from timestamp: {start_timestamp}")
        else:
            logger.info("Fetching all historical crimes from the beginning")
        
        # Fetch all crimes with pagination
        api_crimes = self._fetch_crimes_paginated(from_timestamp=start_timestamp)
        
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
        
        # Update metadata with oldest incomplete timestamp
        oldest_incomplete_ts = self._get_fetch_start_timestamp(crimes_db)
        crimes_db['metadata']['oldest_incomplete_timestamp'] = oldest_incomplete_ts
        
        # Save updated database
        self._save_crimes_database(crimes_db)
        
        # Update Google Sheets
        try:
            self._update_sheets_with_crimes(crimes_db, stats)
        except Exception as e:
            logger.error(f"Failed to update Google Sheets: {e}")
            import traceback
            traceback.print_exc()
        
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
        Update Google Sheets with crime data using batch updates
        
        Args:
            crimes_db: Full crimes database
            stats: Update statistics
        """
        logger.info("Updating Google Sheets with crime data (batch mode)")
        
        # Update dashboard with summary stats (batch)
        dashboard_stats = {
            'total_crimes': len(crimes_db['crimes']),
            'pending_crimes': sum(1 for c in crimes_db['crimes'].values() 
                                 if c['status'] in ['Recruiting', 'available']),
            'completed_this_week': self._count_recent_completions(crimes_db),
            'active_members': len(self._get_active_member_ids(crimes_db))
        }
        
        self.sheets.update_dashboard_stats_batch(dashboard_stats)
        
        # Update pending crimes list (batch)
        pending_crimes = [
            c for c in crimes_db['crimes'].values() 
            if c['status'] in ['Recruiting', 'available', 'Planning']
        ]
        # Sort by creation date (most recent first)
        pending_crimes.sort(key=lambda x: x.get('created_at', 0), reverse=True)
        
        self.sheets.update_dashboard_pending_crimes_batch(pending_crimes[:50])
        
        # Write full crime log to Crime_Log sheet (batch)
        self._write_crime_log_sheet_batch(crimes_db)
        
        # Write crimes to "test" sheet using pandas DataFrame
        self._write_crimes_to_test_sheet_pandas(crimes_db)

        # NEW: Write CPR database to 'cpr_database' sheet
        self._write_cpr_database_to_sheet_pandas()
        
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
    
    def _write_crime_log_sheet_batch(self, crimes_db: Dict):
        """Write comprehensive crime log to Google Sheets using batch update"""
        logger.info("Writing crime log to Google Sheets (batch mode)")
        
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
        
        # Write to Crime_Log sheet using batch
        self.sheets.write_crime_log_batch(crime_rows)
        
        logger.info(f"Wrote {len(crime_rows)} crimes to Crime_Log sheet")
    
    def _write_crimes_to_test_sheet_pandas(self, crimes_db: Dict):
        """
        Write crimes database to 'test' sheet using pandas DataFrame
        Includes item rewards, items used, and participant tuples
        """
        logger.info("Writing crimes to 'test' sheet using pandas DataFrame")
        
        try:
            # Convert crimes dictionary to list of flattened dictionaries
            flattened_crimes = []
            
            for crime_id, crime in crimes_db['crimes'].items():
                # Extract item rewards as tuples: (id, quantity)
                item_rewards = ""
                if crime.get('rewards') and crime['rewards'].get('items'):
                    reward_tuples = [
                        f"({item['id']},{item['quantity']})" 
                        for item in crime['rewards']['items']
                    ]
                    item_rewards = ",".join(reward_tuples)
                
                # Extract items used from slots as tuples: (id, quantity)
                # Items are "used" if they're not reusable (is_reusable=false)
                items_used = []
                items_used_ids = set()  # Track to avoid duplicates
                
                for slot in crime.get('slots', []):
                    item_req = slot.get('item_requirement')
                    if item_req and not item_req.get('is_reusable', True):
                        item_id = item_req['id']
                        # Only add if we haven't seen this item yet for this crime
                        if item_id not in items_used_ids:
                            items_used.append(f"({item_id},1)")  # Quantity is always 1 per slot
                            items_used_ids.add(item_id)
                
                items_used_str = ",".join(items_used) if items_used else ""
                
                # Extract participants as tuples: (user_id, position position_number, joined_at)
                # Example: (3680626,Picklock 1,1755635518)
                participant_tuples = []
                for slot in crime.get('slots', []):
                    if slot.get('user'):
                        user = slot['user']
                        position = slot['position']
                        position_num = slot.get('position_number', 1)
                        joined_at = user.get('joined_at', 0)
                        
                        participant_tuples.append(
                            f"({user['id']},{position} {position_num},{joined_at})"
                        )
                
                participants_str = ",".join(participant_tuples)
                
                # Flatten the crime data - extract key fields
                flat_crime = {
                    'Crime ID': crime.get('id', 0),
                    'Name': crime.get('name', ''),
                    'Difficulty': crime.get('difficulty', 0),
                    'Status': crime.get('status', ''),
                    'Created At': datetime.fromtimestamp(crime['created_at']).strftime('%Y-%m-%d %H:%M') if crime.get('created_at') else '',
                    'Executed At': datetime.fromtimestamp(crime['executed_at']).strftime('%Y-%m-%d %H:%M') if crime.get('executed_at') else '',
                    'Total Slots': crime.get('total_slots', 0),
                    'Filled Slots': crime.get('filled_slots', 0),
                    'Participants': participants_str,
                    'Money Reward': crime.get('rewards', {}).get('money', 0) if crime.get('rewards') else 0,
                    'Item Reward': item_rewards,
                    'Item Used': items_used_str,
                    'Respect': crime.get('rewards', {}).get('respect', 0) if crime.get('rewards') else 0,
                    'Previous Crime ID': crime.get('previous_crime_id') if crime.get('previous_crime_id') else '',
                    'Last Updated': crime.get('last_updated', ''),
                }
                
                flattened_crimes.append(flat_crime)
            
            # Create DataFrame
            df = pd.DataFrame(flattened_crimes)
            
            # Ensure no NaN values - replace with appropriate defaults
            # For numeric columns, replace NaN with 0
            numeric_cols = ['Crime ID', 'Difficulty', 'Total Slots', 'Filled Slots', 
                        'Money Reward', 'Respect']
            for col in numeric_cols:
                if col in df.columns:
                    df[col] = df[col].fillna(0)
            
            # For string columns, replace NaN with empty string
            string_cols = ['Name', 'Status', 'Created At', 'Executed At', 
                        'Participants', 'Item Reward', 'Item Used', 
                        'Previous Crime ID', 'Last Updated']
            for col in string_cols:
                if col in df.columns:
                    df[col] = df[col].fillna('')
            
            # Sort by Crime ID descending (newest first)
            df = df.sort_values('Crime ID', ascending=False)
            
            # Limit to most recent 100 crimes for the test sheet
            df = df.head(100)
            
            logger.info(f"Created DataFrame with {len(df)} rows and {len(df.columns)} columns")
            logger.info(f"Columns: {', '.join(df.columns)}")
            
            # Write to test sheet using pandas integration
            self.sheets.write_dataframe_to_sheet(df, sheet_name='test')
            
            logger.info("✓ Successfully wrote crimes to 'test' sheet using pandas")
            
        except Exception as e:
            logger.error(f"Error writing to test sheet: {e}")
            import traceback
            traceback.print_exc()
        """
        Write CPR database to 'cpr_database' sheet using pandas DataFrame
        Flattens the nested JSON structure into columns for easy viewing
        """
        logger.info("Writing CPR database to 'cpr_database' sheet using pandas DataFrame")
        
        try:
            # Load CPR database
            cpr_data = self.storage.read_json('cpr_database.json')
            
            if not cpr_data or 'members' not in cpr_data:
                logger.warning("No CPR data found to write")
                return
            
            members_data = cpr_data['members']
            
            # Flatten the nested structure into rows
            flattened_rows = []
            
            for member_id, member_info in members_data.items():
                member_name = member_info.get('name', 'Unknown')
                last_scraped = member_info.get('last_scraped', '')
                cpr_by_role = member_info.get('cpr_by_role', {})
                
                # For each difficulty level
                for difficulty, roles in cpr_by_role.items():
                    # For each role in that difficulty
                    for role_name, cpr_score in roles.items():
                        flattened_rows.append({
                            'Member ID': int(member_id),
                            'Member Name': member_name,
                            'Difficulty': int(difficulty),
                            'Role': role_name,
                            'CPR Score': int(cpr_score),
                            'Last Scraped': last_scraped
                        })
            
            if not flattened_rows:
                logger.warning("No CPR data to write (empty dataset)")
                return
            
            # Create DataFrame
            df = pd.DataFrame(flattened_rows)
            
            # Sort for better readability: by Member ID, then Difficulty, then Role
            df = df.sort_values(['Member ID', 'Difficulty', 'Role'])
            
            # Reset index for clean display
            df = df.reset_index(drop=True)
            
            logger.info(f"Created CPR DataFrame with {len(df)} rows")
            logger.info(f"Columns: {', '.join(df.columns)}")
            logger.info(f"Members: {df['Member ID'].nunique()}")
            logger.info(f"Difficulty levels: {sorted(df['Difficulty'].unique())}")
            
            # Write to 'cpr_database' sheet using pandas integration
            self.sheets.write_dataframe_to_sheet(df, sheet_name='cpr_database')
            
            logger.info("✓ Successfully wrote CPR database to 'cpr_database' sheet")
            
            # Log some summary stats
            summary_stats = df.groupby('Difficulty')['CPR Score'].agg(['mean', 'min', 'max']).round(2)
            logger.info("\nCPR Summary by Difficulty:")
            for difficulty in sorted(summary_stats.index):
                stats = summary_stats.loc[difficulty]
                logger.info(f"  Level {difficulty}: Avg={stats['mean']}, Min={stats['min']}, Max={stats['max']}")
            
        except Exception as e:
            logger.error(f"Error writing CPR database to sheet: {e}")
            import traceback
            traceback.print_exc()

    def _write_cpr_database_to_sheet_pandas(self):
        """
        Write CPR database to 'cpr_database' sheet using pandas DataFrame
        Flattens the nested JSON structure into columns for easy viewing
        """
        logger.info("Writing CPR database to 'cpr_database' sheet using pandas DataFrame")
        
        try:
            # Load CPR database
            cpr_data = self.storage.read_json('cpr_database.json')
            
            if not cpr_data or 'members' not in cpr_data:
                logger.warning("No CPR data found to write")
                return
            
            members_data = cpr_data['members']
            
            # Flatten the nested structure into rows
            flattened_rows = []
            
            for member_id, member_info in members_data.items():
                member_name = member_info.get('name', 'Unknown')
                last_scraped = member_info.get('last_scraped', '')
                cpr_by_role = member_info.get('cpr_by_role', {})
                
                # For each difficulty level
                for difficulty, roles in cpr_by_role.items():
                    # For each role in that difficulty
                    for role_name, cpr_score in roles.items():
                        flattened_rows.append({
                            'Member ID': int(member_id),
                            'Member Name': member_name,
                            'Difficulty': int(difficulty),
                            'Role': role_name,
                            'CPR Score': int(cpr_score),
                            'Last Scraped': last_scraped
                        })
            
            if not flattened_rows:
                logger.warning("No CPR data to write (empty dataset)")
                return
            
            # Create DataFrame
            df = pd.DataFrame(flattened_rows)
            
            # Sort for better readability: by Member ID, then Difficulty, then Role
            df = df.sort_values(['Member ID', 'Difficulty', 'Role'])
            
            # Reset index for clean display
            df = df.reset_index(drop=True)
            
            logger.info(f"Created CPR DataFrame with {len(df)} rows")
            logger.info(f"Columns: {', '.join(df.columns)}")
            logger.info(f"Members: {df['Member ID'].nunique()}")
            logger.info(f"Difficulty levels: {sorted(df['Difficulty'].unique())}")
            
            # Write to 'cpr_database' sheet using pandas integration
            self.sheets.write_dataframe_to_sheet(df, sheet_name='cpr_database')
            
            logger.info("✓ Successfully wrote CPR database to 'cpr_database' sheet")
            
            # Log some summary stats
            summary_stats = df.groupby('Difficulty')['CPR Score'].agg(['mean', 'min', 'max']).round(2)
            logger.info("\nCPR Summary by Difficulty:")
            for difficulty in sorted(summary_stats.index):
                stats = summary_stats.loc[difficulty]
                logger.info(f"  Level {difficulty}: Avg={stats['mean']}, Min={stats['min']}, Max={stats['max']}")
            
        except Exception as e:
            logger.error(f"Error writing CPR database to sheet: {e}")
            import traceback
            traceback.print_exc()




def main():
    """Main execution function"""
    try:
        sheets = GoogleSheetsManager()
        api_key = os.environ.get('TORN_API_KEY')
        
        # Sync members first
        logger.info("Syncing faction members...")
        sheets.sync_faction_members(api_key)

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
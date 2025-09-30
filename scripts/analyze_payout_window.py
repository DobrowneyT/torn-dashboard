"""
Payout Window Analysis
Analyzes crimes and member participation within a specific time window
"""

import logging
from typing import Dict, List, Set
from datetime import datetime
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.utils.json_storage import JSONStorageManager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class PayoutWindowAnalyzer:
    """Analyze crime data within a specific time window for payout calculations"""
    
    def __init__(self):
        """Initialize the analyzer"""
        self.storage = JSONStorageManager(data_dir='data', auto_commit=False)
        logger.info("Payout Window Analyzer initialized")
    
    def analyze_window(self, from_timestamp: int, to_timestamp: int) -> Dict:
        """
        Analyze crimes and member participation within time window
        
        Args:
            from_timestamp: Start of analysis window (Unix timestamp)
            to_timestamp: End of analysis window (Unix timestamp)
            
        Returns:
            Dictionary containing:
                - window: Window metadata
                - members: Member participation data
                - crimes: Crime statistics
                - items: Items rewarded and used
        """
        logger.info(f"Analyzing window: {from_timestamp} to {to_timestamp}")
        
        # Load crimes database
        crimes_db = self.storage.read_json('crimes_database.json')
        if not crimes_db or 'crimes' not in crimes_db:
            raise ValueError("crimes_database.json is empty or invalid")
        
        # Initialize result structure
        result = {
            'window': {
                'from': from_timestamp,
                'to': to_timestamp,
                'duration_seconds': to_timestamp - from_timestamp,
                'duration_days': (to_timestamp - from_timestamp) / 86400
            },
            'members': {},
            'crimes': {
                'total': 0,
                'successful': 0,
                'failed': 0,
                'total_rewards': 0,
                'crime_ids': []
            },
            'items': {
                'rewards': [],  # List of {id, quantity, crime_id}
                'used': []      # List of {id, quantity, crime_id}
            }
        }
        
        # Process crimes
        for crime_id, crime in crimes_db['crimes'].items():
            # Only process crimes that executed within the window
            executed_at = crime.get('executed_at')
            
            if not executed_at:
                continue  # Skip crimes that haven't executed
                
            if not (from_timestamp <= executed_at <= to_timestamp):
                continue  # Outside our window
            
            # Count this crime
            result['crimes']['total'] += 1
            result['crimes']['crime_ids'].append(crime_id)
            
            status = crime.get('status', '')
            
            if status == 'Successful':
                result['crimes']['successful'] += 1
                
                # Add rewards
                rewards = crime.get('rewards', {})
                money = rewards.get('money', 0)
                result['crimes']['total_rewards'] += money
                
                # Track reward items
                reward_items = rewards.get('items', [])
                for item in reward_items:
                    result['items']['rewards'].append({
                        'id': item['id'],
                        'quantity': item['quantity'],
                        'crime_id': crime_id
                    })
            
            elif status == 'Failed':
                result['crimes']['failed'] += 1
            
            # Process participants for time tracking
            self._process_participants(
                crime, 
                from_timestamp, 
                to_timestamp, 
                result['members']
            )
            
            # Track used items from all crime slots (successful or failed)
            self._process_used_items(crime, crime_id, result['items']['used'])
        
        logger.info(f"Processed {result['crimes']['total']} crimes in window")
        logger.info(f"  Successful: {result['crimes']['successful']}")
        logger.info(f"  Failed: {result['crimes']['failed']}")
        logger.info(f"  Total rewards: ${result['crimes']['total_rewards']:,}")
        logger.info(f"  Members participated: {len(result['members'])}")
        
        return result
    
    def _process_participants(
        self, 
        crime: Dict, 
        from_ts: int, 
        to_ts: int, 
        members_dict: Dict
    ):
        """
        Process crime participants and calculate time spent in crime
        
        Time boundary logic:
        - Only count time within [from_ts, to_ts] window
        - effectiveStart = max(joined_at, from_ts)
        - effectiveEnd = min(executed_at or to_ts, to_ts)
        """
        executed_at = crime.get('executed_at')
        crime_id = crime.get('id')
        difficulty = crime.get('difficulty')
        
        # For time calculation, use executed_at if available, otherwise use to_ts
        reference_time = executed_at if executed_at else to_ts
        
        # Process each participant
        for participant in crime.get('participants', []):
            user_id = participant.get('user_id')
            if not user_id:
                continue
            
            joined_at = participant.get('joined_at')
            if not joined_at:
                continue
            
            # Skip if joined after window ends
            if joined_at > to_ts:
                continue
            
            # Calculate time within window boundaries
            effective_start = max(joined_at, from_ts)
            effective_end = min(reference_time, to_ts)
            
            # Skip if no overlap with window
            if effective_start >= effective_end:
                continue
            
            time_in_crime = effective_end - effective_start
            
            # Initialize member if not exists
            if user_id not in members_dict:
                members_dict[user_id] = {
                    'member_id': user_id,
                    'name': '',  # Will be filled later from member list
                    'time_in_crimes': 0,
                    'crimes_participated': 0,
                    'positions': set(),
                    'crime_details': []
                }
            
            # Add time and track participation
            members_dict[user_id]['time_in_crimes'] += time_in_crime
            members_dict[user_id]['crimes_participated'] += 1
            
            # Track position
            position = participant.get('position', 'Unknown')
            members_dict[user_id]['positions'].add(position)
            
            # Store crime detail
            members_dict[user_id]['crime_details'].append({
                'crime_id': crime_id,
                'difficulty': difficulty,
                'position': position,
                'time_spent': time_in_crime,
                'joined_at': joined_at,
                'left_at': reference_time
            })
    
    def _process_used_items(self, crime: Dict, crime_id: str, used_items_list: List):
        """
        Extract items that were used (consumed) during the crime
        
        Looks at each slot's item_outcome to find items with outcome='used'
        """
        for slot in crime.get('slots', []):
            user = slot.get('user')
            if not user:
                continue
            
            item_outcome = user.get('item_outcome')
            if not item_outcome:
                continue
            
            outcome = item_outcome.get('outcome')
            if outcome == 'used':
                item_id = item_outcome.get('item_id')
                if item_id:
                    used_items_list.append({
                        'id': item_id,
                        'quantity': 1,  # Items are used one at a time
                        'crime_id': crime_id
                    })
    
    def load_member_names(self, members_data: Dict) -> Dict:
        """
        Load member names from member list and update member data
        
        Args:
            members_data: Member dict from analysis (keyed by user_id)
            
        Returns:
            Updated members_data with names filled in
        """
        # Try to get member names from API or stored member list
        # For now, we'll need to fetch this from the faction members
        # This can be enhanced later to pull from a stored member list
        
        # Placeholder: member IDs will be used if names aren't available
        logger.info(f"Loaded data for {len(members_data)} members")
        
        return members_data


def analyze_window(from_timestamp: int, to_timestamp: int) -> Dict:
    """
    Convenience function to analyze a time window
    
    Args:
        from_timestamp: Start of window (Unix timestamp)
        to_timestamp: End of window (Unix timestamp)
        
    Returns:
        Analysis results dictionary
    """
    analyzer = PayoutWindowAnalyzer()
    return analyzer.analyze_window(from_timestamp, to_timestamp)


if __name__ == "__main__":
    # Test the analyzer
    import os
    from datetime import timedelta
    
    # Use timestamps from environment or default to last 7 days
    to_ts = int(os.environ.get('TO_TIMESTAMP', datetime.now().timestamp()))
    from_ts = int(os.environ.get('FROM_TIMESTAMP', (datetime.now() - timedelta(days=7)).timestamp()))
    
    print(f"\nAnalyzing window from {datetime.fromtimestamp(from_ts)} to {datetime.fromtimestamp(to_ts)}")
    
    result = analyze_window(from_ts, to_ts)
    
    print(f"\nResults:")
    print(f"  Total crimes: {result['crimes']['total']}")
    print(f"  Successful: {result['crimes']['successful']}")
    print(f"  Total rewards: ${result['crimes']['total_rewards']:,}")
    print(f"  Members: {len(result['members'])}")
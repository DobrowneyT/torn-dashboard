#!/usr/bin/env python3
"""
Sync JSON data files to Supabase database
Handles both CPR data and Crimes data
"""

import os
import sys
import json
import logging
from datetime import datetime
from supabase import create_client, Client

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class SupabaseSync:
    """Sync JSON data to Supabase database"""
    
    def __init__(self):
        self.supabase_url = os.environ.get('VITE_SUPABASE_URL')
        self.supabase_key = os.environ.get('VITE_SUPABASE_SERVICE_ROLE_KEY')
        
        if not self.supabase_url or not self.supabase_key:
            raise ValueError("Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_ROLE_KEY environment variables")
        
        self.client: Client = create_client(self.supabase_url, self.supabase_key)
        logger.info("✓ Supabase client initialized")
    
    def sync_cpr_data(self, json_path: str) -> dict:
        """
        Sync CPR data from JSON to Supabase
        
        Args:
            json_path: Path to cpr_database.json
            
        Returns:
            dict with sync statistics
        """
        logger.info(f"Reading CPR data from {json_path}")
        
        with open(json_path, 'r') as f:
            data = json.load(f)
        
        if 'members' not in data:
            raise ValueError("Invalid CPR data format - missing 'members' object")
        
        members_count = 0
        cpr_records_count = 0
        errors = []
        
        for member_id, member_data in data['members'].items():
            try:
                # Upsert member
                member_result = self.client.table('members').upsert({
                    'member_id': member_id,
                    'member_name': member_data.get('name', f'Member {member_id}'),
                    'tier': member_data.get('tier', 6),
                    'last_scraped': member_data.get('last_scraped', datetime.now().isoformat()),
                    'updated_at': datetime.now().isoformat()
                }, on_conflict='member_id').execute()
                
                members_count += 1
                
                # Upsert CPR records
                cpr_by_role = member_data.get('cpr_by_role', {})
                cpr_records = []
                
                for level, roles in cpr_by_role.items():
                    for role, cpr in roles.items():
                        if isinstance(cpr, (int, float)):
                            cpr_records.append({
                                'member_id': member_id,
                                'difficulty_level': int(level),
                                'role_name': role,
                                'cpr_value': float(cpr),
                                'updated_at': datetime.now().isoformat()
                            })
                
                if cpr_records:
                    cpr_result = self.client.table('member_cpr').upsert(
                        cpr_records,
                        on_conflict='member_id,difficulty_level,role_name'
                    ).execute()
                    cpr_records_count += len(cpr_records)
                
                if members_count % 10 == 0:
                    logger.info(f"Progress: {members_count} members, {cpr_records_count} CPR records")
                    
            except Exception as e:
                error_msg = f"Error syncing member {member_id}: {str(e)}"
                logger.error(error_msg)
                errors.append(error_msg)
        
        result = {
            'type': 'CPR',
            'members_synced': members_count,
            'cpr_records_synced': cpr_records_count,
            'errors': errors
        }
        
        logger.info(f"✓ CPR sync complete: {members_count} members, {cpr_records_count} CPR records")
        if errors:
            logger.warning(f"⚠ {len(errors)} errors occurred")
        
        return result
    
    def sync_crimes_data(self, json_path: str) -> dict:
        """
        Sync Crimes data from JSON to Supabase
        
        Args:
            json_path: Path to crimes_database.json
            
        Returns:
            dict with sync statistics
        """
        logger.info(f"Reading crimes data from {json_path}")
        
        with open(json_path, 'r') as f:
            data = json.load(f)
        
        if 'crimes' not in data:
            raise ValueError("Invalid crimes data format - missing 'crimes' object")
        
        crimes_count = 0
        slots_count = 0
        errors = []
        
        for crime_id, crime_data in data['crimes'].items():
            try:
                # Upsert crime
                crime_result = self.client.table('crimes').upsert({
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
                    'rewards_money': crime_data.get('rewards', {}).get('money', 0) if crime_data.get('rewards') else 0,
                    'rewards_respect': crime_data.get('rewards', {}).get('respect', 0) if crime_data.get('rewards') else 0,
                    'rewards_items': json.dumps(crime_data.get('rewards', {}).get('items', [])) if crime_data.get('rewards') else None,
                    'last_updated': crime_data.get('last_updated'),
                    'first_seen': crime_data.get('first_seen'),
                    'updated_at': datetime.now().isoformat()
                }, on_conflict='crime_id').execute()
                
                crimes_count += 1
                
                # UPSERT slots instead of delete/insert
                # This only updates changed slots, much faster
                slots = crime_data.get('slots', [])
                slot_records = []
                
                for slot in slots:
                    # Safely handle null/missing user and item_requirement
                    user = slot.get('user') or {}
                    item_req = slot.get('item_requirement') or {}
                    item_outcome = user.get('item_outcome') or {}
                    
                    slot_record = {
                        'crime_id': crime_id,
                        'position': slot.get('position'),
                        'position_id': slot.get('position_id'),
                        'position_number': slot.get('position_number'),
                        'checkpoint_pass_rate': slot.get('checkpoint_pass_rate'),
                        
                        # User info (may be null for empty slots)
                        'user_id': str(user.get('id')) if user.get('id') else None,
                        'user_name': user.get('name'),
                        'joined_at': user.get('joined_at'),
                        'user_outcome': user.get('outcome'),
                        'user_progress': user.get('progress'),
                        
                        # Item requirement
                        'item_requirement_id': str(item_req.get('id')) if item_req.get('id') else None,
                        'item_requirement_name': item_req.get('name'),
                        'item_requirement_is_reusable': item_req.get('is_reusable', False) if item_req else False,
                        'item_requirement_is_available': item_req.get('is_available', False) if item_req else False,
                        
                        # Item outcome
                        'item_outcome_id': str(item_outcome.get('item_id')) if item_outcome.get('item_id') else None,
                        'item_outcome_outcome': item_outcome.get('outcome'),
                        
                        'updated_at': datetime.now().isoformat()
                    }
                    slot_records.append(slot_record)
                
                if slot_records:
                    # UPSERT: Updates existing slots, inserts new ones
                    # Much more efficient than delete/insert
                    slots_result = self.client.table('crime_slots').upsert(
                        slot_records,
                        on_conflict='crime_id,position_id'
                    ).execute()
                    slots_count += len(slot_records)
                
                if crimes_count % 50 == 0:
                    logger.info(f"Progress: {crimes_count} crimes, {slots_count} slots")
                    
            except Exception as e:
                error_msg = f"Error syncing crime {crime_id}: {str(e)}"
                logger.error(error_msg)
                errors.append(error_msg)
        
        result = {
            'type': 'Crimes',
            'crimes_synced': crimes_count,
            'slots_synced': slots_count,
            'errors': errors
        }
        
        logger.info(f"✓ Crimes sync complete: {crimes_count} crimes, {slots_count} slots")
        if errors:
            logger.warning(f"⚠ {len(errors)} errors occurred")
        
        return result


def main():
    """Main entry point"""
    if len(sys.argv) < 2:
        print("Usage: python sync_to_supabase.py [cpr|crimes|all]")
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
        
        # Print summary
        logger.info("\n=== Sync Summary ===")
        for result in results:
            logger.info(f"{result['type']}:")
            if result['type'] == 'CPR':
                logger.info(f"  Members synced: {result['members_synced']}")
                logger.info(f"  CPR records synced: {result['cpr_records_synced']}")
            else:
                logger.info(f"  Crimes synced: {result['crimes_synced']}")
                logger.info(f"  Slots synced: {result['slots_synced']}")
            
            if result['errors']:
                logger.info(f"  Errors: {len(result['errors'])}")
        
        # Exit with error if there were any errors
        total_errors = sum(len(r['errors']) for r in results)
        if total_errors > 0:
            logger.error(f"Sync completed with {total_errors} errors")
            sys.exit(1)
        else:
            logger.info("✓ All data synced successfully")
            sys.exit(0)
            
    except Exception as e:
        logger.error(f"Fatal error: {str(e)}", exc_info=True)
        sys.exit(1)


if __name__ == '__main__':
    main()
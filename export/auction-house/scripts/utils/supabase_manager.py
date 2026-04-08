"""
Supabase Database Manager for Auction House Listings
Handles all database operations for storing auction listings
"""

import os
import logging
from typing import Dict, List, Optional
from datetime import datetime
import json

# Using supabase-py library
from supabase import create_client, Client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class SupabaseManagerError(Exception):
    """Custom exception for Supabase manager errors"""
    pass

class SupabaseManager:
    """Manage Supabase database operations for auction listings"""
    
    def __init__(self, supabase_url: Optional[str] = None, supabase_key: Optional[str] = None):
        """
        Initialize Supabase manager
        
        Args:
            supabase_url: Supabase project URL (or set SUPABASE_URL env variable)
            supabase_key: Supabase anon/service key (or set SUPABASE_KEY env variable)
        """
        self.supabase_url = supabase_url or os.environ.get('SUPABASE_URL')
        self.supabase_key = supabase_key or os.environ.get('SUPABASE_KEY')
        
        if not self.supabase_url:
            raise ValueError("SUPABASE_URL not found in environment or parameters")
        if not self.supabase_key:
            raise ValueError("SUPABASE_KEY not found in environment or parameters")
        
        # Initialize Supabase client
        try:
            self.client: Client = create_client(self.supabase_url, self.supabase_key)
            logger.info("Supabase client initialized successfully")
        except Exception as e:
            logger.error(f"Failed to initialize Supabase client: {e}")
            raise SupabaseManagerError(f"Supabase initialization failed: {e}")
    
    def get_latest_timestamp_for_item(self, item_id: int) -> Optional[int]:
        """
        Get the most recent timestamp for a given item in the database
        
        Args:
            item_id: Item ID to check
            
        Returns:
            Latest timestamp (Unix timestamp) or None if no records exist
        """
        try:
            response = self.client.table('auction_listings') \
                .select('timestamp') \
                .eq('item_id', item_id) \
                .order('timestamp', desc=True) \
                .limit(1) \
                .execute()
            
            if response.data and len(response.data) > 0:
                latest = response.data[0]['timestamp']
                logger.info(f"Item {item_id}: Latest timestamp in DB is {latest}")
                return latest
            else:
                logger.info(f"Item {item_id}: No existing records in DB")
                return None
                
        except Exception as e:
            logger.error(f"Error fetching latest timestamp for item {item_id}: {e}")
            raise SupabaseManagerError(f"Failed to fetch latest timestamp: {e}")
    
    def _prepare_listing_for_db(self, listing: Dict) -> Dict:
        """
        Transform API listing format to database row format
        
        Args:
            listing: Raw listing from Torn API
            
        Returns:
            Dict formatted for database insertion
        """
        item = listing.get('item', {})
        seller = listing.get('seller', {})
        buyer = listing.get('buyer', {})
        
        return {
            'auction_id': listing['id'],
            'item_id': item.get('id'),
            'item_uid': item.get('uid'),
            'item_name': item.get('name', 'Unknown'),
            'item_type': item.get('type', 'Unknown'),
            'item_sub_type': item.get('sub_type'),
            'seller_id': seller.get('id'),
            'seller_name': seller.get('name', 'Unknown'),
            'buyer_id': buyer.get('id'),
            'buyer_name': buyer.get('name', 'Unknown'),
            'timestamp': listing['timestamp'],
            'price': listing.get('price', 0),
            'bids': listing.get('bids', 0),
            'item_stats': json.dumps(item.get('stats', {})) if item.get('stats') else None,
            'item_bonuses': json.dumps(item.get('bonuses', [])) if item.get('bonuses') else None,
            'item_rarity': item.get('rarity'),
            'full_listing': json.dumps(listing)
        }
    
    def batch_upsert_listings(self, listings: List[Dict], batch_size: int = 1000) -> Dict:
        """
        Insert listings into database in batches (upsert to handle duplicates)
        
        Args:
            listings: List of listings from Torn API
            batch_size: Number of records to insert per batch
            
        Returns:
            Statistics about the operation
        """
        if not listings:
            logger.warning("No listings to insert")
            return {
                'total': 0,
                'inserted': 0,
                'errors': 0
            }
        
        # Prepare all listings for DB
        db_rows = [self._prepare_listing_for_db(listing) for listing in listings]
        
        total_rows = len(db_rows)
        inserted_count = 0
        error_count = 0
        
        logger.info(f"Starting batch upsert of {total_rows} listings (batch size: {batch_size})")
        
        # Process in batches
        for i in range(0, total_rows, batch_size):
            batch = db_rows[i:i + batch_size]
            batch_num = (i // batch_size) + 1
            total_batches = (total_rows + batch_size - 1) // batch_size
            
            try:
                logger.info(f"Upserting batch {batch_num}/{total_batches} ({len(batch)} records)...")
                
                # Upsert (insert or update on conflict)
                response = self.client.table('auction_listings') \
                    .upsert(batch, on_conflict='auction_id') \
                    .execute()
                
                inserted_count += len(batch)
                logger.info(f"  ✓ Batch {batch_num} completed successfully")
                
            except Exception as e:
                logger.error(f"  ✗ Error in batch {batch_num}: {e}")
                error_count += len(batch)
        
        logger.info(f"Batch upsert complete: {inserted_count} successful, {error_count} errors")
        
        return {
            'total': total_rows,
            'inserted': inserted_count,
            'errors': error_count
        }
    
    def get_item_stats(self, item_id: int) -> Dict:
        """
        Get statistics about listings for a specific item
        
        Args:
            item_id: Item ID
            
        Returns:
            Dict with statistics
        """
        try:
            # Get count
            count_response = self.client.table('auction_listings') \
                .select('auction_id', count='exact') \
                .eq('item_id', item_id) \
                .execute()
            
            # Get timestamp range
            range_response = self.client.table('auction_listings') \
                .select('timestamp') \
                .eq('item_id', item_id) \
                .order('timestamp', desc=False) \
                .limit(1) \
                .execute()
            
            oldest = range_response.data[0]['timestamp'] if range_response.data else None
            
            range_response = self.client.table('auction_listings') \
                .select('timestamp') \
                .eq('item_id', item_id) \
                .order('timestamp', desc=True) \
                .limit(1) \
                .execute()
            
            newest = range_response.data[0]['timestamp'] if range_response.data else None
            
            return {
                'item_id': item_id,
                'total_listings': count_response.count,
                'oldest_timestamp': oldest,
                'newest_timestamp': newest
            }
            
        except Exception as e:
            logger.error(f"Error getting stats for item {item_id}: {e}")
            return {
                'item_id': item_id,
                'total_listings': 0,
                'oldest_timestamp': None,
                'newest_timestamp': None,
                'error': str(e)
            }
    
    def test_connection(self) -> bool:
        """
        Test database connection
        
        Returns:
            True if connection successful
        """
        try:
            # Simple query to test connection
            response = self.client.table('auction_listings') \
                .select('auction_id') \
                .limit(1) \
                .execute()
            
            logger.info("Database connection test successful")
            return True
            
        except Exception as e:
            logger.error(f"Database connection test failed: {e}")
            return False


def create_supabase_manager(
    supabase_url: Optional[str] = None,
    supabase_key: Optional[str] = None
) -> SupabaseManager:
    """
    Create SupabaseManager instance
    
    Args:
        supabase_url: Supabase project URL (optional, uses env var if not provided)
        supabase_key: Supabase key (optional, uses env var if not provided)
        
    Returns:
        SupabaseManager instance
    """
    return SupabaseManager(supabase_url=supabase_url, supabase_key=supabase_key)


if __name__ == "__main__":
    # Test script
    print("Testing Supabase Manager...")
    
    try:
        manager = create_supabase_manager()
        
        print("\\n1. Testing connection...")
        if manager.test_connection():
            print("✓ Connection successful")
        else:
            print("✗ Connection failed")
            
    except Exception as e:
        print(f"✗ Error: {e}")
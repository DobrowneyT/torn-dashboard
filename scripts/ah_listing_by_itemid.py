"""
Auction House Listing Scraper by Item ID
Fetches all auction house listings for a specific item and stores them in JSON or Supabase.

SMART INCREMENTAL UPDATES:
- If JSON file exists, automatically starts from the newest timestamp in the file
- If using Supabase, automatically starts from newest timestamp in DB
- Only fetches new listings that don't already exist
- Perfect for daily/periodic updates without re-scraping old data

Usage:
    # JSON storage (default)
    python ah_listing_by_itemid.py --item-id 27 --from-ts 1577858400 --to-ts 1777858400
    
    # Supabase storage
    python ah_listing_by_itemid.py --item-id 27 --from-ts 1577858400 --to-ts 1777858400 --storage supabase
"""

import os
import sys
import logging
import argparse
from typing import Dict, List, Optional
from datetime import datetime
from pathlib import Path

# Add project root to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from utils.torn_api import TornAPI, TornAPIError
from utils.json_storage import JSONStorageManager
from utils.supabase_manager import SupabaseManager, SupabaseManagerError

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class AuctionHouseScraper:
    """Scrape auction house listings for items and store in JSON or Supabase"""
    
    def __init__(
        self, 
        api_key: Optional[str] = None,
        storage_type: str = 'json',
        supabase_url: Optional[str] = None,
        supabase_key: Optional[str] = None
    ):
        """
        Initialize the auction house scraper
        
        Args:
            api_key: Torn API key. If None, reads from TORN_API_KEY env variable
            storage_type: 'json' or 'supabase'
            supabase_url: Supabase project URL (optional, uses env var if not provided)
            supabase_key: Supabase key (optional, uses env var if not provided)
        """
        self.api_key = api_key or os.environ.get('TORN_API_KEY')
        
        if not self.api_key:
            raise ValueError("TORN_API_KEY not found in environment or parameters")
        
        self.api = TornAPI(self.api_key)
        self.storage_type = storage_type.lower()
        
        # Initialize storage backend
        if self.storage_type == 'json':
            self.json_storage = JSONStorageManager(data_dir='data/ah')
            self.db = None
            logger.info("Auction House Scraper initialized (JSON storage)")
        elif self.storage_type == 'supabase':
            self.json_storage = None
            self.db = SupabaseManager(supabase_url=supabase_url, supabase_key=supabase_key)
            logger.info("Auction House Scraper initialized (Supabase storage)")
        else:
            raise ValueError(f"Invalid storage_type: {storage_type}. Must be 'json' or 'supabase'")
    
    def _get_filename(self, item_id: int) -> str:
        """Get the JSON filename for an item (JSON storage only)"""
        return f"{item_id}_ah_listings.json"
    
    def _load_existing_data_json(self, item_id: int) -> Dict:
        """Load existing data from JSON file"""
        filename = self._get_filename(item_id)
        existing_data = self.json_storage.read_json(filename)
        
        if existing_data:
            logger.info(f"Loaded existing data with {len(existing_data.get('listings', {}))} listings")
            return existing_data
        
        # Initialize new data structure
        logger.info(f"Creating new data file for item {item_id}")
        return {
            'item_info': {
                'id': item_id,
                'name': None,
                'type': None,
                'sub_type': None
            },
            'metadata': {
                'last_updated': None,
                'total_listings': 0,
                'oldest_timestamp': None,
                'newest_timestamp': None,
                'scrape_history': []
            },
            'listings': {}
        }
    
    def _get_newest_timestamp(self, item_id: int) -> Optional[int]:
        """Get newest timestamp for item from storage (JSON or Supabase)"""
        if self.storage_type == 'json':
            data = self._load_existing_data_json(item_id)
            return data['metadata'].get('newest_timestamp')
        else:  # supabase
            return self.db.get_latest_timestamp_for_item(item_id)
    
    def _determine_fetch_start_timestamp(
        self, 
        item_id: int,
        requested_from: Optional[int]
    ) -> Optional[int]:
        """
        Determine the actual timestamp to start fetching from
        
        Logic:
        1. Check newest timestamp in storage (JSON or DB)
        2. If exists, use newest + 1
        3. Otherwise use requested from_timestamp
        
        Args:
            item_id: Item ID
            requested_from: User-requested from timestamp
            
        Returns:
            Timestamp to start fetching from
        """
        newest_in_storage = self._get_newest_timestamp(item_id)
        
        if newest_in_storage is not None:
            smart_from = newest_in_storage + 1
            
            if requested_from is not None:
                actual_from = max(smart_from, requested_from)
                
                if actual_from != requested_from:
                    logger.info(f"SMART UPDATE: Storage has data up to timestamp {newest_in_storage}")
                    logger.info(f"  Requested from: {requested_from}")
                    logger.info(f"  Using instead:  {actual_from} (newest in storage + 1)")
                    logger.info(f"  This will skip {actual_from - requested_from} seconds of existing data")
            else:
                actual_from = smart_from
                logger.info(f"SMART UPDATE: Storage has data up to timestamp {newest_in_storage}")
                logger.info(f"  Starting from:  {actual_from} (newest in storage + 1)")
            
            return actual_from
        else:
            if requested_from is not None:
                logger.info(f"NEW DATA: Starting from requested timestamp: {requested_from}")
            else:
                logger.info(f"NEW DATA: Starting from beginning (no timestamp limit)")
            return requested_from
    
    def _update_item_info(self, data: Dict, listing: Dict):
        """Update item info from a listing (JSON storage only)"""
        item = listing.get('item', {})
        
        if not data['item_info']['name']:
            data['item_info']['name'] = item.get('name')
        if not data['item_info']['type']:
            data['item_info']['type'] = item.get('type')
        if not data['item_info']['sub_type']:
            data['item_info']['sub_type'] = item.get('sub_type')
    
    def _add_listing_json(self, data: Dict, listing: Dict) -> bool:
        """Add a listing to JSON data structure"""
        auction_id = str(listing['id'])
        
        if auction_id in data['listings']:
            return False
        
        data['listings'][auction_id] = listing
        self._update_item_info(data, listing)
        
        timestamp = listing['timestamp']
        if data['metadata']['oldest_timestamp'] is None or timestamp < data['metadata']['oldest_timestamp']:
            data['metadata']['oldest_timestamp'] = timestamp
        if data['metadata']['newest_timestamp'] is None or timestamp > data['metadata']['newest_timestamp']:
            data['metadata']['newest_timestamp'] = timestamp
        
        return True
    
    def _save_data_json(self, item_id: int, data: Dict, scrape_info: Dict):
        """Save data to JSON file"""
        data['metadata']['last_updated'] = datetime.now().isoformat()
        data['metadata']['total_listings'] = len(data['listings'])
        data['metadata']['scrape_history'].append(scrape_info)
        
        if len(data['metadata']['scrape_history']) > 50:
            data['metadata']['scrape_history'] = data['metadata']['scrape_history'][-50:]
        
        filename = self._get_filename(item_id)
        self.json_storage.write_json(filename, data, create_backup=True)
        
        logger.info(f"Saved {data['metadata']['total_listings']} listings to {filename}")
    
    def scrape_item(
        self,
        item_id: int,
        from_timestamp: Optional[int] = None,
        to_timestamp: Optional[int] = None
    ) -> Dict:
        """
        Scrape auction house listings for an item
        
        Args:
            item_id: Item ID to scrape
            from_timestamp: Start timestamp (None = from beginning)
            to_timestamp: End timestamp (None = to now)
            
        Returns:
            Statistics about the scrape
        """
        logger.info("=" * 60)
        logger.info(f"Starting Auction House Scrape for Item ID: {item_id}")
        logger.info(f"Storage Type: {self.storage_type.upper()}")
        logger.info(f"Requested From: {from_timestamp} | To: {to_timestamp}")
        logger.info("=" * 60)
        
        # Determine actual fetch start timestamp
        actual_from_timestamp = self._determine_fetch_start_timestamp(item_id, from_timestamp)
        
        logger.info("=" * 60)
        logger.info(f"Actual Fetch Range: {actual_from_timestamp} to {to_timestamp}")
        logger.info("=" * 60)
        
        # Fetch all listings with pagination
        try:
            listings = self.api.get_all_auction_house_listings_paginated(
                item_id=item_id,
                from_timestamp=actual_from_timestamp,
                to_timestamp=to_timestamp,
                sort="ASC"
            )
        except TornAPIError as e:
            logger.error(f"API error during scrape: {e}")
            return {
                'success': False,
                'error': str(e),
                'item_id': item_id
            }
        
        if not listings:
            logger.warning("No listings fetched from API")
            return {
                'success': True,
                'item_id': item_id,
                'fetched': 0,
                'new_listings': 0,
                'duplicates': 0
            }
        
        # Store listings based on storage type
        if self.storage_type == 'json':
            result = self._store_to_json(item_id, listings, from_timestamp, actual_from_timestamp, to_timestamp)
        else:  # supabase
            result = self._store_to_supabase(item_id, listings, from_timestamp, actual_from_timestamp, to_timestamp)
        
        return result
    
    def _store_to_json(
        self, 
        item_id: int, 
        listings: List[Dict],
        requested_from: Optional[int],
        actual_from: Optional[int],
        to_timestamp: Optional[int]
    ) -> Dict:
        """Store listings to JSON file"""
        data = self._load_existing_data_json(item_id)
        
        new_count = 0
        duplicate_count = 0
        
        for listing in listings:
            if self._add_listing_json(data, listing):
                new_count += 1
            else:
                duplicate_count += 1
        
        scrape_info = {
            'timestamp': datetime.now().isoformat(),
            'requested_from_timestamp': requested_from,
            'actual_from_timestamp': actual_from,
            'to_timestamp': to_timestamp,
            'fetched': len(listings),
            'new_listings': new_count,
            'duplicates': duplicate_count
        }
        
        self._save_data_json(item_id, data, scrape_info)
        
        logger.info("=" * 60)
        logger.info(f"Scrape Summary for Item {item_id}:")
        logger.info(f"  Item Name: {data['item_info']['name']}")
        logger.info(f"  Listings fetched from API: {len(listings)}")
        logger.info(f"  New listings added: {new_count}")
        logger.info(f"  Duplicates skipped: {duplicate_count}")
        logger.info(f"  Total listings in database: {len(data['listings'])}")
        logger.info("=" * 60)
        
        return {
            'success': True,
            'item_id': item_id,
            'item_name': data['item_info']['name'],
            'fetched': len(listings),
            'new_listings': new_count,
            'duplicates': duplicate_count,
            'total_listings': len(data['listings'])
        }
    
    def _store_to_supabase(
        self, 
        item_id: int, 
        listings: List[Dict],
        requested_from: Optional[int],
        actual_from: Optional[int],
        to_timestamp: Optional[int]
    ) -> Dict:
        """Store listings to Supabase database"""
        try:
            # Batch upsert to database
            upsert_result = self.db.batch_upsert_listings(listings)
            
            # Get updated stats from database
            stats = self.db.get_item_stats(item_id)
            
            logger.info("=" * 60)
            logger.info(f"Scrape Summary for Item {item_id}:")
            logger.info(f"  Listings fetched from API: {len(listings)}")
            logger.info(f"  Upserted to database: {upsert_result['inserted']}")
            logger.info(f"  Errors: {upsert_result['errors']}")
            logger.info(f"  Total listings in database: {stats['total_listings']}")
            logger.info("=" * 60)
            
            return {
                'success': True,
                'item_id': item_id,
                'fetched': len(listings),
                'upserted': upsert_result['inserted'],
                'errors': upsert_result['errors'],
                'total_listings': stats['total_listings']
            }
            
        except SupabaseManagerError as e:
            logger.error(f"Database error during store: {e}")
            return {
                'success': False,
                'error': str(e),
                'item_id': item_id
            }
    
    def get_item_summary(self, item_id: int) -> Optional[Dict]:
        """Get summary of stored data for an item"""
        if self.storage_type == 'json':
            filename = self._get_filename(item_id)
            data = self.json_storage.read_json(filename)
            
            if not data:
                return None
            
            return {
                'item_id': item_id,
                'item_name': data['item_info']['name'],
                'item_type': data['item_info']['type'],
                'item_sub_type': data['item_info']['sub_type'],
                'total_listings': data['metadata']['total_listings'],
                'oldest_timestamp': data['metadata']['oldest_timestamp'],
                'newest_timestamp': data['metadata']['newest_timestamp'],
                'last_updated': data['metadata']['last_updated']
            }
        else:  # supabase
            return self.db.get_item_stats(item_id)

def main():
    """Main execution function with CLI arguments"""
    parser = argparse.ArgumentParser(
        description='Scrape Torn City Auction House listings for a specific item'
    )
    parser.add_argument(
        '--item-id', '-i',
        type=int,
        required=True,
        help='Item ID to scrape (e.g., 27 for M4A1 Colt Carbine)'
    )
    parser.add_argument(
        '--from-ts', '-f',
        type=int,
        default=None,
        help='Start timestamp (Unix timestamp, optional)'
    )
    parser.add_argument(
        '--to-ts', '-t',
        type=int,
        default=None,
        help='End timestamp (Unix timestamp, optional)'
    )
    parser.add_argument(
        '--storage', '-s',
        type=str,
        default='json',
        choices=['json', 'supabase'],
        help='Storage backend: json or supabase (default: json)'
    )
    parser.add_argument(
        '--api-key', '-k',
        type=str,
        default=None,
        help='Torn API key (optional, uses TORN_API_KEY env var if not provided)'
    )
    
    args = parser.parse_args()
    
    try:
        scraper = AuctionHouseScraper(
            api_key=args.api_key,
            storage_type=args.storage
        )
        stats = scraper.scrape_item(
            item_id=args.item_id,
            from_timestamp=args.from_ts,
            to_timestamp=args.to_ts
        )
        
        if stats.get('success'):
            logger.info("Scrape completed successfully!")
            return 0
        else:
            logger.error(f"Scrape failed: {stats.get('error')}")
            return 1
            
    except Exception as e:
        logger.error(f"Fatal error: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    sys.exit(main())
"""
Bulk Auction House Scraper Test - Supabase Edition

This script scrapes auction house listings for MULTIPLE items and stores them in Supabase.
Perfect for daily scheduled runs to keep your database up to date.

Features:
- Processes multiple items sequentially
- Smart incremental updates (only fetches new data)
- Batch upserts to Supabase for efficiency
- Progress tracking and statistics
"""

import os
import sys
from pathlib import Path
from datetime import datetime
import time

# Add project root to Python path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from scripts.ah_listing_by_itemid import AuctionHouseScraper

# ============================================================================
# CONFIGURATION - MODIFY THESE VALUES
# ============================================================================

# API Keys - Set these OR use environment variables
TORN_API_KEY = "225eKmgnVTCUxeaS"  # Set to your key, or leave None to use env var TORN_API_KEY
SUPABASE_URL = "https://uyqkwxopbsoeukfbvsap.supabase.co"  # Set to your URL, or leave None to use env var SUPABASE_URL
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5cWt3eG9wYnNvZXVrZmJ2c2FwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzMwODU5MCwiZXhwIjoyMDgyODg0NTkwfQ.I_pf7Nl8CgaTGSCr31OH2e0LhLL6ZtvpDe0VAefvfq0"  # Set to your key, or leave None to use env var SUPABASE_KEY

# Timestamp range
# For daily updates: Set FROM_TIMESTAMP to a date in the past (will be auto-adjusted)
# and TO_TIMESTAMP to now or None
FROM_TIMESTAMP = 1577858400  # Jan 1, 2020 (will be overridden by smart update)
TO_TIMESTAMP = None  # None = up to now

# Storage type: 'supabase' for database, 'json' for local files
STORAGE_TYPE = 'supabase'

# Item IDs to scrape (ALL weapons + armors you specified)
ITEM_IDS = [
    # Melee Weapons
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 110, 111, 146, 147, 170, 173, 217, 224, 227, 
    234, 235, 236, 237, 238, 245, 247, 250, 251, 289, 290, 291, 292, 346, 359, 360, 
    387, 391, 395, 397, 400, 401, 402, 438, 439, 440, 539, 599, 600, 604, 605, 614, 
    615, 632, 790, 792, 805, 832, 839, 846, 850, 871, 1053, 1055, 1158, 1159, 1231, 
    1255, 1257,
    
    # Primary Weapons  
    22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 63, 76, 98, 100, 108, 174, 219, 223, 225, 
    228, 231, 232, 241, 249, 252, 382, 398, 399, 484, 487, 488, 545, 546, 547, 548, 
    549, 612, 830, 837, 874, 1155, 1156, 1157,
    
    # Secondary Weapons
    12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 99, 109, 175, 177, 189, 218, 230, 233, 
    240, 243, 244, 248, 253, 254, 255, 388, 393, 483, 485, 486, 489, 490, 613, 831, 
    838, 844, 1152, 1153, 1154,
    
    # Armor
    32, 33, 34, 49, 50, 176, 178, 332, 333, 334, 348, 538, 640, 641, 642, 643, 644, 
    645, 646, 647, 648, 649, 650, 651, 652, 653, 654, 655, 656, 657, 658, 659, 660, 
    661, 662, 663, 664, 665, 666, 667, 668, 669, 670, 671, 672, 673, 674, 675, 676, 
    677, 678, 679, 680, 681, 682, 683, 684, 848, 1164, 1165, 1166, 1167, 1168, 1174, 
    1307, 1308, 1309, 1310, 1311, 1355, 1356, 1357, 1358, 1359
]

# ITEM_IDS = [5, 27, 17, 655]  # For testing, only a few items

# ============================================================================
# END CONFIGURATION
# ============================================================================

def timestamp_to_date(ts):
    """Convert Unix timestamp to readable date string"""
    if ts is None:
        return "None (up to now)"
    return datetime.utcfromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S UTC')

def run_bulk_scrape():
    """Run bulk scrape for all configured items"""
    
    print("=" * 80)
    print("BULK AUCTION HOUSE SCRAPER - SUPABASE EDITION")
    print("=" * 80)
    print()
    print(f"Total Items to Scrape: {len(ITEM_IDS)}")
    print(f"Storage Type:          {STORAGE_TYPE.upper()}")
    print(f"From Timestamp:        {FROM_TIMESTAMP} ({timestamp_to_date(FROM_TIMESTAMP)})")
    print(f"To Timestamp:          {TO_TIMESTAMP} ({timestamp_to_date(TO_TIMESTAMP)})")
    print()
    
    # Check API keys
    torn_api_key = TORN_API_KEY or os.environ.get('TORN_API_KEY')
    if not torn_api_key:
        print("ERROR: TORN_API_KEY not found!")
        print("Set TORN_API_KEY in this script or as environment variable")
        return False
    
    if STORAGE_TYPE == 'supabase':
        supabase_url = SUPABASE_URL or os.environ.get('SUPABASE_URL')
        supabase_key = SUPABASE_KEY or os.environ.get('SUPABASE_KEY')
        
        if not supabase_url or not supabase_key:
            print("ERROR: SUPABASE_URL and/or SUPABASE_KEY not found!")
            print("Set SUPABASE_URL and SUPABASE_KEY in this script or as environment variables")
            return False
        
        print(f"Torn API Key:    {'*' * 10}{torn_api_key[-6:]}")
        print(f"Supabase URL:    {supabase_url}")
        print(f"Supabase Key:    {'*' * 10}{supabase_key[-6:]}")
    else:
        print(f"Torn API Key:    {'*' * 10}{torn_api_key[-6:]}")
    
    print()
    print("-" * 80)
    print()
    
    # Initialize scraper
    try:
        if STORAGE_TYPE == 'supabase':
            scraper = AuctionHouseScraper(
                api_key=torn_api_key,
                storage_type=STORAGE_TYPE,
                supabase_url=supabase_url,
                supabase_key=supabase_key
            )
        else:
            scraper = AuctionHouseScraper(
                api_key=torn_api_key,
                storage_type=STORAGE_TYPE
            )
        
        print("✓ Scraper initialized successfully")
        print()
    except Exception as e:
        print(f"✗ Failed to initialize scraper: {e}")
        return False
    
    # Track overall statistics
    start_time = time.time()
    total_stats = {
        'items_processed': 0,
        'items_failed': 0,
        'total_fetched': 0,
        'total_new': 0,
        'total_errors': 0
    }
    
    failed_items = []
    
    # Process each item
    for idx, item_id in enumerate(ITEM_IDS, 1):
        print("=" * 80)
        print(f"Processing Item {idx}/{len(ITEM_IDS)}: ID {item_id}")
        print("=" * 80)
        
        try:
            stats = scraper.scrape_item(
                item_id=item_id,
                from_timestamp=FROM_TIMESTAMP,
                to_timestamp=TO_TIMESTAMP
            )
            
            if stats.get('success'):
                total_stats['items_processed'] += 1
                total_stats['total_fetched'] += stats.get('fetched', 0)
                
                if STORAGE_TYPE == 'supabase':
                    total_stats['total_new'] += stats.get('upserted', 0)
                    total_stats['total_errors'] += stats.get('errors', 0)
                else:
                    total_stats['total_new'] += stats.get('new_listings', 0)
                
                print(f"✓ Item {item_id} completed successfully")
            else:
                total_stats['items_failed'] += 1
                failed_items.append((item_id, stats.get('error', 'Unknown error')))
                print(f"✗ Item {item_id} failed: {stats.get('error')}")
            
        except Exception as e:
            total_stats['items_failed'] += 1
            failed_items.append((item_id, str(e)))
            print(f"✗ Item {item_id} exception: {e}")
        
        print()
        
        # Small delay between items to be respectful to API
        if idx < len(ITEM_IDS):
            time.sleep(1)
    
    # Final summary
    elapsed_time = time.time() - start_time
    
    print()
    print("=" * 80)
    print("BULK SCRAPE COMPLETE")
    print("=" * 80)
    print()
    print(f"Time Elapsed:         {elapsed_time:.1f} seconds ({elapsed_time/60:.1f} minutes)")
    print(f"Items Processed:      {total_stats['items_processed']}/{len(ITEM_IDS)}")
    print(f"Items Failed:         {total_stats['items_failed']}")
    print(f"Total Listings Fetched: {total_stats['total_fetched']}")
    
    if STORAGE_TYPE == 'supabase':
        print(f"Total Upserted to DB: {total_stats['total_new']}")
        print(f"Total Errors:         {total_stats['total_errors']}")
    else:
        print(f"Total New Listings:   {total_stats['total_new']}")
    
    if failed_items:
        print()
        print("Failed Items:")
        for item_id, error in failed_items:
            print(f"  - Item {item_id}: {error}")
    
    print()
    print("=" * 80)
    
    return total_stats['items_failed'] == 0

if __name__ == "__main__":
    print()
    
    success = run_bulk_scrape()
    
    print()
    print("Next Steps:")
    if STORAGE_TYPE == 'supabase':
        print("  1. Check your Supabase dashboard to verify data was inserted")
        print("  2. Run SQL queries to analyze your auction house data")
        print("  3. Schedule this script to run daily for continuous updates")
    else:
        print("  1. Check data/ah/ folder for JSON files")
        print("  2. Modify STORAGE_TYPE to 'supabase' when ready for production")
    
    sys.exit(0 if success else 1)
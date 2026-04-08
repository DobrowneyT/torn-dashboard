"""
Test Script for Auction House Listing Scraper

This script allows easy testing of the AH scraper with configurable parameters.
Modify the CONFIGURATION section below to test different scenarios.

Test Scenarios:
1. Initial scrape: Set timestamps for a small date range
2. Update scrape: Change timestamps to include new data and verify no duplicates
3. Overlap test: Use overlapping timestamp ranges to verify deduplication works
"""

import os
import sys
from pathlib import Path
from datetime import datetime

# Add project root to Python path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from scripts.ah_listing_by_itemid import AuctionHouseScraper

# ============================================================================
# CONFIGURATION - MODIFY THESE VALUES FOR TESTING
# ============================================================================

# Your Torn API key (or set TORN_API_KEY environment variable)
API_KEY = None  # Set your TORN_API_KEY here or use env var  # Set to your key string, or leave None to use env var

# Item ID to scrape
# Common weapon IDs:
#   27 = M4A1 Colt Carbine
#   28 = Steyr AUG
#   29 = FAMAS
#   30 = Minigun
#   73 = Kodachi
ITEM_ID = 27

# Timestamp range (Unix timestamps)
FROM_TIMESTAMP = 1577858400  # Dec 25, 2025
TO_TIMESTAMP = 1769925600    # Dec 31, 2025

# ============================================================================
# END CONFIGURATION
# ============================================================================


def timestamp_to_date(ts):
    """Convert Unix timestamp to readable date string"""
    if ts is None:
        return "None (no limit)"
    return datetime.utcfromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S UTC')


def run_test():
    """Run the auction house scraper test"""
    
    print("=" * 70)
    print("AUCTION HOUSE SCRAPER TEST")
    print("=" * 70)
    print()
    print(f"Item ID:        {ITEM_ID}")
    print(f"From Timestamp: {FROM_TIMESTAMP} ({timestamp_to_date(FROM_TIMESTAMP)})")
    print(f"To Timestamp:   {TO_TIMESTAMP} ({timestamp_to_date(TO_TIMESTAMP)})")
    print()
    
    # Check for API key
    api_key = API_KEY or os.environ.get('TORN_API_KEY')
    if not api_key:
        print("ERROR: No API key found!")
        print("Either set API_KEY in this script or set TORN_API_KEY environment variable")
        print()
        print("Example:")
        print("  export TORN_API_KEY='your_api_key_here'")
        print("  python test_get_ah_listings.py")
        return False
    
    print(f"API Key:        {'*' * 10}{api_key[-6:]}")  # Show only last 6 chars
    print()
    print("-" * 70)
    print()
    
    try:
        # Initialize scraper
        scraper = AuctionHouseScraper(api_key=api_key)
        
        # Check existing data before scrape
        print("Checking existing data...")
        existing_summary = scraper.get_item_summary(ITEM_ID)
        if existing_summary:
            print(f"  Existing file found:")
            print(f"    Item Name: {existing_summary['item_name']}")
            print(f"    Total Listings: {existing_summary['total_listings']}")
            print(f"    Last Updated: {existing_summary['last_updated']}")
        else:
            print("  No existing data found - will create new file")
        print()
        
        # Run the scrape
        print("Starting scrape...")
        print()
        
        stats = scraper.scrape_item(
            item_id=ITEM_ID,
            from_timestamp=FROM_TIMESTAMP,
            to_timestamp=TO_TIMESTAMP
        )
        
        print()
        print("-" * 70)
        print("RESULTS")
        print("-" * 70)
        print()
        
        if stats.get('success'):
            print(f"✓ Scrape completed successfully!")
            print()
            print(f"  Item ID:         {stats['item_id']}")
            print(f"  Item Name:       {stats.get('item_name', 'Unknown')}")
            print(f"  Fetched from API: {stats['fetched']} listings")
            print(f"  New listings:    {stats['new_listings']}")
            print(f"  Duplicates:      {stats['duplicates']}")
            print(f"  Total in DB:     {stats['total_listings']}")
            print()
            print(f"  Date range in DB:")
            print(f"    Oldest: {stats.get('oldest_timestamp')} ({timestamp_to_date(stats.get('oldest_timestamp'))})")
            print(f"    Newest: {stats.get('newest_timestamp')} ({timestamp_to_date(stats.get('newest_timestamp'))})")
            print()
            print(f"  Data saved to: data/ah/{ITEM_ID}_ah_listings.json")
            return True
        else:
            print(f"✗ Scrape failed!")
            print(f"  Error: {stats.get('error')}")
            return False
            
    except Exception as e:
        print(f"✗ Exception occurred: {e}")
        import traceback
        traceback.print_exc()
        return False


def show_data_summary():
    """Show summary of data currently stored for the item"""
    print()
    print("=" * 70)
    print("CURRENT DATA SUMMARY")
    print("=" * 70)
    print()
    
    api_key = API_KEY or os.environ.get('TORN_API_KEY')
    if not api_key:
        print("No API key - cannot initialize scraper")
        return
    
    try:
        scraper = AuctionHouseScraper(api_key=api_key)
        summary = scraper.get_item_summary(ITEM_ID)
        
        if summary:
            print(f"Item ID:        {summary['item_id']}")
            print(f"Item Name:      {summary['item_name']}")
            print(f"Item Type:      {summary['item_type']}")
            print(f"Item Sub-Type:  {summary['item_sub_type']}")
            print(f"Total Listings: {summary['total_listings']}")
            print(f"Oldest:         {timestamp_to_date(summary['oldest_timestamp'])}")
            print(f"Newest:         {timestamp_to_date(summary['newest_timestamp'])}")
            print(f"Last Updated:   {summary['last_updated']}")
        else:
            print(f"No data found for item {ITEM_ID}")
            
    except Exception as e:
        print(f"Error: {e}")


if __name__ == "__main__":
    print()
    
    # Run the test
    success = run_test()
    
    # Show final data summary
    show_data_summary()
    
    print()
    print("=" * 70)
    print("TEST COMPLETE")
    print("=" * 70)
    print()
    
    if success:
        print("Next steps:")
        print("  1. Check data/ah/{}_ah_listings.json to verify data".format(ITEM_ID))
        print("  2. Modify FROM_TIMESTAMP and TO_TIMESTAMP in this script")
        print("  3. Run again to test incremental updates and deduplication")
        print()
        print("Example test flow:")
        print("  Test 1: FROM=1668000000, TO=1668604800 (1 week)")
        print("  Test 2: FROM=1668000000, TO=1669209600 (2 weeks, overlapping)")
        print("  -> Verify 'duplicates' count shows overlap was handled")
    
    sys.exit(0 if success else 1)
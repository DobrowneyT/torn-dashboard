"""
Local testing for payout analysis
Tests with actual data from crimes_database.json
Can write test timestamps to Dashboard or use manual input
"""

import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent))


def print_section(title):
    """Print section header"""
    print("\n" + "="*60)
    print(f"  {title}")
    print("="*60)


def load_env_file():
    """Load environment variables from .env.local"""
    env_file = Path('.env.local')
    if env_file.exists():
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    os.environ[key] = value
        print("✓ Loaded .env.local")
    else:
        print("⚠ .env.local not found - using environment variables")


def main():
    """Run payout analysis test"""
    print_section("Payout Analysis - Local Test")
    
    # Load environment
    load_env_file()
    
    # Verify required variables
    required = ['TORN_API_KEY', 'GOOGLE_SHEETS_ID']
    missing = [var for var in required if not os.environ.get(var)]
    
    if missing:
        print(f"✗ Missing environment variables: {', '.join(missing)}")
        print("\nPlease set these in .env.local:")
        for var in missing:
            print(f"  {var}=your_value_here")
        sys.exit(1)
    
    print("✓ All required environment variables set")
    
    # Get time window
    print("\n" + "-"*60)
    print("Time Window Selection")
    print("-"*60)
    
    print("\nOptions:")
    print("  1. Last 7 days")
    print("  2. Last 30 days")
    print("  3. Custom timestamps")
    print("  4. Read from Dashboard sheet (cells F2:F3)")
    
    choice = input("\nSelect option (1-4): ").strip()
    
    if choice == '1':
        to_ts = int(datetime.now().timestamp())
        from_ts = int((datetime.now() - timedelta(days=7)).timestamp())
        write_to_sheet = True
    elif choice == '2':
        to_ts = int(datetime.now().timestamp())
        from_ts = int((datetime.now() - timedelta(days=30)).timestamp())
        write_to_sheet = True
    elif choice == '3':
        print("\nEnter Unix timestamps (or press Enter for defaults):")
        from_input = input("  From timestamp: ").strip()
        to_input = input("  To timestamp: ").strip()
        
        if from_input and to_input:
            from_ts = int(from_input)
            to_ts = int(to_input)
        else:
            # Default to last 7 days
            to_ts = int(datetime.now().timestamp())
            from_ts = int((datetime.now() - timedelta(days=7)).timestamp())
            print("  Using default: last 7 days")
        write_to_sheet = True
    elif choice == '4':
        # Read from sheet
        print("\n✓ Will read timestamps from Dashboard F2:F3")
        from_ts = None
        to_ts = None
        write_to_sheet = False
    else:
        print("Invalid choice, using last 7 days")
        to_ts = int(datetime.now().timestamp())
        from_ts = int((datetime.now() - timedelta(days=7)).timestamp())
        write_to_sheet = True
    
    # Write timestamps to sheet if needed
    if write_to_sheet and from_ts and to_ts:
        try:
            from scripts.utils.google_sheets import GoogleSheetsManager
            
            sheets = GoogleSheetsManager()
            
            print(f"\n✓ Writing timestamps to Dashboard sheet...")
            sheets.write_cell('Dashboard', 'F2', from_ts)  # 📍 FROM_TIMESTAMP cell
            sheets.write_cell('Dashboard', 'F3', to_ts)    # 📍 TO_TIMESTAMP cell
            print(f"  F2 (From): {from_ts}")
            print(f"  F3 (To): {to_ts}")
            
            # Display window
            from_date = datetime.fromtimestamp(from_ts).strftime('%Y-%m-%d %H:%M:%S')
            to_date = datetime.fromtimestamp(to_ts).strftime('%Y-%m-%d %H:%M:%S')
            duration_days = (to_ts - from_ts) / 86400
            
            print(f"\n✓ Analysis Window:")
            print(f"  From: {from_date}")
            print(f"  To:   {to_date}")
            print(f"  Duration: {duration_days:.1f} days")
            
        except Exception as e:
            print(f"\n⚠ Could not write to sheet: {e}")
            print("  Will use environment variables instead")
            os.environ['FROM_TIMESTAMP'] = str(from_ts)
            os.environ['TO_TIMESTAMP'] = str(to_ts)
    elif from_ts and to_ts:
        # Set environment variables as backup
        os.environ['FROM_TIMESTAMP'] = str(from_ts)
        os.environ['TO_TIMESTAMP'] = str(to_ts)
    
    # Set testing mode (prevents auto-commit)
    os.environ['TESTING_MODE'] = 'true'
    
    # Confirm
    print("\n" + "-"*60)
    confirm = input("Proceed with analysis? (y/n): ").strip().lower()
    if confirm != 'y':
        print("Analysis cancelled")
        return
    
    # Run analysis
    print_section("Running Payout Analysis")
    
    try:
        from scripts.run_payout_analysis import main as run_analysis
        
        run_analysis()
        
        print_section("Test Completed Successfully!")
        print("\n✓ Check your Google Sheets for results:")
        print("  - Dashboard (payout summary)")
        print("  - Weekly_Analysis sheet")
        print("  - Payout_Calculator sheet")
        print("  - item_outcomes sheet")
        print("\n✓ Check data/ folder for any updates")
        
    except Exception as e:
        print(f"\n✗ Test failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
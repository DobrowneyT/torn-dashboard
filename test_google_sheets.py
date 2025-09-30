"""
Test script for Google Sheets integration
Run this after setting up your Google Sheet to verify everything works
"""

import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

# Add project root to Python path
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

from scripts.utils.google_sheets import GoogleSheetsManager


def print_section(title):
    """Print a section header"""
    print(f"\n{'='*60}")
    print(f"  {title}")
    print('='*60)


def test_connection(sheets):
    """Test basic connection to Google Sheets"""
    print_section("TEST 1: Connection Test")
    
    if sheets.test_connection():
        print("✓ Successfully connected to Google Sheets")
        
        # Get spreadsheet properties
        props = sheets.get_sheet_properties()
        title = props.get('properties', {}).get('title', 'Unknown')
        print(f"✓ Spreadsheet: {title}")
        
        # List all sheets
        sheet_list = props.get('sheets', [])
        print(f"\n✓ Found {len(sheet_list)} sheets:")
        for sheet in sheet_list:
            sheet_name = sheet.get('properties', {}).get('title', 'Unknown')
            print(f"  - {sheet_name}")
        
        return True
    else:
        print("✗ Connection failed")
        return False


def test_config_operations(sheets):
    """Test reading and writing config"""
    print_section("TEST 2: Config Operations")
    
    try:
        # Read config
        print("\nReading config values...")
        config = sheets.read_config()
        print(f"✓ Read {len(config)} config entries")
        
        # Display some config values
        if config:
            print("\nSample config values:")
            for i, (key, value) in enumerate(list(config.items())[:5]):
                print(f"  {key}: {value}")
        
        # Test status update
        print("\nUpdating CPR scrape status...")
        test_status = f"Test at {datetime.now().strftime('%H:%M:%S')}"
        sheets.update_status(test_status)
        print(f"✓ Status updated: {test_status}")
        
        # Verify status was updated
        status = sheets.read_cell(sheets.SHEET_CONFIG, "B10")
        if status == test_status:
            print("✓ Status verified in sheet")
        
        return True
        
    except Exception as e:
        print(f"✗ Config operations failed: {e}")
        return False


def test_dashboard_operations(sheets):
    """Test dashboard updates"""
    print_section("TEST 3: Dashboard Operations")
    
    try:
        # Update dashboard stats
        print("\nUpdating dashboard statistics...")
        test_stats = {
            'total_crimes': 150,
            'pending_crimes': 12,
            'completed_this_week': 25,
            'active_members': 18,
        }
        
        sheets.update_dashboard_stats(test_stats)
        print("✓ Dashboard stats updated")
        
        # Verify by reading back
        print("\nVerifying dashboard values...")
        values = sheets.read_range(sheets.SHEET_DASHBOARD, "A2:B6")
        print("✓ Dashboard values:")
        for row in values:
            if len(row) >= 2:
                print(f"  {row[0]}: {row[1]}")
        
        # Test pending crimes update
        print("\nUpdating pending crimes list...")
        test_crimes = [
            {
                'id': 12345,
                'name': 'Test Crime 1',
                'difficulty': 5,
                'status': 'available',
                'slots': 6,
                'participants': [1, 2, 3],
                'created_at': int(datetime.now().timestamp())
            },
            {
                'id': 12346,
                'name': 'Test Crime 2',
                'difficulty': 7,
                'status': 'available',
                'slots': 8,
                'participants': [1, 2, 3, 4],
                'created_at': int(datetime.now().timestamp())
            }
        ]
        
        sheets.update_dashboard_pending_crimes(test_crimes)
        print(f"✓ Updated {len(test_crimes)} pending crimes")
        
        return True
        
    except Exception as e:
        print(f"✗ Dashboard operations failed: {e}")
        return False


def test_member_operations(sheets):
    """Test member roster operations"""
    print_section("TEST 4: Member Operations")
    
    try:
        # Create test members
        print("\nCreating test member roster...")
        test_members = [
            {
                'member_id': 123456,
                'name': 'TestPlayer1',
                'tier': 'Tier 2',
                'cpr': 15,
                'status': 'Active'
            },
            {
                'member_id': 123457,
                'name': 'TestPlayer2',
                'tier': 'Tier 1',
                'cpr': 8,
                'status': 'Active'
            },
            {
                'member_id': 123458,
                'name': 'TestPlayer3',
                'tier': 'Tier 3',
                'cpr': 25,
                'status': 'Active'
            }
        ]
        
        sheets.update_members(test_members)
        print(f"✓ Updated {len(test_members)} members")
        
        # Read them back
        print("\nReading members back...")
        members = sheets.read_members()
        print(f"✓ Read {len(members)} members")
        for member in members[:3]:
            print(f"  - {member.get('name')} (ID: {member.get('member_id')}, Tier: {member.get('tier')})")
        
        return True
        
    except Exception as e:
        print(f"✗ Member operations failed: {e}")
        return False


def test_weekly_analysis(sheets):
    """Test weekly analysis sheet operations"""
    print_section("TEST 5: Weekly Analysis")
    
    try:
        print("\nWriting test weekly analysis...")
        
        period_start = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
        period_end = datetime.now().strftime('%Y-%m-%d')
        
        test_analysis = [
            {
                'member_id': 123456,
                'name': 'TestPlayer1',
                'tier': 'Tier 2',
                'total_time_hours': 72.5,
                'tier_multiplier': 1.5,
                'weighted_time': 108.75,
                'crime_count': 12
            },
            {
                'member_id': 123457,
                'name': 'TestPlayer2',
                'tier': 'Tier 1',
                'total_time_hours': 65.0,
                'tier_multiplier': 1.0,
                'weighted_time': 65.0,
                'crime_count': 10
            }
        ]
        
        sheets.write_weekly_analysis(test_analysis, period_start, period_end)
        print(f"✓ Wrote analysis for {len(test_analysis)} members")
        print(f"  Period: {period_start} to {period_end}")
        
        return True
        
    except Exception as e:
        print(f"✗ Weekly analysis failed: {e}")
        return False


def test_payout_operations(sheets):
    """Test payout calculator operations"""
    print_section("TEST 6: Payout Operations")
    
    try:
        print("\nWriting test payout data...")
        
        period_start = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
        period_end = datetime.now().strftime('%Y-%m-%d')
        
        test_payouts = [
            {
                'member_id': 123456,
                'name': 'TestPlayer1',
                'weighted_time': 108.75,
                'rate_per_hour': 50000,
                'calculated_payout': 5437500
            },
            {
                'member_id': 123457,
                'name': 'TestPlayer2',
                'weighted_time': 65.0,
                'rate_per_hour': 50000,
                'calculated_payout': 3250000
            }
        ]
        
        sheets.write_payout_data(test_payouts, period_start, period_end)
        print(f"✓ Wrote payout data for {len(test_payouts)} members")
        print(f"  Period: {period_start} to {period_end}")
        
        total = sum(p['calculated_payout'] for p in test_payouts)
        print(f"  Total payout: ${total:,}")
        
        return True
        
    except Exception as e:
        print(f"✗ Payout operations failed: {e}")
        return False


def test_cell_operations(sheets):
    """Test individual cell read/write"""
    print_section("TEST 7: Cell Operations")
    
    try:
        # Write to a test cell
        print("\nTesting cell write...")
        test_value = f"Test {datetime.now().strftime('%H:%M:%S')}"
        sheets.write_cell(sheets.SHEET_CONFIG, "B10", test_value)
        print(f"✓ Wrote to cell: {test_value}")
        
        # Read it back
        print("\nTesting cell read...")
        value = sheets.read_cell(sheets.SHEET_CONFIG, "B10")
        if value == test_value:
            print(f"✓ Read back correct value: {value}")
        else:
            print(f"✗ Value mismatch! Expected: {test_value}, Got: {value}")
            return False
        
        # Test range operations
        print("\nTesting range operations...")
        test_range = [
            ["Test1", "Value1"],
            ["Test2", "Value2"],
            ["Test3", "Value3"]
        ]
        
        sheets.write_range(sheets.SHEET_CONFIG, "A20:B22", test_range)
        print("✓ Wrote test range")
        
        read_range = sheets.read_range(sheets.SHEET_CONFIG, "A20:B22")
        if read_range == test_range:
            print("✓ Read back correct range")
        
        # Clear the test range
        sheets.clear_range(sheets.SHEET_CONFIG, "A20:B22")
        print("✓ Cleared test range")
        
        return True
        
    except Exception as e:
        print(f"✗ Cell operations failed: {e}")
        return False


def main():
    """Run all tests"""
    print("="*60)
    print("  Google Sheets Integration Test Suite")
    print("="*60)
    print(f"\nTest started at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    
    # Check for required environment variables
    spreadsheet_id = os.environ.get('GOOGLE_SHEETS_ID')
    if not spreadsheet_id:
        print("\n✗ Error: GOOGLE_SHEETS_ID environment variable not set")
        print("  Set it to your Google Sheets ID")
        return 1
    
    if not os.path.exists('google_credentials.json'):
        print("\n✗ Error: google_credentials.json not found")
        print("  Make sure your service account credentials are in the project root")
        return 1
    
    print(f"\n✓ Spreadsheet ID: {spreadsheet_id}")
    print("✓ Credentials file found")
    
    try:
        # Initialize sheets manager
        print("\nInitializing Google Sheets manager...")
        sheets = GoogleSheetsManager(spreadsheet_id=spreadsheet_id)
        print("✓ Manager initialized")
        
        # Run tests
        results = []
        results.append(("Connection", test_connection(sheets)))
        results.append(("Config Operations", test_config_operations(sheets)))
        results.append(("Dashboard Operations", test_dashboard_operations(sheets)))
        results.append(("Member Operations", test_member_operations(sheets)))
        results.append(("Weekly Analysis", test_weekly_analysis(sheets)))
        results.append(("Payout Operations", test_payout_operations(sheets)))
        results.append(("Cell Operations", test_cell_operations(sheets)))
        
        # Print summary
        print_section("TEST SUMMARY")
        print()
        
        passed = sum(1 for _, result in results if result)
        total = len(results)
        
        for test_name, result in results:
            status = "✓ PASSED" if result else "✗ FAILED"
            print(f"{status}: {test_name}")
        
        print(f"\n{passed}/{total} tests passed")
        
        if passed == total:
            print("\n" + "="*60)
            print("  All tests completed successfully!")
            print("="*60)
            print("\n✓ Your Google Sheets integration is working correctly!")
            print("\nNext steps:")
            print("  1. Review the test data in your spreadsheet")
            print("  2. Configure your actual config values")
            print("  3. Set up the CPR scrape trigger button")
            print("  4. Run your first crime data update")
            return 0
        else:
            print("\n✗ Some tests failed")
            print("  Check the error messages above")
            print("  Verify your sheet structure matches the setup guide")
            return 1
            
    except Exception as e:
        print(f"\n✗ Test suite failed with error: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    exit_code = main()
    sys.exit(exit_code)
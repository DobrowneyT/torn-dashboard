"""
Test script to verify CPR scraper setup
Run this locally to test before pushing to GitHub
"""

import os
import sys
import json
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent))


def print_section(title):
    """Print section header"""
    print(f"\n{'='*60}")
    print(f"  {title}")
    print('='*60)


def test_api_keys_format():
    """Test if MEMBER_API_KEYS is formatted correctly"""
    print_section("Test 1: API Keys Format")
    
    # Ask user to paste their API keys JSON
    print("\nPaste your MEMBER_API_KEYS JSON (or press Enter to use example):")
    print('Expected format: {"Member1": "key1", "Member2": "key2"}')
    print()
    
    user_input = input().strip()
    
    if not user_input:
        # Use example
        api_keys_json = '{"MonChoon": "225eKmgnVTCUxeaS", "TestPlayer": "abc123def456"}'
        print(f"Using example: {api_keys_json}")
    else:
        api_keys_json = user_input
    
    try:
        api_keys = json.loads(api_keys_json)
        print(f"\n✓ Valid JSON format")
        print(f"✓ Found {len(api_keys)} members:")
        for i, (name, key) in enumerate(api_keys.items(), 1):
            # Mask the key for security
            masked_key = key[:4] + '*' * (len(key) - 8) + key[-4:] if len(key) > 8 else '***'
            print(f"  {i}. {name}: {masked_key}")
        
        print("\n✅ Your API keys JSON is correctly formatted!")
        print("Copy this entire string to your GitHub Secret 'MEMBER_API_KEYS':")
        print(f"\n{api_keys_json}\n")
        
        return True, api_keys
        
    except json.JSONDecodeError as e:
        print(f"\n✗ Invalid JSON format: {e}")
        print("\nMake sure your JSON:")
        print("  - Has curly braces { }")
        print("  - Uses double quotes for keys and values")
        print("  - Has commas between entries")
        print("  - No trailing comma after last entry")
        return False, {}


def test_storage_setup():
    """Test if storage system is set up"""
    print_section("Test 2: Storage Setup")
    
    try:
        from scripts.utils.json_storage import JSONStorageManager
        
        storage = JSONStorageManager(data_dir='data', auto_commit=False)
        print("✓ JSONStorageManager imported successfully")
        
        # Check if data directory exists
        if storage.data_dir.exists():
            print(f"✓ Data directory exists: {storage.data_dir}")
        else:
            print(f"✓ Data directory will be created: {storage.data_dir}")
        
        # Try to create CPR database
        if not storage.file_exists('cpr_database.json'):
            print("\nCreating initial CPR database structure...")
            initial_data = {
                'members': {},
                'metadata': {
                    'last_updated': '',
                    'total_members': 0,
                    'version': '1.0'
                }
            }
            storage.write_json('cpr_database.json', initial_data, create_backup=False)
            print("✓ Created cpr_database.json")
        else:
            print("✓ cpr_database.json already exists")
        
        return True
        
    except ImportError as e:
        print(f"✗ Failed to import storage module: {e}")
        print("\nMake sure you have:")
        print("  - scripts/utils/json_storage.py file")
        print("  - scripts/utils/__init__.py file")
        return False
    except Exception as e:
        print(f"✗ Storage setup failed: {e}")
        return False


def test_torn_api_wrapper():
    """Test if Torn API wrapper is available"""
    print_section("Test 3: Torn API Wrapper")
    
    try:
        from scripts.utils.torn_api import TornAPI
        
        print("✓ TornAPI imported successfully")
        
        # Ask if they want to test with an API key
        print("\nWould you like to test with an API key? (y/n)")
        test_api = input().strip().lower()
        
        if test_api == 'y':
            print("Enter an API key to test:")
            api_key = input().strip()
            
            if api_key:
                try:
                    api = TornAPI(api_key)
                    if api.test_connection():
                        print("✓ API key is valid and working!")
                    else:
                        print("✗ API key test failed")
                except Exception as e:
                    print(f"✗ API test error: {e}")
        
        return True
        
    except ImportError as e:
        print(f"✗ Failed to import TornAPI: {e}")
        return False


def test_sheets_integration():
    """Test if Google Sheets integration is available"""
    print_section("Test 4: Google Sheets Integration")
    
    try:
        from scripts.utils.google_sheets import GoogleSheetsManager
        
        print("✓ GoogleSheetsManager imported successfully")
        
        # Check for credentials file
        if os.path.exists('google_credentials.json'):
            print("✓ google_credentials.json found")
        else:
            print("⚠ google_credentials.json not found (needed for actual runs)")
        
        # Check for GOOGLE_SHEETS_ID
        if os.environ.get('GOOGLE_SHEETS_ID'):
            print("✓ GOOGLE_SHEETS_ID environment variable set")
        else:
            print("⚠ GOOGLE_SHEETS_ID not set (needed for actual runs)")
        
        return True
        
    except ImportError as e:
        print(f"✗ Failed to import GoogleSheetsManager: {e}")
        return False


def test_cpr_scraper_import():
    """Test if CPR scraper can be imported"""
    print_section("Test 5: CPR Scraper Module")
    
    try:
        # Set dummy env var for testing
        os.environ['MEMBER_API_KEYS'] = '{"MonChoon": "225eKmgnVTCUxeaS","Marnix0126": "ZqWtWtyX0ON4eiNz"}'
        
        sys.path.insert(0, str(Path(__file__).parent / 'scripts'))
        from cpr_scraper import CPRScraper
        
        print("✓ CPRScraper imported successfully")
        
        # Try to initialize (won't actually scrape)
        print("\nAttempting to initialize scraper...")
        scraper = CPRScraper()
        print(f"✓ Scraper initialized")
        print(f"✓ Found {len(scraper.member_api_keys)} test API key(s)")
        
        return True
        
    except ImportError as e:
        print(f"✗ Failed to import CPRScraper: {e}")
        return False
    except Exception as e:
        print(f"✗ Scraper initialization failed: {e}")
        return False
    finally:
        # Clean up
        if 'MEMBER_API_KEYS' in os.environ:
            del os.environ['MEMBER_API_KEYS']


def print_github_setup_instructions(api_keys_json):
    """Print instructions for setting up GitHub"""
    print_section("GitHub Setup Instructions")
    
    print("\n📝 To complete setup, add these GitHub Secrets:")
    print("\n1. Go to your repository:")
    print("   https://github.com/YOUR_USERNAME/torn-forge-oc-system")
    
    print("\n2. Navigate to: Settings → Secrets and variables → Actions")
    
    print("\n3. Add these secrets:")
    print("\n   ┌─────────────────────────────────────────────────┐")
    print("   │ Secret Name: MEMBER_API_KEYS                    │")
    print("   │ Secret Value:                                   │")
    print(f"   │ {api_keys_json[:40]}{'...' if len(api_keys_json) > 40 else ''}")
    print("   └─────────────────────────────────────────────────┘")
    
    print("\n4. Also verify these secrets are set:")
    print("   ✓ TORN_API_KEY")
    print("   ✓ GOOGLE_SHEETS_ID")
    print("   ✓ GOOGLE_DRIVE_CREDENTIALS")
    
    print("\n5. Create the workflow file:")
    print("   .github/workflows/cpr-scraper.yml")
    
    print("\n6. Test by running the workflow manually in GitHub Actions")


def main():
    """Run all tests"""
    print("="*60)
    print("  CPR Scraper Setup Verification")
    print("="*60)
    print("\nThis script will help you verify your CPR scraper is set up correctly.")
    
    results = []
    
    # Test 1: API keys format
    success, api_keys = test_api_keys_format()
    results.append(("API Keys Format", success))
    
    if success:
        api_keys_json = json.dumps(api_keys)
    else:
        print("\n⚠ Fix API keys format before continuing")
        return
    
    # Test 2: Storage setup
    success = test_storage_setup()
    results.append(("Storage Setup", success))
    
    # Test 3: Torn API wrapper
    success = test_torn_api_wrapper()
    results.append(("Torn API Wrapper", success))
    
    # Test 4: Sheets integration
    success = test_sheets_integration()
    results.append(("Sheets Integration", success))
    
    # Test 5: CPR scraper
    success = test_cpr_scraper_import()
    results.append(("CPR Scraper Module", success))
    
    # Print summary
    print_section("Test Summary")
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    print()
    for test_name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status}: {test_name}")
    
    print(f"\n{passed}/{total} tests passed")
    
    if passed == total:
        print("\n🎉 All tests passed!")
        print_github_setup_instructions(api_keys_json)
        print("\n✅ You're ready to set up GitHub Secrets and run the scraper!")
    else:
        print("\n⚠ Some tests failed. Fix the issues above before proceeding.")
        print("\nCommon issues:")
        print("  - Missing __init__.py files in scripts/utils/")
        print("  - Import errors - check file locations")
        print("  - Missing dependencies in requirements.txt")


if __name__ == "__main__":
    main()
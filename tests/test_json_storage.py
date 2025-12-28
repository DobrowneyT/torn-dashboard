"""
Test script for JSON storage system
Run this to verify storage functionality before using in workflows
"""

import os
import sys
from datetime import datetime
from pathlib import Path

# Add project root to Python path
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

# Now import the storage manager
from scripts.utils.json_storage import JSONStorageManager


def print_section(title):
    """Print a section header"""
    print(f"\n{'='*60}")
    print(f"  {title}")
    print('='*60)


def test_basic_operations():
    """Test basic read/write operations"""
    print_section("TEST 1: Basic Operations")
    
    # Initialize storage (no auto-commit for testing)
    storage = JSONStorageManager(data_dir='data', auto_commit=False)
    print(f"✓ Initialized storage in: {storage.data_dir}")
    print(f"  - Auto-commit: {storage.auto_commit}")
    print(f"  - Git repo detected: {storage.is_git_repo}")
    
    # List existing files
    print("\nListing existing files...")
    files = storage.list_files()
    print(f"✓ Found {len(files)} existing files")
    for file in files:
        print(f"  - {file['name']} ({file['size']} bytes, modified: {file['modified']})")
    
    return storage


def test_write_and_read(storage):
    """Test writing and reading JSON files"""
    print_section("TEST 2: Write and Read")
    
    # Create test data
    test_data = {
        "test": "data",
        "timestamp": datetime.now().isoformat(),
        "items": [1, 2, 3],
        "nested": {
            "value": 42,
            "message": "Hello from JSON storage!"
        },
        "metadata": {
            "version": "1.0",
            "created_by": "test_script"
        }
    }
    
    # Write test file
    print("\nWriting test_file.json...")
    storage.write_json("test_file.json", test_data, create_backup=False)
    print("✓ File written successfully")
    
    # Read it back
    print("\nReading test_file.json...")
    read_data = storage.read_json("test_file.json")
    
    if read_data == test_data:
        print("✓ Data matches perfectly!")
    else:
        print("✗ Data mismatch!")
        print(f"  Expected: {test_data}")
        print(f"  Got: {read_data}")
        return False
    
    return True


def test_backup_functionality(storage):
    """Test backup creation"""
    print_section("TEST 3: Backup Functionality")
    
    # Update the file (should create backup)
    print("\nUpdating test_file.json (with backup)...")
    updated_data = storage.read_json("test_file.json")
    updated_data["updated"] = True
    updated_data["update_time"] = datetime.now().isoformat()
    updated_data["update_count"] = 1
    
    storage.write_json("test_file.json", updated_data, create_backup=True)
    print("✓ File updated")
    
    # Check if backup was created
    backup_files = list(storage.backups_dir.glob("test_file.backup_*"))
    print(f"\n✓ Found {len(backup_files)} backup(s)")
    for backup in backup_files:
        print(f"  - {backup.name}")
    
    # Update again to create another backup
    print("\nCreating second backup...")
    updated_data["update_count"] = 2
    storage.write_json("test_file.json", updated_data, create_backup=True)
    
    backup_files = list(storage.backups_dir.glob("test_file.backup_*"))
    print(f"✓ Now have {len(backup_files)} backup(s)")


def test_file_operations(storage):
    """Test file existence and path operations"""
    print_section("TEST 4: File Operations")
    
    # Test file existence
    print("\nTesting file existence...")
    exists = storage.file_exists("test_file.json")
    print(f"✓ test_file.json exists: {exists}")
    
    not_exists = storage.file_exists("nonexistent_file.json")
    print(f"✓ nonexistent_file.json exists: {not_exists}")
    
    # Get file path
    print("\nGetting file path...")
    file_path = storage.get_file_path("test_file.json")
    print(f"✓ Full path: {file_path}")
    
    # Verify file actually exists at that path
    if os.path.exists(file_path):
        print(f"✓ File verified at path")
        file_size = os.path.getsize(file_path)
        print(f"  Size: {file_size} bytes")


def test_database_initialization(storage):
    """Test creating initial database files"""
    print_section("TEST 5: Database Initialization")
    
    print("\nCreating initial database structure...")
    
    database_files = {
        "crimes_database.json": {
            "crimes": [],
            "metadata": {
                "last_updated": datetime.now().isoformat(),
                "total_crimes": 0,
                "version": "1.0",
                "created_by": "initialization_script"
            }
        },
        "cpr_database.json": {
            "members": {},
            "metadata": {
                "last_updated": datetime.now().isoformat(),
                "total_members": 0,
                "version": "1.0"
            }
        },
        "update_state.json": {
            "last_processed_created_at": None,
            "last_processed_executed_at": None,
            "last_daily_update": None,
            "last_cpr_scrape": None,
            "last_payout_process": None,
            "version": "1.0"
        },
        "member_tiers.json": {
            "tiers": {
                "tier1": {"name": "Tier 1", "multiplier": 1.0},
                "tier2": {"name": "Tier 2", "multiplier": 1.5},
                "tier3": {"name": "Tier 3", "multiplier": 2.0}
            },
            "members": {},
            "metadata": {
                "last_updated": datetime.now().isoformat(),
                "version": "1.0"
            }
        }
    }
    
    created_count = 0
    existing_count = 0
    
    for filename, data in database_files.items():
        if not storage.file_exists(filename):
            storage.write_json(filename, data, create_backup=False)
            print(f"✓ Created {filename}")
            created_count += 1
        else:
            print(f"  {filename} already exists (skipped)")
            existing_count += 1
    
    print(f"\n✓ Database initialization complete")
    print(f"  - Created: {created_count} files")
    print(f"  - Existing: {existing_count} files")


def test_backup_cleanup(storage):
    """Test backup cleanup functionality"""
    print_section("TEST 6: Backup Cleanup")
    
    # Count current backups
    backup_files = list(storage.backups_dir.glob("*.backup_*"))
    print(f"\nCurrent backup count: {len(backup_files)}")
    
    # Clean up old backups (keep only 2 most recent)
    print("\nCleaning up old backups (keeping 2 most recent)...")
    storage.cleanup_old_backups(keep_last_n=2)
    
    # Count remaining backups
    remaining_backups = list(storage.backups_dir.glob("*.backup_*"))
    print(f"✓ Remaining backups: {len(remaining_backups)}")
    for backup in remaining_backups:
        print(f"  - {backup.name}")


def test_git_integration(storage):
    """Test git integration (if available)"""
    print_section("TEST 7: Git Integration")
    
    if not storage.is_git_repo:
        print("\n⚠ Not in a git repository - skipping git tests")
        print("  This is fine for local testing")
        print("  Git integration will work in GitHub Actions")
        return
    
    print("\n✓ Git repository detected")
    
    # Create storage with auto-commit enabled
    print("\nTesting auto-commit functionality...")
    git_storage = JSONStorageManager(data_dir='data', auto_commit=True)
    
    test_data = {
        "git_test": True,
        "timestamp": datetime.now().isoformat()
    }
    
    try:
        git_storage.write_json("git_test.json", test_data, create_backup=False)
        print("✓ Auto-commit write successful")
        print("  Check 'git log' to see the commit")
    except Exception as e:
        print(f"⚠ Auto-commit failed: {e}")
        print("  This is normal if git is not configured")


def main():
    """Run all tests"""
    print("="*60)
    print("  JSON Storage System Test Suite")
    print("="*60)
    print(f"\nTest started at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    
    try:
        # Run tests
        storage = test_basic_operations()
        
        if test_write_and_read(storage):
            test_backup_functionality(storage)
            test_file_operations(storage)
            test_database_initialization(storage)
            test_backup_cleanup(storage)
            test_git_integration(storage)
            
            # Final summary
            print_section("TEST SUMMARY")
            print("\n✓ All tests passed successfully!")
            print(f"\nCheck your project directory:")
            print(f"  - data/ folder contains all JSON files")
            print(f"  - data/backups/ folder contains backup files")
            
            # List all created files
            print("\nCreated files:")
            all_files = storage.list_files()
            for file in all_files:
                print(f"  - {file['name']} ({file['size']} bytes)")
            
            print("\n" + "="*60)
            print("  Test suite completed successfully!")
            print("="*60)
            
            return 0
        else:
            print("\n✗ Tests failed")
            return 1
            
    except Exception as e:
        print(f"\n✗ Test suite failed with error: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    exit_code = main()
    sys.exit(exit_code)
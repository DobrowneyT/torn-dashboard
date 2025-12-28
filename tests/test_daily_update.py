"""
Test script for daily crime update - runs locally without committing
"""

import os
import sys
from pathlib import Path

# Load environment variables from .env.local
def load_env_file():
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

# Load environment
load_env_file()

# Verify required variables
required = ['TORN_API_KEY', 'GOOGLE_SHEETS_ID']
missing = [var for var in required if not os.environ.get(var)]

if missing:
    print(f"❌ Missing environment variables: {', '.join(missing)}")
    sys.exit(1)

print("\n" + "="*60)
print("Testing Daily Crime Update (LOCAL - NO AUTO-COMMIT)")
print("="*60)

# Temporarily disable auto-commit for testing
os.environ['TESTING_MODE'] = 'true'

# Import and run
from scripts.daily_crime_update import main

try:
    main()
    print("\n✓ Test completed successfully!")
    print("\nCheck data/crimes_database.json to see results")
    print("Check Google Sheets Crime_Log tab")
except Exception as e:
    print(f"\n❌ Test failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
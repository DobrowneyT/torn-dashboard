import os
from scripts.utils.torn_api import TornAPI

# Set your API key
api_key = os.environ.get('TORN_API_KEY') or '225eKmgnVTCUxeaS'

print("Testing Torn API wrapper...")
api = TornAPI(api_key)

# Test 1: Connection test
print("\n1. Testing connection...")
if api.test_connection():
    print("✓ Connection successful")
else:
    print("✗ Connection failed")
    exit(1)

# Test 2: Fetch recent completed crimes
print("\n2. Fetching recent completed crimes...")
result = api.get_faction_crimes(category="completed", offset=0)
crimes = result.get('crimes', [])
print(f"✓ Fetched {len(crimes)} completed crimes")

if crimes:
    crime = crimes[0]
    print(f"\nSample crime:")
    print(f"  Name: {crime['name']}")
    print(f"  Level: {crime['difficulty']}")
    print(f"  Status: {crime['status']}")
    print(f"  Executed: {crime.get('executed_at', 'N/A')}")

# Test 3: Fetch available crimes
print("\n3. Fetching available crimes...")
result = api.get_faction_crimes(category="available", offset=0)
available = result.get('crimes', [])
print(f"✓ Fetched {len(available)} available crimes")

# Test 4: Test pagination
print("\n4. Testing pagination (fetching last 20 crimes)...")
from datetime import datetime, timedelta
one_month_ago = int((datetime.now() - timedelta(days=30)).timestamp())
all_crimes = api.get_all_faction_crimes_paginated(
    category="completed",
    from_timestamp=one_month_ago
)
print(f"✓ Paginated fetch returned {len(all_crimes)} crimes from last month")

print("\n✓ All tests passed!")
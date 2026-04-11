#!/usr/bin/env python3
"""
One-time migration: load member API keys from CSV into the Supabase members table.
Keys are stored encrypted using pgp_sym_encrypt via the set_member_cpr_key() function.

Only updates rows where the member_id already exists in the members table.

Usage:
    python scripts/migrate_cpr_keys_to_supabase.py [path/to/csv]
    Defaults to .secrets/member_api_keys.csv

Required env vars:
    VITE_SUPABASE_URL
    VITE_SUPABASE_SERVICE_ROLE_KEY
    CPR_KEY_SECRET

CSV format:
    id,api_key
    12345,abcdefghijklmnop
"""

import csv
import os
import sys
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

try:
    from supabase import create_client
except ImportError:
    logger.error("supabase-py not installed. Run: pip install supabase")
    sys.exit(1)


def main():
    csv_path = sys.argv[1] if len(sys.argv) > 1 else '.secrets/member_api_keys.csv'

    supabase_url = os.environ.get('VITE_SUPABASE_URL')
    supabase_key = os.environ.get('VITE_SUPABASE_SERVICE_ROLE_KEY')
    cpr_secret   = os.environ.get('CPR_KEY_SECRET')

    if not supabase_url or not supabase_key:
        logger.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_ROLE_KEY")
        sys.exit(1)

    if not cpr_secret:
        logger.error("Missing CPR_KEY_SECRET — keys cannot be encrypted without it")
        sys.exit(1)

    if not Path(csv_path).exists():
        logger.error(f"CSV not found: {csv_path}")
        sys.exit(1)

    supabase = create_client(supabase_url, supabase_key)

    # Read CSV
    csv_keys = {}
    with open(csv_path, newline='') as f:
        for row in csv.DictReader(f):
            mid = row.get('id', '').strip()
            key = row.get('api_key', '').strip()
            if mid and key:
                csv_keys[mid] = key

    logger.info(f"Read {len(csv_keys)} rows from {csv_path}")

    # Check which member IDs actually exist in the DB
    resp = supabase.table('members').select('member_id').in_('member_id', list(csv_keys.keys())).execute()
    existing_ids = {str(row['member_id']) for row in (resp.data or [])}

    not_found = [mid for mid in csv_keys if mid not in existing_ids]
    if not_found:
        logger.warning(f"{len(not_found)} IDs from CSV not in members table (skipped): {not_found}")

    # Encrypt and store each key via the SECURITY DEFINER RPC function
    success, errors = 0, 0
    for mid in sorted(existing_ids):
        try:
            supabase.rpc('set_member_cpr_key', {
                'p_member_id': mid,
                'p_raw_key':   csv_keys[mid],
                'p_secret':    cpr_secret,
            }).execute()
            logger.info(f"  ✓ {mid}")
            success += 1
        except Exception as e:
            logger.error(f"  ✗ {mid}: {e}")
            errors += 1

    print()
    print(f"Done — {success} encrypted and stored, {len(not_found)} skipped (not in DB), {errors} errors")
    if errors:
        sys.exit(1)


if __name__ == '__main__':
    main()

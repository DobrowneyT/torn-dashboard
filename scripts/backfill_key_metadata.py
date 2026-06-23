#!/usr/bin/env python3
"""
One-time backfill: populate the new member_secrets metadata columns
(key_level, has_faction_access, member_rank) for keys that were stored before
the 2.0 consolidated-key migration.

For every stored key we probe Torn's /v2/key/info (access level + faction flag)
and /user?selections=profile (faction position / rank), then re-store the same
key via set_member_api_key() with the metadata attached. The raw key is read
back through the SECURITY DEFINER pool RPC and never logged.

Usage:
    python scripts/backfill_key_metadata.py

Required env vars:
    VITE_SUPABASE_URL
    VITE_SUPABASE_SERVICE_ROLE_KEY
    APP_KEY_SECRET   (or legacy CPR_KEY_SECRET)
"""

import os
import sys
import time
import logging
from pathlib import Path

import requests
from dotenv import load_dotenv

# Load .env (repo root or scripts/) so VITE_* and the key secret are available
# when run locally — mirrors backfill_member_stats.py.
SCRIPT_DIR = Path(__file__).resolve().parent
for env_path in (SCRIPT_DIR / ".env", SCRIPT_DIR.parent / ".env"):
    if env_path.exists():
        load_dotenv(env_path)

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

try:
    from supabase import create_client
except ImportError:
    logger.error("supabase-py not installed. Run: pip install supabase")
    sys.exit(1)

TORN_BASE = "https://api.torn.com"


def probe_key(api_key: str):
    """Return (key_level, has_faction_access, rank) for a key, or None on error."""
    try:
        info = requests.get(f"{TORN_BASE}/v2/key/info?key={api_key}", timeout=15).json()
        if info.get("error"):
            logger.warning(f"  key/info error: {info['error'].get('error')}")
            return None
        access = info.get("info", {}).get("access", {})
        key_level = access.get("level")
        has_faction = bool(access.get("faction"))

        rank = None
        prof = requests.get(
            f"{TORN_BASE}/user/?selections=profile&key={api_key}", timeout=15
        ).json()
        if not prof.get("error"):
            rank = (prof.get("faction") or {}).get("position")
        return key_level, has_faction, rank
    except Exception as e:
        logger.warning(f"  probe failed: {e}")
        return None


def main():
    supabase_url = os.environ.get("VITE_SUPABASE_URL")
    supabase_key = os.environ.get("VITE_SUPABASE_SERVICE_ROLE_KEY")
    secret = os.environ.get("APP_KEY_SECRET") or os.environ.get("CPR_KEY_SECRET")

    if not supabase_url or not supabase_key:
        logger.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_ROLE_KEY")
        sys.exit(1)
    if not secret:
        logger.error("Missing APP_KEY_SECRET / CPR_KEY_SECRET — cannot decrypt keys")
        sys.exit(1)

    supabase = create_client(supabase_url, supabase_key)

    # Pull every stored key (faction_only=False so Recruits are included).
    resp = supabase.rpc(
        "get_active_key_pool", {"p_secret": secret, "p_faction_only": False}
    ).execute()
    pool = resp.data or []
    logger.info(f"Found {len(pool)} stored keys to backfill")

    success, errors = 0, 0
    for row in pool:
        mid = str(row["member_id"])
        api_key = row["api_key"]
        if not api_key:
            continue

        probed = probe_key(api_key)
        if probed is None:
            errors += 1
            continue
        key_level, has_faction, rank = probed

        try:
            supabase.rpc(
                "set_member_api_key",
                {
                    "p_member_id": mid,
                    "p_raw_key": api_key,
                    "p_secret": secret,
                    "p_key_level": key_level,
                    "p_has_faction_access": has_faction,
                    "p_member_rank": rank,
                    "p_consent_version": None,  # leave existing consent untouched
                },
            ).execute()
            logger.info(f"  ✓ {mid} (level={key_level}, faction={has_faction}, rank={rank})")
            success += 1
        except Exception as e:
            logger.error(f"  ✗ {mid}: {e}")
            errors += 1

        time.sleep(0.6)  # stay well under Torn's per-key rate limit

    print()
    print(f"Done — {success} backfilled, {errors} errors")
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()

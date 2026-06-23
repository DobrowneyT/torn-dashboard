"""
2.0 consolidated key-pool helpers for the scrapers.

Keys come from the consented member pool in `member_secrets` — USER KEYS ONLY,
no admin fallback. The faction-wide scrapers (crimes, wars, attacks, member
stats, items) each claim a key from the rotating pool via claim_next_api_key();
in a matrix/parallel workflow every runner therefore gets a distinct key,
bypassing Torn's per-key cache and spreading the rate-limit load.

The CPR scraper is the exception — it targets each member's OWN key directly
(get_member_api_key), so it does not use this rotation.
"""

import os
import logging

logger = logging.getLogger(__name__)

try:
    from supabase import create_client
except ImportError:  # pragma: no cover - exercised only without the dep installed
    create_client = None


class EmptyKeyPoolError(RuntimeError):
    """Raised when no consented keys are eligible (nobody has opted in yet)."""


def _secret():
    # APP_KEY_SECRET is the 2.0 name; CPR_KEY_SECRET is the legacy alias.
    secret = os.environ.get("APP_KEY_SECRET") or os.environ.get("CPR_KEY_SECRET")
    if not secret:
        raise RuntimeError(
            "APP_KEY_SECRET / CPR_KEY_SECRET not set — cannot decrypt the key pool"
        )
    return secret


def _supabase():
    url = os.environ.get("VITE_SUPABASE_URL")
    key = os.environ.get("VITE_SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError(
            "VITE_SUPABASE_URL / VITE_SUPABASE_SERVICE_ROLE_KEY not set — cannot reach the key pool"
        )
    if create_client is None:
        raise RuntimeError("supabase-py not installed — run: pip install supabase")
    return create_client(url, key)


def load_key_pool(faction_only=True, client=None):
    """Return the full eligible pool as a list of (member_id, api_key) tuples.

    faction_only excludes Recruits (has_faction_access = false).
    """
    sb = client or _supabase()
    resp = sb.rpc(
        "get_active_key_pool",
        {"p_secret": _secret(), "p_faction_only": faction_only},
    ).execute()
    return [
        (str(r["member_id"]), r["api_key"])
        for r in (resp.data or [])
        if r.get("api_key")
    ]


def claim_next_api_key(faction_only=True, client=None):
    """Atomically claim the next key in the rotation. Returns the key string.

    Use this in parallel/matrix runners so each runner gets a distinct key.
    Raises EmptyKeyPoolError when nobody has consented yet.
    """
    sb = client or _supabase()
    resp = sb.rpc(
        "claim_next_api_key",
        {"p_secret": _secret(), "p_faction_only": faction_only},
    ).execute()
    rows = resp.data or []
    if not rows or not rows[0].get("api_key"):
        raise EmptyKeyPoolError(
            "No eligible API keys in the rotation pool — no members have consented "
            "yet (or all eligible members are on Recruit status)."
        )
    logger.info("Claimed rotation key for member %s", rows[0].get("member_id"))
    return rows[0]["api_key"]

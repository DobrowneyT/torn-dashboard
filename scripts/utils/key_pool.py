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

import requests

logger = logging.getLogger(__name__)

# Torn /v2/key/info error codes that mean THIS SPECIFIC KEY is unusable, so the
# pool should skip it and rotate to the next one. Mirrors FATAL_REVAL_CODES in
# src/contexts/AuthContext.jsx.
#   1  = key is empty
#   2  = incorrect / deleted key (e.g. the member left the faction)
#   10 = key owner is in federal jail
#   13 = key disabled due to owner inactivity
#   16 = insufficient permissions on the key
#   18 = key has been paused by its owner
DEAD_KEY_CODES = frozenset({1, 2, 10, 13, 16, 18})

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


def _claim_next_raw(faction_only, sb):
    """Claim the next key from the round-robin pool without validating it.
    Returns (member_id, api_key). Raises EmptyKeyPoolError if the pool is empty."""
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
    return str(rows[0].get("member_id")), rows[0]["api_key"]


def _key_is_live(api_key, timeout=15):
    """True if the key still works; False only when the key ITSELF is dead
    (see DEAD_KEY_CODES). Transient Torn errors (rate limit, IP block, backend)
    and network/parse failures return True on purpose — we can't prove the key is
    bad over a blip, and discarding good keys would drain the pool needlessly."""
    try:
        resp = requests.get(
            f"https://api.torn.com/v2/key/info?key={api_key}&comment=Forge_KeyCheck",
            timeout=timeout,
        )
        data = resp.json()
    except (requests.RequestException, ValueError):
        return True
    err = data.get("error") if isinstance(data, dict) else None
    if err:
        return err.get("code") not in DEAD_KEY_CODES
    return True


def probe_key_metadata(api_key, timeout=15):
    """Probe a key's current metadata via Torn. Returns
    (key_level, has_faction_access, rank) or None if the key errored / was
    unreachable. Centralised here so the daily key-pool reconcile and the one-off
    metadata backfill share one implementation of the /key/info + profile logic.
    """
    try:
        info = requests.get(
            f"https://api.torn.com/v2/key/info?key={api_key}", timeout=timeout
        ).json()
        if not isinstance(info, dict) or info.get("error"):
            return None
        access = (info.get("info") or {}).get("access") or {}
        key_level = access.get("level")
        has_faction = bool(access.get("faction"))

        rank = None
        prof = requests.get(
            f"https://api.torn.com/user/?selections=profile&key={api_key}", timeout=timeout
        ).json()
        if isinstance(prof, dict) and not prof.get("error"):
            rank = (prof.get("faction") or {}).get("position")
        return key_level, has_faction, rank
    except (requests.RequestException, ValueError):
        return None


def claim_next_api_key(faction_only=True, client=None, validate=True, max_attempts=8):
    """Atomically claim the next WORKING key in the rotation. Returns the key string.

    Claims from the round-robin pool and, when validate=True (default), verifies
    the key with a cheap /key/info call, rotating PAST dead keys — a member who
    left the faction (code 2), a revoked/disabled/paused key, etc. — up to
    max_attempts times. Since the RPC advances the pointer each call, retries land
    on different members. Use in parallel/matrix runners so each gets a distinct key.

    Raises EmptyKeyPoolError when nobody has consented yet, or RuntimeError when
    every attempt hit a dead key (pool likely full of stale ex-member keys).
    Pass validate=False for the old raw behaviour.
    """
    sb = client or _supabase()
    for attempt in range(1, max_attempts + 1):
        member_id, api_key = _claim_next_raw(faction_only, sb)
        if not validate or _key_is_live(api_key):
            logger.info("Claimed rotation key for member %s", member_id)
            return api_key
        logger.warning(
            "Rotation key for member %s is dead — skipping (attempt %d/%d)",
            member_id, attempt, max_attempts,
        )
    raise RuntimeError(
        f"No working API key after {max_attempts} attempts — the rotation pool "
        f"may be full of stale keys (e.g. members who left the faction). "
        f"Consider pruning member_secrets."
    )

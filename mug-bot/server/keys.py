"""
Dynamic Torn API key pool. The poller + enrichment rotate over the ENABLED keys in the api_keys
table (seeded from TORN_API_KEYS, managed via /keys). A key that returns a key-level error is
auto-disabled and queued as a status-channel alert.

Held in an in-memory cache (`_active`) refreshed from the DB, because torn._get's key pick is
synchronous and per-call.
"""

import logging
import time
from typing import Dict, List, Optional

import httpx

import config
from server import db

log = logging.getLogger("mug.keys")

# Torn error codes that mean the KEY is the problem (not a transient rate limit):
#   1 empty, 2 incorrect, 10 temp-disabled, 13 owner-inactive, 16 access-too-low, 18 paused.
KEY_ERROR_CODES = {1, 2, 10, 13, 16, 18}

_active: List[str] = []
_pending_alerts: List[Dict] = []   # drained by the bot loop -> posted to the status channel
_cooldowns: Dict[str, float] = {}  # key -> unix ts until which it is rate-limited (skipped)
_global_pause_until: float = 0.0   # all keys paused until this ts (optional)


def _mask(key: str) -> str:
    return f"…{key[-4:]}" if key else "?"


def next_key() -> Optional[str]:
    """Rotate across active keys, skipping any that are cooling down from a rate-limit. Returns
    None when paused globally or when every active key is cooling down."""
    now = time.time()
    if now < _global_pause_until:
        return None
    available = [k for k in _active if _cooldowns.get(k, 0) <= now]
    if not available:
        return None
    return available[int(now) % len(available)]


def mark_rate_limited(key: str) -> None:
    """Torn error 5: back the key off for RATE_LIMIT_BACKOFF_SECONDS (and optionally all keys)."""
    global _global_pause_until
    now = time.time()
    _cooldowns[key] = now + config.RATE_LIMIT_BACKOFF_SECONDS
    if config.RATE_LIMIT_GLOBAL_PAUSE:
        _global_pause_until = now + config.RATE_LIMIT_BACKOFF_SECONDS
    log.warning(
        "rate-limited key %s — backing off %ss%s", _mask(key),
        config.RATE_LIMIT_BACKOFF_SECONDS, " (global pause)" if config.RATE_LIMIT_GLOBAL_PAUSE else "",
    )


def active_count() -> int:
    return len(_active)


async def refresh() -> None:
    global _active
    _active = await db.get_enabled_api_keys()


async def validate_key(client: httpx.AsyncClient, key: str) -> Dict:
    """Confirm a key works for our use and identify its owner.
    Returns {ok, user_id, name, level, reason}."""
    try:
        r = await client.get(
            "https://api.torn.com/user/",
            params={"selections": "basic", "key": key, "comment": config.API_COMMENT}, timeout=15,
        )
        data = r.json()
    except (httpx.HTTPError, ValueError) as e:
        return {"ok": False, "reason": f"network error: {e}"}
    if data.get("error"):
        return {"ok": False, "reason": f"{data['error'].get('error')} (code {data['error'].get('code')})"}

    owner = {"user_id": data.get("player_id"), "name": data.get("name"), "level": data.get("level")}

    # Confirm it can actually read the item market (the call we depend on most).
    try:
        r2 = await client.get(
            "https://api.torn.com/v2/market/206/itemmarket",
            params={"key": key, "limit": 1, "comment": config.API_COMMENT}, timeout=15,
        )
        d2 = r2.json()
        if isinstance(d2, dict) and d2.get("error"):
            return {"ok": False, "reason": f"insufficient access for item market: {d2['error'].get('error')}", **owner}
    except (httpx.HTTPError, ValueError):
        pass  # treat market-call hiccups as non-fatal; basic already validated the key
    return {"ok": True, "reason": "ok", **owner}


async def add_key(client: httpx.AsyncClient, key: str) -> Dict:
    res = await validate_key(client, key)
    if not res.get("ok"):
        return res
    await db.api_key_add(key=key, user_id=res.get("user_id"), name=res.get("name"), level=res.get("level"))
    await refresh()
    return res


async def remove_key(identifier) -> int:
    n = await db.api_key_remove(identifier)
    await refresh()
    return n


async def mark_key_error(key: str, code, message: str) -> None:
    """Disable a key that failed with a key-level error and queue a status-channel alert."""
    info = await db.api_key_info(key)
    if info and not info.get("enabled"):
        return  # already disabled — don't spam
    await db.api_key_mark_error(key, f"code {code}: {message}")
    await refresh()
    _pending_alerts.append({
        "name": (info or {}).get("name"), "user_id": (info or {}).get("user_id"),
        "code": code, "error": message, "remaining": len(_active),
    })
    log.warning("disabled API key (%s code %s) — %s active keys remain",
                (info or {}).get("name") or "?", code, len(_active))


async def validate_all(client: httpx.AsyncClient) -> None:
    """Background: fill owner info for seeded keys; disable any that don't validate."""
    for row in await db.all_api_keys():
        res = await validate_key(client, row["key"])
        if res.get("ok"):
            await db.api_key_set_owner(row["key"], res.get("user_id"), res.get("name"), res.get("level"))
        else:
            await db.api_key_mark_error(row["key"], res.get("reason", "validation failed"))
    await refresh()


def drain_alerts() -> List[Dict]:
    out = _pending_alerts[:]
    _pending_alerts.clear()
    return out

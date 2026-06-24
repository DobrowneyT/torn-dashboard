"""
Torn API v2 client for SELLER ENRICHMENT only (the market data itself comes from the
WebSocket, never the API — see README/plan).

On first sight of a new seller (and refreshed as needed) we call:
  - get_job(id)     -> clothing-store detection: job.type_id == 5, rating >= 7 => 75% reduction
  - get_basic(id)   -> status (state + until) for the hospital-accumulation feature
  - get_profile(id) -> fuller profile (faction, last_action, property) for the embed

There is no single endpoint with both status and job, so clothing + status are two calls.
Keys rotate across config.TORN_API_KEYS (advancing each second) to spread the ~100 req/min
per-key budget, mirroring the war-room rotation.
"""

import logging
import time
from typing import Dict, Optional

import httpx

import config
from server import keys as keypool

log = logging.getLogger("mug.torn")

BASE = "https://api.torn.com/v2"
V1_BASE = "https://api.torn.com"
CLOTHING_STORE_TYPE_ID = 5
CLOTHING_STORE_MIN_RATING = 7   # 7-star+ clothing store => 75% mug reduction


def _next_key() -> Optional[str]:
    return keypool.next_key()


async def _get(client: httpx.AsyncClient, path: str, params: Optional[Dict] = None) -> Optional[Dict]:
    key = _next_key()
    if not key:
        log.warning("no active Torn API keys — add one with /keys add")
        return None
    # `timestamp` is a cache-buster (unique URL) so seller status/last_action is never served stale
    # from an edge cache — same trick the war-room fetch uses.
    q = {"key": key, "comment": config.API_COMMENT, "timestamp": int(time.time() * 1000)}
    if params:
        q.update(params)
    try:
        resp = await client.get(f"{BASE}/{path}", params=q, timeout=15)
        data = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        log.warning("torn GET %s failed: %s", path, e)
        return None
    if isinstance(data, dict) and data.get("error"):
        err = data["error"]
        code = err.get("code")
        if code == 5:
            keypool.mark_rate_limited(key)                              # too many requests: back off
        elif code in keypool.KEY_ERROR_CODES:
            await keypool.mark_key_error(key, code, err.get("error"))   # disable + notify
        else:
            log.warning("torn API error on %s: %s", path, err)
        return None
    return data


async def get_itemmarket(
    client: httpx.AsyncClient, item_id: int, *, bonus: Optional[str] = None, offset: int = 0
) -> Optional[Dict]:
    """One page (<=100) of an item's market. Returns {"item": {...meta...}, "listings": [...]}
    or None on error. Gear listings carry item_details.uid + stats; stackable items return only
    {price, amount}. `bonus="Any"` filters gear to bonus-only listings. item.type is one of
    Primary/Secondary/Melee/Defensive (gear) or a consumable category."""
    params = {"limit": 100, "offset": offset}
    if bonus:
        params["bonus"] = bonus
    data = await _get(client, f"market/{item_id}/itemmarket", params)
    if not data:
        return None
    im = data.get("itemmarket") or {}
    # cache_timestamp = when Torn generated this cached snapshot (unix). It increments in exact 30s
    # steps and the snapshot only becomes visible ~30s after that stamp, so it drives adaptive
    # poll scheduling in api_poller (poll just after the NEXT snapshot is due).
    return {"item": im.get("item") or {}, "listings": im.get("listings") or [],
            "cache_timestamp": im.get("cache_timestamp")}


async def get_all_item_values(client: httpx.AsyncClient) -> Optional[Dict]:
    """One call returning every item's market value (v1 `torn?selections=items`). Returns
    {item_id: {"name": str, "market_value": int}} or None on error. Used by the deal-finder;
    refreshed every few hours so one cheap call covers the whole catalogue."""
    key = _next_key()
    if not key:
        log.warning("no active Torn API keys for item-values fetch")
        return None
    try:
        resp = await client.get(
            f"{V1_BASE}/torn/",
            params={"selections": "items", "key": key, "comment": config.API_COMMENT},
            timeout=30,
        )
        data = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        log.warning("torn items fetch failed: %s", e)
        return None
    if isinstance(data, dict) and data.get("error"):
        err = data["error"]
        code = err.get("code")
        if code == 5:
            keypool.mark_rate_limited(key)
        elif code in keypool.KEY_ERROR_CODES:
            await keypool.mark_key_error(key, code, err.get("error"))
        else:
            log.warning("torn items API error: %s", err)
        return None
    items = (data or {}).get("items") or {}
    out: Dict[int, Dict] = {}
    for k, v in items.items():
        try:
            iid = int(k)
        except (TypeError, ValueError):
            continue
        mv = v.get("market_value")
        if mv:   # skip items with no/0 market value
            out[iid] = {"name": v.get("name"), "market_value": int(mv), "type": v.get("type")}
    return out


async def get_job(client: httpx.AsyncClient, user_id: int) -> Optional[Dict]:
    data = await _get(client, f"user/{user_id}/job")
    return data.get("job") if data else None


async def get_basic(client: httpx.AsyncClient, user_id: int) -> Optional[Dict]:
    data = await _get(client, f"user/{user_id}/basic")
    return data.get("profile") if data else None


async def get_profile(client: httpx.AsyncClient, user_id: int) -> Optional[Dict]:
    data = await _get(client, f"user/{user_id}/profile")
    return data.get("profile") if data else None


def is_clothing_store(job: Optional[Dict]) -> bool:
    """True if the seller's job grants the 7*+ clothing-store mug reduction."""
    if not job:
        return False
    return (
        job.get("type_id") == CLOTHING_STORE_TYPE_ID
        and (job.get("rating") or 0) >= CLOTHING_STORE_MIN_RATING
    )

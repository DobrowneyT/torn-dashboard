"""
Phase 1 sale detection from the item-market WebSocket events the userscript forwards.

Event shapes (confirmed from live captures), delivered as body["data"][i]["message"]:
  add    : {listingID, anonymous, status, user:{ID,name}, faction:{...}, price, available, relatedItemID}
  update : {itemID, minPrice}                  -> price floor (deal-finder, Phase 2; ignored here)
           {listingID, available}              -> partial buy: available decreased = a sale
  remove : {listingID}                         -> listing gone = sale of the remaining qty
                                                  (also what "list then delist" emulates for testing)
  counterIncrease/Decrease                     -> listing-count noise; the userscript already drops these

Flow: add -> store listing (with seller) + warm enrichment; quantity-drop/remove -> record a sale,
accumulate the seller's window total, (re)enrich, then alert if the mug clears threshold — unless
the seller is in hospital, in which case we hold and the bot's loop posts ~60s before release.
"""

import asyncio
import logging
import time
from typing import Dict, Optional

import httpx

import config
from server import db, mug
from server.enrich import enrich_clothing, enrich_seller

log = logging.getLogger("mug.detect")

_client: Optional[httpx.AsyncClient] = None

# One lock per seller: sale handling is now spawned as independent tasks (so it never blocks the
# poll loop), so two sales for the SAME seller could otherwise race on the window/cooldown/claim
# and double-alert. Serialise per seller; different sellers still run concurrently.
_seller_locks: Dict[int, "asyncio.Lock"] = {}


def _seller_lock(seller_id) -> "asyncio.Lock":
    lock = _seller_locks.get(seller_id)
    if lock is None:
        lock = asyncio.Lock()
        _seller_locks[seller_id] = lock
    return lock


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient()
    return _client


def _item_name(item_id) -> str:
    if item_id is None:
        return "Unknown"
    return config.ITEM_MAP.get(item_id, f"Item {item_id}")


def _is_anon(row: Dict) -> bool:
    if row.get("anonymous"):
        return True
    user = row.get("user") or {}
    return user.get("ID") in (0, "0", None)


async def process_market_payload(body: Dict, bot=None) -> None:
    """Entry point from the /market ingest route."""
    for entry in (body.get("data") or []):
        if not isinstance(entry, dict):
            continue
        msg = entry.get("message", entry)
        action = msg.get("action")
        for row in (msg.get("data") or []):
            try:
                if action == "add":
                    await _handle_add(row)
                elif action == "update":
                    if row.get("listingID") is not None and isinstance(row.get("available"), (int, float)):
                        await _handle_quantity_update(row, bot)
                    # else: {itemID, minPrice} price floor -> deal-finder (Phase 2)
                elif action == "remove":
                    await _handle_remove(row, bot)
            except Exception:
                log.exception("error handling %s row %r", action, row)


async def _handle_add(row: Dict) -> None:
    listing_id = row.get("listingID")
    if listing_id is None:
        return
    item_id = row.get("relatedItemID")
    anon = _is_anon(row)
    user = row.get("user") or {}
    seller_id = None if anon else user.get("ID")
    seller_name = None if anon else user.get("name")
    faction = (row.get("faction") or {}).get("name")

    await db.upsert_listing(
        listing_id=listing_id, item_id=item_id, item_name=_item_name(item_id),
        seller_id=seller_id, price=row.get("price"), available=row.get("available"),
        anonymous=anon,
    )
    if not anon and seller_id:
        await db.upsert_seller_seen(
            user_id=seller_id, name=seller_name, faction=faction, online_status=row.get("status")
        )
        # Warm enrichment in the background so it's ready by the time they sell.
        asyncio.create_task(_safe_enrich(seller_id))


async def _safe_enrich(seller_id) -> None:
    try:
        await enrich_seller(seller_id, _http())
    except Exception:
        log.exception("enrich failed for %s", seller_id)


async def _handle_quantity_update(row: Dict, bot) -> None:
    listing = await db.get_listing(row["listingID"])
    if not listing:
        return
    new_avail = int(row["available"])
    sold = int(listing["available"] or 0) - new_avail
    await db.set_listing_available(row["listingID"], new_avail)
    if sold > 0 and not listing["anonymous"] and listing["seller_id"]:
        await _record_and_maybe_alert(listing, sold, bot)


async def _handle_remove(row: Dict, bot) -> None:
    listing = await db.get_listing(row["listingID"])
    if not listing:
        return
    await db.delete_listing(row["listingID"])
    remaining = int(listing["available"] or 0)
    if remaining > 0 and not listing["anonymous"] and listing["seller_id"]:
        await _record_and_maybe_alert(listing, remaining, bot)


async def _record_and_maybe_alert(listing: Dict, qty: int, bot) -> None:
    await on_sale(
        seller_id=listing["seller_id"], item_id=listing["item_id"],
        item_name=listing["item_name"], qty=qty, unit_price=listing["price"],
        listing_id=listing["listing_id"], bot=bot,
    )


async def on_sale(*, seller_id, item_id, item_name, qty, unit_price, listing_id=None, bot=None, stats=None) -> None:
    """Shared sale handler used by BOTH the WS path and the API poller: record the sale,
    (re)enrich the seller, then alert if the accumulated mug clears threshold."""
    log.info("SALE detected: seller=%s item=%s(%s) qty=%s unit=%s total=%s listing=%s",
             seller_id, item_name, item_id, qty, unit_price,
             (qty or 0) * (unit_price or 0), listing_id)
    async with _seller_lock(seller_id):
        sale_id = await db.record_sale(
            listing_id=listing_id, item_id=item_id, item_name=item_name,
            seller_id=seller_id, qty_sold=qty, unit_price=unit_price,
        )
        # Per sale we only ensure the clothing flag is fresh (needed for the mug calc). Status/TBS
        # are fetched only if the threshold is crossed (see _evaluate_alert).
        seller = await enrich_clothing(seller_id, _http())
        await _evaluate_alert(
            seller_id, seller, bot,
            last_item={"item_id": item_id, "item_name": item_name, "stats": stats},
            sale_id=sale_id, listing_id=listing_id,
        )


async def _cfg(key, default):
    return await db.get_config(key, default)


async def _mug_for(seller: Optional[Dict], total: int):
    # mug % + clothing reduction are fixed (match the reference bot); only the threshold tunes.
    return mug.compute_mug(
        total,
        in_clothing_store=bool(seller and seller.get("in_clothing_store")),
        min_value=await _cfg("min_mug_value", config.MIN_MUG_VALUE),
    )


async def _evaluate_alert(seller_id, seller: Optional[Dict], bot, last_item=None,
                          sale_id=None, listing_id=None) -> None:
    window = await _cfg("sale_window_seconds", config.SALE_WINDOW_SECONDS)
    win = await db.seller_window(seller_id, window)
    if win["total"] <= 0:
        return
    res = await _mug_for(seller, win["total"])      # cheap pre-check on the raw window total
    if not res.qualifies:
        log.info("mug-eval seller=%s: raw=%s mug_min=%s < threshold -> skip", seller_id, win["total"], res.mug_min)
        return
    if not await _cooldown_ok(seller):
        log.info("mug-eval seller=%s: raw=%s qualifies but in cooldown -> skip", seller_id, win["total"])
        return
    # Threshold crossed: NOW make a fresh API call for their current status (hospital/online) +
    # last_action + TBS. last_action drives the banking decay; status drives hold + embed colour.
    seller = await enrich_seller(seller_id, _http(), force=True)
    # Delist guard for GEAR: if the seller acted right around when their item vanished, it's almost
    # certainly them pulling/relisting/trading it, not a buy. Drop the phantom sale so it neither
    # fires a $0 mug nor inflates the window.
    if config.DELIST_GUARD_SECONDS and str(listing_id or "").startswith("uid:"):
        la = (seller or {}).get("last_action_ts")
        if la and (int(time.time()) - int(la)) < config.DELIST_GUARD_SECONDS:
            log.info("mug-eval seller=%s: GEAR vanish but seller acted %ss ago -> likely DELIST, "
                     "dropping (not a sale)", seller_id, int(time.time()) - int(la))
            if sale_id is not None:
                await db.delete_sale(sale_id)
            return
    raw_total = win["total"]
    win, res = await _bank_adjust(seller, win)
    win, res, protection_pct = await _mug_protect_adjust(seller, win)
    la = (seller or {}).get("last_action_ts")
    state = (seller or {}).get("status_state")
    log.info("mug-eval seller=%s: raw=%s adj=%s mug=%s-%s qualifies=%s protection=%s%% | status=%s last_action=%ss-ago online=%s",
             seller_id, raw_total, win["total"], res.mug_min, res.mug_max, res.qualifies, protection_pct,
             state, (int(time.time()) - int(la)) if la else "?", (seller or {}).get("online_status"))
    if not res.qualifies:
        return  # decayed below threshold — they've likely banked it
    if state == "Hospital" and (seller or {}).get("status_until"):
        log.info("mug-eval seller=%s: HELD (in hospital until %s) -> bot loop posts before release",
                 seller_id, (seller or {}).get("status_until"))
        return  # hold — the bot's loop posts the accumulated total ~60s before release
    # Flag a target who's abroad/travelling so it's clear you must fly to them to mug.
    variant = "overseas" if state in ("Traveling", "Abroad") else "mug"
    hospitalize = await _is_hospitalize_faction(seller)
    log.info("mug-eval seller=%s: POST alert variant=%s value=%s hospitalize=%s",
             seller_id, variant, win["total"], hospitalize)
    if bot is not None:
        await bot.post_mug_alert(
            _build_event(seller_id, seller, win, res, variant=variant, last_item=last_item,
                         hospitalize=hospitalize, protection_pct=protection_pct)
        )
    await _mark_alerted(seller_id, win)


def _was_mugged(seller: Optional[Dict]) -> bool:
    return "mug" in ((seller or {}).get("status_details") or "").lower()


async def _mug_protect_adjust(seller: Optional[Dict], win: Dict):
    """Mug protection: if the seller is in hospital AND was mugged, their wallet was largely taken
    and the leftover is protected, decaying linearly to 0 over MUG_PROTECTION_HOURS. We estimate the
    mug time as their last action (they can't act while hospitalised) and keep only the still-
    muggable fraction. Returns (win, res, protection_pct)."""
    hours = config.MUG_PROTECTION_HOURS
    la = (seller or {}).get("last_action_ts")
    if hours <= 0 or not la or (seller or {}).get("status_state") != "Hospital" or not _was_mugged(seller):
        return win, await _mug_for(seller, win["total"]), 0
    elapsed = int(time.time()) - int(la)
    muggable = max(0.0, min(1.0, elapsed / (hours * 3600)))   # protection decays over `hours`
    adj = int(win["total"] * muggable)
    win = {**win, "total": adj}
    return win, await _mug_for(seller, adj), round((1.0 - muggable) * 100)


async def _is_hospitalize_faction(seller: Optional[Dict]) -> bool:
    """True if the seller is in a faction flagged for hospitalization (don't mug — hosp them)."""
    fid = (seller or {}).get("faction_id")
    return bool(fid) and int(fid) in set(await db.get_hospitalize_factions())


async def _bank_adjust(seller: Optional[Dict], win: Dict):
    """Apply the banking-decay heuristic to the window total (seller active since a sale ⇒ likely
    banked) and recompute the mug. Returns (adjusted_win, recomputed_res)."""
    adj_total = mug.bank_adjusted_total(win.get("sales") or [], (seller or {}).get("last_action_ts"))
    win = {**win, "total": adj_total}
    return win, await _mug_for(seller, adj_total)


async def _mark_alerted(seller_id, win: Dict) -> None:
    """Record the cooldown and (assuming the alert => a mug) claim the alerted sales so they're
    never re-counted in a later window."""
    await db.set_last_alerted(seller_id)
    sales = win.get("sales") or []
    if config.MUG_CLAIM_ON_ALERT and sales:
        await db.set_mug_claimed(seller_id, max(s["sold_at"] for s in sales))


async def _cooldown_ok(seller: Optional[Dict]) -> bool:
    last = (seller or {}).get("last_alerted_at")
    if not last:
        return True
    cooldown = await _cfg("alert_cooldown_seconds", config.ALERT_COOLDOWN_SECONDS)
    return (int(time.time()) - int(last)) >= cooldown


async def post_hospital_due(bot) -> None:
    """Called periodically by the bot: post held alerts for sellers about to leave hospital."""
    for row in await db.sellers_in_hospital_due(config.HOSPITAL_RELEASE_LEAD_SECONDS):
        seller_id = row["user_id"]
        window = await _cfg("sale_window_seconds", config.SALE_WINDOW_SECONDS)
        win = await db.seller_window(seller_id, window)
        if win["total"] <= 0 or not await _cooldown_ok(row):
            continue
        res = await _mug_for(row, win["total"])
        if not res.qualifies:
            continue
        # Fresh status right before posting (they may have left hospital early).
        seller = await enrich_seller(seller_id, _http(), force=True)
        win, res = await _bank_adjust(seller, win)
        win, res, protection_pct = await _mug_protect_adjust(seller, win)
        if not res.qualifies:
            continue
        variant = "hospital" if (seller or {}).get("status_state") == "Hospital" else "mug"
        if bot is not None:
            await bot.post_mug_alert(_build_event(
                seller_id, seller, win, res, variant=variant,
                hospitalize=await _is_hospitalize_faction(seller), protection_pct=protection_pct))
        await _mark_alerted(seller_id, win)


def _build_event(seller_id, seller: Optional[Dict], win: Dict, res, *, variant="mug",
                 last_item=None, hospitalize=False, protection_pct=0) -> Dict:
    seller = seller or {}
    # Headline item for the embed: the sale that triggered this, else the most recent in the window.
    headline = last_item or {}
    if not headline.get("item_name") and win["sales"]:
        s = win["sales"][-1]
        headline = {"item_id": s.get("item_id"), "item_name": s.get("item_name"), "stats": None}
    return {
        "variant": variant,
        "seller_id": seller_id,
        "seller_name": seller.get("name") or str(seller_id),
        "item_id": headline.get("item_id"),
        "item_name": headline.get("item_name"),
        "item_stats": headline.get("stats"),
        "value_change": win["total"],
        "num_sales": win["count"],
        "mug_min": res.mug_min,
        "mug_max": res.mug_max,
        "tbs": seller.get("bsp_total"),
        "last_action_ts": seller.get("last_action_ts"),
        "status_state": seller.get("status_state"),     # Hospital/Okay/Traveling/Abroad/...
        "status_until": seller.get("status_until"),      # hospital release time (countdown)
        "status_description": seller.get("status_description"),  # e.g. "In Switzerland"
        "online_status": seller.get("online_status"),   # Online/Idle/Offline -> embed colour + dot
        "detected_ts": int(time.time()),
        "faction": seller.get("faction"),
        "faction_id": seller.get("faction_id"),
        "hospitalize": bool(hospitalize),
        "protection_pct": protection_pct,   # mug-protection reduction applied (%)
        "in_clothing_store": bool(seller.get("in_clothing_store")),
        # Only claim "Was Mugged" if the hospital REASON actually says so — being in hospital for
        # any other reason (self-hosp, attacked, medical) is NOT a mug.
        "was_mugged": "mug" in (seller.get("status_details") or "").lower(),
        "sales": [
            {"item_name": s["item_name"], "qty": s["qty_sold"], "price": s["unit_price"], "ts": s["sold_at"]}
            for s in win["sales"][-10:]
        ],
    }

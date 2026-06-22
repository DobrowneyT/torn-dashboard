"""
API-mode sale detection for GEAR (weapons/armour). Compliant: only the Torn item-market API is
polled here; seller identity comes from the item-matcher capture (the `listings` seller map).

Per item we have captured sellers for, we poll `itemmarket` and read each listing's
`item_details.uid`. The uid is unique per weapon/armour and persists across reprices, so:
  - a uid newly present that matches a captured (item_id, price) seller -> start tracking it,
  - a tracked uid absent for GEAR_VANISH_CONFIRM_POLLS polls -> that item sold -> mug the seller.

Feeds detection.on_sale (the same enrichment + mug + alert path the WS path uses). Stackable
items are intentionally out of scope here (added later via price/quantity matching).
"""

import asyncio
import json
import logging

import httpx

import config
from server import db, deal_finder, detection, torn
from server import keys as keypool

log = logging.getLogger("mug.poller")

# Sale handling (enrich + mug calc + Discord post) runs as independent tasks so it NEVER blocks the
# poll loop — a sale is processed in real time, concurrently with ongoing polling, instead of
# stalling that item's poll slot while we wait on the Torn API / Discord.
_sale_tasks: set = set()


def _spawn_sale(coro) -> None:
    task = asyncio.create_task(coro)
    _sale_tasks.add(task)
    task.add_done_callback(_sale_tasks.discard)


async def drain_sale_tasks() -> None:
    """Await all in-flight sale tasks. The poller never needs this (tasks finish on their own);
    tests use it to observe the result of a reconcile synchronously."""
    if _sale_tasks:
        await asyncio.gather(*list(_sale_tasks), return_exceptions=True)


async def run_gear_poller(bot=None) -> None:
    """Long-lived loop; started from main when DETECTION_MODE is api/both."""
    client = httpx.AsyncClient()
    log.info("gear API poller started (interval=%ss, confirm=%s polls)",
             config.GEAR_POLL_INTERVAL_SECONDS, config.GEAR_VANISH_CONFIRM_POLLS)
    try:
        while True:
            try:
                # Self-throttling: only actually re-fetches every VALUES_REFRESH_SECONDS (~4h).
                await deal_finder.maybe_refresh_values(client)
                await _poll_cycle(bot, client)
            except Exception:
                log.exception("gear poll cycle error")
                await asyncio.sleep(config.GEAR_POLL_INTERVAL_SECONDS)
    finally:
        await client.aclose()


async def _poll_cycle(bot, client: httpx.AsyncClient) -> None:
    """One full pass over the watched items, polling them CONCURRENTLY (bounded) so a large watch
    list still completes within the interval — sequential polling falls behind and detects sales
    late (by which point the cash is often banked). Then sleep the remainder of the interval so we
    don't poll faster than the API's 30s cache."""
    targets = await db.poll_targets()
    interval = config.GEAR_POLL_INTERVAL_SECONDS
    if not targets:
        await asyncio.sleep(interval)
        return

    concurrency = config.MAX_CONCURRENT_POLLS or keypool.active_count() or 1
    concurrency = max(1, min(concurrency, len(targets)))
    sem = asyncio.Semaphore(concurrency)
    all_bonus = await db.get_gear_all_bonus()   # gear to fetch with NO bonus filter (capture all)

    async def _one(item_id, is_gear, category):
        async with sem:   # each in-flight call grabs the next key in the rotation
            try:
                await poll_item(bot, client, item_id, is_gear, category, all_bonus)
            except Exception:
                log.exception("poll error item=%s", item_id)

    loop = asyncio.get_event_loop()
    t0 = loop.time()
    await asyncio.gather(*(_one(i, g, c) for i, g, c in targets))
    elapsed = loop.time() - t0
    behind = " (BEHIND — raise keys/concurrency)" if elapsed > interval else ""
    log.info("poll cycle: %d items in %.1fs, concurrency=%d%s", len(targets), elapsed, concurrency, behind)
    await asyncio.sleep(max(0.0, interval - elapsed))


async def _fetch_pages(client, item_id, bonus, max_pages):
    """Paginate up to max_pages (stops early when a page returns < 100). Returns
    (item_meta, listings); listings is None on a first-page API error, else the accumulated
    listings (possibly empty)."""
    item_meta = None
    out = []
    for page in range(max_pages):
        res = await torn.get_itemmarket(client, item_id, bonus=bonus, offset=page * 100)
        if res is None:
            return (item_meta, out if page > 0 else None)
        if item_meta is None:
            item_meta = res.get("item") or {}
        listings = res.get("listings") or []
        out.extend(listings)
        if len(listings) < 100:
            break
    return (item_meta, out)


def _detect_is_gear(item_meta, listings) -> bool:
    if (item_meta or {}).get("type") in ("Primary", "Secondary", "Melee", "Defensive"):
        return True
    return any((e.get("item_details") or {}).get("uid") is not None for e in listings)


async def poll_once(bot, client: httpx.AsyncClient) -> None:
    """One back-to-back pass over all watched items (used by tests / non-staggered mode)."""
    all_bonus = await db.get_gear_all_bonus()
    for item_id, is_gear, category in await db.poll_targets():
        await poll_item(bot, client, item_id, is_gear, category, all_bonus)


def _wants_all_bonus(item_id, category, tokens) -> bool:
    """True if this gear should be polled with NO bonus filter (capture every listing), per the
    /gear allbonus list — matched by item id or by Torn category (Primary/Secondary/Melee/Defensive)."""
    if not tokens:
        return False
    low = {str(t).lower() for t in tokens}
    return str(item_id) in low or (category and str(category).lower() in low)


async def poll_item(bot, client: httpx.AsyncClient, item_id, is_gear, category=None, all_bonus=None) -> None:
    # GEAR: filter to bonus listings (the valuable mug targets) UNLESS this item/category is on the
    # "all bonuses" list (then capture every listing). Non-gear / undetected: no filter, 1 page.
    if is_gear is True and not _wants_all_bonus(item_id, category, all_bonus):
        bonus = config.GEAR_BONUS_FILTER
    else:
        bonus = None
    max_pages = config.MAX_PAGES_GEAR if is_gear else config.MAX_PAGES_ITEM
    item_meta, listings = await _fetch_pages(client, item_id, bonus, max_pages)
    if listings is None:
        return
    if is_gear is None:
        is_gear = _detect_is_gear(item_meta, listings)
    await db.watchlist_mark_polled(
        item_id, len(listings), is_gear=is_gear, category=(item_meta or {}).get("type")
    )
    label = (item_meta or {}).get("name")
    if label:
        await db.watchlist_ensure(item_id, label, is_gear=is_gear)

    if is_gear:
        current = {}
        for entry in listings:
            det = entry.get("item_details") or {}
            uid = det.get("uid")
            if uid is None:
                continue
            current[str(uid)] = {"price": entry.get("price"), "stats": det.get("stats")}
        await reconcile_gear(bot, item_id, current, label)
    else:
        current = [{"price": e.get("price"), "amount": e.get("amount")} for e in listings]
        await reconcile_items(bot, item_id, current)
        await deal_finder.check_item_deals(
            bot, item_id, current, item_name=label, category=(item_meta or {}).get("type")
        )


async def reconcile_items(bot, item_id, current: list) -> None:
    """Items: track each UNIQUE price and watch its quantity. A quantity drop = a confident sale
    by the captured seller (matched on price+quantity). Collisions are dropped; a unique price
    fully vanishing only alerts when ITEM_ALERT_ON_REMOVE is set (sale vs delist/reprice is
    ambiguous without a uid)."""
    tracked = await db.get_tracked_items(item_id)
    price_counts: dict = {}
    amount_at: dict = {}
    for e in current:
        p = e["price"]
        price_counts[p] = price_counts.get(p, 0) + 1
        amount_at[p] = e["amount"]

    for p, count in price_counts.items():
        if count != 1:
            if p in tracked:
                await db.delete_tracked_item(item_id, p)   # became ambiguous
            continue
        amt = amount_at[p]
        if p in tracked:
            prev = tracked[p].get("last_amount")
            seller_id = tracked[p].get("seller_id")
            if prev is not None and amt < prev and seller_id:
                log.info("item sale: item=%s price=%s qty=%s seller=%s", item_id, p, prev - amt, seller_id)
                _spawn_sale(detection.on_sale(
                    seller_id=seller_id, item_id=item_id, item_name=tracked[p].get("item_name"),
                    qty=prev - amt, unit_price=p, listing_id=f"item:{item_id}:{p}", bot=bot,
                ))
            await db.upsert_tracked_item(
                item_id=item_id, price=p, seller_id=seller_id,
                item_name=tracked[p].get("item_name"), last_amount=amt,
            )
        else:
            match = await db.resolve_item_seller(item_id, p, amt)
            if match:
                await db.upsert_tracked_item(
                    item_id=item_id, price=p, seller_id=match["seller_id"],
                    item_name=match.get("item_name"), last_amount=amt,
                )

    for p, row in tracked.items():
        if p in price_counts:
            continue
        misses = await db.bump_tracked_item_miss(item_id, p)
        if misses < config.ITEM_VANISH_CONFIRM_POLLS:
            continue
        await db.delete_tracked_item(item_id, p)
        if config.ITEM_ALERT_ON_REMOVE and row.get("seller_id"):
            _spawn_sale(detection.on_sale(
                seller_id=row["seller_id"], item_id=item_id, item_name=row.get("item_name"),
                qty=row.get("last_amount") or 1, unit_price=p,
                listing_id=f"item:{item_id}:{p}", bot=bot,
            ))


async def reconcile_gear(bot, item_id, current: dict, item_label=None) -> None:
    """Diff this item's current uids. A uid we can attribute to a seller (exact uid match, or a
    unique price) is tracked for sale detection; an anonymous uid is ignored; everything else is
    recorded as UNMATCHED so the item-matcher knows to capture its seller. Vanished tracked uids
    with a seller = a sale.
    """
    tracked = await db.get_tracked_uids_for_item(item_id)
    uid_map = await db.get_gear_uid_map(item_id)
    anon = await db.get_anon_uid_set()

    price_counts: dict = {}
    for info in current.values():
        price_counts[info["price"]] = price_counts.get(info["price"], 0) + 1

    # Per-poll disposition tally (logged below; helps diagnose "weapons won't leave the list").
    stats_n = {"tracked": 0, "uid": 0, "price": 0, "anon": 0, "unmatched": 0}

    for uid, info in current.items():
        if uid in tracked:
            await db.upsert_tracked_gear(  # resets misses, refreshes last_seen
                uid=uid, item_id=item_id, item_name=tracked[uid].get("item_name"),
                price=info["price"], seller_id=tracked[uid].get("seller_id"),
                stats_json=tracked[uid].get("stats_json"),
            )
            stats_n["tracked"] += 1
            continue

        seller_id = None
        item_name = None
        how = None
        if uid in uid_map:                                   # exact uid match (best)
            seller_id = uid_map[uid]["seller_id"]
            item_name = uid_map[uid].get("item_name")
            how = "uid"
        elif price_counts.get(info["price"], 0) == 1:        # unambiguous price
            match = await db.resolve_gear_seller(item_id, info["price"])
            if match:
                seller_id = match["seller_id"]
                item_name = match.get("item_name")
                how = "price"

        if seller_id:
            await db.upsert_tracked_gear(
                uid=uid, item_id=item_id, item_name=item_name, price=info["price"],
                seller_id=seller_id,
                stats_json=json.dumps(info.get("stats")) if info.get("stats") else None,
            )
            await db.remove_unmatched_gear(uid)
            stats_n[how] += 1
        elif uid in anon:
            await db.remove_unmatched_gear(uid)              # anonymous -> stash + ignore
            stats_n["anon"] += 1
        else:                                                # missing a seller -> unmatched
            stats = info.get("stats") or {}
            stat = stats.get("damage") if stats.get("damage") is not None else stats.get("armor")
            await db.upsert_unmatched_gear(
                uid=uid, item_id=item_id, item_name=item_label, price=info["price"],
                stat=stat, accuracy=stats.get("accuracy") or 0,
            )
            stats_n["unmatched"] += 1
            if config.DEBUG_GEAR:
                log.info("  uid=%s price=%s UNMATCHED (in_uid_map=%s in_anon=%s price_count=%s)",
                         uid, info["price"], uid in uid_map, uid in anon,
                         price_counts.get(info["price"]))

    if config.DEBUG_GEAR or stats_n["unmatched"]:
        log.info("reconcile item=%s: %d listings -> tracked=%d uid=%d price=%d anon=%d unmatched=%d "
                 "(uid_map=%d, anon=%d)", item_id, len(current), stats_n["tracked"], stats_n["uid"],
                 stats_n["price"], stats_n["anon"], stats_n["unmatched"], len(uid_map), len(anon))

    # Tracked uids that are gone this poll: debounce, then treat as a sale.
    for uid, row in tracked.items():
        if uid in current:
            continue
        misses = await db.bump_tracked_miss(uid)
        if misses < config.GEAR_VANISH_CONFIRM_POLLS:
            continue
        await db.delete_tracked_gear(uid)
        if row.get("seller_id"):
            # Listed-for duration: a uid that vanishes seconds after appearing is more likely a
            # delist/reprice than a real buy (helps explain $0 mugs in the logs).
            first_seen, last_seen = row.get("first_seen"), row.get("last_seen")
            listed_for = (int(last_seen) - int(first_seen)) if (first_seen and last_seen) else None
            # Stale-match guard: if the uid was attributed but never re-confirmed present (seen in
            # only one poll), it was matched from a stale capture — e.g. a just-marked backlog whose
            # listing was already gone. Not a real sale — drop silently.
            if config.GEAR_REQUIRE_RESEEN and (row.get("seen") or 0) < 2:
                log.info("gear uid=%s item=%s: attributed but only seen %s poll(s) -> stale match, "
                         "dropping (no sale)", uid, item_id, row.get("seen") or 0)
                continue
            log.info("gear vanished -> SALE: uid=%s item=%s price=%s seller=%s listed_for=%ss "
                     "(note: a delist looks identical to a buy)",
                     uid, item_id, row.get("price"), row.get("seller_id"), listed_for)
            stats = None
            if row.get("stats_json"):
                try:
                    stats = json.loads(row["stats_json"])
                except (ValueError, TypeError):
                    stats = None
            _spawn_sale(detection.on_sale(
                seller_id=row["seller_id"], item_id=item_id,
                item_name=row.get("item_name"), qty=1, unit_price=row.get("price"),
                listing_id=f"uid:{uid}", bot=bot, stats=stats,
            ))

    await db.prune_unmatched_gear(item_id, set(current.keys()))

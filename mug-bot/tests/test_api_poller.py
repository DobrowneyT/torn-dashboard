"""
Gear API poller: an item-matcher-captured seller + a uid that appears then vanishes across two
polls = a sale. Drives api_poller.reconcile_item directly (no Torn API), temp DB, fake bot,
enrich stubbed.
"""

import asyncio

import config
from server import api_poller, db, detection


class FakeBot:
    def __init__(self):
        self.alerts = []

    async def post_mug_alert(self, event):
        self.alerts.append(event)


def test_gear_uid_vanish_is_a_sale(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "g.db"))
    monkeypatch.setattr(config, "GEAR_VANISH_CONFIRM_POLLS", 1)

    async def fake_enrich(user_id, client, force=False):
        return await db.get_seller(user_id)

    monkeypatch.setattr(detection, "enrich_seller", fake_enrich)

    async def scenario():
        await db.init_db()
        await db.set_config("min_mug_value", 1)
        # item-matcher captured: seller Vglost selling ArmaLite M-15A4 (399) at 21,200,000.
        await db.upsert_seller_seen(user_id=4106545, name="Vglost")
        await db.store_gear_listing(
            listing_id="L1", item_id=399, item_name="ArmaLite M-15A4",
            seller_id=4106545, price=21_200_000, armoury_uid="armX",
        )
        bot = FakeBot()

        # poll 1: the API shows this listing (uid at the captured price) -> we track it.
        await api_poller.reconcile_gear(bot, 399, {"19527062233": {"price": 21_200_000, "stats": {"damage": 68.66}}})
        tracked = await db.get_tracked_uids_for_item(399)
        assert "19527062233" in tracked and tracked["19527062233"]["seller_id"] == 4106545
        assert bot.alerts == []

        # poll 2: still present -> re-confirms a real listing (not a stale match).
        await api_poller.reconcile_gear(bot, 399, {"19527062233": {"price": 21_200_000, "stats": {"damage": 68.66}}})
        # poll 3: the uid is gone -> sold -> alert.
        await api_poller.reconcile_gear(bot, 399, {})
        await api_poller.drain_sale_tasks()   # sale handling runs as a background task now
        assert len(bot.alerts) == 1
        a = bot.alerts[0]
        assert a["seller_name"] == "Vglost"
        assert a["value_change"] == 21_200_000
        assert await db.get_tracked_uids_for_item(399) == {}
        await db.close_db()

    asyncio.run(scenario())


def test_unmapped_uid_is_ignored(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "g2.db"))

    async def fake_enrich(user_id, client, force=False):
        return await db.get_seller(user_id)

    monkeypatch.setattr(detection, "enrich_seller", fake_enrich)

    async def scenario():
        await db.init_db()
        bot = FakeBot()
        # No captured seller for this item/price => uid never tracked => vanish is a no-op.
        await api_poller.reconcile_gear(bot, 399, {"111": {"price": 99_999_999, "stats": None}})
        assert await db.get_tracked_uids_for_item(399) == {}
        await api_poller.reconcile_gear(bot, 399, {})
        assert bot.alerts == []
        await db.close_db()

    asyncio.run(scenario())


def test_price_collision_is_not_attributed(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "g3.db"))

    async def fake_enrich(user_id, client, force=False):
        return await db.get_seller(user_id)

    monkeypatch.setattr(detection, "enrich_seller", fake_enrich)

    async def scenario():
        await db.init_db()
        await db.set_config("min_mug_value", 1)
        await db.upsert_seller_seen(user_id=2250591, name="MonChoon")
        await db.store_gear_listing(
            listing_id="L1", item_id=399, item_name="ArmaLite M-15A4",
            seller_id=2250591, price=30_000_000, armoury_uid="arm-1",
        )
        bot = FakeBot()
        # 3 live listings at the round price 30M with no uid match -> ambiguous -> none tracked.
        await api_poller.reconcile_gear(bot, 399, {
            "111": {"price": 30_000_000, "stats": None},
            "222": {"price": 30_000_000, "stats": None},
            "333": {"price": 30_000_000, "stats": None},
        })
        assert await db.get_tracked_uids_for_item(399) == {}
        await api_poller.reconcile_gear(bot, 399, {"222": {"price": 30_000_000, "stats": None}})
        assert bot.alerts == []          # nothing was attributed, so nothing fires
        await db.close_db()

    asyncio.run(scenario())


def test_unmatched_and_anon_discovery(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "u.db"))

    async def fake_enrich(user_id, client, force=False):
        return await db.get_seller(user_id)

    monkeypatch.setattr(detection, "enrich_seller", fake_enrich)

    async def scenario():
        await db.init_db()
        # uid 111 has a captured seller; uid 333 is anonymous; uid 222 is unknown.
        await db.upsert_seller_seen(user_id=42, name="Seller")
        await db.store_gear_listing(
            listing_id="L", item_id=399, item_name="ArmaLite M-15A4",
            seller_id=42, price=100, armoury_uid="111",
        )
        await db.mark_anon_uid(uid="333", item_name="ArmaLite M-15A4", stat=68.0, accuracy=57.0, price=300)
        bot = FakeBot()
        current = {
            "111": {"price": 100, "stats": {"damage": 68.6, "accuracy": 57.7}},  # seller -> tracked
            "222": {"price": 200, "stats": {"damage": 69.0, "accuracy": 58.0}},  # no seller -> unmatched
            "333": {"price": 300, "stats": {"damage": 68.0, "accuracy": 57.0}},  # anon -> ignored
        }
        await api_poller.reconcile_gear(bot, 399, current, "ArmaLite M-15A4")

        assert "111" in await db.get_tracked_uids_for_item(399)
        assert await db.unmatched_count() == 1
        uncached = await db.get_uncached_gear()
        assert {(u["item_name"], u["price"]) for u in uncached} == {("ArmaLite M-15A4", 200)}

        # the item-matcher then captures uid 222's seller -> it leaves the unmatched list.
        await db.remove_unmatched_gear("222")
        assert await db.unmatched_count() == 0
        await db.close_db()

    asyncio.run(scenario())


def test_exact_uid_match_wins_despite_collision(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "g4.db"))
    monkeypatch.setattr(config, "GEAR_VANISH_CONFIRM_POLLS", 1)

    async def fake_enrich(user_id, client, force=False):
        return await db.get_seller(user_id)

    monkeypatch.setattr(detection, "enrich_seller", fake_enrich)

    async def scenario():
        await db.init_db()
        await db.set_config("min_mug_value", 1)
        await db.upsert_seller_seen(user_id=2250591, name="MonChoon")
        # Captured WITH the real uid ("222") -> exact join even though the price collides.
        await db.store_gear_listing(
            listing_id="L1", item_id=399, item_name="ArmaLite M-15A4",
            seller_id=2250591, price=30_000_000, armoury_uid="222",
        )
        bot = FakeBot()
        await api_poller.reconcile_gear(bot, 399, {
            "111": {"price": 30_000_000, "stats": None},
            "222": {"price": 30_000_000, "stats": None},
        })
        assert set((await db.get_tracked_uids_for_item(399)).keys()) == {"222"}
        # 222 still present (re-seen) so its later vanish counts as a real sale.
        await api_poller.reconcile_gear(bot, 399, {
            "111": {"price": 30_000_000, "stats": None},
            "222": {"price": 30_000_000, "stats": None},
        })
        await api_poller.reconcile_gear(bot, 399, {"111": {"price": 30_000_000, "stats": None}})
        await api_poller.drain_sale_tasks()   # sale handling runs as a background task now
        assert len(bot.alerts) == 1 and bot.alerts[0]["seller_name"] == "MonChoon"
        await db.close_db()

    asyncio.run(scenario())


def test_recapture_backfills_armoury_uid(tmp_path, monkeypatch):
    """A listing first stored WITHOUT a uid (old capture, surviving restarts) must get its uid
    backfilled on re-capture, or the poller re-adds it as unmatched forever (the persisting
    weapons bug). Verifies the ON CONFLICT now updates armoury_uid + is_gear."""
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "r.db"))

    async def scenario():
        await db.init_db()
        await db.upsert_seller_seen(user_id=3631262, name="TheCulturedOne")
        # Old-style capture: same listing id, no armouryID -> not joinable.
        await db.store_gear_listing(
            listing_id="L1", item_id=399, item_name="ArmaLite M-15A4",
            seller_id=3631262, price=200_000_000, armoury_uid=None,
        )
        assert await db.get_gear_uid_map(399) == {}
        # Re-capture WITH the uid -> must backfill so reconcile can join it.
        await db.store_gear_listing(
            listing_id="L1", item_id=399, item_name="ArmaLite M-15A4",
            seller_id=3631262, price=200_000_000, armoury_uid="19568008914",
        )
        umap = await db.get_gear_uid_map(399)
        assert "19568008914" in umap and umap["19568008914"]["seller_id"] == 3631262

        # And reconcile now tracks it (removes from unmatched) instead of re-adding it.
        await db.upsert_unmatched_gear(uid="19568008914", item_id=399, item_name="ArmaLite M-15A4",
                                       price=200_000_000, stat=74.57, accuracy=60.54)
        await api_poller.reconcile_gear(None, 399, {"19568008914": {"price": 200_000_000, "stats": None}})
        assert await db.get_uncached_gear() == []
        assert "19568008914" in await db.get_tracked_uids_for_item(399)
        await db.close_db()

    asyncio.run(scenario())


def test_reprice_does_not_false_sale(tmp_path, monkeypatch):
    """A delist→relist reprice: the uid is briefly absent (one poll), then reappears at a NEW
    price. With confirm=2 that gap must NOT fire a sale; the tracked entry just migrates to the
    new price and keeps the seller."""
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "rp.db"))
    monkeypatch.setattr(config, "GEAR_VANISH_CONFIRM_POLLS", 2)

    async def scenario():
        await db.init_db()
        await db.set_config("min_mug_value", 1)
        await db.upsert_seller_seen(user_id=2250591, name="MonChoon")
        await db.store_gear_listing(
            listing_id="L1", item_id=399, item_name="ArmaLite M-15A4",
            seller_id=2250591, price=200_000_000, armoury_uid="222",
        )
        bot = FakeBot()
        # Poll 1: tracked at 200M.
        await api_poller.reconcile_gear(bot, 399, {"222": {"price": 200_000_000, "stats": None}})
        assert (await db.get_tracked_uids_for_item(399))["222"]["price"] == 200_000_000
        # Poll 2: uid gone (mid-reprice). confirm=2 -> only 1 miss, no sale yet.
        await api_poller.reconcile_gear(bot, 399, {})
        assert bot.alerts == []
        assert "222" in await db.get_tracked_uids_for_item(399)
        # Poll 3: reappears at a NEW price -> migrate, reset misses, still no sale.
        await api_poller.reconcile_gear(bot, 399, {"222": {"price": 180_000_000, "stats": None}})
        assert bot.alerts == []
        t = await db.get_tracked_uids_for_item(399)
        assert t["222"]["price"] == 180_000_000 and t["222"]["seller_id"] == 2250591 and t["222"]["misses"] == 0
        await db.close_db()

    asyncio.run(scenario())


def test_gear_delist_suppressed_when_seller_just_acted(tmp_path, monkeypatch):
    """A vanished gear uid where the seller acted seconds ago = a delist, not a buy. It must NOT
    alert and the phantom sale must be removed from the window."""
    import time as _t
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "del.db"))
    monkeypatch.setattr(config, "GEAR_VANISH_CONFIRM_POLLS", 1)
    monkeypatch.setattr(config, "DELIST_GUARD_SECONDS", 180)

    async def fake_enrich(user_id, client, force=False):
        return await db.get_seller(user_id)

    monkeypatch.setattr(detection, "enrich_seller", fake_enrich)

    async def scenario():
        await db.init_db()
        await db.set_config("min_mug_value", 1)
        await db.upsert_seller_seen(user_id=2250591, name="MonChoon")
        await db.update_seller_enrichment(2250591, {"last_action_ts": int(_t.time())})  # acted now
        await db.store_gear_listing(listing_id="L1", item_id=399, item_name="ArmaLite M-15A4",
                                    seller_id=2250591, price=200_000_000, armoury_uid="222")
        bot = FakeBot()
        # Seen in 2 polls (passes the stale-match guard) so we reach the delist guard.
        await api_poller.reconcile_gear(bot, 399, {"222": {"price": 200_000_000, "stats": None}})
        await api_poller.reconcile_gear(bot, 399, {"222": {"price": 200_000_000, "stats": None}})
        await api_poller.reconcile_gear(bot, 399, {})   # uid gone
        await api_poller.drain_sale_tasks()
        assert bot.alerts == []                                            # suppressed as delist
        assert (await db.seller_window(2250591, 9_000_000))["total"] == 0  # phantom sale dropped
        await db.close_db()

    asyncio.run(scenario())


def test_gear_stale_match_dropped(tmp_path, monkeypatch):
    """A uid attributed a seller but seen in only ONE poll, then gone, is a stale match (e.g. a
    just-marked backlog whose listing was already removed) — no sale, nothing recorded."""
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "stale.db"))
    monkeypatch.setattr(config, "GEAR_VANISH_CONFIRM_POLLS", 1)

    async def fake_enrich(user_id, client, force=False):
        return await db.get_seller(user_id)

    monkeypatch.setattr(detection, "enrich_seller", fake_enrich)

    async def scenario():
        await db.init_db()
        await db.set_config("min_mug_value", 1)
        await db.upsert_seller_seen(user_id=2250591, name="MonChoon")
        await db.store_gear_listing(listing_id="L1", item_id=399, item_name="ArmaLite M-15A4",
                                    seller_id=2250591, price=200_000_000, armoury_uid="222")
        bot = FakeBot()
        await api_poller.reconcile_gear(bot, 399, {"222": {"price": 200_000_000, "stats": None}})  # seen=1
        await api_poller.reconcile_gear(bot, 399, {})                                              # gone
        await api_poller.drain_sale_tasks()
        assert bot.alerts == []
        assert (await db.seller_window(2250591, 9_000_000))["total"] == 0
        await db.close_db()

    asyncio.run(scenario())

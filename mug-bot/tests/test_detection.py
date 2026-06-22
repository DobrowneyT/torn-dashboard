"""
Drives the detection pipeline with the exact WebSocket payloads captured live (item 985),
using a temp DB and a fake bot. enrich_seller is stubbed so no network is touched.
"""

import asyncio

import config
from server import db, detection

# Real captured frames (server receives {channel, data:[ msg.data ]}).
ADD = {"channel": "item-market_985", "data": [{"message": {"namespace": "item-market", "action": "add", "data": [
    {"listingID": 78614891, "anonymous": False, "status": "online",
     "user": {"ID": 4106545, "name": "Vglost"}, "faction": {"ID": 38063, "name": "HiHk"},
     "price": 344000, "available": 1, "relatedItemID": 985}]}}]}
REMOVE = {"channel": "item-market_985", "data": [{"message": {"namespace": "item-market", "action": "remove", "data": [
    {"listingID": 78614891}]}}]}


class FakeBot:
    def __init__(self):
        self.alerts = []

    async def post_mug_alert(self, event):
        self.alerts.append(event)


def test_add_then_remove_is_a_sale(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "t.db"))

    async def fake_enrich(user_id, client, force=False):
        return await db.get_seller(user_id)

    monkeypatch.setattr(detection, "enrich_seller", fake_enrich)

    async def scenario():
        await db.init_db()
        await db.set_config("min_mug_value", 1)        # tiny sale should clear the bar
        bot = FakeBot()

        await detection.process_market_payload(ADD, bot)
        listing = await db.get_listing(78614891)
        assert listing and listing["seller_id"] == 4106545 and listing["available"] == 1

        await detection.process_market_payload(REMOVE, bot)
        assert await db.get_listing(78614891) is None      # listing removed

        assert len(bot.alerts) == 1
        a = bot.alerts[0]
        assert a["seller_name"] == "Vglost"
        assert a["value_change"] == 344000
        assert a["variant"] == "mug"

        # After alerting we claim the sale (assumed mugged), so the window is now empty and the
        # same cash won't be re-counted in a later alert.
        win = await db.seller_window(4106545, 10_000_000)
        assert win["total"] == 0 and win["count"] == 0
        await db.close_db()

    asyncio.run(scenario())


def test_clothing_store_suppresses_alert(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "t2.db"))

    async def fake_enrich(user_id, client, force=False):
        await db.update_seller_enrichment(user_id, {"in_clothing_store": 1})
        return await db.get_seller(user_id)

    monkeypatch.setattr(detection, "enrich_seller", fake_enrich)

    async def scenario():
        await db.init_db()
        # 344000 * 0.0995 * 0.25 ~= 8.5k, which is under this threshold => no alert.
        await db.set_config("min_mug_value", 200_000)
        bot = FakeBot()
        await detection.process_market_payload(ADD, bot)
        await detection.process_market_payload(REMOVE, bot)
        assert bot.alerts == []
        await db.close_db()

    asyncio.run(scenario())


def test_anonymous_listing_never_alerts(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "t3.db"))

    async def fake_enrich(user_id, client, force=False):
        return await db.get_seller(user_id)

    monkeypatch.setattr(detection, "enrich_seller", fake_enrich)

    anon_add = {"channel": "item-market_985", "data": [{"message": {"action": "add", "data": [
        {"listingID": 999, "anonymous": True, "price": 5_000_000_000, "available": 1, "relatedItemID": 985}]}}]}
    anon_remove = {"channel": "item-market_985", "data": [{"message": {"action": "remove", "data": [
        {"listingID": 999}]}}]}

    async def scenario():
        await db.init_db()
        await db.set_config("min_mug_value", 1)
        bot = FakeBot()
        await detection.process_market_payload(anon_add, bot)
        await detection.process_market_payload(anon_remove, bot)
        assert bot.alerts == []                          # anonymous => no seller to mug
        await db.close_db()

    asyncio.run(scenario())

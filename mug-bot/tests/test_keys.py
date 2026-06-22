import asyncio

import config
from server import db
from server import keys as keypool


def test_key_error_codes():
    assert 2 in keypool.KEY_ERROR_CODES        # incorrect key
    assert 10 in keypool.KEY_ERROR_CODES       # temporarily disabled
    assert 5 not in keypool.KEY_ERROR_CODES    # rate limit is NOT a key problem


def test_api_keys_crud_and_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "k.db"))

    async def scenario():
        await db.init_db()
        await db.seed_api_keys_from_env(["AAAA1111", "BBBB2222"])
        assert sorted(await db.get_enabled_api_keys()) == ["AAAA1111", "BBBB2222"]
        await keypool.refresh()
        assert keypool.active_count() == 2

        await db.api_key_set_owner("AAAA1111", 2250591, "MonChoon", 100)
        info = await db.api_key_info("AAAA1111")
        assert info["name"] == "MonChoon" and info["user_id"] == 2250591

        # a key-level error disables the key + queues exactly one status alert
        await keypool.mark_key_error("BBBB2222", 2, "Incorrect key")
        assert await db.get_enabled_api_keys() == ["AAAA1111"]
        assert keypool.active_count() == 1
        alerts = keypool.drain_alerts()
        assert len(alerts) == 1 and alerts[0]["code"] == 2
        assert keypool.drain_alerts() == []        # drained

        # removing by owner id works
        assert await keypool.remove_key(2250591) == 1
        assert await db.get_enabled_api_keys() == []
        await db.close_db()

    asyncio.run(scenario())


def _reset_pool():
    keypool._active = []
    keypool._cooldowns.clear()
    keypool._global_pause_until = 0.0


def test_rate_limit_backs_off_just_that_key(monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_BACKOFF_SECONDS", 60)
    monkeypatch.setattr(config, "RATE_LIMIT_GLOBAL_PAUSE", False)
    _reset_pool()
    keypool._active = ["K1", "K2"]

    assert keypool.next_key() in ("K1", "K2")
    keypool.mark_rate_limited("K1")
    assert {keypool.next_key() for _ in range(6)} == {"K2"}   # K1 skipped while cooling down
    keypool.mark_rate_limited("K2")
    assert keypool.next_key() is None                          # all cooling down -> calls pause
    _reset_pool()


def test_rate_limit_global_pause(monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_BACKOFF_SECONDS", 60)
    monkeypatch.setattr(config, "RATE_LIMIT_GLOBAL_PAUSE", True)
    _reset_pool()
    keypool._active = ["K1", "K2"]
    keypool.mark_rate_limited("K1")                            # one limit pauses everything
    assert keypool.next_key() is None
    _reset_pool()

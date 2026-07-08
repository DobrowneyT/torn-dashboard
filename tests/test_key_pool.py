"""Tests for the 2.0 consolidated key-pool helper (scripts/utils/key_pool.py)."""

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.utils import key_pool
from scripts.utils.key_pool import (
    claim_next_api_key,
    load_key_pool,
    EmptyKeyPoolError,
    _secret,
)


class _FakeResp:
    def __init__(self, data):
        self.data = data


class _FakeClient:
    """Minimal stand-in for the supabase client: records the last rpc call."""

    def __init__(self, data):
        self._data = data
        self.calls = []

    def rpc(self, name, params):
        self.calls.append((name, params))
        return self

    def execute(self):
        return _FakeResp(self._data)


class _FakeRotatingClient(_FakeClient):
    """Like _FakeClient, but each execute() pops the next queued response —
    mimicking the claim RPC advancing the round-robin pointer between calls."""

    def __init__(self, responses):
        super().__init__(None)
        self._responses = list(responses)

    def execute(self):
        return _FakeResp(self._responses.pop(0))


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv("APP_KEY_SECRET", "test-secret")
    yield


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """Unit tests must never hit Torn. claim_next_api_key validates keys via
    _key_is_live by default, so stub it live-by-default; individual tests
    override it to exercise the dead-key rotation paths."""
    monkeypatch.setattr(key_pool, "_key_is_live", lambda api_key, timeout=15: True)
    yield


# ── _secret resolution ────────────────────────────────────────────────────────

def test_secret_prefers_app_key_secret(monkeypatch):
    monkeypatch.setenv("APP_KEY_SECRET", "new")
    monkeypatch.setenv("CPR_KEY_SECRET", "legacy")
    assert _secret() == "new"


def test_secret_falls_back_to_cpr_key_secret(monkeypatch):
    monkeypatch.delenv("APP_KEY_SECRET", raising=False)
    monkeypatch.setenv("CPR_KEY_SECRET", "legacy")
    assert _secret() == "legacy"


def test_secret_raises_when_unset(monkeypatch):
    monkeypatch.delenv("APP_KEY_SECRET", raising=False)
    monkeypatch.delenv("CPR_KEY_SECRET", raising=False)
    with pytest.raises(RuntimeError):
        _secret()


# ── claim_next_api_key ─────────────────────────────────────────────────────────

def test_claim_returns_key_and_passes_faction_flag():
    client = _FakeClient([{"member_id": "123", "api_key": "AAAA1111BBBB2222"}])
    key = claim_next_api_key(faction_only=True, client=client)
    assert key == "AAAA1111BBBB2222"
    name, params = client.calls[-1]
    assert name == "claim_next_api_key"
    assert params["p_faction_only"] is True
    assert params["p_secret"] == "test-secret"


def test_claim_raises_on_empty_pool():
    client = _FakeClient([])
    with pytest.raises(EmptyKeyPoolError):
        claim_next_api_key(client=client)


def test_claim_raises_when_row_has_no_key():
    client = _FakeClient([{"member_id": "123", "api_key": None}])
    with pytest.raises(EmptyKeyPoolError):
        claim_next_api_key(client=client)


# ── claim_next_api_key: dead-key rotation (validate=True) ─────────────────────

def test_claim_skips_dead_key_and_returns_next_live_one(monkeypatch):
    monkeypatch.setattr(
        key_pool, "_key_is_live",
        lambda api_key, timeout=15: api_key != "DEADDEADDEADDEAD",
    )
    client = _FakeRotatingClient([
        [{"member_id": "1", "api_key": "DEADDEADDEADDEAD"}],
        [{"member_id": "2", "api_key": "LIVELIVELIVELIVE"}],
    ])
    assert claim_next_api_key(client=client) == "LIVELIVELIVELIVE"


def test_claim_raises_after_exhausting_dead_keys(monkeypatch):
    monkeypatch.setattr(key_pool, "_key_is_live", lambda api_key, timeout=15: False)
    client = _FakeClient([{"member_id": "1", "api_key": "DEADDEADDEADDEAD"}])
    with pytest.raises(RuntimeError, match="No working API key after 3 attempts"):
        claim_next_api_key(client=client, max_attempts=3)


def test_claim_validate_false_never_checks_liveness(monkeypatch):
    def _boom(api_key, timeout=15):
        raise AssertionError("_key_is_live must not be called when validate=False")

    monkeypatch.setattr(key_pool, "_key_is_live", _boom)
    client = _FakeClient([{"member_id": "123", "api_key": "AAAA1111BBBB2222"}])
    assert claim_next_api_key(client=client, validate=False) == "AAAA1111BBBB2222"


# ── load_key_pool ──────────────────────────────────────────────────────────────

def test_load_pool_returns_tuples_and_drops_empties():
    client = _FakeClient([
        {"member_id": "1", "api_key": "key1"},
        {"member_id": "2", "api_key": None},   # dropped
        {"member_id": "3", "api_key": "key3"},
    ])
    pool = load_key_pool(faction_only=False, client=client)
    assert pool == [("1", "key1"), ("3", "key3")]
    name, params = client.calls[-1]
    assert name == "get_active_key_pool"
    assert params["p_faction_only"] is False

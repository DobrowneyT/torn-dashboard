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


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setenv("APP_KEY_SECRET", "test-secret")
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

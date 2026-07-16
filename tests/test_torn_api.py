"""Rate-limit policy of the legacy scraper's Torn client (scripts/utils/torn_api.py).

2026-07-16 incident: with the rotation pool down to one key, six parallel
nightly jobs saturated it. A rate-limited request then slept 60s and retried
the SAME key three times (both the HTTP-429 path and the Torn error-code-5
path), so every job stalled for minutes and failed anyway. The policy under
test: a rate limit gets ONE short retry and then surfaces as a distinct
RateLimitedError, so callers can rotate keys or fail fast instead of dogpiling
a saturated key.
"""

import sys
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.utils import torn_api
from scripts.utils.torn_api import TornAPI, TornAPIError, RateLimitedError


class _FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}

    def raise_for_status(self):
        if self.status_code >= 400:
            err = requests.exceptions.HTTPError(f"{self.status_code} Client Error")
            err.response = self
            raise err

    def json(self):
        return self._payload


@pytest.fixture
def api(monkeypatch):
    api = TornAPI("K" * 16)
    api.rate_limit_delay = 0  # pacing sleep off — tests count only retry sleeps
    sleeps = []
    monkeypatch.setattr(torn_api.time, "sleep", lambda s: sleeps.append(s))
    api._test_sleeps = sleeps
    return api


def test_http_429_is_a_rate_limit_with_one_retry_then_typed_error(api, monkeypatch):
    calls = []

    def _get(url, params=None, timeout=None):
        calls.append(url)
        return _FakeResponse(status_code=429)

    monkeypatch.setattr(api.session, "get", _get)
    with pytest.raises(RateLimitedError):
        api._make_request("https://api.torn.com/v2/faction/members", {})
    # One retry, not three 60-second dogpiles on a saturated key.
    assert len(calls) == 2
    assert len(api._test_sleeps) == 1


def test_torn_error_code_5_maps_to_the_same_policy(api, monkeypatch):
    monkeypatch.setattr(
        api.session, "get",
        lambda url, params=None, timeout=None: _FakeResponse(
            payload={"error": {"code": 5, "error": "Too many requests"}}
        ),
    )
    with pytest.raises(RateLimitedError):
        api._make_request("https://api.torn.com/v2/faction/members", {})
    assert len(api._test_sleeps) == 1


def test_rate_limited_error_is_a_torn_api_error(api):
    # Existing scrapers catch TornAPIError — the new type must not escape them.
    assert issubclass(RateLimitedError, TornAPIError)


def test_other_torn_errors_still_raise_immediately(api, monkeypatch):
    monkeypatch.setattr(
        api.session, "get",
        lambda url, params=None, timeout=None: _FakeResponse(
            payload={"error": {"code": 2, "error": "Incorrect key"}}
        ),
    )
    with pytest.raises(TornAPIError, match="Incorrect key"):
        api._make_request("https://api.torn.com/v2/faction/members", {})
    assert api._test_sleeps == []

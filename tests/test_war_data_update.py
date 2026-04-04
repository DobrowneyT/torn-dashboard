"""
Tests for scripts/war_data_update.py

Tests cover:
- War list pagination logic
- Attack pagination cursor (DESC order, backward cursor)
- Incremental skip logic (already-scraped wars)
- Data normalization (API shape → storage shape)
"""

import sys
import os
import pytest
from unittest.mock import MagicMock, patch, call
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))


# ---------------------------------------------------------------------------
# Fixtures: sample API responses
# ---------------------------------------------------------------------------

FACTION_ID = '10739'

SAMPLE_WAR_LIST_PAGE1 = {
    'rankedwars': [
        {
            'id': 39511,
            'start': 1775160000,
            'end': 0,
            'target': 14160,
            'winner': None,
            'factions': [
                {'id': 10739, 'name': 'The Next Level - Forge', 'score': 7083},
                {'id': 25874, 'name': 'Hookers n Blow', 'score': 16047},
            ]
        },
        {
            'id': 39161,
            'start': 1774533600,
            'end': 1774911659,
            'target': 3240,
            'winner': 41929,
            'factions': [
                {'id': 10739, 'name': 'The Next Level - Forge', 'score': 7236},
                {'id': 41929, 'name': 'Valor', 'score': 10511},
            ]
        },
    ],
    '_metadata': {'links': {'prev': None, 'next': None}}
}

SAMPLE_WAR_REPORT = {
    'rankedwarreport': {
        'id': 39161,
        'start': 1774533600,
        'end': 1774911659,
        'winner': 41929,
        'forfeit': False,
        'factions': [
            {
                'id': 10739,
                'name': 'The Next Level - Forge',
                'score': 7236,
                'attacks': 740,
                'rank': {'before': 'Diamond I', 'after': 'Diamond'},
                'rewards': {
                    'respect': 8277,
                    'points': 0,
                    'items': [
                        {'id': 1120, 'name': 'Small Arms Cache', 'quantity': 1},
                        {'id': 1121, 'name': 'Medium Arms Cache', 'quantity': 3},
                    ]
                },
                'members': [
                    {'id': 3629708, 'name': 'CaptShen_616', 'level': 57, 'attacks': 11, 'score': 256.62},
                    {'id': 2250591, 'name': 'MonChoon_616', 'level': 100, 'attacks': 0, 'score': 0},
                ]
            },
            {
                'id': 41929,
                'name': 'Valor',
                'score': 10511,
                'attacks': 869,
                'rank': {'before': 'Diamond II', 'after': 'Diamond III'},
                'rewards': {'respect': 28090, 'items': []},
                'members': [
                    {'id': 2666855, 'name': 'Gumnut', 'level': 100, 'attacks': 66, 'score': 1017.81},
                ]
            }
        ]
    }
}

SAMPLE_ATTACKS_PAGE = {
    'attacks': [
        {
            'id': 461558711,
            'started': 1774911246,
            'ended': 1774911271,
            'attacker': {'id': 428286, 'name': 'AlleyCat_616', 'level': 100,
                         'faction': {'id': 10739, 'name': 'The Next Level - Forge'}},
            'defender': {'id': 2666855, 'name': 'Gumnut', 'level': 100,
                         'faction': {'id': 41929, 'name': 'Valor'}},
            'result': 'Hospitalized',
            'respect_gain': 3.64,
            'chain': 1,
            'is_ranked_war': True,
            'modifiers': {'fair_fight': 2.72, 'war': 1, 'chain': 1, 'warlord': 1}
        },
        {
            'id': 461558567,
            'started': 1774911000,
            'ended': 1774911100,
            'attacker': {'id': 428286, 'name': 'AlleyCat_616', 'level': 100,
                         'faction': {'id': 10739, 'name': 'The Next Level - Forge'}},
            'defender': {'id': 19, 'name': 'Jimmy', 'level': 0, 'faction': None},
            'result': 'Assist',
            'respect_gain': 0,
            'chain': 0,
            'is_ranked_war': False,  # non-war attack in the same window
            'modifiers': {'fair_fight': 1, 'war': 1, 'chain': 1, 'warlord': 1}
        },
    ],
    '_metadata': {'links': {'next': None}}
}


# ---------------------------------------------------------------------------
# Helper: create WarDataUpdater with mocked dependencies
# ---------------------------------------------------------------------------

def make_updater():
    with patch.dict(os.environ, {'TORN_API_KEY': 'test_key', 'TESTING_MODE': 'true'}):
        from scripts.war_data_update import WarDataUpdater
        updater = WarDataUpdater()
    updater.storage = MagicMock()
    updater.storage.read_json.return_value = None  # empty DB by default
    updater.storage.write_json = MagicMock()
    updater.api = MagicMock()
    return updater


# ---------------------------------------------------------------------------
# Tests: war list pagination
# ---------------------------------------------------------------------------

class TestFetchAllRankedWars:
    def test_single_page(self):
        updater = make_updater()
        updater.api.get_ranked_wars.return_value = SAMPLE_WAR_LIST_PAGE1
        wars = updater._fetch_all_ranked_wars()
        assert len(wars) == 2
        assert wars[0]['id'] == 39511
        assert wars[1]['id'] == 39161
        updater.api.get_ranked_wars.assert_called_once()

    def test_pagination_stops_on_no_next_link(self):
        updater = make_updater()
        page1 = {
            'rankedwars': [{'id': i, 'start': 0, 'end': 0, 'target': 0, 'winner': None, 'factions': []} for i in range(100)],
            '_metadata': {'links': {'prev': None, 'next': 'https://api.torn.com/next'}}
        }
        page2 = {
            'rankedwars': [{'id': 200, 'start': 0, 'end': 0, 'target': 0, 'winner': None, 'factions': []}],
            '_metadata': {'links': {'prev': 'something', 'next': None}}
        }
        updater.api.get_ranked_wars.side_effect = [page1, page2]
        wars = updater._fetch_all_ranked_wars()
        assert len(wars) == 101
        assert updater.api.get_ranked_wars.call_count == 2

    def test_pagination_stops_when_fewer_than_100(self):
        updater = make_updater()
        # First call returns < 100 — should stop even if next link exists
        page = {
            'rankedwars': [{'id': i, 'start': 0, 'end': 0, 'target': 0, 'winner': None, 'factions': []} for i in range(50)],
            '_metadata': {'links': {'next': 'https://api.torn.com/next'}}
        }
        updater.api.get_ranked_wars.return_value = page
        wars = updater._fetch_all_ranked_wars()
        assert len(wars) == 50
        updater.api.get_ranked_wars.assert_called_once()


# ---------------------------------------------------------------------------
# Tests: war normalization
# ---------------------------------------------------------------------------

class TestNormalizeWar:
    def test_our_faction_identified(self):
        updater = make_updater()
        raw = SAMPLE_WAR_LIST_PAGE1['rankedwars'][1]  # war 39161
        result = updater._normalize_war(raw, FACTION_ID)
        assert result['id'] == 39161
        assert result['our_score'] == 7236
        assert result['opponent_id'] == 41929
        assert result['opponent_name'] == 'Valor'
        assert result['opponent_score'] == 10511
        assert result['winner_faction_id'] == 41929
        assert result['end_at'] == 1774911659

    def test_ongoing_war_end_at_is_none(self):
        updater = make_updater()
        raw = SAMPLE_WAR_LIST_PAGE1['rankedwars'][0]  # war 39511, end=0
        result = updater._normalize_war(raw, FACTION_ID)
        assert result['end_at'] is None

    def test_is_termed_defaults_false(self):
        updater = make_updater()
        raw = SAMPLE_WAR_LIST_PAGE1['rankedwars'][1]
        result = updater._normalize_war(raw, FACTION_ID)
        assert result['is_termed'] is False

    def test_scraper_flags_default_false(self):
        updater = make_updater()
        raw = SAMPLE_WAR_LIST_PAGE1['rankedwars'][1]
        result = updater._normalize_war(raw, FACTION_ID)
        assert result['report_fetched'] is False
        # attacks_fetched no longer exists — attacks are scraped by faction_attacks_update.py


# ---------------------------------------------------------------------------
# Tests: war report application
# ---------------------------------------------------------------------------

class TestApplyWarReport:
    def test_rewards_items_extracted(self):
        updater = make_updater()
        report = SAMPLE_WAR_REPORT['rankedwarreport']
        war_entry = {'our_score': 0, 'rewards_items': None, 'rank_before': None, 'rank_after': None, 'forfeit': False, 'report_fetched': False}
        updater._apply_war_report(war_entry, report, FACTION_ID)
        assert len(war_entry['rewards_items']) == 2
        assert war_entry['rewards_items'][0]['name'] == 'Small Arms Cache'

    def test_rank_extracted(self):
        updater = make_updater()
        report = SAMPLE_WAR_REPORT['rankedwarreport']
        war_entry = {'our_score': 0, 'rewards_items': None, 'rank_before': None, 'rank_after': None, 'forfeit': False, 'report_fetched': False}
        updater._apply_war_report(war_entry, report, FACTION_ID)
        assert war_entry['rank_before'] == 'Diamond I'
        assert war_entry['rank_after'] == 'Diamond'

    def test_report_fetched_flag_set(self):
        updater = make_updater()
        report = SAMPLE_WAR_REPORT['rankedwarreport']
        war_entry = {'our_score': 0, 'rewards_items': None, 'rank_before': None, 'rank_after': None, 'forfeit': False, 'report_fetched': False}
        updater._apply_war_report(war_entry, report, FACTION_ID)
        assert war_entry['report_fetched'] is True


# ---------------------------------------------------------------------------
# Tests: contributions extraction
# ---------------------------------------------------------------------------

class TestExtractContributions:
    def test_all_factions_included(self):
        updater = make_updater()
        report = SAMPLE_WAR_REPORT['rankedwarreport']
        contributions = updater._extract_contributions(report)
        # Our faction: 2 members; opponent: 1 member
        assert len(contributions) == 3

    def test_our_faction_member(self):
        updater = make_updater()
        report = SAMPLE_WAR_REPORT['rankedwarreport']
        contributions = updater._extract_contributions(report)
        capt = next(c for c in contributions if c['member_id'] == 3629708)
        assert capt['member_name'] == 'CaptShen_616'
        assert capt['score'] == 256.62
        assert capt['attacks'] == 11
        assert capt['faction_id'] == 10739

    def test_war_id_set(self):
        updater = make_updater()
        report = SAMPLE_WAR_REPORT['rankedwarreport']
        contributions = updater._extract_contributions(report)
        assert all(c['war_id'] == 39161 for c in contributions)


# Note: _normalize_attack and _fetch_war_attacks_paginated were removed from
# WarDataUpdater — attack scraping is now handled by faction_attacks_update.py.
# Those methods' tests live in test_faction_attacks_update.py (future file).


# ---------------------------------------------------------------------------
# Tests: incremental skip logic
# ---------------------------------------------------------------------------

class TestIncrementalSkip:
    def test_completed_war_with_report_is_skipped(self):
        """A war with report_fetched=True should not trigger another report API call."""
        updater = make_updater()

        existing_db = {
            'wars': {
                '39161': {
                    'id': 39161,
                    'start_at': 1774533600,
                    'end_at': 1774911659,
                    'opponent_id': 41929,
                    'opponent_name': 'Valor',
                    'our_score': 7236,
                    'opponent_score': 10511,
                    'target': 3240,
                    'winner_faction_id': 41929,
                    'forfeit': False,
                    'is_termed': False,
                    'rewards_items': [],
                    'rank_before': 'Diamond I',
                    'rank_after': 'Diamond',
                    'report_fetched': True,
                }
            },
            'contributions': {'39161': []},
            'metadata': {'last_updated': None}
        }

        updater.storage.read_json.return_value = existing_db
        updater.api.get_ranked_wars.return_value = {
            'rankedwars': [SAMPLE_WAR_LIST_PAGE1['rankedwars'][1]],
            '_metadata': {'links': {'next': None}}
        }

        updater.update_all_wars()

        # Report should NOT be re-fetched
        updater.api.get_ranked_war_report.assert_not_called()

    def test_war_without_report_triggers_report_fetch(self):
        updater = make_updater()

        existing_db = {
            'wars': {
                '39161': {
                    'id': 39161, 'start_at': 1774533600, 'end_at': 1774911659,
                    'opponent_id': 41929, 'opponent_name': 'Valor',
                    'our_score': 7236, 'opponent_score': 10511, 'target': 3240,
                    'winner_faction_id': 41929, 'forfeit': False, 'is_termed': False,
                    'rewards_items': None, 'rank_before': None, 'rank_after': None,
                    'report_fetched': False,
                }
            },
            'contributions': {},
            'metadata': {'last_updated': None}
        }

        updater.storage.read_json.return_value = existing_db
        updater.api.get_ranked_wars.return_value = {
            'rankedwars': [SAMPLE_WAR_LIST_PAGE1['rankedwars'][1]],
            '_metadata': {'links': {'next': None}}
        }
        updater.api.get_ranked_war_report.return_value = SAMPLE_WAR_REPORT['rankedwarreport']

        updater.update_all_wars()

        updater.api.get_ranked_war_report.assert_called_once_with(39161)

    def test_ongoing_war_skips_report(self):
        """Ongoing wars (end_at is None/0) should never have report fetched."""
        updater = make_updater()
        updater.storage.read_json.return_value = {'wars': {}, 'contributions': {}, 'metadata': {}}
        # Only ongoing war (end=0)
        updater.api.get_ranked_wars.return_value = {
            'rankedwars': [SAMPLE_WAR_LIST_PAGE1['rankedwars'][0]],
            '_metadata': {'links': {'next': None}}
        }

        updater.update_all_wars()

        updater.api.get_ranked_war_report.assert_not_called()

#!/usr/bin/env python3
"""
One-shot migration: flatten -> nested personalstats shape (Phase 3).

Run AFTER applying 20260521000001_member_daily_stats_v2.sql. Reads every row
in member_daily_stats whose personalstats is in the OLD flat shape (top-level
keys like "attackswon", "criminaloffenses", "networth") and rewrites it into
the NEW nested shape (top-level keys "attacking", "crimes", "networth", …),
matching what /v2/user/{id}/personalstats?cat=all returns.

Idempotent: rows already in the nested shape are skipped.

Usage:
    python scripts/migrate_personalstats_shape.py [--dry-run]

Env: VITE_SUPABASE_URL, VITE_SUPABASE_SERVICE_ROLE_KEY
"""

import os
import sys
import logging
from pathlib import Path
from typing import Any, Dict

from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
for env_path in (SCRIPT_DIR / ".env", SCRIPT_DIR.parent / ".env"):
    if env_path.exists():
        load_dotenv(env_path)

sys.path.insert(0, str(SCRIPT_DIR))

from supabase import create_client, Client  # noqa: E402

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

CHUNK_SIZE = 200

# old flat key  →  dotted path in the new nested shape
KEY_MAP: Dict[str, str] = {
    'attackswon':            'attacking.attacks.won',
    'defendswon':            'attacking.defends.won',
    'retals':                'attacking.faction.retaliations',
    'respectforfaction':     'attacking.faction.respect',
    'rankedwarhits':         'attacking.faction.ranked_war_hits',
    'trainsreceived':        'jobs.trains_received',
    'peoplebusted':          'jail.busts.success',
    'bloodwithdrawn':        'hospital.blood_withdrawn',
    'criminaloffenses':      'crimes.offenses.total',
    'boostersused':          'items.used.boosters',
    'consumablesused':       'items.used.consumables',
    'candyused':             'items.used.candy',
    'alcoholused':           'items.used.alcohol',
    'energydrinkused':       'items.used.energy_drinks',
    'statenhancersused':     'items.used.stat_enhancers',
    'drugsused':             'drugs.total',
    'overdosed':             'drugs.overdoses',
    'rehabs':                'drugs.rehabilitations.amount',
    'rehabcost':             'drugs.rehabilitations.fees',
    'xantaken':              'drugs.xanax',
    'missioncreditsearned':  'missions.credits',
    'timeplayed':            'other.activity.time',
    'refills':               'other.refills.energy',
    'networth':              'networth.total',
    'nerverefills':          'other.refills.nerve',
}

# Keys present at the top level of the NEW nested shape — used to detect rows
# that have already been migrated (idempotency check).
NESTED_TOP_KEYS = {'attacking', 'jobs', 'jail', 'hospital', 'crimes', 'items',
                   'drugs', 'missions', 'other', 'networth'}


def is_already_nested(ps: Any) -> bool:
    if not isinstance(ps, dict):
        return False
    return any(k in NESTED_TOP_KEYS and isinstance(ps[k], dict) for k in ps)


def set_path(target: dict, dotted: str, value: Any) -> None:
    parts = dotted.split('.')
    node = target
    for k in parts[:-1]:
        if k not in node or not isinstance(node[k], dict):
            node[k] = {}
        node = node[k]
    node[parts[-1]] = value


def flatten_to_nested(flat: Dict[str, Any]) -> Dict[str, Any]:
    nested: Dict[str, Any] = {}
    for k, v in flat.items():
        path = KEY_MAP.get(k)
        if path is None:
            # Unknown key — preserve at top level so we don't drop data.
            nested[k] = v
            continue
        set_path(nested, path, v)
    return nested


def main() -> None:
    dry_run = '--dry-run' in sys.argv

    supabase_url = os.environ.get('VITE_SUPABASE_URL')
    supabase_key = os.environ.get('VITE_SUPABASE_SERVICE_ROLE_KEY')
    if not supabase_url or not supabase_key:
        raise ValueError("Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_ROLE_KEY")

    sb: Client = create_client(supabase_url, supabase_key)

    logger.info("=" * 60)
    logger.info("Personalstats shape migration (flat → nested)")
    logger.info(f"Mode: {'DRY RUN' if dry_run else 'WRITE'}")
    logger.info("=" * 60)

    # Page through rows. The PK is (member_id, snapshot_date) — order by both
    # to get deterministic pagination.
    page = 0
    total_seen = 0
    total_migrated = 0
    total_skipped_nested = 0
    total_no_data = 0

    while True:
        start = page * CHUNK_SIZE
        end = start + CHUNK_SIZE - 1
        resp = sb.table('member_daily_stats') \
            .select('member_id, snapshot_date, personalstats') \
            .order('member_id') \
            .order('snapshot_date') \
            .range(start, end) \
            .execute()
        rows = resp.data or []
        if not rows:
            break

        page += 1
        updates = []
        for row in rows:
            total_seen += 1
            ps = row.get('personalstats')
            if ps is None or ps == {}:
                total_no_data += 1
                continue
            if is_already_nested(ps):
                total_skipped_nested += 1
                continue
            new_ps = flatten_to_nested(ps)
            updates.append({
                'member_id':     row['member_id'],
                'snapshot_date': row['snapshot_date'],
                'personalstats': new_ps,
            })

        if updates:
            logger.info(f"  Page {page}: {len(updates)} rows to migrate")
            if not dry_run:
                # Upsert with on_conflict on the composite PK so we update in-place
                sb.table('member_daily_stats').upsert(
                    updates,
                    on_conflict='member_id,snapshot_date'
                ).execute()
            total_migrated += len(updates)
        else:
            logger.info(f"  Page {page}: nothing to migrate")

    logger.info("\n" + "=" * 60)
    logger.info("DONE")
    logger.info(f"Rows seen:               {total_seen}")
    logger.info(f"Rows migrated:           {total_migrated}{' (dry-run, no writes)' if dry_run else ''}")
    logger.info(f"Already-nested skipped:  {total_skipped_nested}")
    logger.info(f"No personalstats data:   {total_no_data}")
    logger.info("=" * 60)


if __name__ == '__main__':
    main()

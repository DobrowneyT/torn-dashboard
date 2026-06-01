"""
Fetch all incoming revives for a ranked war and persist them to the
`faction_revives` Supabase table.

Workflow:
  1. Pick a war (--war-id NN  or interactive picker showing the most recent
     wars from the ranked_wars table).
  2. Resolve the time window:
       * start_at  → required, no fallback
       * end_at    → falls back to "now" when the war is still ongoing
       * If start_at > now (war hasn't started), abort.
  3. ASC-paginate /v2/faction/revives?filters=incoming&from=…&to=…
     advancing the cursor on the last revive's timestamp until a partial page
     comes back.
  4. Upsert each batch into `faction_revives` with on_conflict=revive_id +
     ignore_duplicates=True (Torn revive ids are immutable, so duplicates are
     a guarantee on overlapping fetches — we want to silently skip).

Run:
  python scripts/fetch_revives_for_war.py --war-id 42698
  python scripts/fetch_revives_for_war.py                  # interactive picker
  python scripts/fetch_revives_for_war.py --list            # list recent wars

Env (loaded automatically from .env in the project root):
  TORN_API_KEY / VITE_TORN_API_KEY   — Torn API key (basic is enough)
  VITE_SUPABASE_URL                  — Supabase project URL
  VITE_SUPABASE_SERVICE_ROLE_KEY     — service-role key (server-side)
  VITE_FACTION_ID                    — our faction id, used for picker labels
"""

import argparse
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# Append (not insert) so the installed `supabase` package is found before the
# local supabase/ directory, which would otherwise shadow it.
_PROJECT_ROOT = str(Path(__file__).parent.parent)
if _PROJECT_ROOT not in sys.path:
    sys.path.append(_PROJECT_ROOT)

# Load .env so scripts work without manually exporting env vars.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(_PROJECT_ROOT) / '.env')
except ImportError:
    pass  # dotenv not installed — rely on shell environment

from supabase import create_client, Client

from scripts.utils.torn_api import TornAPI, TornAPIError

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
)
logger = logging.getLogger(__name__)

OUR_FACTION_ID = int(os.environ.get('VITE_FACTION_ID', '10739'))
PAGE_LIMIT = 100
UPSERT_CHUNK = 500  # rows per Supabase upsert call


def _supabase_client(debug: bool = False) -> Client:
    url = os.environ.get('VITE_SUPABASE_URL')
    key = os.environ.get('VITE_SUPABASE_SERVICE_ROLE_KEY')
    if not url or not key:
        raise SystemExit("Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_ROLE_KEY")
    if debug:
        print(f"\n[DEBUG] Supabase URL : {url}")
        print(f"[DEBUG] Key prefix   : {key[:20]}…  (length {len(key)})")
        # A service-role JWT encodes role=service_role; spot-check the prefix
        if not key.startswith('eyJ'):
            print("[DEBUG] WARNING: key does not look like a JWT — may be wrong env var")
    return create_client(url, key)


def _preflight_check(client: Client, debug: bool = False) -> None:
    """
    Verify the faction_revives table is reachable and print current row count.
    Raises SystemExit if the table can't be queried (missing table, wrong creds, etc.).
    """
    try:
        result = (
            client.table('faction_revives')
            .select('*', count='exact', head=True)
            .execute()
        )
        count = result.count if hasattr(result, 'count') else '?'
        print(f"[preflight] faction_revives reachable — current row count: {count}")
    except Exception as e:
        raise SystemExit(
            f"[preflight] FAILED — cannot query faction_revives: {e}\n"
            "Check VITE_SUPABASE_URL, VITE_SUPABASE_SERVICE_ROLE_KEY, and that the migration has been applied."
        )


def _torn_api() -> TornAPI:
    api_key = os.environ.get('TORN_API_KEY') or os.environ.get('VITE_TORN_API_KEY')
    if not api_key:
        raise SystemExit("Missing TORN_API_KEY / VITE_TORN_API_KEY")
    return TornAPI(api_key)


def _fmt_tct(ts: Optional[int]) -> str:
    """TCT == UTC. Format unix seconds as `YYYY-MM-DD HH:MM` for display."""
    if not ts:
        return '—'
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')


def list_recent_wars(client: Client, limit: int = 20) -> List[Dict]:
    """Return wars we participated in, newest first."""
    result = (
        client.table('ranked_wars')
        .select('id, start_at, end_at, our_score, their_score, opponent_faction_id, opponent_faction_name')
        .order('start_at', desc=True)
        .limit(limit)
        .execute()
    )
    return result.data or []


def pick_war_interactive(client: Client) -> Optional[int]:
    """Show a numbered menu of recent wars and ask the user to pick one."""
    wars = list_recent_wars(client)
    if not wars:
        print("No wars found in ranked_wars. Run war_data_update.py first?")
        return None

    print("\nMost recent wars:")
    print(f"{'#':>3}  {'War ID':>8}  {'Start (TCT)':<17}  {'End (TCT)':<17}  Opponent")
    print('-' * 90)
    for i, w in enumerate(wars, 1):
        opponent = w.get('opponent_faction_name') or f"faction {w.get('opponent_faction_id')}"
        live = 'LIVE' if not w.get('end_at') else ''
        print(f"{i:>3}  {w['id']:>8}  {_fmt_tct(w.get('start_at')):<17}  {_fmt_tct(w.get('end_at')) or '(live)':<17}  {opponent} {live}")

    choice = input("\nPick a war by number (or war id directly, blank to cancel): ").strip()
    if not choice:
        return None
    # Allow either menu index OR a war id
    if choice.isdigit():
        n = int(choice)
        if 1 <= n <= len(wars):
            return wars[n - 1]['id']
        # Treat as a war id if it doesn't match a menu index
        return n
    return None


def resolve_war_window(client: Client, war_id: int) -> Tuple[int, int]:
    """
    Look up start_at/end_at for the war. Returns (from_ts, to_ts).
    Raises SystemExit with a clear message on any failure mode.
    """
    result = (
        client.table('ranked_wars')
        .select('id, start_at, end_at')
        .eq('id', war_id)
        .maybe_single()
        .execute()
    )
    war = result.data
    if not war:
        raise SystemExit(f"War {war_id} not found in ranked_wars.")

    start_at = war.get('start_at')
    end_at = war.get('end_at')
    now = int(time.time())

    if not start_at:
        raise SystemExit(f"War {war_id} has no start_at — can't bound the fetch.")
    if start_at > now:
        raise SystemExit(f"War {war_id} hasn't started yet (start_at={_fmt_tct(start_at)}). Nothing to fetch.")

    if not end_at:
        logger.info(f"War {war_id} is still live — fetching up to now ({_fmt_tct(now)})")
        return start_at, now
    return start_at, end_at


def flatten_revive(raw: Dict, rw_id: int) -> Dict:
    """Project Torn's nested revive payload onto the flat row shape."""
    reviver = raw.get('reviver') or {}
    target = raw.get('target') or {}
    reviver_faction = reviver.get('faction') or {}
    target_faction = target.get('faction') or {}
    # last_action from the Torn v2 API is an object {"status": "...", "timestamp": N}.
    # The DB column is bigint, so extract just the timestamp integer.
    last_action_raw = target.get('last_action')
    last_action_ts = (
        last_action_raw.get('timestamp') if isinstance(last_action_raw, dict) else last_action_raw
    )
    return {
        'revive_id':            raw['id'],
        'rw_id':                rw_id,
        'timestamp':            raw.get('timestamp'),
        'reviver_id':           reviver.get('id'),
        'reviver_name':         reviver.get('name'),
        'reviver_faction_id':   reviver_faction.get('id'),
        'reviver_faction_name': reviver_faction.get('name'),
        'reviver_skill':        reviver.get('skill'),
        'target_id':            target.get('id'),
        'target_name':          target.get('name'),
        'target_faction_id':    target_faction.get('id'),
        'target_faction_name':  target_faction.get('name'),
        'hospital_reason':      target.get('hospital_reason'),
        'early_discharge':      bool(target.get('early_discharge', False)),
        'target_last_action':   last_action_ts,
        'target_online_status': target.get('online_status'),
        'success_chance':       raw.get('success_chance'),
        'result':               raw.get('result'),
    }


def upsert_revives(client: Client, rows: List[Dict], debug: bool = False) -> int:
    """
    Bulk upsert. Uses merge-duplicates (ON CONFLICT DO UPDATE) so the response
    always contains the affected rows — making it possible to count actual
    DB writes rather than just "rows we sent".
    """
    if not rows:
        return 0
    inserted = 0
    for start in range(0, len(rows), UPSERT_CHUNK):
        chunk = rows[start:start + UPSERT_CHUNK]
        if debug:
            print(f"\n[DEBUG] Upserting chunk[{start}:{start+len(chunk)}]  "
                  f"({len(chunk)} rows, first revive_id={chunk[0].get('revive_id')})")
            print(f"[DEBUG] First row payload: {chunk[0]}")
        try:
            result = client.table('faction_revives').upsert(
                chunk,
                on_conflict='revive_id',
            ).execute()
            rows_confirmed = len(result.data) if (hasattr(result, 'data') and result.data) else 0
            inserted += rows_confirmed
            if debug:
                print(f"[DEBUG] execute() returned {rows_confirmed} rows in result.data")
                if rows_confirmed == 0:
                    print(f"[DEBUG] result object: {result}")
        except Exception as e:
            logger.error(f"Upsert FAILED for chunk at index {start}: {e}")
            if debug:
                import traceback
                traceback.print_exc()
            raise
    return inserted


def fetch_revives_for_window(
    api: TornAPI,
    client: Client,
    rw_id: int,
    from_ts: int,
    to_ts: int,
    debug: bool = False,
) -> Dict[str, int]:
    """
    ASC-paginate /v2/faction/revives until a partial page comes back. The
    cursor advances on the last revive's `timestamp`. Because two revives
    can share the same epoch second, we use the seen-id set inside the loop
    to skip duplicates inside the same page-boundary edge case before they
    even reach the upsert.
    """
    cursor = from_ts
    seen: set = set()
    total_pages = 0
    total_fetched = 0
    total_upserted = 0
    total_skipped = 0

    while True:
        total_pages += 1
        try:
            resp = api.get_faction_revives(
                from_timestamp=cursor,
                to_timestamp=to_ts,
                filters='incoming',
                limit=PAGE_LIMIT,
                sort='ASC',
                comment='Forge_Revive_Backfill',
            )
        except TornAPIError as e:
            logger.error(f"Page {total_pages} API error at cursor={cursor}: {e}")
            break

        revives_raw = resp.get('revives') or []
        if not revives_raw:
            logger.info(f"Page {total_pages}: empty payload, stopping.")
            break

        # Deduplicate within this fetch session (paging boundaries can repeat
        # the last row when cursor=last.timestamp). DB upsert with
        # ignore_duplicates handles cross-run dedup; this just trims work.
        rows: List[Dict] = []
        last_ts = cursor
        for raw in revives_raw:
            rid = raw.get('id')
            if rid in seen:
                total_skipped += 1
                continue
            seen.add(rid)
            rows.append(flatten_revive(raw, rw_id))
            ts = raw.get('timestamp')
            if isinstance(ts, int) and ts > last_ts:
                last_ts = ts

        total_fetched += len(revives_raw)
        upserted = upsert_revives(client, rows, debug=debug)
        total_upserted += upserted

        logger.info(
            f"Page {total_pages}: fetched={len(revives_raw)} new={len(rows)} "
            f"upserted={upserted} cursor→{_fmt_tct(last_ts)}"
        )

        # Stop when the page wasn't full — we've reached the tail.
        if len(revives_raw) < PAGE_LIMIT:
            break
        # Advance the cursor by 1 second past the last seen timestamp to avoid
        # an infinite loop if every revive on the page shares a timestamp
        # (rare but possible). The seen-set still catches cross-page dupes.
        cursor = last_ts + 1
        if cursor > to_ts:
            break

    return {
        'pages': total_pages,
        'fetched': total_fetched,
        'upserted': total_upserted,
        'duplicates_skipped': total_skipped,
    }


def main():
    parser = argparse.ArgumentParser(description='Fetch all incoming revives for a ranked war.')
    parser.add_argument('--war-id', type=int, help='Ranked war id (skip the interactive picker).')
    parser.add_argument('--list', action='store_true', help='List the 20 most recent wars and exit.')
    parser.add_argument('--debug', action='store_true',
                        help='Verbose debugging: print credentials summary, first row payload, '
                             'raw Supabase response, and post-upsert row count.')
    args = parser.parse_args()

    client = _supabase_client(debug=args.debug)
    _preflight_check(client, debug=args.debug)

    if args.list:
        wars = list_recent_wars(client, limit=20)
        if not wars:
            print('No wars found.')
            return
        for w in wars:
            tag = ' LIVE' if not w.get('end_at') else ''
            opp = w.get('opponent_faction_name') or f"faction {w.get('opponent_faction_id')}"
            print(f"  {w['id']:>8}  {_fmt_tct(w.get('start_at'))} → {_fmt_tct(w.get('end_at')) or '(live)':<17}  vs {opp}{tag}")
        return

    war_id = args.war_id
    if war_id is None:
        war_id = pick_war_interactive(client)
        if war_id is None:
            print('Cancelled.')
            return

    from_ts, to_ts = resolve_war_window(client, war_id)
    logger.info(f"War {war_id}: fetching incoming revives from {_fmt_tct(from_ts)} to {_fmt_tct(to_ts)}")

    api = _torn_api()
    summary = fetch_revives_for_window(api, client, war_id, from_ts, to_ts, debug=args.debug)

    # Post-run verification: ask the DB how many rows actually exist for this war.
    try:
        verify = (
            client.table('faction_revives')
            .select('*', count='exact', head=True)
            .eq('rw_id', war_id)
            .execute()
        )
        db_count = verify.count if hasattr(verify, 'count') else '?'
    except Exception as e:
        db_count = f'(query failed: {e})'

    print('\n— Done —')
    print(f"  War id:               {war_id}")
    print(f"  Window (TCT):         {_fmt_tct(from_ts)}  →  {_fmt_tct(to_ts)}")
    print(f"  Pages walked:         {summary['pages']}")
    print(f"  Revives fetched:      {summary['fetched']}")
    print(f"  Revives written (DB): {summary['upserted']}")
    print(f"  In-flight dup skips:  {summary['duplicates_skipped']}")
    print(f"  DB row count (rw_id={war_id}): {db_count}  ← this is what's actually in Supabase")


if __name__ == '__main__':
    main()

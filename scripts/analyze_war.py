"""
War post-mortem: pull every incoming attack and every incoming revive for a
given war (or arbitrary TCT window) and produce two plot views.

  FACTION VIEW (default)
    Two-panel figure, time on the x-axis, stacked-bar counts:
      • Incoming attacks on our faction, stacked by attacker faction.
        At a glance you can see the war opponent's block of hits and any
        mercenary faction's block as distinct colors.
      • Incoming revives on our faction, stacked by reviver faction.
        Lets you compare the responsiveness of competing revive services.
    Same faction is the same color across both panels.

  MEMBER VIEW (--member-id N)
    Three-panel figure for one of our members:
      • Their outgoing hits, stacked by the defender's faction.
      • Their incoming hits, stacked by the attacker's faction.
      • Their incoming revives, stacked by the reviver's faction.
    Useful for asking "during the push at 02:30, did this member take all
    incoming from the war opponent, or were mercenaries piling on?"

Both views also print the faction summary table + the per-member counts to
the terminal (revives_received / incoming / war_incoming / merc_incoming /
outgoing) so you have the numeric ledger alongside the plots.

Run:
  # Faction view for a war (default)
  python scripts/analyze_war.py --war-id 42698

  # Member view for one of our players during that war
  python scripts/analyze_war.py --war-id 42698 --member-id 873341

  # Ad-hoc TCT window (no war record needed)
  python scripts/analyze_war.py --from "2026-05-30 12:00" --to "2026-05-31 02:00"

  # Top-N color slots per panel (default 8). Anyone past N collapses to "Other".
  python scripts/analyze_war.py --war-id 42698 --top-n 12

  # Dump the per-member table to CSV
  python scripts/analyze_war.py --war-id 42698 --csv out/war_42698_players.csv

  # Open the PNGs after generating
  python scripts/analyze_war.py --war-id 42698 --show
"""

import argparse
import csv
import logging
import os
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).parent.parent))

from supabase import create_client, Client

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
)
logger = logging.getLogger(__name__)

OUR_FACTION_ID = int(os.environ.get('VITE_FACTION_ID', '10739'))
# Pagination cap when reading from Supabase — PostgREST defaults to 1000 per call.
PAGE_SIZE = 1000


def _supabase_client() -> Client:
    url = os.environ.get('VITE_SUPABASE_URL')
    key = os.environ.get('VITE_SUPABASE_SERVICE_ROLE_KEY')
    if not url or not key:
        raise SystemExit("Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_ROLE_KEY")
    return create_client(url, key)


def _fmt_tct(ts: Optional[int]) -> str:
    if not ts:
        return '—'
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')


def parse_tct(s: str) -> int:
    """
    Parse a TCT timestamp from either:
      * `YYYY-MM-DD HH:MM`  (interpreted as UTC = TCT)
      * unix-seconds integer (passed through)
    """
    s = s.strip()
    if s.isdigit():
        return int(s)
    for fmt in ('%Y-%m-%d %H:%M', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d'):
        try:
            dt = datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
            return int(dt.timestamp())
        except ValueError:
            continue
    raise SystemExit(f"Could not parse TCT timestamp: {s!r}")


def resolve_window(client: Client, args) -> Tuple[int, int, Optional[int], Optional[int]]:
    """
    Returns (from_ts, to_ts, war_id, war_opponent_faction_id). war_id and
    war_opponent_faction_id are None when the user passed --from/--to instead.
    """
    if args.war_id is not None:
        result = (
            client.table('ranked_wars')
            .select('id, start_at, end_at, opponent_faction_id, opponent_faction_name')
            .eq('id', args.war_id)
            .maybeSingle()
            .execute()
        )
        war = result.data
        if not war:
            raise SystemExit(f"War {args.war_id} not found in ranked_wars.")
        start_at = war.get('start_at')
        end_at = war.get('end_at') or int(time.time())
        if not start_at or start_at > int(time.time()):
            raise SystemExit(f"War {args.war_id} hasn't started yet.")
        return start_at, end_at, war['id'], war.get('opponent_faction_id')

    if args.from_ is None or args.to is None:
        raise SystemExit("Pass either --war-id, or both --from and --to.")
    return parse_tct(args.from_), parse_tct(args.to), None, None


def _read_all(client: Client, query) -> List[Dict]:
    """
    PostgREST limits a single response to a project-configurable max
    (default 1000). Page through with `.range()` until we get a short page.
    """
    rows: List[Dict] = []
    start = 0
    while True:
        result = query.range(start, start + PAGE_SIZE - 1).execute()
        page = result.data or []
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            break
        start += PAGE_SIZE
    return rows


def fetch_revives(client: Client, from_ts: int, to_ts: int, war_id: Optional[int]) -> List[Dict]:
    q = (
        client.table('faction_revives')
        .select('*')
        .gte('timestamp', from_ts)
        .lte('timestamp', to_ts)
        .order('timestamp')
    )
    if war_id is not None:
        # Most efficient path — uses the rw_id index.
        q = q.eq('rw_id', war_id)
    return _read_all(client, q)


def fetch_attacks(client: Client, from_ts: int, to_ts: int) -> List[Dict]:
    """
    Pull every attack involving our faction in the window — both incoming
    (defender_faction_id = us) and outgoing (attacker_faction_id = us). The
    `.or()` filter is server-side so we don't fetch the whole world's attacks.
    """
    q = (
        client.table('faction_attacks')
        .select('attack_id, started, ended, attacker_id, attacker_name, attacker_faction_id, '
                'defender_id, defender_name, defender_faction_id, result, respect_gain')
        .gte('started', from_ts)
        .lte('started', to_ts)
        .or_(f'attacker_faction_id.eq.{OUR_FACTION_ID},defender_faction_id.eq.{OUR_FACTION_ID}')
        .order('started')
    )
    return _read_all(client, q)


# ── Analysis ──────────────────────────────────────────────────────────────


def faction_view(revives: List[Dict], attacks: List[Dict]) -> Dict[str, List[Tuple]]:
    """
    Returns two top-N tables:
      * attacks_by_faction:  enemy faction id/name → incoming attack count
      * revives_by_faction:  reviver faction id/name → revives count delivered to us
    """
    atk_counts: Counter = Counter()
    atk_names: Dict[int, str] = {}
    for a in attacks:
        if a.get('defender_faction_id') == OUR_FACTION_ID:
            fid = a.get('attacker_faction_id')
            if fid:
                atk_counts[fid] += 1
                # attacker_name is the player's name; we don't have faction
                # name on the attacks row — leave the lookup to the printout.

    rev_counts: Counter = Counter()
    rev_names: Dict[int, str] = {}
    for r in revives:
        fid = r.get('reviver_faction_id')
        if fid:
            rev_counts[fid] += 1
            if fid not in rev_names and r.get('reviver_faction_name'):
                rev_names[fid] = r['reviver_faction_name']

    return {
        'attacks_by_faction': sorted(
            [(fid, atk_names.get(fid, '—'), n) for fid, n in atk_counts.items()],
            key=lambda x: x[2], reverse=True,
        ),
        'revives_by_faction': sorted(
            [(fid, rev_names.get(fid, '—'), n) for fid, n in rev_counts.items()],
            key=lambda x: x[2], reverse=True,
        ),
    }


def player_view(
    revives: List[Dict],
    attacks: List[Dict],
    war_opponent_faction_id: Optional[int],
) -> List[Dict]:
    """
    Per-member counts for our faction (id 10739).
      revives_received   — incoming revives where target = them
      incoming_attacks   — attacks where defender = them
      outgoing_attacks   — attacks where attacker = them
      war_incoming       — incoming from the war opponent specifically
      merc_incoming      — incoming_attacks − war_incoming  (likely paid hits)

    war_incoming + merc_incoming is only meaningful when war_opponent_faction_id
    is known (i.e. you called --war-id). For ad-hoc windows the war column is
    None and both fields just report 0 / incoming_attacks.
    """
    by_member: Dict[int, Dict] = defaultdict(lambda: {
        'member_id': None,
        'member_name': None,
        'revives_received': 0,
        'incoming_attacks': 0,
        'outgoing_attacks': 0,
        'war_incoming': 0,
        'merc_incoming': 0,
    })

    for r in revives:
        if r.get('target_faction_id') != OUR_FACTION_ID:
            continue
        mid = r.get('target_id')
        if not mid:
            continue
        row = by_member[mid]
        row['member_id'] = mid
        row['member_name'] = row['member_name'] or r.get('target_name')
        row['revives_received'] += 1

    for a in attacks:
        # Defender is one of ours → incoming hit
        if a.get('defender_faction_id') == OUR_FACTION_ID:
            mid = a.get('defender_id')
            if mid:
                row = by_member[mid]
                row['member_id'] = mid
                row['member_name'] = row['member_name'] or a.get('defender_name')
                row['incoming_attacks'] += 1
                if war_opponent_faction_id is not None and a.get('attacker_faction_id') == war_opponent_faction_id:
                    row['war_incoming'] += 1
                else:
                    row['merc_incoming'] += 1
        # Attacker is one of ours → outgoing hit
        if a.get('attacker_faction_id') == OUR_FACTION_ID:
            mid = a.get('attacker_id')
            if mid:
                row = by_member[mid]
                row['member_id'] = mid
                row['member_name'] = row['member_name'] or a.get('attacker_name')
                row['outgoing_attacks'] += 1

    # If no war is selected, merc_incoming above counted every incoming hit
    # as "merc" because the war_opponent_faction_id check failed. Reset so
    # the output is honest.
    if war_opponent_faction_id is None:
        for row in by_member.values():
            row['merc_incoming'] = 0
            row['war_incoming'] = 0

    return sorted(by_member.values(), key=lambda r: r['revives_received'], reverse=True)


# ── Plots ─────────────────────────────────────────────────────────────────


def _pick_bin_seconds(window_seconds: int) -> Tuple[int, str]:
    """Bin width that gives roughly 30–120 bars regardless of window size."""
    if window_seconds <= 2 * 3600:        # ≤ 2h → 1-minute bins
        return 60, '1 min'
    if window_seconds <= 24 * 3600:       # ≤ 1d → 5-minute bins
        return 300, '5 min'
    if window_seconds <= 7 * 86400:       # ≤ 1w → 1-hour bins
        return 3600, '1 h'
    return 6 * 3600, '6 h'                # otherwise 6-hour bins


def _faction_label(fid: int, name_lookup: Dict[int, str]) -> str:
    nm = name_lookup.get(fid)
    return f"{nm} [{fid}]" if nm else f"faction {fid}"


def _stacked_panel(
    ax,
    events: List[Dict],
    ts_field: str,
    faction_id_field: str,
    name_lookup: Dict[int, str],
    from_ts: int,
    to_ts: int,
    bin_seconds: int,
    color_map: Dict[int, tuple],
    top_n: int,
):
    """
    Render one stacked-bar timeseries panel keyed by faction.

    Each of the top-N factions (by count in this event slice) gets its own
    stack with a stable color drawn from a shared `color_map` — passing the
    same map to multiple panels keeps the same faction the same color across
    them. Remaining factions collapse into a single grey "Other (N)" bucket.

    Side-effect: extends `color_map` with new factions as they're encountered.
    """
    import matplotlib.dates as mdates
    import matplotlib.pyplot as plt

    # Rank factions by event count in this slice.
    counts_by_faction: Counter = Counter()
    for e in events:
        fid = e.get(faction_id_field)
        if fid:
            counts_by_faction[fid] += 1

    ranked = [fid for fid, _ in counts_by_faction.most_common()]
    top_fids = ranked[:top_n]
    other_fids = set(ranked[top_n:])

    # Bin events into time buckets, splitting top-N vs Other.
    n_bins = max(1, (to_ts - from_ts) // bin_seconds + 1)
    bins_by_top: Dict[int, List[int]] = {fid: [0] * n_bins for fid in top_fids}
    bins_other: List[int] = [0] * n_bins
    for e in events:
        fid = e.get(faction_id_field)
        if not fid:
            continue
        ts = e.get(ts_field)
        if ts is None:
            continue
        idx = min(n_bins - 1, max(0, (ts - from_ts) // bin_seconds))
        if fid in other_fids:
            bins_other[idx] += 1
        else:
            bins_by_top[fid][idx] += 1

    # Assign palette colors to new factions in the shared map.
    palette = plt.get_cmap('tab20').colors
    for fid in top_fids:
        if fid not in color_map:
            color_map[fid] = palette[len(color_map) % len(palette)]

    xs = [datetime.fromtimestamp(from_ts + i * bin_seconds, tz=timezone.utc) for i in range(n_bins)]
    bar_width = bin_seconds / 86400.0  # matplotlib bar widths for date axes are in days
    bottom = [0] * n_bins
    for fid in top_fids:
        counts = bins_by_top[fid]
        if sum(counts) == 0:
            continue
        ax.bar(xs, counts, width=bar_width, bottom=bottom,
               label=_faction_label(fid, name_lookup), color=color_map[fid])
        bottom = [b + c for b, c in zip(bottom, counts)]
    if sum(bins_other) > 0:
        ax.bar(xs, bins_other, width=bar_width, bottom=bottom,
               label=f"Other ({len(other_fids)})", color='#888888')

    ax.xaxis.set_major_formatter(mdates.DateFormatter('%m-%d %H:%M'))
    ax.grid(axis='y', alpha=0.3)


def _build_faction_name_lookup(revives: List[Dict], attacks: List[Dict]) -> Dict[int, str]:
    """
    Best-effort faction-id → faction-name lookup.

    `faction_attacks` rows don't carry faction names (just IDs) — only
    `faction_revives` does. So the lookup is sparse for attacker/defender
    factions on attacks-only data, but at least the reviver side is named
    and any faction that appears in both gets the name from the revives side.
    """
    lookup: Dict[int, str] = {}
    for r in revives:
        fid, name = r.get('reviver_faction_id'), r.get('reviver_faction_name')
        if fid and name and fid not in lookup:
            lookup[fid] = name
        fid, name = r.get('target_faction_id'), r.get('target_faction_name')
        if fid and name and fid not in lookup:
            lookup[fid] = name
    return lookup


def plot_faction_view(
    revives: List[Dict],
    attacks: List[Dict],
    from_ts: int,
    to_ts: int,
    out_path: Path,
    top_n: int,
):
    """
    Faction-wide view: two stacked-bar panels sharing the time axis.
      Top panel    — incoming attacks (defender = us), stacked by attacker faction
      Bottom panel — incoming revives (target = us), stacked by reviver faction

    Stable per-faction colors across the two panels: any faction that appears
    in both attacks and revives is drawn in the same color in both legends.
    """
    import matplotlib.pyplot as plt

    bin_seconds, bin_label = _pick_bin_seconds(to_ts - from_ts)
    name_lookup = _build_faction_name_lookup(revives, attacks)

    inc_attacks = [a for a in attacks if a.get('defender_faction_id') == OUR_FACTION_ID]
    inc_revives = [r for r in revives if r.get('target_faction_id') == OUR_FACTION_ID]

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(14, 8.5), sharex=True)
    color_map: Dict[int, tuple] = {}

    _stacked_panel(ax1, inc_attacks, 'started', 'attacker_faction_id',
                   name_lookup, from_ts, to_ts, bin_seconds, color_map, top_n)
    ax1.set_title('Incoming attacks — stacked by attacker faction')
    ax1.set_ylabel(f'Attacks / {bin_label}')
    ax1.legend(loc='upper right', fontsize=8, ncol=2)

    _stacked_panel(ax2, inc_revives, 'timestamp', 'reviver_faction_id',
                   name_lookup, from_ts, to_ts, bin_seconds, color_map, top_n)
    ax2.set_title('Incoming revives — stacked by reviver faction')
    ax2.set_ylabel(f'Revives / {bin_label}')
    ax2.set_xlabel('TCT')
    ax2.legend(loc='upper right', fontsize=8, ncol=2)

    fig.suptitle(f'Faction view: {_fmt_tct(from_ts)} → {_fmt_tct(to_ts)}', fontsize=13)
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)
    logger.info(f"Saved faction view → {out_path}")


def plot_member_view(
    member_id: int,
    member_name: str,
    revives: List[Dict],
    attacks: List[Dict],
    from_ts: int,
    to_ts: int,
    out_path: Path,
    top_n: int,
):
    """
    Per-member view: three stacked panels sharing the time axis.
      Top    — this member's outgoing hits, stacked by the *defender's* faction
      Middle — this member's incoming hits, stacked by the *attacker's* faction
      Bottom — this member's incoming revives, stacked by the *reviver's* faction

    Color consistency holds across all three panels: the war opponent
    faction will be the same color top-to-bottom.
    """
    import matplotlib.pyplot as plt

    bin_seconds, bin_label = _pick_bin_seconds(to_ts - from_ts)
    name_lookup = _build_faction_name_lookup(revives, attacks)

    outgoing = [a for a in attacks if a.get('attacker_id') == member_id]
    incoming = [a for a in attacks if a.get('defender_id') == member_id]
    rev_in   = [r for r in revives if r.get('target_id')   == member_id]

    fig, (ax1, ax2, ax3) = plt.subplots(3, 1, figsize=(14, 11), sharex=True)
    color_map: Dict[int, tuple] = {}

    _stacked_panel(ax1, outgoing, 'started', 'defender_faction_id',
                   name_lookup, from_ts, to_ts, bin_seconds, color_map, top_n)
    ax1.set_title(f'Outgoing hits — stacked by defender faction ({len(outgoing)} total)')
    ax1.set_ylabel(f'Hits / {bin_label}')
    ax1.legend(loc='upper right', fontsize=8, ncol=2)

    _stacked_panel(ax2, incoming, 'started', 'attacker_faction_id',
                   name_lookup, from_ts, to_ts, bin_seconds, color_map, top_n)
    ax2.set_title(f'Incoming hits — stacked by attacker faction ({len(incoming)} total)')
    ax2.set_ylabel(f'Hits / {bin_label}')
    ax2.legend(loc='upper right', fontsize=8, ncol=2)

    _stacked_panel(ax3, rev_in, 'timestamp', 'reviver_faction_id',
                   name_lookup, from_ts, to_ts, bin_seconds, color_map, top_n)
    ax3.set_title(f'Incoming revives — stacked by reviver faction ({len(rev_in)} total)')
    ax3.set_ylabel(f'Revives / {bin_label}')
    ax3.set_xlabel('TCT')
    ax3.legend(loc='upper right', fontsize=8, ncol=2)

    fig.suptitle(
        f'Member view — {member_name or "?"} [{member_id}]   '
        f'{_fmt_tct(from_ts)} → {_fmt_tct(to_ts)}',
        fontsize=13,
    )
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)
    logger.info(f"Saved member view → {out_path}")


# ── CLI ───────────────────────────────────────────────────────────────────


def _print_faction_table(label: str, rows: List[Tuple]):
    print(f"\n{label}")
    print(f"  {'Faction ID':>10}  {'Faction name':<32}  Count")
    print('  ' + '-' * 56)
    for fid, name, n in rows[:15]:
        print(f"  {fid:>10}  {(name or '—')[:32]:<32}  {n}")


def _print_player_table(rows: List[Dict], war_known: bool):
    print('\nPLAYER VIEW (our faction only)')
    if war_known:
        hdr = f"  {'Member':<22}  {'ID':>8}  {'Revives':>8}  {'In':>4}  {'War':>4}  {'Merc':>4}  {'Out':>4}"
    else:
        hdr = f"  {'Member':<22}  {'ID':>8}  {'Revives':>8}  {'In':>4}  {'Out':>4}"
    print(hdr)
    print('  ' + '-' * (len(hdr) - 2))
    for r in rows[:50]:
        name = (r['member_name'] or '—')[:22]
        if war_known:
            print(f"  {name:<22}  {r['member_id']:>8}  {r['revives_received']:>8}  "
                  f"{r['incoming_attacks']:>4}  {r['war_incoming']:>4}  {r['merc_incoming']:>4}  {r['outgoing_attacks']:>4}")
        else:
            print(f"  {name:<22}  {r['member_id']:>8}  {r['revives_received']:>8}  "
                  f"{r['incoming_attacks']:>4}  {r['outgoing_attacks']:>4}")


def _resolve_member_name(member_id: int, attacks: List[Dict], revives: List[Dict]) -> Optional[str]:
    """
    Find a display name for the member by scanning the data we already
    loaded — saves a separate `members` table query when one isn't needed.
    """
    for a in attacks:
        if a.get('attacker_id') == member_id and a.get('attacker_name'):
            return a['attacker_name']
        if a.get('defender_id') == member_id and a.get('defender_name'):
            return a['defender_name']
    for r in revives:
        if r.get('target_id') == member_id and r.get('target_name'):
            return r['target_name']
    return None


def main():
    parser = argparse.ArgumentParser(description='War post-mortem: attacks + revives analysis.')
    parser.add_argument('--war-id', type=int, help='Ranked war id (preferred — pulls start/end from ranked_wars).')
    parser.add_argument('--from', dest='from_', help='Ad-hoc TCT start (YYYY-MM-DD HH:MM or unix seconds).')
    parser.add_argument('--to', dest='to', help='Ad-hoc TCT end.')
    parser.add_argument('--member-id', type=int, help='Switch to the per-member 3-panel view for this member.')
    parser.add_argument('--top-n', type=int, default=8, help='Per-panel max distinct faction stacks (rest → "Other"). Default 8.')
    parser.add_argument('--csv', help='Optional path to dump the per-member table to CSV.')
    parser.add_argument('--out-dir', default='out', help='Directory for plot PNGs (default: ./out).')
    parser.add_argument('--show', action='store_true', help='Open plots after generating.')
    args = parser.parse_args()

    client = _supabase_client()
    from_ts, to_ts, war_id, war_opp = resolve_window(client, args)
    logger.info(f"Window: {_fmt_tct(from_ts)} → {_fmt_tct(to_ts)} ({(to_ts - from_ts) // 60} min)")

    revives = fetch_revives(client, from_ts, to_ts, war_id)
    attacks = fetch_attacks(client, from_ts, to_ts)
    logger.info(f"Loaded {len(revives)} revives, {len(attacks)} attacks involving our faction.")

    fv = faction_view(revives, attacks)
    _print_faction_table('FACTION VIEW — incoming attacks by attacker faction', fv['attacks_by_faction'])
    _print_faction_table('FACTION VIEW — incoming revives by reviver faction', fv['revives_by_faction'])

    pv = player_view(revives, attacks, war_opp)
    _print_player_table(pv, war_known=war_opp is not None)

    if args.csv:
        Path(args.csv).parent.mkdir(parents=True, exist_ok=True)
        with open(args.csv, 'w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=list(pv[0].keys()) if pv else [])
            writer.writeheader()
            writer.writerows(pv)
        print(f"\nWrote player CSV → {args.csv}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    tag = f'war{war_id}' if war_id else f'{from_ts}_{to_ts}'

    written: List[Path] = []
    if args.member_id is not None:
        # Member view: 3-panel per-member breakdown.
        name = _resolve_member_name(args.member_id, attacks, revives)
        if name is None:
            logger.warning(
                f"No attacks or revives in the window mention member_id={args.member_id}. "
                "Plot will still render but be empty."
            )
        out_path = out_dir / f'{tag}_member{args.member_id}.png'
        plot_member_view(args.member_id, name or '?', revives, attacks,
                         from_ts, to_ts, out_path, top_n=args.top_n)
        written.append(out_path)
    else:
        # Faction view: 2-panel faction-stacked timeseries.
        out_path = out_dir / f'{tag}_faction_view.png'
        plot_faction_view(revives, attacks, from_ts, to_ts, out_path, top_n=args.top_n)
        written.append(out_path)

    if args.show:
        try:
            import subprocess, platform
            opener = 'open' if platform.system() == 'Darwin' else 'xdg-open'
            for p in written:
                subprocess.Popen([opener, str(p)])
        except Exception as e:
            logger.warning(f"Couldn't open plots: {e}")


if __name__ == '__main__':
    main()

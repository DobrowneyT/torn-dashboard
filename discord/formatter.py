"""
Turn the alerts dict (from alerts.build_alerts) into a list of discord.Embed.

Layout: a single embed.
  - Title:       "OC Watcher"
  - Description: legend (🚑 / 🎒 / 📉) + crime count + per-crime blocks.
                 Each crime is one block: header line followed by an
                 indented bullet per offending member, prefixed with the
                 alert-type emoji.
  - Color:       severity-driven — red if any unavailable, else orange if
                 any missing items, else blue if only low CPR, else green.
  - Footer:      "Last updated …" — refresh acts as a watchdog.

Crimes whose only issues were approved are filtered upstream in alerts.py,
so this layer never has to render an "approval-only" crime.
"""

from datetime import datetime, timezone
from typing import Dict, List, Optional

import discord


PROFILE_URL = "https://www.torn.com/profiles.php?XID={user_id}"

COLOR_OK = 0x2ECC71          # green — all clear
COLOR_LOW_CPR = 0x3498DB     # blue
COLOR_MISSING = 0xE67E22     # orange
COLOR_UNAVAILABLE = 0xE74C3C # red

EMBED_TITLE = "OC Watcher"

LEGEND = "🚑 Unavailable  ·  🎒 Missing items  ·  📉 CPR too low"

# Discord description max is 4096 chars; leave headroom for the truncation hint.
DESCRIPTION_LIMIT = 4000


def build_embeds(alerts: Dict, *, now_ts: Optional[int] = None) -> List[discord.Embed]:
    crimes = alerts.get("crimes", [])
    generated_at = alerts.get("generated_at", "")

    if not crimes:
        embed = discord.Embed(
            title=EMBED_TITLE,
            description=f"{LEGEND}\n\nAll clear — no organized crimes need attention.",
            color=COLOR_OK,
        )
        embed.set_footer(text=_footer_text(generated_at))
        return [embed]

    n = len(crimes)
    header = (
        f"{LEGEND}\n\n"
        f"**{n} crime{'s' if n != 1 else ''} need attention.**"
    )
    blocks = [_crime_block(c, index=i + 1, now_ts=now_ts) for i, c in enumerate(crimes)]
    description = _join_with_header(header, blocks, DESCRIPTION_LIMIT)

    embed = discord.Embed(
        title=EMBED_TITLE,
        description=description,
        color=_severity_color(crimes),
    )
    embed.set_footer(text=_footer_text(generated_at))
    return [embed]


def _crime_block(crime: Dict, *, index: int, now_ts: Optional[int]) -> str:
    when = _format_hours(crime["hours_until"])
    header = (
        f"**{index}.** **{crime['name']}** — executes in {when} "
        f"• [#{crime['id']}]({crime['url']})"
    )

    bullets: List[str] = []

    for m in crime.get("unavailable", []):
        bullets.append(
            f"> 🚑 {_member_link(m)} — {m['position']}: "
            f"{m['state']}{_until_str(m.get('until'), now_ts)}"
        )
    for m in crime.get("missing_items", []):
        bullets.append(
            f"> 🎒 {_member_link(m)} — {m['position']}: {m['item']}"
        )
    for m in crime.get("low_cpr", []):
        bullets.append(
            f"> 📉 {_member_link(m)} — {m['position']}: {m['cpr']} / {m['required']}"
        )

    return header + "\n" + "\n".join(bullets)


def _severity_color(crimes: List[Dict]) -> int:
    if any(c.get("unavailable") for c in crimes):
        return COLOR_UNAVAILABLE
    if any(c.get("missing_items") for c in crimes):
        return COLOR_MISSING
    if any(c.get("low_cpr") for c in crimes):
        return COLOR_LOW_CPR
    return COLOR_OK


def _join_with_header(header: str, blocks: List[str], limit: int) -> str:
    """Join header + blocks separated by blank lines, truncating with a hint if over `limit`."""
    parts = [header]
    used = len(header)
    truncated = 0
    for i, block in enumerate(blocks):
        addition = "\n\n" + block
        if used + len(addition) > limit:
            truncated = len(blocks) - i
            break
        parts.append(block)
        used += len(addition)
    out = "\n\n".join(parts)
    if truncated:
        out += f"\n\n…and {truncated} more crime{'s' if truncated != 1 else ''} omitted (length cap)."
    return out


def _member_link(member: Dict) -> str:
    url = PROFILE_URL.format(user_id=member["user_id"])
    return f"[{member['name']}]({url}) ({member['user_id']})"


def _format_hours(hours: float) -> str:
    if hours < 0:
        return "now"
    if hours < 1:
        mins = max(int(round(hours * 60)), 1)
        return f"{mins}m"
    whole = int(hours)
    mins = int(round((hours - whole) * 60))
    if mins == 60:
        whole, mins = whole + 1, 0
    return f"{whole}h" if mins == 0 else f"{whole}h {mins}m"


def _until_str(until_ts: Optional[int], now_ts: Optional[int]) -> str:
    if not until_ts or not now_ts:
        return ""
    remaining_h = (until_ts - now_ts) / 3600.0
    if remaining_h <= 0:
        return ""
    return f" (~{_format_hours(remaining_h)} left)"


def _format_iso_short(iso: str) -> str:
    if not iso:
        return "?"
    try:
        dt = datetime.fromisoformat(iso).astimezone(timezone.utc)
        return dt.strftime("%Y-%m-%d %H:%M UTC")
    except ValueError:
        return iso


def _footer_text(generated_at: str) -> str:
    return f"Last updated {_format_iso_short(generated_at)} • refreshes every 60s"

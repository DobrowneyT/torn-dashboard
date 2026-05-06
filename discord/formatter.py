"""
Turn the alerts dict (from alerts.build_alerts) into a discord.Embed.

Layout:
  - Title: "OC Watcher"
  - Description: header line ("N crimes need attention.") followed by one
    block per crime. Each block is the crime header (name, time, linked id)
    followed by blockquote-indented alert sections so the per-crime alerts
    are visually nested under their crime.
  - Footer: "Last updated …"
"""

from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional

import discord


PROFILE_URL = "https://www.torn.com/profiles.php?XID={user_id}"

COLOR_OK = 0x2ECC71      # green
COLOR_ALERT = 0xE74C3C   # red

EMBED_TITLE = "OC Watcher"

# Discord description max is 4096 chars; leave room for the trailing notice.
DESCRIPTION_LIMIT = 4000


def build_embed(alerts: Dict, *, now_ts: Optional[int] = None) -> discord.Embed:
    crimes = alerts.get("crimes", [])
    generated_at = alerts.get("generated_at", "")

    if not crimes:
        embed = discord.Embed(
            title=EMBED_TITLE,
            description="All clear — no organized crimes need attention.",
            color=COLOR_OK,
        )
    else:
        n = len(crimes)
        header = f"**{n} crime{'s' if n != 1 else ''} need attention.**"
        blocks = [_crime_block(c, index=i, now_ts=now_ts) for i, c in enumerate(crimes)]
        description = _join_with_limit(header, blocks, DESCRIPTION_LIMIT)

        embed = discord.Embed(
            title=EMBED_TITLE,
            description=description,
            color=COLOR_ALERT,
        )

    embed.set_footer(text=f"Last updated {_format_iso_short(generated_at)} • refreshes every 60s")
    return embed


def _crime_block(crime: Dict, *, index: int, now_ts: Optional[int]) -> str:
    """Header line for the crime followed by blockquote-indented alert sections."""
    when = _format_hours(crime["hours_until"])
    header = f"**{index + 1}.** **{crime['name']}** — executes in {when} • [#{crime['id']}]({crime['url']})"

    sections: List[str] = []

    if crime["missing_items"]:
        sections.append(_section(
            "🎒 Missing items",
            (f"{_member_link(m)} — {m['position']}: {m['item']}" for m in crime["missing_items"]),
        ))

    if crime["unavailable"]:
        sections.append(_section(
            "🚑 Unavailable",
            (
                f"{_member_link(m)} — {m['position']}: {m['state']}{_until_str(m.get('until'), now_ts)}"
                for m in crime["unavailable"]
            ),
        ))

    if crime["low_cpr"]:
        bullets = [
            f"{_member_link(m)} — {m['position']}: {m['cpr']} / {m['required']}"
            for m in crime["low_cpr"]
        ]
        approved = crime.get("low_cpr_approved", 0)
        if approved:
            bullets.append(f"_✓ {approved} approved_")
        sections.append(_section("📉 Below CPR", bullets))
    elif crime.get("low_cpr_approved", 0):
        # All low-CPR alerts for this crime have been approved; surface that
        # fact so the user sees their overrides are active.
        sections.append(_section(
            "📉 Below CPR",
            [f"_✓ {crime['low_cpr_approved']} approved (no remaining alerts)_"],
        ))

    return header + "\n" + "\n".join(sections)


def _section(title: str, bullets: Iterable[str]) -> str:
    """Render one alert section as a Discord blockquote (visually indented)."""
    lines = [f"> **{title}**"]
    for b in bullets:
        lines.append(f"> • {b}")
    return "\n".join(lines)


def _join_with_limit(header: str, blocks: List[str], limit: int) -> str:
    """Join header + blocks separated by blank lines, truncating if we run over."""
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

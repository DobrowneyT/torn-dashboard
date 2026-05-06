"""
Pure logic: turn a list of (enriched) crime dicts + a member-status map
into a structured alerts dict suitable for the formatter.

The crimes passed in are expected to already carry display names on
slot.user.name and slot.item_requirement.name (see enrich.py). If those
names are missing the code falls back to "user_<id>" / "item_<id>".

Three alert categories per crime:
  - missing_items: assigned member doesn't have the slot's required item
                   AND crime executes within WINDOW_MISSING_ITEMS_HOURS
  - unavailable:   assigned member is in Hospital/Jail/Abroad/etc.
                   AND crime executes within WINDOW_UNAVAILABLE_HOURS
  - low_cpr:       assigned member's CPR is below the configured threshold
                   for that crime+position (no time window)

Crimes with zero issues are filtered out.
"""

import re
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set, Tuple

from config import (
    ACTIVE_CRIME_STATUSES,
    CPR_REQUIREMENTS,
    CRIME_URL_TEMPLATE,
    DEFAULT_CPR_THRESHOLD,
    UNAVAILABLE_STATES,
    WINDOW_MISSING_ITEMS_HOURS,
    WINDOW_UNAVAILABLE_HOURS,
)

_INSTANCE_SUFFIX = re.compile(r"\s*#\d+\s*$")

OverrideKey = Tuple[int, int, str]  # (crime_id, user_id, position_label)


def build_alerts(
    crimes: List[Dict],
    member_status: Optional[Dict[int, Dict]],
    now_ts: int,
    *,
    cpr_overrides: Optional[Set[OverrideKey]] = None,
) -> Dict:
    """
    Args:
        crimes: list of enriched crime dicts (see enrich.enrich_crimes).
        member_status: optional map of user_id -> {"state": str, "until": int}.
                       Pass None or {} if status data isn't available this tick.
        now_ts: current unix timestamp.
        cpr_overrides: optional set of (crime_id, user_id, position) tuples
                       that have been explicitly approved; matching low_cpr
                       entries are suppressed (counted instead).

    Returns:
        {
          "generated_at": iso8601 str,
          "crimes": [ ...one entry per crime with at least one issue... ]
        }
    """
    member_status = member_status or {}
    cpr_overrides = cpr_overrides or set()

    flagged = []
    for crime in crimes:
        if crime.get("status") not in ACTIVE_CRIME_STATUSES:
            continue
        ready_at = crime.get("ready_at")
        if not ready_at:
            continue

        hours_until = (ready_at - now_ts) / 3600.0
        crime_name = crime.get("name", "")
        position_thresholds = CPR_REQUIREMENTS.get(crime_name, {}).get("positions", {})

        missing_items: List[Dict] = []
        unavailable: List[Dict] = []
        low_cpr: List[Dict] = []

        for slot in crime.get("slots", []):
            user = slot.get("user")
            if not user:
                continue

            label = _position_label(slot)
            user_id = user.get("id")
            user_name = user.get("name") or f"user_{user_id}"

            # 1) Missing item (within 24h window)
            if hours_until <= WINDOW_MISSING_ITEMS_HOURS:
                req = slot.get("item_requirement")
                if req and not req.get("is_available", True):
                    missing_items.append({
                        "user_id": user_id,
                        "name": user_name,
                        "position": label,
                        "item": req.get("name") or f"item_{req.get('id')}",
                    })

            # 2) Unavailable (within 6h window)
            if hours_until <= WINDOW_UNAVAILABLE_HOURS:
                status = member_status.get(user_id)
                if status and status.get("state") in UNAVAILABLE_STATES:
                    unavailable.append({
                        "user_id": user_id,
                        "name": user_name,
                        "position": label,
                        "state": status["state"],
                        "until": status.get("until"),
                    })

            # 3) Low CPR (no time window). Falls back to DEFAULT_CPR_THRESHOLD
            # when this crime or this specific position isn't tuned in config.
            required = _resolve_cpr_threshold(label, position_thresholds)
            cpr = slot.get("checkpoint_pass_rate")
            if cpr is not None and cpr < required:
                low_cpr.append({
                    "user_id": user_id,
                    "name": user_name,
                    "position": label,
                    "cpr": int(round(float(cpr))),
                    "required": required,
                })

        # Apply CPR overrides AFTER collecting low_cpr so the count of
        # approvals is accurate (and the formatter can show it).
        approved = 0
        if cpr_overrides:
            kept = []
            for entry in low_cpr:
                key = (crime["id"], entry["user_id"], entry["position"])
                if key in cpr_overrides:
                    approved += 1
                else:
                    kept.append(entry)
            low_cpr = kept

        if missing_items or unavailable or low_cpr:
            flagged.append({
                "id": crime["id"],
                "name": crime_name,
                "executes_at": ready_at,
                "hours_until": round(hours_until, 1),
                "url": CRIME_URL_TEMPLATE.format(crime_id=crime["id"]),
                "missing_items": missing_items,
                "unavailable": unavailable,
                "low_cpr": low_cpr,
                "low_cpr_approved": approved,
            })

    flagged.sort(key=lambda c: c["executes_at"])

    return {
        "generated_at": datetime.fromtimestamp(now_ts, tz=timezone.utc).isoformat(),
        "crimes": flagged,
    }


def _position_label(slot: Dict) -> str:
    """Prefer position_info.label (e.g. "Muscle #1"); fall back to bare position."""
    info = slot.get("position_info") or {}
    return info.get("label") or slot.get("position") or ""


def _resolve_cpr_threshold(label: str, thresholds: Dict[str, int]) -> int:
    """
    Try the suffixed label first ("Muscle #1"), then the base name ("Muscle"),
    and finally fall back to DEFAULT_CPR_THRESHOLD. The config mixes both
    styles and doesn't list every crime/role, so we always have to be ready
    to fall through to the default.
    """
    if label in thresholds:
        return thresholds[label]
    base = _INSTANCE_SUFFIX.sub("", label)
    if base in thresholds:
        return thresholds[base]
    return DEFAULT_CPR_THRESHOLD

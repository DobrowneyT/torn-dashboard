# War Room v2 — Phase 4 Validation Guide

Track real-world usage of v2 against v1 over ~1 week of war and idle traffic.
This doc captures **what to compare**, **where to look**, and the **cutover
plan** for Phase 5/6 once validation passes.

---

## What "validated" means

Three boxes must check before cutover:

1. **Behavioral parity** — every flow that works in v1 works in v2 with the
   same observable result (within ~1 s timing tolerance).
2. **Cost parity (down)** — Realtime usage on v2 is effectively zero; egress
   is within the projected ~190 GB/month budget; Edge Function invocations
   unchanged (write side wasn't touched).
3. **No regressions** in dibs claim/release race behavior or save flow.

---

## Behavioral parity checklist

Open `/rw/war-room` (v1) and `/rw/war-room-v2` in two adjacent browsers (or
two tabs in the same browser) under your account. They should show identical
data within ~1 s of each other. Run these flows in each:

### Member updates
- [ ] Status state change (someone hospitalised) → both UIs reflect the new
      status badge + countdown within ~1 s.
- [ ] Activity transitions (Online → Idle → Offline) → both update the
      activity column.
- [ ] BSP enrichment (Update Spies) → both populate the same totals.

### Dibs
- [ ] Claim a target in v1 → appears in v2 within ~1 s (and vice versa,
      since both backends are independent during validation).
- [ ] Release a dib → tombstone propagates to both.
- [ ] Two leaders race to claim the same target → DB unique partial index
      gives one of them the claim, the other sees the owner's name returned
      from the 409. Same behavior on both versions.

### Config
- [ ] Toggle Enable War Room in v1 → v2's Live badge does NOT change
      (independent backends — by design during validation). Same flip
      separately on v2's own toggle.
- [ ] Switch enemy faction via Save → both versions populate the new roster
      on their own next Save.

### Save / Clear
- [ ] Save a new faction id → table populates within ~1 s on v2.
- [ ] Clear State → all rows disappear from v2's table within ~1 s
      (tombstones sweep through the polling channel).

### Update Spies
- [ ] Click Update Spies in a paused state (no members loaded) → fetches
      members first, then BSP. Same behavior as v1.

---

## Cost monitoring

### Realtime messages (the whole point of v2)

Dashboard path: **Supabase Project → Reports → Realtime messages**.

Filter for the last 24 h while only the v2 tab is open. You should see:
- **A flat-zero line for v2-only traffic.** v2 sends no Realtime messages.
- v1 still emits if anyone else has v1 open. Confirm the rate drops
  proportional to v2 adoption.

If v2 shows any Realtime messages, something's wrong — investigate immediately.

### Egress

Dashboard path: **Supabase Project → Reports → Egress**.

Expectation: v2's polling RPCs use HTTP+gzip. With ~30 viewers polling at
1 Hz, war-day egress should run **~10 GB/day**; off-peak ~5 GB/day. Total
month should land at **~190 GB**.

If egress runs higher: response payload regression (the delta RPC is
returning more than it should). Inspect by recording a poll in DevTools
and checking the response size.

### Edge Function invocations

Dashboard path: **Supabase Project → Edge Functions → war-room-fetch → Logs / Stats**.

Expectation: unchanged from v1. Each viewer still polls Torn every
`pollIntervalSec` seconds. v2 doesn't reduce this; only the read path
changed. (See "Future work" below.)

### Postgres CPU + connection pool

Dashboard path: **Supabase Project → Reports → Database**.

The delta RPCs hit the `updated_at` btree index. With 30 viewers × 1 Hz
× 3 RPC calls/tick = 90 queries/sec total. Postgres handles this easily
for indexed queries, but watch for:
- CPU > 60% sustained → may need to bump the polling interval or add
  caching.
- Connection saturation → unlikely since PostgREST pools, but check.

---

## Edge cases worth a manual test

- **Tab backgrounded for >5 min** then re-foregrounded: hook should
  resume at the configured interval. No stale data, no duplicate rows.
  (The visibility-aware polling drops to 5 s while hidden.)
- **Network blip**: drop wifi for 30 s then reconnect. v2 should
  resume polling without a full-page reload. Watermark should pick up
  where it left off.
- **Long-running session (>24 h)**: leave a v2 tab open overnight.
  No memory leak, no token expiry weirdness, RPC calls still authorised.
- **Concurrent claim race**: two browsers race to claim the same target.
  Confirm one wins, one sees the 409 with owner info.

---

## When to call validation passed

Minimum criteria before triggering Phase 5 cutover:
- All behavioral parity checks pass.
- At least one **full war cycle** (war start → war end → recovery) run
  on v2 without a leadership-reported issue.
- Realtime message rate on v2 confirmed zero across a 24 h window.
- Egress within budget across a 24 h window with v2-only traffic.

Suggested duration: **1 week**, including at least one peak-war period.

---

## Phase 5 cutover plan (preview)

Once validated, the cutover is intentionally low-risk:

1. **Swap routes** in `src/views/RWPage.jsx`:
   - `/rw/war-room` → renders `WarRoomViewV2`
   - `/rw/war-room-v2` → can stay as an alias, or removed
2. **Delete v1 view** (`WarRoomView.jsx`, `warRoomApi.js`) — but only
   after a confidence interval (e.g., another 48 h running the v2 view
   at the canonical `/rw/war-room` route).
3. **Rename `_v2` tables to canonical names** via migration:
   ```sql
   -- Done in a separate, reviewable migration. Idempotent.
   ALTER TABLE war_room_state_v2  RENAME TO war_room_state_new;
   ALTER TABLE war_room_state     RENAME TO war_room_state_legacy;
   ALTER TABLE war_room_state_new RENAME TO war_room_state;
   -- (Plus matching RPC, trigger, RLS policy renames.)
   ```
   The rename approach is preferred over drop+recreate because it
   preserves data continuity for the hook's watermark — clients keep
   their `p_since` and the next poll just returns whatever's changed.
4. **Drop v1 Realtime triggers + RLS policy on `realtime.messages`**:
   ```sql
   DROP TRIGGER war_room_state_broadcast  ON war_room_state_legacy;
   DROP TRIGGER war_room_dibs_broadcast   ON war_room_dibs_legacy;
   DROP TRIGGER war_room_config_broadcast ON war_room_config_legacy;
   DROP FUNCTION war_room_broadcast();
   DROP POLICY "war_room: authenticated can read broadcasts"
     ON realtime.messages;
   ```
5. **Drop the `jwt_secret` Edge Function secret** if no other feature
   uses it. (PostgREST/RPC calls use the standard supabase-js auth
   stack — they don't need the function-minted JWT.)
6. **Drop legacy tables** (after another ~48 h):
   ```sql
   DROP TABLE war_room_state_legacy CASCADE;
   DROP TABLE war_room_dibs_legacy CASCADE;
   DROP TABLE war_room_config_legacy CASCADE;
   ```

Total time from cutover start to legacy drop: ~96 hours. Each step is
independently reversible until step 6.

### Saved view migration
v2 currently uses `useViewState('warroom_desktop_v2')` to keep filter
prefs separate from v1. At cutover we either:
- **Rename storage keys** (one-time migration on first v2 load):
  copy `warroom_desktop` → `warroom_desktop_v2` if the v2 entry is
  empty. Drop the rename code after a week.
- **Reset** (declared beta — users re-configure). Simpler; OK given
  user already accepts this.

---

## Future work (post-cutover)

These are *not* blockers for v2 validation but should be tracked as
follow-up work:

1. **Centralised Torn polling.** Today each viewer polls Torn independently
   (30 viewers × 3 s = 10 calls/sec to Torn). A pg_cron job (or a
   single-leader-elected client) calling `fetch_members_v2` globally
   would cut this to 1 call per faction per interval. Reduces Edge
   Function invocations + Torn API rate consumption ~30×.

2. **Tombstone GC.** A daily `pg_cron` job to hard-delete rows where
   `deleted_at < now() - interval '24 hours'`. Prevents tables from
   growing without bound.

3. **Pagination / pruning.** Not needed at 175 rows. Add if v2 ever
   handles multiple opponent factions simultaneously.

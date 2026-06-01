# War Room v2 — Polling Architecture

## Problem

Current architecture (v1) uses Supabase Realtime broadcast for every changed row.

**Measured usage:** 162 messages/sec → 14M/day → **~420M/month**.
**Pro plan quota:** 5M/month included, $2.50 per additional million → **overage cost ≈ $1,037/month** in Realtime fees alone.

**Why this is architecturally unfixable:**
- Cost scales as `changed_rows/sec × subscribers`.
- Already at 32% of the Pro per-second cap (500 msg/s) with a single faction × 30 viewers. A second faction or more viewers exceeds the hard limit.
- Aggregating broadcasts (1 per tick instead of 1 per row) only divides cost by the average row-change count; the `× subscribers` multiplier remains. Insufficient.

**Verified against Supabase docs:**
- `https://supabase.com/docs/guides/realtime/quotas.md` — Pro: 500 msg/s, 3 MB payload, 500 concurrent connections.
- `https://supabase.com/pricing` — Pro: 5M msgs included, $2.50/M overage; 250 GB egress, $0.09/GB overage.

## Solution: HTTP delta polling on `updated_at` watermark

Each client polls a single endpoint every ~1 s:
> _"Give me every row whose `updated_at > last_seen_timestamp`."_

Server returns only what changed since the last poll, plus the current server timestamp to use as the next watermark. No Realtime involved — no per-subscriber multiplier, and the bandwidth bill is paid in cheaper egress instead of expensive Realtime messages.

### Math for v2 (delta polling at 1 Hz, 30 viewers)

| Scenario | Avg changes / tick | Bytes / tick | 30 viewers × 1 Hz | Per day | Per month |
|---|---|---|---|---|---|
| War peak | 5 rows × 600 B = 3 KB | + 1 KB headers ≈ 4 KB | 120 KB/s | ~10 GB | ~310 GB/mo |
| Off-peak | 0–1 rows ≈ 1 KB | 2 KB | 60 KB/s | ~5 GB | ~155 GB/mo |
| Realistic mix (2 war days/wk) | — | — | — | ~6 GB/day avg | **~190 GB/mo** |

Comfortably under the 250 GB egress quota. No Realtime messages billed at all. If we ever blow through egress, response sizes get squeezed further (column whitelisting, gzip).

### Why not poll the full snapshot each tick?

30 viewers × 1 Hz × ~90 KB full payload = ~2.6 MB/s = **~6.8 TB/month**. Twenty-seven times over budget. Full-snapshot polling is not viable; the watermark is what makes this work.

---

## Architecture

### New tables (parallel to v1; both coexist for safe rollback)

```sql
-- supabase/migrations/<timestamp>_war_room_v2_tables.sql

CREATE TABLE war_room_state_v2 (
  member_id    bigint PRIMARY KEY,
  faction_id   bigint NOT NULL,
  member_name  text   NOT NULL,
  level        int,
  position     text,
  bsp_total    bigint,
  bsp_str      bigint,
  bsp_spd      bigint,
  bsp_def      bigint,
  bsp_dex      bigint,
  bsp_fetched_at timestamptz,
  state        jsonb  NOT NULL DEFAULT '{}'::jsonb,
  deleted_at   timestamptz,                                   -- soft-delete tombstone
  updated_at   timestamptz NOT NULL DEFAULT now()             -- watermark
);

CREATE INDEX war_room_state_v2_updated_at_idx ON war_room_state_v2 (updated_at);
CREATE INDEX war_room_state_v2_faction_id_idx ON war_room_state_v2 (faction_id);

CREATE TABLE war_room_dibs_v2 (
  id           bigserial PRIMARY KEY,
  target_id    bigint NOT NULL,
  claimed_by   bigint NOT NULL,
  claimed_name text   NOT NULL,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  war_id       bigint,
  deleted_at   timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX war_room_dibs_v2_updated_at_idx ON war_room_dibs_v2 (updated_at);
CREATE UNIQUE INDEX war_room_dibs_v2_active_target_idx
  ON war_room_dibs_v2 (target_id) WHERE deleted_at IS NULL;

CREATE TABLE war_room_config_v2 (
  id                     int PRIMARY KEY DEFAULT 1,
  enabled                boolean NOT NULL DEFAULT false,
  faction_id             bigint,
  faction_name           text,
  revive_service_name    text,
  revive_service_url     text,
  revive_services        jsonb,
  started_by             bigint,
  started_at             timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (id = 1)
);
CREATE INDEX war_room_config_v2_updated_at_idx ON war_room_config_v2 (updated_at);
```

**Soft delete instead of hard delete.** When a member leaves a faction or dibs is released, we set `deleted_at = now()` and bump `updated_at`. The next delta poll sends the tombstone to all clients; they prune their local state. A scheduled job (or RPC) hard-deletes tombstones older than ~24 h to keep the table small.

**RLS posture.** Tables are in `public`. Enable RLS on all three. Read access for `anon` (with `select` policies scoped to current war). Write access denied for direct client — all writes go through Edge Function via service role. (Matches v1 model.)

### Polling RPC (single source of truth)

```sql
CREATE FUNCTION public.war_room_state_v2_delta(p_since timestamptz)
RETURNS TABLE (
  rows    jsonb,
  server_now timestamptz
)
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(jsonb_agg(to_jsonb(s.*)), '[]'::jsonb) AS rows,
    now()                                           AS server_now
  FROM war_room_state_v2 s
  WHERE s.updated_at > COALESCE(p_since, 'epoch'::timestamptz);
END;
$$;

-- Similar for dibs and config.
```

**Why RPC vs direct PostgREST select?**
- Returns `server_now` atomically with the rows → no client clock drift creates gaps.
- Single endpoint contract; easier to extend later (pagination, filtering).
- Cleaner to wrap in RLS / `SECURITY DEFINER` if we tighten read auth later.

### Edge Function: write path

Add v2 actions to `supabase/functions/war-room-fetch/index.ts`:

- `fetch_members_v2` / `fetch_our_members_v2` — same diff-filter logic as v1; writes go to `war_room_state_v2`. Sets `updated_at = now()` only on rows that actually changed (preserves the watermark's meaning).
- Soft-delete: when the live roster shrinks, we don't `DELETE`; we `UPDATE … SET deleted_at = now(), updated_at = now() WHERE member_id IN (…)`.
- `claim_dibs_v2` / `release_dibs_v2` / `get_dibs_v2`, `get_config_v2` / `set_config_v2`, `clear_state_v2` — same.

**Dual-write during transition (optional).** During side-by-side validation we can have `fetch_members` write to BOTH v1 and v2 tables. Simplest path: parameterize the table name in the existing handlers and call them twice. Costs a bit of Edge Function CPU but no extra Torn API calls.

### Client: `useWarRoomPoll` hook

Replaces the entire Realtime block in `WarRoomView.jsx`. Single source of truth:

```js
function useWarRoomPoll({ intervalMs = 1000, enabled = true }) {
  const [state, setState]   = useState(new Map())   // member_id → row
  const [dibs, setDibs]     = useState(new Map())   // target_id → dib
  const [config, setConfig] = useState(null)
  const watermarks = useRef({ state: null, dibs: null, config: null })

  useEffect(() => {
    if (!enabled) return
    let alive = true
    let timer = null

    async function tick() {
      const [s, d, c] = await Promise.all([
        supabase.rpc('war_room_state_v2_delta',  { p_since: watermarks.current.state }),
        supabase.rpc('war_room_dibs_v2_delta',   { p_since: watermarks.current.dibs }),
        supabase.rpc('war_room_config_v2_delta', { p_since: watermarks.current.config }),
      ])
      if (!alive) return
      applyStateDelta(setState, s.data?.rows ?? [])
      applyDibsDelta(setDibs, d.data?.rows ?? [])
      applyConfigDelta(setConfig, c.data?.rows ?? [])
      watermarks.current.state  = s.data?.server_now ?? watermarks.current.state
      watermarks.current.dibs   = d.data?.server_now ?? watermarks.current.dibs
      watermarks.current.config = c.data?.server_now ?? watermarks.current.config
    }

    tick()                                    // immediate first poll
    timer = setInterval(tick, intervalMs)
    return () => { alive = false; clearInterval(timer) }
  }, [intervalMs, enabled])

  return { state, dibs, config }
}
```

**Tombstone handling** in `applyStateDelta`:
```js
function applyStateDelta(setMap, rows) {
  setMap(prev => {
    const next = new Map(prev)
    for (const r of rows) {
      if (r.deleted_at) next.delete(r.member_id)
      else next.set(r.member_id, r)
    }
    return next
  })
}
```

**Adaptive polling.** Three knobs:
1. `document.visibilityState !== 'visible'` → drop to 5 s.
2. War paused (`config.enabled === false`) → drop to 10 s.
3. Tab-level focus + active war → full 1 Hz.

**Optimistic UI for dibs.** Claim/release flips the local Map immediately, server confirms within ~1 s. If the server rejects (race with another claimer), we revert. Same UX as v1's broadcast pattern.

### Routing

- v1 route stays at `/war-room` (the current path).
- v2 lives at `/war-room/v2` for the duration of side-by-side testing.
- After validation, swap the routes and delete v1 code + tables in a separate cleanup commit.

---

## Phases

### Phase 0 — Branch + schema (this PR)
- [x] `git checkout -b war-room-v2` (done)
- [ ] Migration: create `war_room_state_v2`, `war_room_dibs_v2`, `war_room_config_v2` with indexes
- [ ] RLS policies on all three (deny direct client writes)
- [ ] Run `supabase db advisors` (per Supabase skill) before committing migration

### Phase 1 — Edge Function v2 actions
- [ ] Add `fetch_members_v2`, `fetch_our_members_v2` writing to v2 tables with soft-delete + updated_at bump on change
- [ ] Add `claim_dibs_v2`, `release_dibs_v2`, `get_dibs_v2`
- [ ] Add `get_config_v2`, `set_config_v2`, `clear_state_v2`
- [ ] Dual-write toggle (write to both v1 and v2 during validation) — env-flag controlled

### Phase 2 — Delta RPCs
- [ ] `war_room_state_v2_delta(p_since)`, `war_room_dibs_v2_delta(p_since)`, `war_room_config_v2_delta(p_since)`
- [ ] Grant EXECUTE to `anon`, `authenticated`
- [ ] Smoke test in SQL editor with synthetic `p_since` values

### Phase 3 — Client hook + v2 view
- [ ] `src/utils/warRoomApiV2.js` — RPC wrappers
- [ ] `src/hooks/useWarRoomPoll.js` — the hook above
- [ ] `src/views/WarRoomViewV2.jsx` — copy v1 view, replace Realtime block with the hook, point dibs/config writes at v2 actions
- [ ] Route at `/war-room/v2`

### Phase 4 — Side-by-side validation (1 week minimum)
- [ ] Open both v1 and v2 in adjacent browser tabs, confirm they show identical state
- [ ] Trigger dibs in v1 → verify v2 reflects it within 1 s (and vice versa, via dual-write)
- [ ] Monitor Supabase Dashboard → Reports → Realtime vs Egress graphs for a 24 h window
- [ ] Confirm v2 generates 0 Realtime messages
- [ ] Confirm v2 egress is within projected budget

### Phase 5 — Cut over
- [ ] Route `/war-room` to v2 view
- [ ] Disable Realtime triggers on v1 tables
- [ ] (After 1 more week) drop v1 tables + Edge Function actions

### Phase 6 — Cleanup
- [ ] Remove v1 `warRoomApi.js`, broadcast trigger function, RLS policy on `realtime.messages`
- [ ] Remove the `jwt_secret` Edge Function secret if no other code uses it

---

## Trade-offs vs alternatives

| Approach | Cost (current scale) | Worst case | Verdict |
|---|---|---|---|
| **Realtime per-row (current v1)** | $1,000+/mo overage | Hits 500 msg/s wall | ❌ Not viable |
| **Aggregated Realtime (1 broadcast/tick)** | Still ~155M msg/mo at 30 viewers × 2 Hz → $375/mo overage | Better but still expensive; payload size grows with row count | ❌ |
| **Full-snapshot polling** | ~6.8 TB/month egress | Over budget by 27× | ❌ |
| **Delta polling on `updated_at` (v2)** | ~190 GB/mo egress, 0 Realtime msgs | Stays under 250 GB; cost ~ $0 overage | ✅ **Chosen** |
| **External pub/sub (Ably / Pusher)** | ~free for our volume | Ably free tier = 6M msg/mo, then per-msg pricing | ⚠ Adds vendor + complexity; reserve as fallback if polling has unexpected issues |
| **SSE from Edge Function** | Free in theory | Deno deploy WS/SSE long-lived support is fragile; risk of dropped connections | ⚠ Not worth the complexity here |

## Open questions
- **Polling interval default.** 1 Hz feels right; 500 ms is closer to v1's perceived latency but doubles bandwidth. Recommend launching at 1 Hz and dialing down to 750 ms if leaders complain.
- **Tombstone retention.** 24 h default. Add a pg_cron job (or Edge Function cron) to hard-delete `deleted_at < now() - interval '24 hours'`.
- **Pagination.** Not needed at 175 rows. Add later if v2 ever proxies multiple opponent factions simultaneously.
- **Future option:** A single Postgres `LISTEN/NOTIFY` channel triggered by row changes, consumed by an Edge Function that maintains a CDN-cached snapshot. Lets all clients hit a CDN URL instead of PostgREST. Defer until we know polling can't carry the load.

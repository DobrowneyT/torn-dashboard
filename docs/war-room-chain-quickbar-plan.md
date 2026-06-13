# War Room — Chain Timer + QuickBar Enrichment Plan

Status: draft for review

## Goals

Enrich the FactionStatusBar (the "quickbar panel" at the top of the War Room) with:

1. **Chain timer for our faction** — countdown until our chain drops, colour-coded by urgency. Refreshes every 5 min when a hit lands; drops if a tick goes by with no hit. Higher chain = more respect/hit, so keeping it alive matters during a war.
2. **Chain-save dibs** — one designated person claims "I'll take the next chain hit." Auto-releases when chain advances OR when chain drops into cooldown.
3. **Enemy chain readout** — value-only, plus cooldown indicator. No timer, no claim — just intel: "are they chained right now? how big?"
4. **Activity counts rework** — drop the Offline number. Add an `Okay (Online)` count showing how many faction members are attackable right now and what subset of that is Online.
5. **Find Target button** — emergency chain-save. Random Torn user ID in a configurable range; clicking opens the attack page.

The whole bar should still read as a single glance — no scrolling, no popovers in normal state.

---

## Data model

### New table: `war_room_chain_v2`

Singleton (`id = 1`), same pattern as `war_room_config_v2`.

```sql
CREATE TABLE public.war_room_chain_v2 (
  id                int PRIMARY KEY DEFAULT 1,

  -- Our chain (from /v2/faction/10739/chain)
  current           int,                -- hit count
  max               int,                -- next bonus threshold
  modifier          numeric,            -- current respect multiplier
  timeout           bigint,             -- unix seconds: when chain drops
  start_ts          bigint,             -- unix seconds: chain start
  cooldown          bigint,             -- unix seconds: cooldown ends (0 = no cooldown)
  end_ts            bigint,             -- unix seconds: chain ended

  -- Chain-save claim (separate from member-target dibs)
  save_claimed_by   bigint,
  save_claimed_name text,
  save_claimed_at   timestamptz,

  -- Enemy chain (value + cooldown only — no claim/timer mechanics)
  enemy             jsonb,              -- { current, cooldown, modifier, timeout }

  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

CREATE INDEX war_room_chain_v2_updated_at_idx ON public.war_room_chain_v2 (updated_at);

-- Singleton seed
INSERT INTO public.war_room_chain_v2 (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Trigger updated_at on every UPDATE (reuse the existing touch_updated_at_v2)
CREATE TRIGGER touch_updated_at_chain_v2
  BEFORE INSERT OR UPDATE ON public.war_room_chain_v2
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_v2();
```

**RLS**: same `strict_*_faction_select` pattern — authenticated, `current_faction_id() = '10739'`. Service-role writes bypass RLS so the cron poll updates it.

**Why one row, not per-faction**:
- The save-claim columns only make sense for our chain.
- Enemy chain is just a JSONB readout (no schema rigidity needed; if Torn adds fields we get them for free).
- Singleton avoids the "which row do I update" question entirely.

### New delta RPC: `war_room_chain_v2_delta`

Same shape as the existing three — returns `rows jsonb, server_now timestamptz`. Plugged into `useWarRoomPoll` so the existing watermark machinery handles it.

---

## Edge Function changes

### Extend `cron_poll_war_room`

Two new sub-calls inside the existing tick loop:

1. `GET /v2/faction/10739/chain` → upsert into `war_room_chain_v2` (id=1).
2. If `war_room_config_v2.faction_id` is set AND `war_room_config_v2.enabled`, `GET /v2/faction/{enemy_id}/chain` → store result in the `enemy` JSONB column.

**Auto-release chain-save claim**: when upserting, compare the *new* `current` against the row's previous `current`. If it advanced (claimer made the hit) OR the new `cooldown > 0` (chain dropped), null out `save_claimed_by`, `save_claimed_name`, `save_claimed_at` in the same UPDATE.

**Frequency**: chain endpoint changes at most every 5 min (on each hit). Polling it on every cron tick (~1s) is wasteful but cheap; we can revisit if it shows up in Torn rate-limit metrics. First version: poll every tick alongside members.

### New actions

- `claim_chain_save_v2(user_id, user_name)` — sets `save_claimed_*` columns. Rejects if a claim already exists by a *different* user (returns the existing claimer's name, like member dibs).
- `release_chain_save_v2(user_id)` — clears the columns. Non-admins can only release their own claim; admins (your `ADMIN_IDS`) can override.

Both bypass `verifyTornUser` (POLL_ACTIONS, same trust model as member dibs).

---

## Client changes

### Extend `useWarRoomPoll`

Add a fourth watermark/Map for chain. Returns a new `chain` object alongside `members`, `ourMembers`, `dibs`, `config`:

```js
const { chain, ... } = useWarRoomPoll(...)
// chain shape: { current, max, modifier, timeout, cooldown, save_claimed_by, save_claimed_name, save_claimed_at, enemy }
```

### New component: `ChainTimerCard`

Lives inside `FactionStatusBar` (center column). Layout sketch:

```
┌────────────────────────────────────────────────────────────────┐
│  ⚔ 4:23  1,247×  3.0R               Enemy: 45× ⏸ cooldown  │
│  [Save Chain] / "Claimed by Onyx — release"                   │
└────────────────────────────────────────────────────────────────┘
```

- Countdown ticks client-side every 1 s off `chain.timeout`. Same trick as `CountdownCell` for hospital timers.
- Colour states (matching the tampermonkey script):
  - ≥ 3 min: green
  - 1–3 min: yellow
  - < 1 min: red, pulsing
  - cooldown / 0: gray
- Save claim section flips between three states:
  - No claim: button `Save Chain` (clicking calls `claimChainSaveV2`).
  - My claim: button `Release` + label "You're saving".
  - Someone else's claim: label "Onyx is saving" + (admin) `Release` button.
- Enemy chain readout: small label `Enemy: {N}× {status}`. Status badge from `enemy.cooldown` — `🔵 chained` / `⏸ cooldown` / `—`.

### Activity counts rework: `ActivityCounts`

Today it shows `Online | Idle | Offline`. New shape:

```
6●  12◐   30 Okay (4 online)
```

- `Online` (green dot, pulse if > 0)
- `Idle` (amber dot)
- `Okay (N online)` — counts members with `status_state = 'Okay'` AND `status_description = 'Okay'` (the strict "Okay and in Torn" — Hospital/Travelling/Jail/Abroad all excluded). The parenthetical `(N online)` is the subset whose `last_action_status === 'Online'`.

Applied to both panes (enemy left, us right).

### QuickLinksBar additions

Two new items in the center cluster, alongside the existing faction/items/revives/inventory icons:

- **Find Target** button — random ID in a configurable range, opens `https://www.torn.com/page.php?sid=attack&user2ID={id}` in a new tab. Range is stored in localStorage with sensible defaults (we'll pick fresh numbers — the script's `3600000-3900000` is dated).
- Live-but-tiny **Chain ribbon** when chain is active (just the time + count) so it's visible even if `ChainTimerCard` is scrolled out of view on mobile. Optional, decide during impl.

---

## Phases (suggested order)

| Phase | Scope | Deploy unit |
|---|---|---|
| **7a — Schema + RPC** | `war_room_chain_v2` table, RLS, delta RPC, singleton seed. | One migration. |
| **7b — Edge Function chain fetch** | Add our-chain fetch to cron poll. Add `claim_chain_save_v2` / `release_chain_save_v2` actions. | Edge Function redeploy. |
| **7c — Hook + ChainTimerCard** | Wire `useWarRoomPoll` to chain delta. Build `ChainTimerCard`. Wire into `FactionStatusBar`. | Frontend deploy. |
| **7d — Enemy chain readout** | Add JSONB column + enemy chain fetch in cron + readout in `ChainTimerCard`. | Migration + Edge Function redeploy + frontend. |
| **7e — Activity counts rework** | Replace `ActivityCounts` rendering on both panes. | Frontend deploy. |
| **7f — Find Target button** | QuickLinksBar entry, localStorage range config, attack URL launcher. | Frontend deploy. |

Each is independently shippable. 7a → 7b → 7c is the dependency spine; 7d/7e/7f are additive.

---

## Polling cadence (locked in)

Each chain has three states the Edge Function distinguishes per cron tick:

| State | Trigger | Behavior |
|---|---|---|
| Active | `cooldown <= now` AND `timeout > now` | Poll on the cadence below. **Force a poll when `timeout - now ≤ 6 s`** so we catch the hit-vs-drop transition with one extra fetch. |
| Cooldown | `cooldown > now` | Skip polling entirely until cooldown ends. Tick at `cooldown + 1` triggers a confirming poll. |
| Idle (no chain) | `current = 0` AND no cooldown | Poll on normal cadence to detect new chain start. |

**Cadences:**
- Our chain — every **5 s**.
- Enemy chain — every **30 s** (aligns with the existing our-members poll cycle).

**Implementation**: two new columns on the table — `our_last_fetched_at` and `enemy_last_fetched_at`. Cron tick reads the row, computes "should I poll this side?" against the cadence + force conditions, and only hits Torn when the answer is yes.

## Open / deferred decisions

1. ~~Chain fetch frequency.~~ Resolved above.
2. **Enemy chain fetch on `enabled=false`.** Skip — the cron is already gated by `enabled`. No extra logic.
3. **Find Target ID range.** Default to `3,600,000 – 3,900,000` (tampermonkey script's original values). Stored in localStorage keys `warroom_find_target_min` / `warroom_find_target_max`. Adjustable via a tiny settings popover from the QuickLinksBar; user can also edit the keys directly in DevTools without touching code.
4. **Mobile layout for ChainTimerCard.** Likely needs a compact variant. Plan to lift `MobileWarRoomView` once desktop card lands.
5. **Stuck-claim safeguard.** Spec says auto-release on `current` advance OR cooldown. If neither happens (chain ends "naturally" with `end_ts` set but no cooldown), we should also clear. Will add to the upsert diff logic.

---

## Out of scope (not in this plan)

- Per-member chain hit attribution (would need scraping faction attacks per-tick; existing pipeline does it daily, not real-time).
- Chain bonus prediction / countdown to next multiplier tier.
- Chain history / charts.
- Enemy chain-save dibs (they don't share our claim mechanic).

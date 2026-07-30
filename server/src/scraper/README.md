# Scraper jobs — schedules, API calls, and what they feed

Reference for the in-container scraper system (`server/src/scraper/`). In the
self-hosted stack there is no GitHub Actions: **each tenant's api container
runs its own node-cron scheduler**, so Forge, TNL, Mayhem, and Ascension each
scrape independently with their own key pool and their own schedules.

## How scheduling works

- Job schedules live in each tenant DB's `scraper_jobs` table
  (`job_name`, `cron_schedule`, `enabled`). Rows are created on first startup
  from the defaults in `registerJobs.ts`, **with `enabled = false`** — nothing
  scrapes until you enable it per tenant.
- Edit schedules and enabled flags from **Global Admin** on the dashboard
  (or SQL against `scraper_jobs`).
- **Edits arm on the api container's next restart** — cron tasks are built
  from the table at startup. After changing anything:
  `DC restart api-<slug>` (see `deploy/LAUNCH.md` for the `DC` alias).
- All schedules run in the container's clock, which is **UTC — identical to
  TCT** (Torn City Time is UTC). No conversion needed, ever.
- Every run (scheduled or manual) is logged to `scraper_runs` with row counts
  and per-job details — visible in Global Admin's run history.

## Reading the cron expressions

node-cron uses a **6-field** expression — like classic Unix cron but with a
seconds field prepended:

```
┌──────── second        (0–59)
│ ┌────── minute        (0–59)
│ │ ┌──── hour          (0–23)
│ │ │ ┌── day of month  (1–31)
│ │ │ │ ┌ month         (1–12)
│ │ │ │ │ ┌ day of week (0–7, both 0 and 7 = Sunday)
│ │ │ │ │ │
0 20,50 * * * *
```

Field syntax:

| Syntax | Meaning | Example |
|---|---|---|
| `*` | every value | `*` in the hour field = every hour |
| `N` | exactly N | `4` in the hour field = 04:xx only |
| `A,B` | list | `20,50` = at minute 20 AND minute 50 |
| `*/N` | every N | `*/30` in the minute field = :00 and :30 |
| `A-B` | range | `9-17` in the hour field = 09:00–17:00 |

So `0 20,50 * * * *` reads right-to-left as "any weekday, any month, any day,
any hour, at minutes 20 and 50, at second 0" — i.e. **twice an hour at :20
and :50**. To make attacks-sync run every 10 minutes instead, you'd use
`0 */10 * * * *`.

## The jobs

Defaults from `registerJobs.ts`. "API calls" is per run, per tenant. Every
job claims **one pooled key** per run (the least-recently-used non-disabled
key in `member_secrets`); the Torn client self-limits to 60 requests/min.
A run with an empty pool fails and is recorded in `scraper_runs`
(war-lifecycle no-ops instead of failing).

### crimes-sync — `0 */30 * * * *` (every 30 min)

Fetches organized crimes incrementally: resumes from the oldest crime that
hasn't executed yet (so in-flight crimes keep updating), pages
`/v2/faction/crimes` in blocks of 100.

- **Writes:** `crimes`, `crime_slots`, `crime_required_items`,
  `crime_reward_items`
- **Feeds:** OC page, Crimes view, OC Planner, Payout Management
  (weekly OC payouts), dashboard OC widgets
- **API calls:** 1–few (pages of 100 since last incomplete crime)

### attacks-sync — `0 20,50 * * * *` (twice hourly at :20 and :50)

Incremental forward sync of `/v2/faction/attacks` from the newest stored
attack's `started` timestamp, ASC pages of 100. Captures respect, chain,
fair-fight/war/chain/warlord modifiers, and flags incoming attacks.

- **Writes:** `faction_attacks`
- **Feeds:** War Room / RW pages' attack stats, RW Payouts, war overview
- **API calls:** 1 per 100 new attacks (quiet hour = 1 call; heavy war
  hour = several)

### members-sync — `0 5 * * * *` (hourly at :05)

Fetches the roster (`/v2/faction/members`), marks missing members as left
(rows are history — never deleted), upserts current ones, and **reconciles
the key pool**: leavers' keys are disabled, rejoiners' keys re-enabled.
Refuses to act on an empty roster response.

- **Writes:** `members`, `member_secrets` (disabled flag only)
- **Feeds:** Members page, every roster dropdown, key-pool health
- **API calls:** 1

### war-lifecycle — `0 */3 * * * *` (every 3 min)

The war-room automation. Watches `/v2/faction/{id}/rankedwars`; when a new
matched war appears it wipes last week's roll call/notes, points the war-room
config at the new opponent, and baselines both factions' member states;
auto-enables the room at T-1h before war start; auto-disables when the war
ends. Never touches a manually-configured session.

- **Writes:** `war_room_config_v2`, `war_room_notes_v2`, roll call, member
  state tables
- **Feeds:** War Room (auto setup/enable/disable)
- **API calls:** 1 (plus 2 member-state baseline calls during auto-setup)

### wars-sync — `0 10 */3 * * *` (every 3 h at :10)

Full ranked-wars list sync: updates live scores in place, and fetches the
official `/v2/faction/{warId}/rankedwarreport` once per newly-completed war
(rewards, rank change, forfeit, per-member contributions for both sides).
Reports Torn permanently refuses are flagged and never retried.

- **Writes:** `ranked_wars`, `war_member_contributions`
- **Feeds:** RW page, War History, RW Payouts, war overview
- **API calls:** 1–2 pages + 1 per unreported completed war

### cpr-scan — `0 30 5,17 * * *` (05:30 and 17:30 TCT)

Two stages: (1) faction available-crimes scan with a pooled key — filled
slots reveal the slotted member's CPR; (2) **per-member**
`/v2/user/organizedcrimes` using *each member's own key* — Torn reports the
key owner's CPR on every empty slot, so this is the complete picture. A key
that errors is dropped from rotation with the reason recorded (the member
re-submits by logging in again). Afterwards it recomputes every current
member's **tier** from the CPR baseline (per `faction_settings.tier_requirements`;
manual `tier_override` is never touched).

- **Writes:** `member_cpr_v2`, `oc_crime_types`, `oc_crime_positions`,
  `members.tier`
- **Feeds:** CPR modals, Tier Requirements view, OC Planner, tiered payouts
- **API calls:** 1 + one per pooled key

### member-stats — `0 5 1 * * *` (daily 01:05 TCT)

Daily per-member snapshot: personalstats + profile for every current member,
gym contribution totals from 5 faction-level calls, and up to 30 days of
per-member backfill for any missing snapshot dates (relevant on first run or
after downtime).

- **Writes:** `member_daily_stats`
- **Feeds:** dashboard stats, Member Overview (stats/compliance/gym trends)
- **API calls:** the heavy one — ~2 per member + 5
  (100 members ≈ 205 calls ≈ 3.5 min at the 60/min budget), more while
  backfilling

### items-sync — `0 15 4 * * *` (daily 04:15 TCT)

Full Torn item catalog (`/v2/torn/items`) with market/sell/buy prices, so
payout enrichment values crime reward/requirement items correctly.

- **Writes:** `items`
- **Feeds:** payout item valuations, OC economics
- **API calls:** 1

### inventory-sync — `0 0 * * * *` (hourly, top of the hour)

Faction armory snapshot: one v1 `/faction/{id}` call across every tracked
category (temporary, medical, utilities, drugs, armor, weapons, caches,
cesium) with a pooled key. The cron counterpart of the manual Leadership
"Sync" button — both upsert `inventory_items` and write the same
`sync_metadata` row (`data_type='inventory'`; cron runs attribute it to
`scraper`).

- **Writes:** `inventory_items`, `sync_metadata`
- **Feeds:** Leadership inventory/loaned-item tracking, payout item valuations
- **API calls:** 1

### revives-sync — no schedule (on demand)

Not on cron. Triggered from the war-room/RW fetch flow for a specific ranked
war: pages incoming `/v2/faction/revives` across that war's window.

- **Writes:** `faction_revives`
- **Feeds:** RW Payouts (revive counts)

## Raising cadences safely

Cheap to raise: **attacks-sync, crimes-sync, war-lifecycle, members-sync**
(1–few calls each). Fine at every-10-min or faster during wars.

Think twice: **member-stats** (hundreds of calls — keep daily),
**cpr-scan** (touches every member's own key — twice daily is plenty; CPR
only changes when members do OCs).

Budget math: the Torn client caps each tenant at 60 req/min pool-wide, and
Torn allows 100 req/min *per key* — so 2–3 pooled Limited keys per tenant
gives comfortable headroom even with everything cranked up during a war.

## Time sanity check

TCT = UTC. On the host: `timedatectl` — you want `System clock
synchronized: yes` and the UTC line matching TCT. Inside a container:
`DC exec api-forge date -u`. The host's *timezone* setting is irrelevant to
the containers (they run UTC regardless); only clock accuracy matters, and
systemd-timesyncd handles that.

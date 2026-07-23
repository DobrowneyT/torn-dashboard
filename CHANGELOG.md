# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**How to bump:** The repo-root **`VERSION`** file is the single source of truth for
the app version. To cut a release: set `VERSION` to the new `X.Y.Z`, sync the root
`package.json` `version` to match, and add a new `## [X.Y.Z] - YYYY-MM-DD` block at
the top (below `[Unreleased]`) whose version equals `VERSION`. Level follows the
change: `feat` → minor, `fix` → patch, breaking → major (a human may override). The
footer (`VITE_APP_VERSION`, read from `VERSION` at build) and `/api/health` (read
from `VERSION` at runtime) both surface it automatically.

---

## [Unreleased]

### Added

- **War Room Defaults** now shows a starting schema shape (poll cadences, dibs
  auto-drop window, revive service) in Leadership → Settings when it hasn't been
  saved yet, instead of an empty object.

- **War Room: dibs auto-drop on a live target.** A claim on an already-alive target
  auto-releases after a configurable window (default 30s) if the holder still hasn't
  killed them, so a stalled claim can't block the queue. A target killed inside the
  window keeps the dib; a claim on someone still in hospital waits for the exit window
  instead. Window is a leadership-editable War Room setting (#159).
- **War Room personal alerts.** Opt-in per-user (saved to the browser): a **dib
  hospital-exit reminder** that fires shortly before a target you've dibbed leaves
  hospital (#156), and a **chain-watch alert** that fires when the chain is about to
  drop and rings attackable targets' buttons red so you know where to click (#157).
  Each has a configurable lead/threshold and sound + screen-flash toggles, with
  distinct tones so the two are told apart by ear.
- **Delivery agent + workflow docs.** A combined `delivery` agent (`.claude/agents/`)
  that authors issues (`/to-prd` → `/to-issues`) and implements ready-for-agent issues
  end-to-end, plus the canonical per-change checklist in
  `docs/agents/delivery-workflow.md` (branch off `dev`, TDD, changelog, `VERSION`
  bump, PR with auto-merge-on-green + a `hold-merge` opt-out) (#164).


## [3.0.0] - 2026-07-23

The **self-hosted, multi-faction** release. The dashboard moves off Supabase onto a
self-hosted stack — React SPA + Fastify/TypeScript API + Postgres — deployed as one
container module per faction. `main` stays on the Supabase build (GitHub Pages) until
cutover; this line is the containerized `dev` stack.

### Added

- **Self-hosted per-faction stack** (slices #59–#75): docker compose project
  `tnl-dashboard` (shared Postgres + nginx), a faction DB template, and a
  `new-faction` script that scaffolds a tenant's DB, scoped credentials, and vhost.
- **Torn-key login → API JWT** auth path with `/api/bootstrap`; remember-me sessions
  with a 24h membership re-check (#119).
- **Multi-faction tenancy** (#94, #95): scoped per-tenant DB credentials, host-based
  routing, dynamic per-tenant branding from bootstrap (#131), a global-admin surface,
  and boot hardening so every faction is an independently bootable module.
- **Scrapers rewritten in TypeScript** (#67–#70): key-rotation pool, Torn client with
  a consistent API comment on every call (#113), run log, in-process scheduler, and
  the items / crimes / CPR / members / member-stats / wars / attacks / revives jobs
  plus on-demand sync triggers.
- **Self-hosted War Room** (#71–#73): HTTP-polled read path, war-gated ticker, write
  path (dibs, chain save, roll call, notes), and in-process weekly war-lifecycle
  automation. Auto-expiring stale dibs (#106/#107) and two-tier farm-mode sort (#108).
- **Auto spy-fetch** on the weekly matchup setup (#139).
- **Structured public war notes** — reorderable bullet list, no truncation,
  last-updated stamp (#141) — and **collaborative live editing** with optimistic
  locking and near-real-time refresh (#160).
- **Past Wars notes archive**: prior wars' notes are retained instead of wiped, with a
  leads-only browser (#145).
- **OC payout modes** — tiered / flat-weighted / equal (#134) — and **Crime Statistics**
  for a saved week from OC → Payouts history (#142).
- **Faction payout-mode default** in Leadership → Settings; non-tiered factions hide the
  tier machinery (Tier Management / Requirements + tier columns) entirely (#136).
- **Ops**: nightly per-faction backups, healthchecks, off-site backups to B2, and
  UptimeRobot monitoring (#76, #117); a deploy script with an auto-deploy poller and a
  live-DB dev loop (#121).
- **Load/stress harness** (#116): mock Torn API, WebSocket swarm, and documented modes.
- **`VERSION` file** as the single version source of truth, surfaced in the footer and
  on `/api/health` (#154).

### Changed

- The Discord bot and mug-bot were **extracted to their own repos** (`torn-discord-bot`,
  `torn-mug-bot`); this repo is now just the dashboard (#137).
- crimes-sync cursor now skips terminal `Expired` crimes so it no longer rescans the
  whole backlog each run (#144).
- War notes panel is available to leadership/admin, and the roll-call ribbon clears on
  submit (#138).

### Fixed

- Spy-age no longer shows a dash despite a real `ts_spy_at` (timestamptz parsing) (#140).
- Deploy readiness now polls after a rebuild instead of a single shot (#146).
- Scraper key handling: stop dogpiling a rate-limited key — rotate, fail fast,
  serialize (#123); one-time forced re-login to refill the rotation pool (#124).
- Restored faction DBs are bootable again — scoped grants are re-applied (#115).


## [2.1.0] - 2026-06-24

### Added

- **War roll call.** Native pre-war availability form (replaces the Google Form),
  stored in `war_room_roll_call_v2`. A blocking overlay gates the War Room until a
  member responds, auto-releasing within 1 hour of war start. A post-login banner
  nudges anyone who hasn't responded; a "Roll Call" button lets members review/edit
  their answer (edits are flagged to leadership).
- **War summary card** — opponent, start time (TCT) + countdown, war type/agreed
  score, and leadership notes, shown to everyone.
- **War Notes panel** (War Leaders only) beside the settings gear: war type
  (real/termed/race), termed wars carry **two agreed scores (ours / theirs)**,
  race target, and **separate public + leads-only notes** (private notes live in
  a service-role-only table members can't read). Concurrent edits are guarded by
  optimistic locking. Includes the embedded roll-call results table + "not yet
  responded" list.
- **Live enemy chain countdown** in the chain card (mirrors our chain timer,
  from the enemy data we already poll every ~30s), and the Paused banner now sits
  directly above the chain/status card with the timers it refers to.
- **Tuesday automation** (`cron_war_lifecycle`): auto-sets-up the matched war
  (save faction → clear → fetch members → spies, wiping the prior week's roll
  call/notes), auto-enables at T-1h, and auto-disables on war end — only for
  automation-owned sessions, so manual/testing runs are never touched.

## [2.0.0] - 2026-06-22

### Added

- **Single consolidated API key with mandatory opt-in.** Members now log in with
  one **Limited Access** key, accepting a Torn-ToS disclosure that explains
  exactly how the key is stored and used. A one-click "Generate Limited Key"
  link (titled `Forge-Dashboard`) creates a correctly-scoped key.
- **Consented key rotation pool.** That single key (user keys only — no admin
  fallback) powers CPR scraping, the War Room, and the faction-wide scrapers.
  New `get_active_key_pool` / `claim_next_api_key` SECURITY DEFINER RPCs hand out
  keys; the War Room loads the pool from the DB and rotates per second; each
  parallel scraper runner claims a distinct key.
- **Recruit handling.** Recruits (no faction API access for 72h) still log in and
  use the site; their key is flagged (`has_faction_access = false`) and skipped
  for faction-scoped calls. Current-crimes shows a friendly Recruit note.
- **Parallel attacks backfill workflow** — a matrix where each shard backfills a
  time window with its own pooled key and upserts idempotently to Supabase.
- Reusable `scraper-setup` composite GitHub Action (Python + pip cache + deps).
- One-time `scripts/backfill_key_metadata.py` to populate key level / faction
  access / rank for pre-2.0 stored keys.

### Changed

- `member_secrets` generalised to hold each member's one consolidated key plus
  `key_level`, `has_faction_access`, `member_rank`, `consent_at`,
  `consent_version`, `key_fingerprint`, and `disabled` metadata.
- Login now requires Limited Access (was Minimal); the hamburger "API Key Usage"
  window and the login disclosure share one `ApiKeyDisclosure` component.
- Daily/manual scrapers claim keys from the pool instead of `TORN_API_KEY`;
  edge functions accept `APP_KEY_SECRET` (legacy `CPR_KEY_SECRET` still works).

### Removed

- The separate Dashboard "CPR Scraper Key" entry (the consolidated key is
  captured at login). The Dashboard pill is now an API-key status/info view.
- The `TORN_API_KEY`, `TORN_API_KEYS`, and `MEMBER_API_KEYS` secrets are no
  longer used by the scrapers or the War Room.


## [1.1.0] - 2026-06-01

### Added

- War Room v2 using HTTP Polling.
- Green attack button state added for online and okay.
- Mobile app launcher persists on all pages.

## [1.0.1] - 2026-06-01

### Fixed

- **Page navigation no longer loops infinitely.** Switching between sub-tabs (e.g.
  OC → OC History, RW → War Room) previously caused the URL to grow endlessly
  (`/oc/payouts/payouts/payouts/…`) and the page to freeze. The routing has been
  corrected to use absolute paths so every tab click lands exactly where it should.

- **Page width is now stable.** On certain pages (particularly War Overview and the
  War Room) the navigation bar would shrink or grow to match the content width,
  making the layout feel jumpy when switching tabs. The outer shell is now clamped
  so the nav bar and page container maintain a consistent width regardless of what
  is displayed.

### Changed

- **Sub-page URLs now use the full tab name**, hyphen-delimited — easier to share
  or bookmark a specific page:
  - `/oc/history` → `#/oc/oc-history`
  - `/oc/tiers` → `#/oc/tier-requirements`
  - `/rw/history` → `#/rw/rw-history`
  - `/leadership/members` → `#/leadership/member-overview`

### Added

- **Site footer** with version number at the bottom of every page. Version is
  stamped automatically from this changelog on each deploy so it always reflects
  what is live. "MonChoon" links to the Torn profile.

## [1.0.0] - 2026-06-01

### Added
- Full client-side routing via React Router v6 HashRouter — every page now has a
  stable URL that survives a browser refresh (`#/`, `#/members`, `#/oc/*`, `#/rw/*`,
  `#/leadership/*`)
- War Overview: three-panel Plotly chart (Outgoing / Incoming / Revives) with
  per-subplot legend groups labelled "Outgoing", "Incoming", "Revives"
- War Overview: Histogram / Scatter display toggle; manual bin-size control
  (Auto · 1m · 5m · 1h · 6h · 1d); TCT (UTC) time axis
- War Overview: faction names resolved from the `factions` DB table instead of
  showing raw IDs
- Mobile War Room overlay (md:hidden launcher, full-viewport phone-frame)
- Revive data pipeline: `fetch_revives_for_war.py` scrapes Torn v2
  `/faction/revives` and upserts into `faction_revives` Supabase table
- `faction_revives` migration with RLS, indexes on `(rw_id, timestamp)`,
  `(target_id, timestamp)`, `(reviver_faction_id, timestamp)`
- Tier 0 "Needs Manual Review" sentinel replacing legacy −1 across all
  scrapers, payout calculations, and UI badge/filter components
- Info modals on RW Payouts and OC Payouts pages explaining payout formulas
- Payout explanation updated: new members start at Tier 0 until a leader
  assigns a tier
- TornStats spy integration and max-age configuration in War Room
- Stats breakdown fields on mobile War Room member cards
- Leadership controls collapse toggle in War Room
- Activity filter and farm-sort toggle in War Room two-tier filters
- Revive scraper `--debug` flag with pre-flight Supabase connectivity check,
  payload inspection, and post-run DB row count verification

### Fixed
- `reviver_skill` column widened from `integer` to `numeric(6,2)` to accept
  Torn API decimal values (e.g. 36.21)
- `target_last_action` correctly extracts the Unix timestamp integer from the
  Torn v2 `{status, timestamp}` object (was inserting the whole dict into a
  `bigint` column, silently failing)
- War Overview legend no longer shows duplicate faction entries across subplots
- War Overview x-axis displays TCT instead of local browser timezone
- `sys.path` ordering in Python scraper scripts no longer shadows the installed
  `supabase` package with the local `supabase/` directory
- `maybeSingle()` renamed to `maybe_single()` for supabase-py v2 compatibility
- `|| 6` tier fallbacks replaced with `?? 6` throughout payout calculations and
  display code so Tier 0 members are not coerced to Tier 6

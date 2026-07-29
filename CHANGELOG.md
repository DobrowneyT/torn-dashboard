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

- **Members page shows CPR instead of tiers for non-tiered factions (#251).**
  A faction on a `flat-weighted` or `equal` payout mode no longer sees meaningless
  tier UI on the Members page: the tier **filter dropdown** and **Tier Distribution**
  panel are hidden, and the "Tier" column becomes a **"CPR"** column with a plain
  CPR badge per member (sorted by average CPR, still click-through to the
  per-crime CPR breakdown). Tiered factions are unchanged. Gated on the existing
  `useFactionConfig().usesTiers` signal.
- **War Room roll call shows a yes/no tally.** The roll-call results table now
  shows a **"On at start: X Yes · Y No (Z responded)"** tally above it, so
  leadership can see at a glance how many members will be online at kickoff.
- **Global Admin: Key Pool Health shows missing keys, totals, and sortable columns.**
  The Key Pool Health table now also lists **current members with no key** as red
  **"Missing"** rows (blank level/consent/last-claimed), so leadership can see who
  still needs to enrol, and shows a **key count** (and how many are missing) in the
  card header. Every column is **sortable** (missing members surface first by
  default). Both the Recent Runs and Key Pool Health tables now **cap their height
  (~10 rows) and scroll** with a sticky header instead of growing unbounded.
- **Pinned competitions show your own position (#242).** The dashboard
  pinned-competition cards now tell a member **where they stand**, not just the
  top of the board. A **leaderboard** card shows the top 5 plus your own **rank +
  value** — highlighted in place when you're inside the top 5, or appended as a
  "you: #14 · 1,240" row when you're outside it. A **lottery** card keeps the
  qualified count and adds your own **score + a qualified / not-yet indicator**
  against the threshold. Members with no data yet see a graceful note. Backed by
  an additive `me` field on `GET /api/competitions/pinned` (no schema change).
- **Competition prizes — catalogue item slots (#241).** A prize slot can now be
  a **Torn item** with a quantity (e.g. `2x Xanax`) alongside cash and text, in
  both placement and flat modes. The create form's slot picker gains an **Item**
  kind with an async name search over the catalogue (new auth-gated
  `GET /api/items/search?q=`); the chosen item's canonical name is frozen onto
  the prize so tables and history render it consistently for all members. Unknown
  item ids are rejected at create time.
- **Competition prizes — flat distribution (#240).** Leaders can now choose a
  **flat** distribution instead of ranked placements: one prize slot awarded to
  **every** ranked / qualified member. The competition shows it to all members as
  an **"Everyone"** prize, and on resolution every recorded result row gets that
  prize. The create form offers a Placement / Flat choice; Flat collapses the
  editor to a single slot. Placement competitions are unaffected.
- **Competition prizes — placement cash/text (#239).** Leaders can attach a
  **placement** prize table (1st / 2nd / 3rd …) to a competition using **cash**
  (formatted) or **free-text** prize slots. Every member sees the prize table on
  the competition, and on resolution each member's **earned prize is recorded**
  in the frozen results and shown in history — leaderboard by rank, lottery to
  the drawn winner only. Informational (no automatic disbursement).
- **Competition start/end time-of-day picker + visible end time (#231).** The
  create form now takes an optional **time** beside each date (Torn City Time);
  leave it blank for start-of-day / end-of-day. Every member sees the window —
  including the **exact end time** — on the competition, so a hard cutoff is
  clear to everyone. Date-only windows still display cleanly as just dates.
- **Exact competition boundaries via precise timers (#230).** Each fixed
  competition now arms a one-off timer at its **start** (captures a baseline
  sample) and its **end** (captures a final sample, then auto-freezes an
  auto-resolving contest) — stamped at the exact boundary instant, so a contest
  with a hard time cutoff freezes on the values as they were at that moment, no
  leader action required. Timers are re-armed from the DB on restart; the
  auto-resolve tick remains the backstop if a timer was missed. A just-started
  contest grabs its baseline immediately; a long-past start is left to the
  latest existing reading.
- **Faster, gap-free `member-stats` via multi-key fan-out (#228).** The run now
  spreads its per-member calls across up to ~3 pooled keys (operator-tunable via
  `MEMBER_STATS_MAX_KEYS`), finishing in a fraction of the single-key time. The
  Torn client's rate budget is now enforced **per key**, so N keys run at N×
  throughput (each within Torn's per-key limit). A member whose call fails on one
  key is **retried on another** — no one is dropped after a single failed attempt
  — and a key returning a bad-key error is **disabled and removed** from the run,
  which finishes on the survivors.
- **Intraday competition-stat sampling (#227).** New append-only
  `member_stat_samples` table holding a slim, timestamped sample (the
  competition-relevant personalstats categories + gym) per member. `member-stats`
  now runs **every 4h** and appends a sample each run (still refreshing the daily
  full-blob row), so competition leaderboards can be fresh through the day. A
  daily retention job prunes samples past 90 days, keeping any still needed to
  resolve an unresolved competition. Foundation for exact, timestamped
  competition boundaries (#229/#230).
- **Separate daily `member-profile` scraper (#226).** Donator status, property
  name and last-action move out of `member-stats` into their own once-daily job,
  so the upcoming intraday `member-stats` runs (#225) don't re-fetch slow-changing
  profile data every few hours. Both jobs upsert the same day's row and compose
  via COALESCE. Prep for the intraday-sampling epic.

- **Default revive services in the War Room.** A never-configured faction now
  starts with **UHC, WTF and Nuke** preset (name/URL/source/payload shape) instead
  of an empty list, so leaders can pick one from the dropdown without re-entering
  them. Editing or clearing the list saves an explicit list that overrides the
  defaults.
- **Per-tenant PWA manifest.** Each faction API now serves its own
  `/api/manifest.webmanifest` from its identity, so an **installed** dashboard
  shows the tenant's name (and its logo as the app icon when one is set) instead
  of the shared "TNL Forge" default — important for non-TNL tenants. iOS uses the
  per-tenant page title for the home-screen name. Falls back to the default tile
  when a faction hasn't uploaded a logo.
- **Leader-confirmed rally headline on a surge (#209).** When a PUSH surge is
  detected, war leads / leadership / admin get a **one-tap "Post rally call"** on
  the surge banner that posts the matching preset — **defensive** ("we're being
  pushed — retaliate") to the faction headline for everyone (#158). Non-leaders
  never see the prompt, and nothing hits the banner until a leader confirms. The
  offensive ("we have the numbers — organize a push") preset also lives in the
  manual headline composer.
- **War Room PUSH-surge alerts (#208).** The server ticker detects an **enemy**
  surge — a wave of enemies leaving hospital ("we're being pushed") — on a rate
  rule (≥ N enemies Okay within M seconds) with a cooldown so flicker can't
  re-spam. On a surge, every open War Room tab auto-fires a sound/flash + banner,
  and subscribers get a background web-push (via #207). A **global on/off toggle**
  plus the threshold/window/cooldown live in War Room settings (war leads /
  leadership / admin) — **off by default**, so a termed war stays silent until
  leadership opts in.
- **War Room push notifications — delivery pipe (#207).** Members can now opt in
  to background push from a live war room; the browser subscription is stored
  server-side and stale endpoints self-prune on delivery (HTTP 404/410). The PWA
  service worker (#206) now shows pushes and, on click, focuses/opens the War
  Room. Delivery is VAPID-signed via a one-time operator keypair (documented in
  `docs/PUSH.md`); push stays fully off until it's set. This is the pipe the
  surge alerts (#208) and leader headlines (#209) will send through — a
  leadership **test send** (`POST /api/push/test`) verifies it end-to-end.
- **Install the dashboard as an app (PWA).** The dashboard now ships a web app
  manifest, app icons (incl. a maskable icon), and a service worker that caches the
  app shell for a fast, offline-tolerant launch. Supported browsers (Chrome/Edge/
  Android) get an **"Install app"** item in the Settings menu; iOS shows Add-to-Home-
  Screen instructions. Navigations stay network-first so deploys still land
  immediately. Foundation for War Room push notifications (#198), which extend this
  same service worker (#206).


- **Per-member War Room notes + an overdose flag.** Each roster row has a pencil —
  war leads / leadership / admin can jot a note (armour, job, timezone, OD-prone…),
  and everyone can read it; notes persist across wars. Members currently in hospital
  from an overdose also show an automatic **OD** flag (read live from Torn’s status
  reason). Works on desktop and the Mobile App overlay (#199).


- **War Room help panel now covers the quick bar, alerts window, filters and farm
  mode.** New sections explain each quick-bar button (war page, medical, items,
  revives, find-target), what’s inside the personal-alerts bell (dib hospital-exit
  and chain-watch, with lead/threshold, sound, flash), how the status/activity/
  battle-stat filters work, and farm mode’s priority order (#153).

- **The War Room first-run tour now also walks the quick bar, filters and farm
  mode, and opens the alerts window** on its alerts step so members see what’s
  inside it. (Replay it from the "?" panel if you’ve already seen the old tour —
  it only auto-runs once per browser.) (#153)


- **War Room first-run tour.** On a member's first War Room visit, a dismissable
  spotlight tour highlights the key controls in place — targets/dibs, chain, roll
  call, alerts, the Mobile App launcher, and the "?" help button — with a one-click
  **Skip** on every step and a **Replay** from the help panel. Opening the Mobile
  App runs a short pass over the phone layout. Any step whose target isn't on screen
  is skipped, and "seen" is remembered per browser (#153, completes the in-app
  tutorial).
- **War Room help panel.** A "?" button in the War Room opens a reference panel
  explaining the member-facing features — dibs (incl. auto-drop), the attack-button
  colours, the chain, roll call, personal alerts, and where the same controls live
  in the Mobile App — plus a clearly-labelled "For leaders" section shown only to
  leaders. First slice of the in-app tutorial; the first-run spotlight tour follows
  (#153).
- **Competitions can be pinned to the dashboard.** Leadership can pin any
  competition (multiple at once); each pinned one shows a compact card on the
  dashboard — a leaderboard's top few, or a lottery's qualified count — linking
  through to the full view (#188).
- **Competitions: lottery type.** As well as ranked leaderboards, a competition can
  be a lottery — members who meet a threshold on the metric (at least / at most a
  value, e.g. "avg ≥ 2 xanax/day") form a qualified pool, and resolving draws a
  winner from that pool uniformly at random. The pool (and who qualifies) is shown
  live, and auto-resolve draws it on schedule like any other competition (#187).
- **Competitions can auto-resolve on a schedule.** A competition can be marked
  auto-resolve: a fixed one closes itself once its end day has passed (waiting for
  the final day's stat snapshot to land first), and a rolling one draws on a chosen
  interval, each draw kept in history. Runs as a new `competitions-resolve` scraper
  job (enable it alongside the other scrapers) (#186).
- **Competitions can be resolved into a recorded result.** Leadership can "Close &
  record" a competition, freezing its current standings into history and crowning
  the top-ranked member; each resolution is kept (a rolling competition accretes
  one per close), and past results with their frozen standings are browsable under
  the competition. The stored rows are self-contained so a future payout can read a
  result without recomputing it (#185).
- **Competitions: rolling windows + per-day averages.** A competition can now use
  a rolling "last N days" window (recomputed live) instead of only fixed dates,
  and can score by per-day average of the metric as well as the raw total —
  backing rate-based contests like "avg xanax/day" (#184).
- **The Members page is now tabbed** (Overview + Competitions), matching the OC and
  War pages; Overview is the default. The Competitions tab only appears on the
  self-hosted stack (#184).
- **The dashboard title in the header links back to the Dashboard**, like a site
  masthead.
- **Competitions (first slice).** Leadership can create a named, fixed-window
  leaderboard competition over a faction stat (metric picked from a curated,
  code-defined registry backed by the daily personalstats snapshots); members see
  a live leaderboard in a new Competitions section on the Members page. Standings
  are per-member deltas over the window (day-granular, forward-only — no data
  before the snapshot started); members whose first in-window snapshot lands after
  the window opened are flagged *partial*. Ranks highest-wins by default with a
  lowest-wins option (#183).
- **The faction logo now renders in the header**, left of the title, sized to match
  it; the title shifts right to sit beside it. Unset → the header shows the text title
  alone (no placeholder, no broken image). Logo/hero uploads also accept animated GIFs
  and now allow up to 3 MB (favicon stays 1 MB) so animated marks fit (#178).
- **OC payouts now credit time banked in crimes a member left before execution** —
  the left-early time from #168's participation log is added to their weekly
  time-spent (so their share reflects it), and Payout Management's time cell has a
  hover breakdown listing those stints, flagged red (#168, part 2). Only from when the
  log started — genuinely-old weeks have no data.


- **Branding image uploads.** Leadership can upload a logo, favicon, and hero image in
  Settings (with preview + a URL fallback) instead of pasting a URL; images are stored
  per-faction in the DB and served over the tenant's own origin. The favicon applies to
  the browser tab; where the logo/hero render is a follow-up (#173).

- **War Room leader headline banner.** Warleads/leadership/admin can pin one urgent
  message to the top of the War Room ("TURTLE — STAY IN HOSPITAL", "STOP ALL HITS",
  "PUSH 2 20:30", or free text) from quick-pick presets or a custom field, with a
  tone that colours the banner. Shown to everyone and broadcast live; cleared on a new
  matchup (#158).

- **OC participation log** — the crimes-sync now retains a per-(crime, member) stint
  (`joined_at`/`left_at`, `completed`), so time a member banked in a crime they left
  before it executed is no longer lost. Foundation for crediting that time in payouts
  and a per-crime breakdown (#168, part 1).


- **Changelog CI gate** (warn-only for now): a PR touching `frontend/`, `server/`, or
  `db/` source without a `CHANGELOG.md` update gets a warning annotation, with a
  `no-changelog` / `[skip changelog]` escape hatch and a documented path to enforce
  it later (#165).

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

### Changed

- **Scrapers publish backfill data incrementally so a failed run resumes (#247).**
  The long-running backfill jobs no longer discard a whole run when they fail
  part-way through. **crimes-sync** now commits **per page** (instead of buffering
  all history into one transaction), so a rate limit or crash mid-pagination keeps
  every page already fetched. **member-stats** writes each backfilled `(member,
  date)` snapshot **as it's fetched**, so an interruption during the ~30-day
  first-run backfill keeps the days already captured and the next run only fetches
  the still-missing ones. **attacks-sync** (already resumable) now treats a
  Torn rate-limit (error 5 / 8) mid-backlog as a **soft stop** — the run ends as a
  success with its partial rows, instead of a red failure; a genuine non-transient
  error still surfaces as a failure.
- **Competitions resolve at exact timestamp boundaries (#229).** Competition
  windows are now timestamps, not dates, and standings are computed from the
  intraday sample series (#227): each member's value is `(latest sample ≤
  window_end) − (latest sample ≤ window_start)`. A sample exactly at the end
  boundary counts; anything after is excluded — so a contest can have a real
  time-of-day cutoff. Where no sample exists (competitions predating the series),
  resolution falls back to the once-daily `member_daily_stats` rows. This retires
  the interim #223 "day-after snapshot" workaround, whose approximation the exact
  boundaries supersede. Existing date-only competitions are migrated to
  start-of-day / end-of-day and keep resolving unchanged.
- **Member notes open on hover; the pencil edits.** Hovering a roster row's note
  icon now shows the note (read-only) for everyone; clicking the pencil opens the
  editor (war leads / leadership / admin only). A click also pins it open for touch
  devices (#199).
- **War Room header/footer tidy-up.** The leader **headline composer** moved into
  the filters card (the banner itself still shows above the roster); the **"?" help
  button** moved to the top-right of the header card; and the **"last updated"**
  readout moved into the roster footer — now members (left) · last updated (centre)
  · refresh rates (right).


- **Scheduled-push headline is now a live countdown.** The leader "Push at…"
  headline preset posts a **live countdown** — "PUSH IN 4:37" ticking down to
  "PUSH NOW" — instead of the old static "PUSH 2 HH:MM" text. It's driven by an
  absolute target time, so every War Room tab counts down to the same instant
  regardless of timezone.


- **The War Room headline banner moved to a more in-flow spot.** On desktop it now
  sits between the chain/quick-button status bar and the player roster (instead of
  at the very top); in the Mobile App overlay it’s pinned to the top so it stays
  visible as the roster scrolls (#197).

### Fixed

- **Login now requires + verifies Faction API access (#263).** A Limited key
  without faction API access passed login and joined the key pool, then poisoned
  faction-scoped scrapers with Torn error 7 (*"Incorrect ID-entity relation"*) —
  observed on a newly-provisioned faction, isolated to one member's key. Login
  now reads `access.faction` from `/v2/key/info`: a faction member whose key
  lacks it is refused with actionable guidance ("enable Faction API access in
  Torn, then log in again") instead of silently enrolling, the real value is
  stored on `member_secrets.has_faction_access`, and the key pool defensively
  skips any key flagged without faction access so a stale row can never be
  claimed for a faction call. Visitors (whose keys are never pooled) are
  unaffected.
- **RW payouts can be saved again — removed a stale API-key guard.** Saving a
  ranked-war payout on the Payout Management page failed with *"Missing API key —
  please log in again."* on the self-hosted stack. The save is authenticated by
  the session JWT and never needs the raw Torn key — but a leftover guard required
  `user.apiKey`, which API mode deliberately never stores client-side, so every
  save was blocked. The guard now only checks there's a computed payout to save.
- **War pages no longer assume the Forge faction (#249).** Four war-related
  frontend modules hard-coded the Forge faction id (`10739`), so on any other
  tenant **every completed war showed "Loss"** (the winner check never matched)
  and past wars showed **"No contribution data"** (the live leaderboard filtered
  attacks to the wrong faction). RW History win/loss, the contribution leaderboard,
  War Overview, and the payout math now resolve the tenant's own faction id at
  runtime via `getFactionId()` — the same per-tenant source the rest of the app
  already uses. No provisioning step is needed; contributions populate from the
  attacks already scraped. Forge behaviour is unchanged.
- **Manually-triggered scrapers no longer 502 the Global Admin page.** The "Run"
  button held the HTTP request open until the whole job finished, so a long job
  (member-stats runs for minutes) blew past the reverse-proxy read timeout and
  returned a 502 — while the job kept running invisibly. The trigger now returns
  immediately with a **running** record; the job runs in the background and the
  **Recent Runs** panel auto-refreshes until it settles. Any run left stuck in
  **running** by a killed process (redeploy/crash) is now **reaped to failure at
  startup**, so it can't linger forever or masquerade as in-flight.
- **Competitions now count the full final window day.** A cumulative-stat board
  read its end value from the snapshot dated on the window's end day, but the
  daily `member-stats` job runs early each morning, so that snapshot only captured
  activity up to the end day's *start* — losing the entire last day. Standings now
  read the end value from the **day-after** snapshot (which captures the full end
  day), and an auto-resolving fixed competition **waits until that day-after
  snapshot has landed** before it freezes the board, so no one's final-day effort
  is under-counted when picking the winner.
- **War Room alert timers no longer corrupt typed input.** The dib lead-time and
  chain-watch threshold fields clamped to a minimum on every keystroke, so typing
  "15" bumped the leading "1" to "5" → "55" (any 1–4 became 5). They now let you
  type freely and clamp only on commit (blur/Enter), and the floor is 1 second.
- **Competition metric paths corrected against live personalstats.** Several
  metrics pointed at the wrong keys, so their boards silently showed "No data in
  this window yet" even with snapshots present: **Xanax** (`drugs.xantaken` →
  `drugs.xanax`), **Blood bags** and **Revives** (there is no `medical` category —
  now `hospital.blood_withdrawn` / `hospital.reviving.revives`). **Energy spent in
  the gym** isn't a personalstat at all — it now reads the dedicated `gym_energy`
  column (a new `daily_column` metric source) that `member-stats` already collects.
  Existing snapshots populate the corrected boards with no re-scrape.
- **Generic default branding.** Removed leftover "TNL"/"Forge" strings from
  shared (non-per-tenant) surfaces: the revive-service **Nuke `app_info`** fallback
  is now `War Room` (was `TNL War Room`), the faction-tag settings placeholder is a
  neutral example, and the **default PWA app icon** is a generic "T" (Torn) tile
  instead of the "TF" monogram. Per-tenant identity (name, logo, favicon) is
  unaffected; a tenant's uploaded logo still overrides the default icon.
- **Restored the headline "clear" (✕) button.** The header/footer reshuffle dropped
  the clear control from the displayed headline banner; war leads / leadership /
  admin can once again dismiss/clear a posted headline from the banner itself.


- **War Room tour highlight alignment.** The spotlight ring sat slightly below its
  target because a smooth scroll ran after measuring; it now scrolls the target to
  centre first and re-measures, so the highlight frames the control it’s pointing at.


- CI: the `db` schema-drift test now knows about the new `crime_participation_v2`
  and `faction_branding_assets` tables (it had gone red after those merged), and the
  changelog gate no longer errors on a missing `pull-requests: read` token scope —
  it degrades to a skip and stays advisory (never blocking).


- **War Room roll-call overlay no longer reappears after you've submitted.** A
  backgrounded/throttled tab's periodic refresh could transiently return empty and
  wipe your submitted response, re-tripping the blocking gate; the refresh now keeps
  known-good data on a failed read, and a submit/leader-bypass is persisted per war
  so tab switches don't re-gate (#167).

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

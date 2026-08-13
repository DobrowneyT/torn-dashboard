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

## [3.24.0] - 2026-08-12

### Added
- **Observed OC occupancy** (#389). A new `crime-occupancy` scraper job polls the
  current crimes once a minute (at the `:30` mark, off the other jobs' `:00`) and
  records what it actually saw: one stint per member per slot, with `first_seen_at`
  and `last_seen_at`. Torn reports when a member joined a crime and who is in it
  now, but never when they left — so every "left at" in the payout calculation has
  until now been inferred. This records it instead.
  - `crime_occupancy` uses a surrogate key, unlike `crime_participation_v2`'s
    `(crime_id, member_id)`, so a member who leaves a crime and rejoins it keeps
    both stints rather than having the first silently overwritten.
  - A crime **absent** from a poll response never closes a stint. Absent means we
    did not look, not that anyone left; closing on absence would fabricate a
    departure and stamp it with a plausible-looking time.
  - `crime_occupancy_polls` records every poll, so a payout window containing an
    outage can report the hole instead of quietly under-counting departures.
  - Migration `db/migrations/0034-crime-occupancy.sql`; existing tenants need
    `node db/migrate.mjs`.

## [3.23.1] - 2026-08-12

### Fixed
- **OC Payouts: Time Spent counted expired crimes as still running** (#392, #389).
  An OC that never filled and lapsed took the "in progress" branch, so its members
  accrued right up to the payout window's edge — six hours of participation scored
  as a full 168. Because Time Spent is a share of the total, that moved money away
  from members who had actually been in crimes. Only `Planning` and `Recruiting`
  now accrue to now; anything else ends at its resolution marker (`executed_at`, or
  `expired_at` for a lapsed crime), and an unrecognised status ends rather than runs.
- The participation tracker resolved on `status === 'Executed'`, which Torn never
  sends (its statuses are `Successful`/`Failure`/`Expired`). `completed` was
  therefore false on every row in every tenant, and its tests could not see it
  because they drove the tracker with the same invented status.

### Changed
- **Left-early (banked) time no longer drives the OC payout** (#389), pending
  verification against the new occupancy poller. It is still fully displayed —
  `timeSpent` and `bankedSeconds` are unchanged and Payout Management reads
  exactly as before — but tickets, the sit-out penalty and the payout share are
  now computed from `ticketTimeSpent`: the completed/current intervals alone.
  Requested by MonChoon, who wants to observe the banked figures for a few weeks
  before letting them move money. Reverting to the combined figure is a one-line
  change once the data is trusted.

## [3.23.0] - 2026-08-12

### Added
- RW Payout Management: saved payouts now list in the same table as OC Historical
  Payouts — total payout, members, opposing faction, faction cut, saved by — with
  **Load** and **Delete** per row. Loading restores the payout's settings, reselects
  its war and recalculates, so the batch URL can be regenerated. The recalculation
  is compared against the saved sheet and any drift is reported, because a batch URL
  that silently disagrees with what was already paid sends the wrong amounts.
- `GET /api/war-payouts` and `/api/wars/:id/payouts` join the war they belong to
  (`war_opponent_name`, `war_opponent_id`, `war_start_at`, `war_end_at`).

### Fixed
- RW payout history showed **"Invalid Date"** on every row (#140). `new Date` returns
  NaN on the bare `+00` offset Postgres serves, the same trap as #330.
- The #140 scanner only checked `Date.parse`, missing `new Date(str)` — the same
  parser, and the spelling the codebase actually used. Widening it found five more
  live instances: mobile War Room stat age (never displayed), Key Pool "last claimed"
  sorting (never ordered), War Overview last-ingest times (always zero), the OC
  overwrite confirmation, and the inventory last-sync time (read as local, not UTC).
- `parseBoundary` no longer re-implements the #140 offset repair; it delegates to
  `parseDbTime`, which is where the timestamp-without-tz case was fixed.

### Removed
- OC Payout Management: the **Import CSV/XLSX** button and its import flow
  (`ImportPreviewModal`, `csvPayoutImport`), unused since the self-hosted cutover.

## [3.22.5] - 2026-08-12

### Fixed
- `files.monchoon.me/scripts` and `/videos` (no trailing slash) 404'd while the
  slashed form worked. `location /videos/` does not match `/videos`, so it fell
  to `try_files $uri =404`, and nginx's own add-the-slash redirect never ran
  because try_files bypasses the handler that issues it. Fixed with exact-match
  redirects, which keeps a plain 404 on every folder that is not published.
- Redirects from this vhost are now relative (`absolute_redirect off`), so nginx
  cannot rebuild them onto the wrong scheme, host or port.
  
## [3.22.4] - 2026-08-12

### Fixed
- `deploy/update.sh` now rebuilds the backup sidecar. It sits behind a compose
  profile, so `up -d --build` skipped it — meaning changes to `db/backup.mjs` or
  `backup.Dockerfile` never reached the running container, and the pre-deploy
  backup kept using a stale image. The 3.22.3 timeout fix would not have
  deployed without this.

## [3.22.3] - 2026-08-12

### Fixed
- A backup upload can no longer wedge deploys. `rclone` ran with no network
  timeout, so a Backblaze maintenance window left it waiting over an hour in
  the foreground of `deploy/update.sh` — which holds the deploy lock, so every
  5-minute auto-deploy logged "another update is already running" and skipped.
  The stack stopped updating with nothing reporting a fault. rclone now has
  connect/transfer timeouts and finite retries, plus a `timeout` around the
  whole pre-deploy step.
- An unreachable remote no longer aborts the backup run. `upload()` threw, which
  killed the loop, so every database *after the first* got no local dump either
  — the offsite copy failing took the local archives with it.
- The closing summary now names failed uploads instead of reporting "6
  archived" for a run whose offsite copy never happened.
- The backup image ships an empty `rclone.conf`, so `NOTICE: Config file ... not
  found` no longer appears on every call. rclone is driven by `RCLONE_*` env
  vars; the notice was harmless but read as a misconfiguration and sent us
  chasing the wrong cause during the outage.

## [3.22.2] - 2026-08-12

### Added
- `files.monchoon.me/scripts/` and `/videos/` now render a directory listing,
  so a folder can be linked instead of an exact filename. Opt-in per folder:
  `/` and every other subdirectory still 404 rather than listing.

## [3.22.1] - 2026-08-12

### Fixed
- Travel ETAs still never rendered after the server-side fix (#330). The client
  parsed `travel_departed_at` with `Date.parse`, which returns **NaN** on the
  bare two-digit offset Postgres serves (`2026-08-12T15:30:28.041124+00` is not
  valid ISO 8601) — so every estimate fell through to "unknown". The #140 trap.
- Same trap in the War Room member stats, where it was quieter and worse:
  cooldowns stopped **ageing** and displayed their stored value as though live,
  and the reading's staleness never rendered at all.
- A scanner test now fails the build on any unguarded `Date.parse` in `src`,
  since this has now silently broken four separate features.

### Changed
- All three of Torn's aircraft are mapped to travel methods (#330):
  `private_jet → wlt` and `airliner → business` are now confirmed, so an
  estimate narrows to Torn's own ±3% instead of spanning business-to-standard.
  An unknown aircraft still falls back to every method rather than guessing.

## [3.22.0] - 2026-08-12

### Added
- Groundwork for the OC simulator (#390): the hand-entry table for per-ending
  payouts (`frontend/src/data/ocEndingPayouts.json`, 31 scenarios / 167 good
  endings, all `null` until measured) and a pure `expectedValue` helper that
  computes E(x) over whatever has been filled in. Partial data yields an
  explicit **lower bound** rather than a number presented as the answer. Failed
  crimes pay nothing (confirmed), so the 202 bad endings need no entry.
  
## [3.21.1] - 2026-08-12

### Fixed
- Travel ETAs never appeared in the War Room (#330). The guard that refuses a
  departure we did not witness was asking "did this member's row change in the
  last 120s?" when it meant "was the board watching?". A member's row is only
  written when they actually change, so anyone sitting idle stopped advancing
  their `updated_at` while we polled them every second — and their eventual
  take-off was then discarded as unwitnessed. That is every take-off, since
  "idle, then travels" is what travelling looks like from the roster's point of
  view. Board liveness is now recorded once per sweep
  (`war_room_config_v2.last_roster_sync_at`, migration 0033) instead of being
  inferred per member.

## [3.21.0] - 2026-08-12

### Added
- Member Overview now carries a **Battle Stats** column (#355), war-lead and
  above only: the same hover breakdown and exact-vs-estimate treatment as the
  War Room, sortable (members with no reading sink to the bottom in both
  directions, the #351 rule), and filterable by min/max total using the War
  Room's `3m` / `2.6b` shorthand or by source — "BSP only" being the list of
  members to chase for a key.

### Changed
- `parseStatInput` extracted to `utils/statInput` and shared. It existed twice
  (War Room desktop and mobile) and Member Overview would have been the third;
  two pages parsing `2.6b` differently is a bug nobody reports because each
  page looks right on its own. A test scans `src/` to stop a fourth copy.
- The battle-stats cell moved out of `WarRoomViewV2` into
  `components/BattleStatsCell`, so both pages render the same cell rather than
  lookalikes. Its age now uses `fmtAgo`, which already handles the bare
  Postgres offset that JS `Date` rejects (#140).

## [3.20.2] - 2026-08-12

### Added
- Server-side dibs concurrency harness (#385): a seeded run of concurrent
  claims and releases from five holders against an oscillating roster, with
  the real ticker and real WebSocket clients, asserting invariants that must
  hold for any interleaving. Verified to reproduce #376 when the fix is
  reverted (12 violations across 30 rounds); ~2.8s, so it stays in the
  existing Vitest job.

### Fixed
- The Torn client rate-limit test measured gaps between resolutions, so a
  loaded event loop compressed them and the test failed on total suite load
  rather than on the limiter. It now measures from a fixed pre-dispatch
  baseline, which cannot be compressed.

## [3.20.1] - 2026-08-12

### Changed
- The header version chip moved from beside the username to the header's
  bottom-right corner (#394). It sits in padding that was already empty, so
  unlike a second row it costs no vertical space — which was the constraint
  behind the issue, the War Room being the densest view in the app.

### Added
- `npm run preview:header` renders the real `Header` at desktop, tablet and
  phone widths with auth stubbed, so layout can be judged without deploying.
  It is dev-only tooling: the production build does not see it.

## [3.20.0] - 2026-08-12

### Added
- The app version is now shown in the header instead of only in the footer
  (#394). It carries the tenant slug too (`v3.20.0`, copying `3.20.0 / tnl`),
  is selectable, and copies to the clipboard on click. When a newer build is
  deployed the chip turns amber, shows both versions, and reloads on click —
  so "what version am I on" and "am I out of date" are one place rather than
  two. Below `sm` it moves into the settings menu. The footer is unchanged.
- Feedback submitted through **Send feedback** now records the reporter's
  running version on the GitHub issue automatically (#402) — no extra field,
  nothing for the reporter to copy. The issue shows both their version and the
  deployed one, and flags a mismatch, since a reporter on a stale build is the
  case worth spotting.

### Changed
- `faction identity` now exposes the tenant `slug` (it was already sent by
  `/api/bootstrap` but only used to derive the display tag).

## [3.19.1] - 2026-08-12

### Fixed
- OC Payouts → Crime Statistics: participants in a saved payout week now show
  their names instead of `User 4422276 [4422276]` (#400). Torn never sends a
  name with a crime slot, so `crime_slots.user_name` is always NULL; the
  saved-week endpoint now resolves it by joining `members`, the same way
  `/api/crimes/:id/slots` already did. The join deliberately includes departed
  members, since an archived week is history.

## [3.19.0] - 2026-08-12

### Fixed

- **RW Payout Management worked only on Forge (#393).** Every other tenant got
  *"No contribution data available for this war"* on wars that had synced
  perfectly well. `WarPayoutManagement` and `RWPayoutsView` read the tenant's
  faction id into a **module-scope constant**, which evaluates when the module
  is imported — during app startup, before `/api/bootstrap` has answered. So it
  captured the `config.js` fallback (Forge, `10739`), and the contribution
  filter discarded every row belonging to the actual tenant.

  This was a **re-occurrence of #249**, which fixed the same symptom by
  replacing hardcoded `10739` literals with `getFactionId()` calls — two of
  which landed at module scope, where the call returns the fallback, which is
  the same literal. The bug was relocated, not removed.

  No configuration could have fixed it: one nginx image serves every tenant
  from a single bundle, so a build-time `VITE_FACTION_ID` is necessarily wrong
  for four of five factions. Identity has to come from the runtime bootstrap.

  Identity is now read at use time. Two guards stop a third occurrence: a
  dev-only warning when identity is read before bootstrap resolves, and a test
  that **scans `frontend/src` for module-scope captures** and fails naming the
  file and line. The scanner was verified by reintroducing the bug and watching
  it fail.

- **Crime Statistics showed "0 participants" for saved payout weeks (#391).**
  `GET /api/payouts/weeks/:id/crimes` returned crimes without their slots, so
  the client hardcoded an empty array and the participant list rendered as "no
  data". The live calculator always had slots, which is why this only broke on
  **reopening** a saved payout — exactly when someone is auditing who was in
  what. The endpoint now returns slots, and both paths share one slot shaper so
  they cannot drift apart again.

### Added

- **`isFactionIdentityResolved()`** — lets a call site distinguish a genuine
  per-tenant bootstrap from the pre-load fallback, rather than silently
  rendering another faction's identity.

## [3.18.1] - 2026-08-09

### Fixed

- **`revives-sync` only reached back 7 days on a cold start (#358).** The cap
  was justified in the code with "the only consumer of this feed is a rolling
  24-hour score". That was wrong: the **War Overview** reads `faction_revives`
  across whole war windows (`GET /api/wars/:id/revives`) and has done since
  long before the revive-chance column existed. A seven-day cold start left
  every war older than a week with empty revive charts unless someone
  remembered to run the per-war backfill by hand.

  Revives are the same kind of record as attacks and now get the same
  treatment: the cold start walks the entire history. The first run is long;
  every run after it reads one page.

### Added

- **`POST /api/sync/revives/backfill` (#358)** — walks forward from `?from=`
  (default 0, the whole history) regardless of what is already stored, so a
  faction with partial history can complete it **without truncating the table
  first**. The upsert is idempotent, so re-read revives are refreshed rather
  than duplicated.

  This exists specifically so nobody has to delete data to force a re-pull.
  Truncating reaches the same end state while opening a window where the data
  is gone — and if Torn's own retention is shorter than the history we already
  hold, everything past their horizon would be lost permanently. Logged as
  `revives-sync-backfill` so a deliberate backfill is distinguishable from the
  routine tail in the run history.

## [3.18.0] - 2026-08-09

### Fixed

- **Users were running old builds for hours after a deploy (#382).** During the
  war behind #371 and #376, people reported bugs against code that had already
  been fixed and shipped. The cause was confirmed: **there were no cache
  headers anywhere.** nginx served `index.html` with only `ETag`/`Last-Modified`,
  which lets a browser apply its own heuristic freshness and serve the entry
  document *without revalidating* — and `index.html` is the manifest naming the
  content-hashed bundles, so a stale one pins the whole app to an old build.

  Now: `index.html` and `sw.js` are `no-store`, and `/assets/*` is cached
  immutably for a year. The split is safe precisely because Vite content-hashes
  the bundles — the hash *is* the version, so those URLs can never change
  content. `sw.js` was a third vector worth calling out separately: it is not
  hashed, and a stale service worker can serve old assets from its own cache
  and survive even a hard refresh.

  Applied through a shared snippet so the production vhost, the staging vhost,
  and every per-faction vhost generated by `db/new-faction.mjs` cannot drift
  apart. CI asserts all five headers, since a wrong one is invisible to a human.

### Added

- **In-app version gate (#382).** The cache rules fix any tab that navigates.
  They cannot fix a tab that never does — which is the normal state of the War
  Room, left open for the length of a war, and exactly where stale code does
  the most damage. The running app now compares its build version against
  `/api/health` every five minutes and whenever the tab becomes visible.

  On the War Room it reloads outright: a board showing wrong dibs is worse than
  a two-second interruption, and a dismissible banner gets dismissed. Elsewhere
  it prompts, because a reload can discard something half-typed.

  The reload-loop guard is the substance of it. "Version differs → reload" is
  one bad deploy away from an infinite refresh that locks everyone out of the
  board mid-war — far worse than the staleness it set out to fix. So: at most
  one reload per observed server version, recorded *before* reloading; if the
  mark can't be written (private mode) it declines to reload at all rather than
  risk the loop; the mark clears once the versions agree, so a later rollback
  isn't refused. Rollbacks trigger a reload too — a "newer than" check would
  strand everyone on a bad build — and a missing version is treated as no
  information, never a mismatch, so an API outage can't refresh the board on a
  loop during the incident.

## [3.17.2] - 2026-08-09

### Fixed

- **Dibs dropped the instant a farmed target left hospital (#376).** Reported
  as "the dibs is stripped and it appears it was never called". The auto-expiry
  countdown was armed once and never disarmed — `auto_expire_at` was only ever
  *set*, and only when it was still null. So after a target went back into
  hospital the claim kept a deadline that quietly lapsed while they were down,
  and the next time they surfaced the sweep saw `auto_expire_at <= now()` on an
  Okay target and released the claim **on that tick**, with none of the
  intended 30-second window.

  Farm mode runs head-on into this, because the loop is precisely
  hospital → out → hit → hospital → out: the *first* exit behaved correctly and
  every exit after it dropped the claim immediately.

  The countdown now disarms whenever the target stops being Okay. Both
  countdowns that write this column — the hospital-exit window (#106) and the
  claim-timeout (#159) — mean "the target is up and the holder hasn't
  converted", and neither survives the target going back down. A claim nobody
  converts still expires; a target who simply stays up still runs one window to
  its end.

  This also removes the last way the hospital flicker could destroy real data.
  #371 fixed the flicker's effect on the *display*; a spurious `Okay` reaching
  the server still armed a genuine countdown against a target who had never
  left, which then killed the claim on their next real exit. That is why the
  flicker fix improved things without ending the reports.

## [3.17.1] - 2026-08-09

### Changed

- **The revive-chance formula is confirmed exact, not inferred (#358).** The
  source thread was unreachable when 3.17.0 shipped (Cloudflare 403), so the
  curve between Torn's published endpoints was reconstructed and labelled as
  inference. The formula is now in hand:

      chance = 90 + skill/10 − score × (8 − skill/25)
      score  = Σ over revives in the last 24h of (1 − t/86400)

  It matches what shipped, exactly. **No behaviour changed** — this release is
  the evidence plus the corrected wording. The implementation is now pinned to
  the published expression across the whole skill × score domain, and to the
  three worked examples in the post (score 1.5 at skill 50 → 86%, score 12 at
  skill 100 → 52%, score 12 at skill 30 → 11.4%).

- **The model check is now a data check, and a sharper one.** With the maths
  confirmed, any disagreement between our figure and the percentage Torn
  displayed means our reconstructed score differs from theirs — that is, our
  revive history is missing revives. The sign says which way: a **positive**
  bias means we counted too little score, i.e. revives we never scraped.
  Expected in the first 24 hours after the job is enabled, and it should decay
  to zero as the window fills; if it doesn't, the feed has a gap. The column
  header tooltip says so.

## [3.17.0] - 2026-08-09

### Added

- **Standing revives scraper (#358).** `revives-sync` runs twice hourly at :05
  and :35, walking `/v2/faction/revives?filters=incoming` forward from the
  newest stored revive — revives our members *received*, whoever performed
  them, with each one's `success_chance` and the reviver's `skill`. Revives
  were previously only ever fetched one finished war at a time, which cannot
  answer a question about the last 24 hours. The first run reaches back 7 days
  rather than the whole history: the only consumer is a rolling day, and
  war-era history is already covered by the per-war backfill.

- **Best-case revive chance on our own roster (#358).** A new lead-only
  `Revive %` column: what a skill-100 reviver would see for that member right
  now, sortable and colour-ramped like the other numeric columns. Computed from
  the revive history rather than fetched — each revive a member receives adds 1
  to their score, decaying linearly to zero over 24 hours, and each point of
  score costs a reviver 4 percentage points at skill 100. The client holds the
  raw events and recomputes on its own clock, so the figure decays live instead
  of going stale between polls.

  **There is no enemy equivalent and cannot be.** Torn reports a success chance
  only on revives our own faction received, so the original form of this
  request — a percentage next to a target we are deciding whether to pay to
  revive — is not obtainable. What is on the board is our side only.

  The chance is an estimate: Torn publishes the endpoints of the curve (90% at
  skill 0 → 100% at skill 100; 8% per score point → 4% at skill 100) but not
  the shape between them, and the interpolation here is inference. Because
  every scraped revive carries the percentage Torn actually displayed, that
  inference is checked against real observations rather than trusted — the
  column header reports the model's mean error and signed bias against however
  many revives we have seen.

### Fixed

- **War pages could silently miss the opening hours of a war's revives
  (#358).** `GET /api/wars/:id/revives` filtered on the stored `rw_id` tag,
  which was correct while the only writer was the per-war backfill. The
  standing feed tags rows from whatever wars `ranked_wars` knows about at
  ingest time, and `wars-sync` only runs every three hours — so revives landing
  early in a new war were written untagged, and nothing ever went back to fill
  them in. The war pages now resolve revives by **time window**, with the tag
  kept as a union so a war whose window is later corrected can't drop rows.

- **The "no reading is not a zero" guard now lives in one place.** `Number(null)`
  is `0`, and that has produced the same class of bug four times — a member
  whose key failed rendering as `0/150` energy, an unfetched cooldown rendering
  as Ready, and (caught while building this) an absent reviver skill counting
  as skill 0. The guard moved out of `warRoomMemberStats` into
  `frontend/src/utils/reading.js`, and everything numeric goes through it.

## [3.16.0] - 2026-08-08

### Fixed

- **The overdose flag vanished as the drug cooldown burned down (#357).**
  Detection was a threshold test against the *current* cooldown, but the sweep
  overwrites that column every pass — so a real overdose lost its flag the
  moment it dropped under 10h, leaving a member who is out of the fight for
  another nine hours looking available.

  The server now latches an expiry the first time a reading crosses the
  threshold, and never shortens it. That is sound because nothing in the game
  reduces drug cooldown, so the first reading above the line already says when
  it ends — and because a member cannot dose again while on one, so the
  cooldown's duration *is* the window in which they are stuck.

  The latch survives a failed key (a fetch that could not happen must never
  read as "recovered") and a cooldown reaching zero; expiry is decided by
  comparing the timestamp to now, so nothing has to guess when to reset. Rows
  written before the migration fall back to the old live test, so an overdose
  already in progress does not blink off across the deploy.

- Removed a comment in `warRoomMemberStats.js` claiming the stored reading made
  this immune to burn-down. It never did — the stored value falls exactly like
  the displayed one — and anyone reading it would reasonably have concluded the
  case was already handled.

## [3.15.0] - 2026-08-08

### Added

- **Colour gradient on the three cooldown columns (#356).** Inverted from
  energy — green means ready to act, red means capped — and linear rather than
  piecewise: energy needed the split because it has two regimes read for two
  different questions, while a cooldown just counts down and less is better the
  whole way. Ceilings are drug **8h** (a full xanax), medical **9h** and booster
  **48h**.

  Medical is anchored at the **wartime** maximum. 6h is the usual cap but war
  perks raise it to 9h, and wartime is exactly when the column is read — a 6h
  ceiling would pin every war-perk member to flat red through their last three
  hours, flattening the window a lead is scanning.

  Coloured off the **aged** remaining value, the same figure the cell prints.
  Over-ceiling readings clamp rather than wrapping through red: an item that
  would push a member past the cap applies anyway, so those are normal, not
  errors. A member with no reading stays grey, never green — a failed key must
  not read as "ready". An overdose keeps its own red-and-bold treatment from
  #351 instead of taking a gradient, so that state has one appearance rather
  than two.

### Changed

- The energy and cooldown gradients now share one CSS rule (`.hue-grad`,
  `--grad-hue`) instead of energy owning its own, so the two cannot drift apart
  on legibility in either theme.

## [3.14.1] - 2026-08-08

### Fixed

- **Enemies flickered between Okay and Hospital as they came out (#371).** The
  delta merge applied rows by ARRIVAL order rather than by version. Two
  transports feed the board at once — the WebSocket, and a REST delta fired by
  `pollNow()` after every dibs claim, release and note — so a response already
  in flight when the ticker wrote a member could land on top of fresher data
  and hold until that member's next write. It clustered around hospital exits
  because that is exactly when people are clicking, and it repeated because
  Torn's `last_action.relative` text rewrites almost every row constantly,
  keeping stale rows inside the `since` window.

  Rows now merge **newest-wins** on `updated_at`. Equal timestamps still apply
  (re-sends are routine, and a same-millisecond update is real), unversioned
  rows still apply (the old behaviour beats silently dropping data), and
  tombstones are kept in the map and filtered at publish time rather than
  deleted — deleting the entry discards the only thing able to reject a stale
  row for that member, and a resurrected member would never leave the board.

## [3.14.0] - 2026-08-08

### Changed

- **In farm mode, a green attack button always survives the Stats filter
  (#366).** Online + Okay members are the only people who can be hit this
  second, so if a push starts they are precisely what a lead needs on screen —
  and a min/max left over from farming would quietly remove exactly them. A
  filter that hides the thing you must react to is worse than no filter.
  Non-green members still filter normally, and outside farm mode the filter is
  left alone: set deliberately, it is a targeting tool and should do what it
  says.
- The green-target predicate is now shared between the farm sort and the stats
  filter rather than written twice. Two copies would eventually disagree, and
  the failure mode is a member the sort promotes to the top tier being filtered
  off the board.

## [3.13.1] - 2026-08-08

### Fixed

- **Surge alerts fired while WE were farming (#367).** Hospital timers expire on
  their own, so during a farming run batches of enemies dropped out of hospital
  every few minutes with nobody at the keyboard — and the detector read that as
  "incoming push!" at the faction doing the pushing. A status surge now requires
  **Online + Okay**: back *and playing*, not just back. Absent activity reads as
  not-online rather than defaulting to online.
- **The revive surge had the same bug, from the day it shipped (#359).**
  `is_revivable` means "a revive is possible right now", and a revive is only
  possible in hospital — so the flag flips true the moment a member with revives
  already on gets **hospitalised**, which while farming is every target we put
  down. It now counts the flip only when the member's status did **not** also
  change in that observation: revives coming on while nothing else moved is
  somebody reaching for the setting; revives coming on alongside a status change
  is a side effect of it. This holds whichever way Torn reports `is_revivable`
  for a healthy member, since it rejects a simultaneous status change rather
  than a particular status.

## [3.13.0] - 2026-08-08

### Added

- **Estimated arrival for travelling members (#330).** The Timer column was
  empty for anyone in the air, because Torn returns no arrival time for travel —
  `status.until` is null for a traveller, unlike hospital and jail. The estimate
  is derived instead, from three things: the departure (latched server-side when
  the roster poll observes the transition into Traveling), the destination
  (parsed from the status description), and the aircraft
  (`status.plane_image_type`, already present in the faction-members payload we
  poll, so it costs no extra calls and works for the opponent).
- **Elimination narrows the estimate as the flight runs.** The four travel
  methods differ by roughly 1.4x, so a method whose latest possible landing has
  passed while the member is still airborne is ruled out. An unrecognised
  aircraft starts as a wide range and tightens on its own.

### Notes

- The result is always a **band, never a point**: Torn added up to 3%
  flight-time variance in patch #26, so even a fully identified flight lands
  inside a window. It renders italic with a `~` prefix so it can never be
  mistaken for the exact hospital countdown beside it.
- **A missed departure shows nothing rather than a guess.** If the board was not
  polling — war room off, roster cadence 0, process restarted — the first tick
  back would read a member who left hours ago as having just taken off. A
  freshness check rejects that transition, and the cell stays blank. A wrong
  arrival time is worse than none: a lead waits on it and loses the window.
- Two aircraft are mapped from live observation (`airliner` = Business Class,
  `light_aircraft` = private airstrip). Standard and WLT are still unknown and
  fall back to the full range rather than defaulting to a method.
- A member still airborne past every candidate reads `landing` rather than a
  time in the past — reachable in normal play, since a Detective Agency's
  Watchlist can extend a flight.

## [3.12.1] - 2026-08-08

### Fixed

- **Surge alerts ignored every sound and flash preference (#361).** The handler
  called `fireAlert('surge', { sound: true, flash: true })` with the settings
  hardcoded, and the Alerts popover had no surge channel — so a member who
  wanted quiet had no control that could deliver it, while the Sound and
  Screen-flash checkboxes sitting right there visibly did not apply. There is
  now a surge channel with the same two switches. It defaults **on**, unlike
  dibs and chain: this is a war-wide warning from the server, not a personal
  reminder anyone asked for, so it is opt-out. Silencing it does **not** hide
  the banner — muting a ping and suppressing a warning are different things.

### Changed

- **Flash colour and tone now differ per surge kind (#361).** Status flashes red
  to match its red banner (it was amber, disagreeing with its own banner) and
  keeps the urgent klaxon; a revive surge flashes amber to match its banner and
  gets fewer, softer beeps, so the two are told apart without looking — the same
  way dibs and chain already are.

## [3.12.0] - 2026-08-08

### Added

- **Revive-surge alerts — "a push is being set up" (#359).** A second push-surge
  detector alongside the existing one, firing when N members turn their revives
  **on** within a window. The original detector (#208) fires when members become
  Okay, by which point the push has already started; nobody enables revives
  casually mid-war, so a cluster of that is the push being *prepared*. The
  settings panel now has two sections, Status and Revives, each with its own
  toggle, threshold, window and cooldown — hospital churn is constant during a
  chain while revive prep is deliberate and rare, so one shared window would
  tune one of them wrong. Off by default.
- Distinct copy, rally-call preset and banner colour for the new alert. A revive
  surge is amber and reads "turtle up and hold"; telling a faction to retaliate
  against a push that has not started yet would spend the chain early.

### Changed

- The surge detector now tracks two kinds through one state machine rather than
  duplicating the window, threshold, cooldown and seed-on-first-sight logic.
  `SurgeEvent` carries a `kind`, and the web-push tag includes it — sharing one
  tag would let a revive alert silently replace an unread status alert in the
  notification tray.

## [3.11.0] - 2026-08-08

### Added

- **Our members' battle stats in the War Room Stats column (#353).** #348 had
  been collecting them daily into `member_battle_stats` with nothing rendering
  them, so the data landed in the DB and stayed invisible; meanwhile our own
  roster showed a column of `???` because spies are only fetched for the
  opponent. The lead-gated `/api/members/battle-stats` rows are now projected
  onto the `bsp_*` field names the Stats cell, both sorts and the min/max
  filter already read, so no call site needed an our-faction code path.
- **The Stats tooltip distinguishes an exact figure from an estimate (#353).**
  A reading from the member's own key is labelled `OWN` and underlined solid;
  TornStats (`TS`) and BSP (`BSP`) keep the dotted "this is a guess" treatment.
  The cell previously knew only two sources, so an exact figure would have been
  labelled as a prediction.

### Changed

- **The Stats filter works on our own roster (#353)** — but only once the daily
  sweep has actually run. It stays suspended while we hold no battle stats,
  because with every total null a min/max carried over from the enemy side
  would silently empty the table, which is the trap the original suspension
  existed to prevent.

## [3.10.0] - 2026-08-08

### Added

- **Sortable Energy and cooldown columns on our own roster (#351).** Energy,
  Drug CD, Medical CD and Booster CD now sort ascending/descending like the
  other headers. Energy sorts on the current value; cooldowns sort on the
  **aged** remaining value, matching what the cell renders — the sweep walks
  keys serially, so ranking the raw stored seconds would produce an order that
  disagrees with the numbers beside it. Members with no reading sink to the
  bottom in **both** directions: sorting ascending by energy asks "who is
  empty", and a member whose key failed is an absence of an answer, not one.
- **Energy colour gradient (#351).** Red at empty → amber at a full natural bar
  → green at a stacked 1000, and piecewise rather than linear so the 0-150
  stretch where nearly everyone sits mid-war gets a full sweep instead of the
  bottom 15% of one ramp. Replaces a band on `current / maximum`, which
  collapsed the distinction that matters most — 150/150 and 1000/150 both came
  out "high", so a roster that had not stacked looked identical to one that
  had. The amber anchor follows each member's own reported maximum.

### Changed

- **A ready cooldown renders as `0`, not "Ready" (#351).** The column is
  numeric and scanned vertically; "Ready" was the widest value in it and the
  only non-numeric one. `—` still means "no reading".

### Fixed

- **A member whose key failed no longer reads as 0 energy (#351).** `Number(null)`
  is 0, so rows the sweep wrote with a `last_error` and null energy rendered as
  `0/150` — indistinguishable from a genuinely empty member, and enough to get
  someone written off for a push. Every numeric read in the module now goes
  through a guard that keeps null as null, and the gradient leaves those cells
  grey rather than colouring them red.
- The war-room empty-state row spanned the wrong number of columns after a
  forced fall back to the enemy roster, and the sort column persisted across
  reloads could survive onto a side where that column is not rendered.

## [3.9.1] - 2026-08-08

### Fixed

- **War Room energy never populated while cooldowns worked (#348).** The v2
  response nests the bars under `bars` but returns `cooldowns` at the **top
  level**, and `parseMemberStats` read `body.energy`. The parser was written
  from YATA's v1 code, where selections are flattened — and the test fixture
  was written in that same v1 shape, so it passed against a parser that could
  never have worked against the live API. The fixture is now a real captured
  response, plus a case asserting the two halves cannot diverge again. A
  flattened body still parses.

### Added

- **Our own members' battle stats (#348).** A daily `member-battle-stats` job
  fills `member_battle_stats` from three sources, best first and never
  downgrading: the member's **own key** via
  `/v2/user?selections=battlestats` (self-only, Limited access — our enrolment
  floor — so exact and current), then our faction's **TornStats** spy report
  for anyone without an enrolled key, then a **BSP** estimate for whoever is
  still unknown. The `source` is stored so an estimate is never presented with
  the same confidence as a member's own figure.
- **`GET /api/members/battle-stats`, war leads / leadership / admin only
  (#348).** Battle stats decide who can hit whom, so they live in their own
  table with their own role check — folding them into `/api/members` would
  have exposed them to every authenticated caller, since that route backs
  every view.
- **API key disclosure covers battle stats (#348).** `battlestats` is added to
  the Torn API Calls row, and a new "Battle Stats" row states the daily
  cadence, that the figures are visible only to war leads / leadership /
  admins, and that a TornStats or BSP figure is an estimate the dashboard
  labels as such.

## [3.9.0] - 2026-08-08

### Fixed

- **Roll call is archived per war instead of being wiped (#345).** The war
  lifecycle's auto-setup ran an unqualified `DELETE FROM war_room_roll_call_v2`,
  destroying every past war's responses — while the notes table beside it was
  deliberately archived by `war_id`. Worse, auto-setup fires whenever the job
  sees a war it does not already own, which is reachable mid-week: it deleted
  93 live responses in production today. Rows are already keyed by `war_id`, so
  a new war id is an empty slate by construction and there was never anything
  to reset. Roll call now archives exactly like notes.

### Changed

- **`enabled` is now the only gate on War Room polling (#345).** The ticker
  used to refuse to poll an auto-managed session outside its war's start/end
  window, so "enabled" really meant "enabled, unless the calendar disagrees" —
  a board could sit frozen for days before a scheduled war while showing every
  sign of being live. If leadership switched the room on, it polls: before a
  war, after one, whenever. What it polls is controlled by the cadences, both
  of which now accept `0` as off — `roster_poll_interval_ms` stops the roster
  sweep, `member_stats_poll_interval_sec` stops the member-stats sweep.
- **The War Room no longer switches itself on (#345).** Auto-enable at T-1h is
  gone. On the weekly reset the lifecycle still detects the new war, points the
  config at it, baselines both rosters and pulls spies — then leaves the room
  **off** for leadership to start. It still auto-disables when the managed war
  ends, so a finished war stops costing Torn calls.
- **Status badge reflects the simpler model (#345).** `SCHEDULED — NOT POLLING`
  and `WAR ENDED — NOT POLLING` are gone. Enabled reads **LIVE**, disabled reads
  **STOPPED**, and an enabled room whose roster cadence is 0 reads **RUNNING —
  ROSTER PAUSED**, so a switched-off roster poll cannot masquerade as a live
  board.

## [3.8.1] - 2026-08-08

### Fixed

- **War Room board froze silently when the roster cadence was set faster than
  the key pool could sustain (#342).** A roster sync spends two Torn calls on a
  single key, so the 0.5s cadence #339 allowed meant 240 calls/minute spread
  across the pool — past Torn's 100/min *per key* on any small pool. Every sync
  threw a rate-limit error, the ticker's `.catch(() => {})` discarded it, and a
  board that had stopped updating was indistinguishable from one with nothing
  to report: stale statuses, hospital timers stuck on "Releasing…", and
  "Updated 200s ago" while the footer claimed it was polling twice a second.

  The configured cadence is now floored by what the pool can actually sustain
  (`1500ms / enrolled keys`, never below 500ms), so one key gets 1.5s, two get
  750ms, and three or more reach the full 2 Hz. The override is logged. Tick
  failures are logged too, throttled to once a minute — the swallow is what
  made this invisible, and it predated #339.

### Changed

- **Removed the poll-cadence readout from the roster footer (#342).** It was
  diagnostic detail shown to every viewer, actionable only by an admin, who can
  read it from War Room settings. The paused-state notice stays.
- **Removed the descriptive blurb beside the "Showing:" toggle (#342).**
- **The roster toggle now names our faction (#342)** instead of the generic
  "Our faction", matching how the opponent side is labelled.
- **An unknown revive setting now reads as "revivable by anyone" (#342).** Torn
  reports `Unknown` when it will not disclose the preference, which is the
  normal case for an opponent — so #339 painted the entire enemy roster with
  the muted glyph and buried the distinction it was meant to draw.
  `is_revivable` is already computed from our vantage point, so the revive is
  possible; only the stated preference is missing. The muted glyph is now
  reserved for members Torn explicitly reports as "Friends & faction".

### Added

- **The War Room no longer claims to be LIVE while the server has stopped
  polling (#342).** The green LIVE badge was driven by `war_room_config_v2.enabled`
  alone, but the ticker deliberately refuses to poll an **auto-managed** session
  outside its war's window. In the hours before a scheduled war — and between
  wars — that produced a board showing a pulsing LIVE badge and an "Updated 12s
  ago" footer over a roster frozen at the previous war's end, with a poll
  cadence it was not honouring. The badge now reads **SCHEDULED — NOT POLLING**
  or **WAR ENDED — NOT POLLING**, and the footer says "Last known state —
  server is not polling". Pressing **Save** next to the Opponent Faction ID
  still takes manual control and starts polling immediately; the badge tooltip
  now says so.
- **The war-room ticker now says why it is idle (#342).** Four conditions
  previously stopped a tick with a bare `return`: the war room being disabled,
  no opponent set, an auto-managed war outside its active window, and no
  claimable API key. A board frozen for any of those reasons was
  indistinguishable from one with nothing to report. Each now logs once when
  the reason changes (and once more when polling resumes) — notably the
  auto-managed-war case, which is easy to hit on a cloned staging database
  whose `managed_war_id` points at a war that has since finished.

## [3.8.0] - 2026-08-08

### Added

- **Configurable roster refresh, floored at 2 Hz (#339).** How often the server
  re-reads both rosters from Torn is now a setting (`roster_poll_interval_ms`,
  default 1000) rather than a hardcoded 1 Hz — turn it down during a termed war
  so a per-second sweep of both factions stops burning API calls, or push it to
  0.5s during a live chain. 500ms is a hard floor enforced in the clamp table
  *and* in the ticker's gate, since each sweep is two Torn calls. This is the
  control the old "UI Refresh" slider appeared to be: that one was client-side
  and wired to nothing, and no server setting for the roster existed at all.
- **Overdose flag on the roster (#339).** Combines both detectors: the hospital
  status flag (#199), certain but only while the member is still in hospital,
  and the drug cooldown over 10h (#336), which survives release.

### Changed

- **The revivable flag now says who can actually revive (#339).** Torn has
  three revive privacy settings and `is_revivable` collapses them. Since we
  hire **outside** revivers, a target on "Friends & faction" is revivable in
  Torn's sense but not by anyone we can pay — the old single flag sent leads
  chasing revives that could not happen. Now: green for `Everyone` (a hired
  reviver works), muted for `Friends & faction` (their own side only), nothing
  for `No one`, and an unknown setting degrades to the weaker claim. The data
  was already stored; the UI was ignoring it.
- **Removed the "In OC" flag from the War Room (#339).** Being in an organised
  crime never affected whether a member could be hit or revived, and the flags
  column is scanned rather than read. Gone from desktop and mobile.

## [3.7.0] - 2026-08-08

### Added

- **Live energy and drug/medical/booster cooldowns for our own members
  (#336).** The our-faction roster now shows each member's current energy and
  all three cooldowns, replacing the placeholders shipped with #335. Torn
  exposes `bars` and `cooldowns` as self-only selections — there is no
  `/v2/user/{id}` variant — so this is one `GET
  /v2/user?selections=bars,cooldowns` per member using that member's own pooled
  key. A new **Member Stats** cadence in War Room settings controls it: `0`
  disables it entirely (the default, since it costs one Torn call per enrolled
  member per cycle) and any enabled value is floored at 30s, server-side as
  well as in the UI. The sweep only runs while the war room is enabled, and
  runs detached from the 1 Hz tick so a full roster walk never stalls the
  board.
- **Overdose detection that outlives the hospital stay (#336).** A drug
  cooldown over 10h can only be an overdose — a xanax tops out around 8h — so
  the Drug CD cell flags it. This complements rather than replaces the existing
  hospital-status flag (#199): that one is direct but disappears the moment the
  member is released, while a crippling cooldown persists long after.

### Changed

- **The our-faction roster is now war-lead only (#336).** Live energy and drug
  state say when a teammate is playing and whether they are mid-overdose, so
  the "Showing:" toggle is restricted to war leads, leadership and admins
  (never visitors), matching the member-notes guard. This is enforced on the
  **server**: the data lives in its own table on its own delta channel, which
  the WebSocket hub withholds from non-lead sockets and
  `GET /api/war-room/delta` never reads for a non-lead. Hiding the columns in
  the UI would still have shipped every member's energy to every browser.
- **API key disclosure now names the live-stats collection (#336).** A new
  "Live War Stats" row states in plain language that energy and drug/medical/
  booster cooldowns are read from your own key at most every 30 seconds while a
  war room is active, that a long drug cooldown is surfaced as an overdose
  indicator, that this is visible to war leads rather than the whole faction,
  and that the nerve/happy/life bars returned by the same call are discarded.
  `bars` and `cooldowns` are added to the Torn API Calls row.

### Fixed

- **War Room footer reported poll cadences that could not be right (#336).** It
  labelled a client-side slider as the enemy chain rate and hardcoded "Ours:
  every 30s", so the two numbers a lead would check to confirm a cadence change
  had taken effect were the two that never reflected it. The footer now reads
  the real server-side values from config. (Server cadences take effect
  immediately — the ticker re-reads config every second — so no war-room
  restart is or ever was needed.)
- **Removed the inert "UI Refresh" poll-rate control (#336).** It had done
  nothing since the API-mode collapse: the board is push-driven over the
  WebSocket and the value was passed to `useWarRoomSocket` as `intervalMs`,
  which the hook never read. Removed from both the desktop config panel and the
  mobile leadership sheet; the slot now holds the Member Stats cadence, which
  is live.
- **The roster-side toggle was unreachable with no opponent loaded (#336).**
  #335 put the toggle in the filters card, which renders only when the *enemy*
  roster has members — so between wars, or before Save & Fetch, the way to view
  our own faction did not exist, and the table sat on "Waiting for first poll…"
  even though our members were loaded. The filters card and the roster table
  now key off either roster, and the empty state follows the side actually
  being shown.
- **"Find Target ID range" popover opened underneath the sticky header
  (#336).** A regression from #331: the popover was `z-20`, the same as the
  headers it needed to cover, and an equal `z-index` falls back to DOM order —
  which the header wins. Raised to `z-30`, matching the sibling popovers and
  the invariant #331 already documented.

## [3.6.0] - 2026-08-07

### Added

- **War Room roster can switch to our own faction (#335).** A "Showing:" toggle
  above the roster swaps the table between the opponent and our own members, so
  leads can see who is in hospital or flying and when they are back without
  leaving the room. No backend work: the ticker already polls both factions and
  the socket hook already splits them, so this selects which roster feeds the
  table. Dibs and Attack are hidden on our side (you cannot claim or hit a
  team-mate) and Energy / Booster CD columns take their place as placeholders
  until #336 collects that data. The stats filter is suspended on our roster —
  spy data is only fetched for the opponent. Surge alerts and the spy auto-fetch
  keep tracking the enemy regardless of what is displayed, and the toggle resets
  to the opponent on reload.

### Fixed

- **War Room sticky header no longer has row content painted over it (#331).**
  The sticky `<th>` cells carried no `z-index`, and a sticky element with
  `z-index: auto` paints in DOM order — so every positioned element in a row
  (the stat cell, the member-note button, the tooltips) drew straight over the
  header as it scrolled underneath. The headers are now `z-20`, above row
  content but below the `z-30`/`z-40` popovers that are meant to cover them.

## [3.5.1] - 2026-08-06

### Fixed

- **War Room poll cadences are clamped server-side (#260).** `PUT
  /api/war-room/config` wrote whatever it was handed straight to the database,
  so the client's clamps could be bypassed by a crafted request and the
  server-side chain poller set to 0s. Chain poll intervals are now floored at
  1s (comfortably above the 0.5s safety minimum) and capped at 600s, and the
  other numeric cadence/threshold fields — dibs expiry, the surge thresholds,
  windows and cooldown, TornStats max age — are clamped to their own bounds.
  A non-numeric value is rejected with a 400 rather than silently stored as the
  floor. In-range values save and broadcast exactly as before.

### Changed

- **A disabled API key now ends the member's session (#319).** When the hourly
  members-sync re-verification (#309) disables a pooled key — paused, deleted,
  access denied, or resolving to a different account — the member is logged out
  at their next session refresh (next page load, or within 4h in an open tab)
  and told which key problem caused it, rather than the generic "faction access
  was removed". **Recruits are unaffected:** a recruit's key is healthy, just
  not yet faction-scoped, so they keep browsing and join the pool at ~72h with
  no re-login. Members who never enrolled a key are unaffected too. Fixing the
  key in Torn and logging in again restores access.

## [3.4.0] - 2026-08-06

### Added

- **Server-side revive-request proxy (#308).** `POST /api/war-room/revive`
  forwards a revive request to the service from the VPS, restoring the
  JSON-preset services (UHC/WTF) that broke when the Supabase edge function was
  retired — they showed a "needs a self-hosted revive endpoint" message. The
  per-service `sourceKey` (UHC `source`, WTF `requestChannel`) is honoured, and
  the requester's identity is derived from the session rather than the request
  body. The Nuke preset **stays direct-from-browser** for now: Nuke
  shadow-filters datacenter IPs, so proxying it through the VPS would answer
  200 while no reviver ever saw it. The server implements the Nuke payload
  shape too, so switching it over is a one-line change once a real request
  through the VPS is confirmed to land.
- **Staging / dev instance on the VPS (#292).** A private second instance
  serving a full copy of a real tenant (`faction_<slug>_dev`), reachable only
  through an SSH tunnel, so a branch can be exercised against real data — key
  pool included — before it is promoted to `main`. `db/clone-tenant-dev.mjs`
  clones a live tenant into its copy with every scraper disabled;
  `deploy/dev-deploy.sh` puts any pushed branch on the staging ground and, as a
  `--if-changed` cron, auto-follows `dev` while standing down whenever the
  worktree is on some other branch. Runs from its own git worktree, compose
  project, lock file and databases, so it cannot deploy over production. Setup,
  the tunnel recipe and the live-outbound blast radius are in `deploy/DEV.md`.

### Changed

- **Production deploy and backups skip staging databases (#292).**
  `deploy/update.sh` migrations and the nightly backup now exclude
  `faction_*_dev`, so the production cron can never write to — or archive — a
  staging copy.
- **Deploy docs corrected (#292).** `deploy/update.sh` deploys whatever branch
  its checkout is on, and the production checkout stays on `main` permanently;
  merging to `dev` reaches no live tenant. `docs/agents/delivery-workflow.md`,
  `.claude/agents/delivery.md` and `deploy/LAUNCH.md` said otherwise.

## [3.2.0] - 2026-08-05

### Added

- **Pooled Torn keys are re-verified on every members-sync (#309).** After the
  roster reconcile, the hourly job checks each enrolled, non-disabled key against
  `/v2/key/info` using that member's own key: a Recruit's key gains
  `has_faction_access` (and joins the pool) within an hour of Torn promoting them
  — no re-login — a key that lost faction access is dropped back out, `key_level`
  is refreshed, and a key with a fatal Torn error or a changed owner account is
  disabled with the reason. Transient errors leave the key untouched for the next
  run, and one key's failure never aborts the rest.

### Changed

- **Repo renamed `torn-forge-oc-system` → `torn-dashboard` (#132).** Updated the
  in-repo references to the old slug: the feedback issue-target default
  (`server/src/main.ts`, `deploy/.env.example`), the deploy runbook + helper
  script paths (`deploy/LAUNCH.md`, `deploy/pull-live-db.sh`), the root package
  name, the CLAUDE.md heading, and the delivery-agent doc. The GitHub rename
  auto-redirects git/API from the old path; live servers' git remotes + checkout
  dirs + cron paths are updated out-of-band by the operator.

## [3.1.0] - 2026-08-05

### Changed

- **"Sync Crimes" and "Sync Members" now trigger their scraper job (#135 part 2,
  slice 3a).** Both buttons ran through the retired Supabase admin-db function
  with the browser's raw key (they'd already been stubbed to "not available yet"
  in API mode). They now POST to new leadership-gated `/api/sync/crimes` and
  `/api/sync/members` endpoints — the same on-demand trigger family the war
  pages use (`/api/sync/wars`, `/api/sync/attacks`) — which run the crimes-sync
  / members-sync jobs under the run logger. No raw key in the browser.
- **Payout item valuation reads market prices from the catalogue, not a raw key
  (#135 part 2, slice 2).** `enrichItemBreakdown` used to fetch live market
  prices straight from Torn with the browser's API key (skipped entirely in API
  mode, so reward items fell back to sell price). `/api/items/lookup` now also
  returns each item's `market_price` (kept fresh by the items-sync scraper), and
  the enrichment uses it — no raw key needed. Removes the last raw-key
  `api.torn.com/.../items` calls from the frontend (two dead copies deleted).

### Added

- **Delete buttons for saved payouts (#135 part 2, slice 3b).** The OC payout
  history (Payout Management → Historical Payouts) and the RW payout history
  (RW Payout Management → View History) each get a per-row **Delete** button,
  wired to the slice-1 endpoints (`DELETE /api/payouts/weeks/:id` /
  `DELETE /api/war-payouts/:id`) with a confirm + list refresh. Restores the
  "remove a bad payout" capability the retired DataManagement view had.
- **Server endpoints to delete a saved payout (#135 part 2, slice 1).**
  `DELETE /api/payouts/weeks/:id` (OC — unlinks the week's crimes, then removes
  its member rows and the week) and `DELETE /api/war-payouts/:id` (RW — removes
  its member rows and the payout), both leadership/admin-gated. Restores the
  "delete a bad payout" capability that the retired DataManagement view ran
  through the now-dead Supabase admin-db function; the frontend delete UI is
  rewired to these when DataManagement is removed.

### Removed

- **Legacy superset deleted post-cutover (#135, part 1).** With production on the
  self-hosted stack, the retired Supabase + GitHub Pages pipeline is dead weight
  and is gone: the Python scrapers (`scripts/`) and their pytest suite (`tests/`),
  the Actions-committed data store (`data/`), the Supabase project (`supabase/`,
  `supabase.tar.gz`), the legacy Pages/scraper workflows (`deploy-pages.yml`,
  `daily-scrapers.yml`, `scrape-*.yml`), `requirements.txt`, the root
  `items.json` (the stack seeds from `db/seed/items.json`), and `export/`.
  `tests.yml` drops the Python job (Node stack only); the root `sync:items`
  script and `supabase` CLI devDependency are removed. The frontend's legacy
  Supabase/`API_MODE` client paths are a separate follow-up (#135 part 2).
- **Frontend `API_MODE`/Supabase fallback removed entirely (#135 part 2, slice
  3c).** Production has been API-only since the cutover, so the build-time
  `API_MODE` flag was always `true` and every Supabase branch behind it was dead
  code. Deleted the dead files — the `DataManagement` admin view (its ops ran
  through the retired admin-db function) and its route, the `adminApi` admin-db
  client, the Supabase browser client (`utils/supabase`) and its session-token
  minter (`utils/sessionToken`), the legacy war-room polling hook
  (`useWarRoomPoll`), the orphan `StatsOverview`, and the unused
  CPR/crimes/members/items import utilities. Collapsed every `API_MODE`
  conditional (~70 across 18 files — auth, faction identity, contexts, the
  war-room socket + API client, and the routed views) to its API-only arm, and
  removed the `@supabase/supabase-js` dependency plus the fake `VITE_SUPABASE_*`
  test env. No behavior change in production; the browser no longer references a
  raw Torn key anywhere. **Note:** JSON-preset revive requests (the non-Nuke war
  room revive services) relied on the retired Supabase edge function and now
  show a clear "needs a self-hosted revive endpoint" message instead of failing
  silently — a server `/api/war-room/revive` endpoint is the follow-up; the Nuke
  preset (direct-from-browser) is unaffected.
- **Purged remaining Supabase references (#135 part 2).** Deleted the dead
  `db/snapshot-from-supabase.mjs` restore script and the orphaned
  `.github/actions/scraper-setup` action (no workflow used it after the legacy
  scrapers were removed), cleared the retired Supabase server from `.mcp.json`,
  and corrected stale wording across agent docs (`main` is live production, not
  "the live Supabase site"), deploy docs, and user-facing help text (payouts /
  inventory no longer say "stored in Supabase"). `db/template.sql` keeps its
  provenance note and `docs/security-model.md` / `docs/war-room-v2-*.md` remain
  as historical design records.

### Fixed

- **OC Payouts "Compare Weeks" was broken in production.** `loadCompareWeek`
  still read from Supabase (`supabase.from('oc_payout_members')`) — ungated and
  not even imported in that file — so comparing two payout weeks threw a
  `ReferenceError` on the self-hosted stack. Rerouted to
  `GET /api/payouts/weeks/:id/members` (the same endpoint the page already uses
  to load a week). Found during a full audit of remaining legacy Supabase call
  sites (#135 part 2).
- **War payouts scored only war hits — assists, losses and mugs came through as
  0.** Since the June "exclude non-war assists/losses" change, the participation
  calculator required Torn's `is_ranked_war` flag to credit an assist/loss/mug as
  war-scoped, but Torn only sets that flag on scoring *wins* — assists and losses
  against the war opponent come back `is_ranked_war=false`, so every one was
  dropped from the score (they still showed in the raw Hit Report). War scope is
  now decided by whether the attack was against the war opponent faction
  (`war.opponent_id`), with the flag kept as a fallback; genuinely non-war
  assists against other factions during the window are still excluded.
- **War Room chain timer showed "no chain" even during a live chain.** Torn's
  chain API returns `timeout`/`cooldown` as *relative* seconds, but the war-room
  code stored them verbatim while the UI counts down against *absolute* epochs —
  so the chain always read as idle. `fetch-chains` now converts both to absolute
  epochs (for our side and the enemy) on store; `start`/`end` were already
  absolute and are unchanged.
- **War Overview "Fetch Attacks"/"Fetch Revives" and War Room BSP auto-fetch /
  private-notes were silently disabled in production (#135 part 2, slice 3c).**
  Several war-room and war-overview actions were gated on the browser holding a
  raw Torn API key (`user.apiKey`), which the self-hosted stack deliberately
  never stores — so the stale-data "Fetch" buttons sat permanently disabled and
  the auto BSP spy fetch never fired. These paths already call session-authed
  `/api/*` endpoints, so the raw-key guards were removed and they work off the
  session token.

### Added

- **Faction names stored on each attack row.** `faction_attacks` now carries
  `attacker_faction_name` / `defender_faction_name` (mirroring how
  `faction_revives` already stores faction names), so an attack row is
  self-describing. `attacks-sync` populates them from the payload; a migration
  backfills existing rows in-place from the `factions` table (no re-pull, so no
  risk of losing attacks beyond Torn's API retention). The RW payout filter and
  war-overview now resolve names from the rows themselves, with the `factions`
  table still canonical for names and authoritative for the `[TAG]` suffix.
- **Faction names captured inline by `attacks-sync`.** The v2 attack payload
  carries each side's faction `{id, name}`, which we were discarding. The attacks
  sync now upserts those names into the `factions` lookup as it pages — so the
  payout opposing-faction filter fills in names for **free** (no extra API
  calls), and a fresh re-pull of the attacks table rebuilds the lookup for every
  faction ever fought.
- **Faction lookup completion scraper (`factions-sync`).** The old sync's
  faction lookup (`_backfill_factions`) wasn't ported in the server migration.
  Restored as an hourly job that fills the **tags** (and any names attacks
  didn't cover) via `GET /v2/faction/{id}/basic` — the attack payload has no
  tag — so the filter shows "SMTH - Phoenix Nirvana [PN]" rather than a bare
  name or "Faction #20465". Tagless factions are stored with an empty tag so
  they aren't re-fetched forever; capped at 40 lookups per run. Registered
  disabled by default — enable it in Global Admin (or "Run now" once).
- **War Room chain watch is now live.** While the war room is enabled, the
  server ticker polls our and the enemy's chain at their configured cadences
  (`chain_poll_interval_ours_sec` / `_enemy_sec`), plus a forced poll when our
  chain is within ~6s of dropping, and broadcasts the refreshed timer to every
  open tab. Previously the chain was only seeded once at setup and never
  refreshed. (Chain fetch/convert/store logic extracted to a shared module and
  reused by the manual seed.)
- **Days in faction in the Member Overview (#287).** Two new sortable, pickable
  columns: **Total Days** (lifetime, across every stint) and **Streak** (current
  continuous stint). Plus a **minimum-tenure threshold** ("Min Days in Faction")
  in threshold sets and a **Tenure ≥ days** filter to isolate recent joiners or
  veterans. Completes the member-metrics epic.
- **Member Overview now flags members it can't assess (#286).** When a member
  lacks the data to evaluate a threshold, they're marked amber **"inconclusive"**
  instead of silently counted as passing — with its own summary count and a
  "needs data" filter, kept separate from the red "flagged" (confirmed problem)
  bucket. Individual missing-data cells show amber too. (Row math extracted to a
  unit-tested `memberMetrics` util.)
- **Member Overview windows now go the distance (#285).** The overview can look
  back over 7 / 30 / 90 / 365 days or **All** — and "All" finally spans a
  member's whole stored history instead of silently capping at ~30 days. The
  daily-stats endpoint projects each day-row down to just the stats the grid can
  display, so the longer windows stay small on the wire.
- **Faction tenure is now tracked (#284).** `members-sync` captures each member's
  lifetime `days_in_faction` from the roster (no extra API calls) and maintains a
  new `member_faction_stints` history — opening a stint when a member appears,
  closing it when they leave, and opening a fresh one on rejoin — so a current
  membership **streak** can be derived. On rollout, existing members' current
  stint start is inferred from the gap in their daily-stats snapshot history.
  (Groundwork for the Member Overview days-in-faction columns.)
- **Faction armory now syncs automatically every hour (`inventory-sync`).** A new
  scraper job snapshots the faction inventory across every category with a pooled
  key and upserts `inventory_items` on the hour, so loaned-item tracking and payout
  valuations stay fresh without a leader clicking "Sync". The manual Leadership sync
  still works and writes the same `sync_metadata` row. Registered disabled — enable
  it per tenant in Global Admin like every other job.
- **Scraper job names in Global Admin now explain themselves on hover.** Each job in
  the Scraper Jobs table shows a tooltip summarizing what it does, which Torn API
  calls it makes, and what it feeds — sourced from the job-by-job reference.
- **Your own API key is shown (masked) in the hamburger menu (#264).** The
  account dropdown now displays which key is on file for your session as
  `••••<last 4>` — so you can confirm you logged in with the right key when
  troubleshooting. The last-4 hint comes from the server for **your own key
  only** (stored at login enrolment; the full/decrypted key is never exposed),
  and sessions with no pooled key (e.g. visitors) see a clear "No key on file".
- **Feedback attachments are pruned once the issue closes (#255).** A daily job
  deletes stored feedback attachments once their linked GitHub issue is **closed**,
  with a hard **90-day TTL fallback** for issues that never close, so attachment
  storage can't grow unbounded. The run is resilient — a GitHub API error for one
  issue is skipped, not fatal — and only runs when feedback is configured.
- **Feedback form now takes image + video attachments (#254).** The "Send
  feedback" form gains a file picker (up to 5 images/videos, ≤10 MB each). Files
  are validated and **stored server-side** (bytea, like branding assets — no
  shared volume), served from an unguessable `/api/feedback/attachments/<uuid>`
  URL, and **embedded in the GitHub issue** — images inline, video as a link
  (GitHub only inline-plays its own uploads). Each file is recorded against its
  issue number so a later prune can clean it up (#255). Text-only submissions are
  unchanged. (Set `PUBLIC_BASE_URL` so the embedded links use the public origin.)
- **In-app feedback form → triaged GitHub issue (#253).** A **"Send feedback"**
  entry in the hamburger menu opens a form (Bug / Suggestion, title, details).
  Submitting files a **GitHub issue** in the shared repo via a server-side PAT,
  labelled `needs-triage` and stamped with the submitter's Torn **name + id**
  (taken from the session, never the request body) and the **tenant slug** — so
  members can report issues without a GitHub account and leaders know who to
  follow up with. Read-only **visitors can't submit**; the entry and endpoint are
  **hidden/disabled** until a PAT (`FEEDBACK_GITHUB_TOKEN`) is configured, and a
  simple per-user rate limit guards against spam. (Attachments + cleanup land in
  #254/#255.)
- **Termed RW payouts: the first-24h shares are now editable too (#273).** In the
  two-section termed view, leaders can adjust a member's **first-window (blue)**
  shares independently of their **after (purple)** shares — each into its own
  override, re-splitting the one whole pool. Previously only the after shares
  were editable and the first-24h share was read-only.
- **Termed RW payouts split into a first-window + scaled breakdown (#267, #269).**
  Termed wars now default to **flat-then-scale** shares (previously everything
  landed in one flat post window): a **flat 1 share** for reaching the
  minimum-score-per-share within the first **24h** of war start (adjustable), plus
  **proportional shares** for respect earned after that mark, all paid from one
  whole pool split by total shares (one share value). The Payout Management table
  now shows this as **two coloured sections** — a **First {N}h** group (blue) and
  an **After {N}h** group (purple) — each with its own **hit report, score,
  shares, and payout**, so leadership can see exactly what was earned and paid in
  the opening window vs the remainder. The first-window share is the read-only
  1/0 base share; the after shares are the editable scaled shares. Race and real
  wars are unchanged.
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

- **New factions get the feedback env wired automatically (#253 follow-up).**
  `db/new-faction.mjs` now emits the `FEEDBACK_GITHUB_TOKEN`/`REPO`/`LABEL` imports
  and a per-tenant `PUBLIC_BASE_URL` (`https://<slug>.${PUBLIC_DOMAIN:-monchoon.me}`)
  into each generated `api-<slug>` service, so a newly-provisioned faction picks up
  the in-app feedback form as soon as the shared PAT is set in `deploy/.env`.
  Documented in `deploy/.env.example` and `deploy/LAUNCH.md`.
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

- **OC payout time can no longer exceed the payout window (#262).** A member's
  adjusted/total time could read impossibly high — e.g. **211.9h for a one-week
  (168h) window** — because completed/current-crime time and left-early "banked"
  time were summed independently, double-counting any wall-clock overlap. Since a
  member can only be in one OC at a time, their real time is the **union** of
  their crime/stint intervals: the total is now the merged, window-clipped span,
  so it can never exceed the window, while left-early time is **still credited**
  (a member whose only activity was a left-early stint is unchanged). The
  "Completed / current" vs "left early" breakdown stays coherent.
- **Keys without Faction API access no longer poison faction scrapers — and no
  longer bar login (#263, #271).** A Limited key without faction API access used
  to join the key pool and poison faction-scoped scrapers with Torn error 7
  (*"Incorrect ID-entity relation"*) — observed on a newly-provisioned faction,
  isolated to one member's key. Login now reads `access.faction` from
  `/v2/key/info` and stores the real value on `member_secrets.has_faction_access`,
  and the key pool **excludes any key without faction access** from faction-scoped
  claims so a no-access key can never be used for a faction call. Because faction
  API access is **leader-granted** (a recruit in their first ~72h literally can't
  enable it), such members **still log in normally** — their key is enrolled but
  kept out of the pool rotation, and **Key Pool Health flags it with a yellow "No
  faction access" badge** so leadership can see who needs a faction position.
  Visitors (whose keys are never pooled) are unaffected.
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

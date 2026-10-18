# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**How to bump:** The repo-root **`VERSION`** file is the single source of truth for
the app version. Every PR that changes behaviour bumps it: set `VERSION` to the
new `X.Y.Z`, sync the root `package.json` `version` to match, and add a new
`## [X.Y.Z] - YYYY-MM-DD` block at the top whose version equals `VERSION`. Level
follows the change: `feat` → minor, `fix` → patch, breaking → major (a human may
override). There is no `[Unreleased]` staging section — every branch merges to
`dev` before it is ever promoted to `main`, so an entry is only ever added once
it is genuinely about to ship. The footer (`VITE_APP_VERSION`, read from
`VERSION` at build) and `/api/health` (read from `VERSION` at runtime) both
surface it automatically.

---

## [3.233.1] - 2026-10-18

### Fixed
- **Custom ranges on Stats take a date AND a time**, to the second (TCT), pre-filled with the range on screen. Clicking **Custom** no longer asks the server for an empty range, which is what showed "from and to must be epoch ms". If the end is before the start, the page says so in plain words.
- **"Highest respect hit"** replaces "Best hit (no bonus)" on Totals, with the unit written after the figure.

## [3.233.0] - 2026-10-18

### Changed
- **Per-member boards list the whole faction**, sortable, in a window about ten rows tall that scrolls: Revitalize, Treats, Loot drops, Most earned from bounties, Most targeted and Busiest. `#` is the place in the current sort.
- **One-off lists go to the top 100**, also scrolling with ten in view: highest mugs, biggest hits, highest bounties, who hit us, who we hit.
- **Loot drops expand:** click a member's drops to see each item, how many, when, and who it came from, linked (e.g. Jimmy [19]).
- **Totals:**
  - "Best hit (no bonus)" is the best ordinary hit. Torn's own figure counts chain bonuses (the 100k bonus is 40,960).
  - "Draws" is now "Stalemates", as Torn says in game.
  - The "Bonuses" card is gone; the bonus hits are listed below it.
- **The "Members" view is now "Report".**
- **Scrollbars match the page**, thin and in the page's own greys in both themes, site-wide.

### Fixed
- **Tooltips that repeated their own text** (CPR role names, payout names, stat-picker and threshold labels, calendar titles, scraper errors) now only appear when the text is actually cut off on screen.

## [3.232.1] - 2026-10-18

### Fixed
- **Ranked lists on Stats no longer run off a phone screen.** A long name with a long figure ("$2,000,000 on Fiveseven_ [340409]") pushed the card past the right edge and cut the figure off. The figure now drops under the name when both don't fit.

## [3.232.0] - 2026-10-18

### Added
- **Stats replaces Daily and Highlights** on the event report. One view, any range: **Overall**, a single TCT day, or a **custom** span of days. Totals, the member table and every highlight follow the range.
- **Revitalize and treat leaderboards** lead the Stats view. Neither has been seen in a log yet, so each matches any spelling of Torn's icon and says plainly when it has nothing yet.
- **Loot drops are tracked again** (parser v4): who looted what, how many, and from whom (in the test window, NPC "Jimmy"), in every wording seen ("a Jawbreaker", "3x Concussion Grenade", "some Pixie Sticks").
- **Every name is a link**, written `name [id]`: members, opponents, bonus hitters, non-attackers, bounty and mug targets, and factions. Each opens the Torn profile or faction page.

### Changed
- **Factions on Targets list every faction**, in a box that scrolls past about ten. "No faction" and "Stealthed" rows are gone (reviewed as not useful); those attacks still count everywhere else.
- **Other effects** (Powerful, Stricken and the rest) are folded into an "All effects seen" list. That is where the real Revitalize and treat names will first appear.

## [3.231.0] - 2026-10-17

### Added
- **A live event colours the whole site.** While an event is live, the site's accent (buttons, active tabs, links and highlights, normally blue) takes the event's colour: Halloween orange, or any colour set in Settings. It switches back the moment the event ends.
  - **Accent only:** each viewer's light or dark choice is untouched.
  - **Per-event switch:** "Colour the whole site in this colour while the event is live" in Settings, on by default (migration 0083).
  - **How it works:** the site's blue palette is now CSS variables defaulting to the same blues, so with no live event the site looks exactly as before.

## [3.230.1] - 2026-10-17

### Fixed
- **Chain Watch stays in the Members tabs**, now linking to its new home on the Events page. Members only see the Events tab once an event exists, but Chain Watch sign-ups open before that: tnl and forge both had Halloween sign-ups open with no event created yet.

## [3.230.0] - 2026-10-17

### Added
- **Factions on Targets (#987):**
  - **Factions we hit most:** attacks, wins, members of ours involved, and respect gained.
  - **Factions that hit us most:** attacks, how many beat us, how many we defended, members of ours hit, and respect lost.
  - **Edge cases:** factionless players and stealthed attackers are rows of their own, never dropped. A stealthed attack hides the faction too, so it is never lumped in with "No faction". Attacks between our own members are excluded.
- **Most earned from bounties** on Highlights: per member, by total value, with the number of claims, beside the highest single claims (now titled "Highest bounties claimed").
- **Retaliations on Daily**, per member and per day, counted from Torn's 1.5× retaliation modifier on synced attacks. They were already in Totals and Members, from Torn's chain report.

## [3.229.0] - 2026-10-17

### Added
- **Bounties claimed (parser v3).** Read from the archived attack logs: Torn writes a claim on the hospitalize line ("X hospitalized Y and claimed a $100,000 bounty"), and only there, never on a leave or a mug. Highlights shows bounties claimed, their total, and the biggest claims. Our members' claims only; a bounty claimed on one of ours is not ours. The archive is re-read automatically (migration 0082).
- **A position column on Members**, frozen beside the name, so a member scrolled to any figure can see where they stand. It numbers the rows in the current sort: sort by respect and it is a respect ranking.

### Changed
- **The report opens on Members**, the live chain report board, with Totals second.
- **Settings** is pinned by tests to leadership and admins: no tab, and the URL does not open it, for anyone else. This was already true; the URL case was not tested.

## [3.228.1] - 2026-10-17

### Fixed
- **Leadership can find the Events page before an event exists.** The Events tab is now always shown to leadership ("Events" when nothing is scheduled) and opens on Settings, where an event is created. Before, it only appeared once an event existed, so creating the first one meant typing the URL. Members still see it only while an event is upcoming or live.
- **The attack-log parser no longer counts non-effects as procs (parser v2).** Checked against ~2,000 real forge logs on staging:
  - **Dropped:** losses, stalemates, loot, boosters, sledgehammer and wind-up stances, and recoil damage.
  - **Burns and bleeds count once:** a multi-word damage-over-time tick ("Molotov Cocktail scorches X for 807") is no longer counted as a new proc each tick.
  - **Credited to the defender:** a parry and No Touching, as the log text shows.
  - The whole archive is re-read automatically.
- **Attacks between two of our own members no longer count as incoming.** They are stored as incoming, which put our own members into "Who hit us most" and inflated "Attacked" on Targets and "Hit by others" on Daily.
- **The report on a phone**, checked at 390 px against real staging data:
  - **Members, Daily and Targets:** the name column stays put while the figures scroll sideways, and rows no longer change height when a figure wraps.
  - **Report views:** they sit on one row that scrolls sideways, instead of wrapping.
  - **Totals:** packed three to a row, with Respect across the top; "Best hit" is now "Best respect", which is what it is.

## [3.228.0] - 2026-10-17

### Added
- **Archived attack logs are read (#974).** For every event attack: the mug amount, each hit's damage and the biggest, damage dealt and taken (Torn's own per-fight summary), respect, and **one row per effect line** (weapon procs such as Stricken, Plunder, Powerful, Execute, and named effects such as Bleeding). The archiver parses new logs as they arrive. Re-running over the whole archive is idempotent, and a parser version bump re-reads everything (how the treat parser in #975 will catch up).
- **Highlights** on Events → Report: highest mugs, biggest hits, most effects per member, every effect seen, and effects per day. Our members only; an opponent's proc in the same fight is never credited to us.

### Notes
- Built from 35 real forge logs. Effects are identified by the icon Torn puts on the log line, never by wording, so **Revitalize** needs no guessed text: it appears under its own name the first time a real log carries it. A damage-over-time tick ("Bleeding damaged X for 106") is not counted as a proc or a hit; only the line that starts it counts.
- Stealthed attackers ("Someone") are attributed from the stored attack, never the log text.

## [3.227.0] - 2026-10-17

### Added
- **Every event attack's log is archived while it still exists (#973).** Torn's attack logs expire, so they are collected during the event. Outgoing and incoming are both fetched on pooled keys and stored raw (Torn's response, unparsed), ready for the parsers in #974 and #975.
  - **Work list:** any event attack without a stored log is due, so the archive resumes by itself after an outage or restart.
  - **Expired logs** (Torn error 28) are recorded and never asked for again. Other failures retry with backoff from 2 minutes up to an hour.
  - **After the event:** archiving continues for 7 days, to pick up the last few logs.
  - **Per-key limit:** no key makes more than 10 calls in any minute. This is a courtesy to members' own scripts, tunable as `event_attack_log_per_key_per_min`.
- **Attack log archive panel** under Events → Settings (leadership): archived, waiting, expired and retrying counts. A backlog that keeps growing for ten minutes shows as a red warning.

## [3.226.0] - 2026-10-17

### Added
- **The event report updates live (#972).** An open Report page checks every 5 seconds whether anything it is built from has changed, and refetches only then: a new attack, a backfilled one, or a chain report that actually differs. Attacks-sync re-reading its newest attack, or an identical chain-report poll, changes nothing. The page stops checking while its tab is hidden and catches up when it is shown again.

### Notes
- The server caches the "has it changed?" answer for 3 seconds per event, so many open tabs cost one query. It is a separate endpoint and shares nothing with the War Room's push hub; a test now fails if events code imports anything from the War Room.

## [3.225.0] - 2026-10-17

### Added
- **The event's live chain report (#971)** on Events → Report, with four views:
  - **Totals:** chain, respect raw and capped (10 per bonus hit, with the deduction named), hits, mugs, hospitalizations, assists, retaliations, overseas, losses, escapes, draws and bonuses, plus every bonus hit and what capping it costs.
  - **Members:** the same per member, plus respect average and best, sortable, and who has **not hit yet**.
  - **Daily:** per member per TCT day from the daily start, from our synced attacks, so a day interrupted by an outage fills in once Torn is back.
  - **Targets:** attacks made and received per member, most-targeted members, who hit us most, and who we hit most.
- Totals and Members are Torn's own chain report, the numbers members will check us against. The report refreshes every 30 seconds and stays readable after the event ends.

## [3.224.0] - 2026-10-17

### Added
- **Live chain report collection (#970).** While a faction event is live, the dashboard polls Torn's chain report for our own chain every 5 seconds on pooled keys. It keeps the latest report, the faction totals on every change, and a full per-member snapshot every 5 minutes (and always when the chain starts or ends). Both intervals are tunable per tenant (`event_chain_report_poll_sec`, 0 = off; `event_chain_report_snapshot_min`). Outside an event it makes no Torn calls.
- **The event ends at the chain's exact end.** Once the minimum end has passed, the chain report's own end time is used, ahead of the four-minute chain sampler.
- **Chain report collection panel** under Events → Settings (leadership): polls, how often the report actually changed, failures, last error.

### Notes
- Measured before building: Torn serves the same cached answer for ~30 seconds unless the request carries `timestamp`, so every poll sends it.
- A report from another faction (a key whose owner has left) is never stored, and neither is the faction's last ordinary chain from before the event. During an outage, failures are recorded and polling backs off to once a minute, then resumes by itself.

## [3.223.0] - 2026-10-17

### Added
- **Events page (#969).** A faction event (Halloween first) now has its own page at **Events**, in the event's colour. While an event is live it is the landing page; the nav tab appears only while one is upcoming or live. Leadership schedule and edit it under Events → Settings (all times TCT): opens, daily figures from, runs at least until, and whether it then runs until the chain ends (dies or reaches 100k). The end is stamped from the chain samples, so a later ordinary chain cannot revive a finished event, and a Torn outage keeps it live rather than ending it.
- **Chain Watch moved to Events.** `/members/chain-watch` redirects there, so the bot's sign-up link and old bookmarks still work. Sign-ups stay reachable with no event scheduled.

### Changed
- **The dashboard lives at `/dashboard`.** `/` now redirects — to the event while one is live, otherwise to the dashboard — so the Dashboard tab still works mid-event.

### Fixed
- **Path-style links land on the right page.** A link like `https://<faction>.monchoon.me/members/chain-watch` (the bot's sign-up link) used to open the home page; it now opens the page it names.

## [3.222.1] - 2026-10-17

### Changed
- **The Attack Logs disclosure no longer promises a call rate** (#968). MonChoon: *"Lets not
  make any promises on the number of calls per minute."* The sentence *"Your key is used for
  this at most 10 times a minute"* is gone; the attack-log archive keeps a per-key cap as an
  internal courtesy, not a commitment on the page.
  ⚠️ **A new version, `attack-logs-v2`, rather than editing v1's fingerprint** — any change
  to this page re-prompts, removing a constraint included. It cost little: three members had
  accepted v1 when this landed. Still not gated. A test now fails if a call-rate figure
  reappears in the row.

## [3.222.0] - 2026-10-17

### Added
- **The API Key Usage page discloses attack-log reading, and every member is re-prompted**
  (#968, first slice of the Halloween PRD #967). A new *Attack Logs* row says, in plain
  words, that during faction events members' keys read the detailed logs of the faction's
  attacks in both directions — damage, money mugged, weapon effects, items gained such as
  event treats — at most 10 calls a minute from any one key, and why: **Torn deletes attack
  logs after a few weeks**, so they have to be collected while the event runs. The endpoint
  list now names `chainreport` and `/v2/torn/attacklog` too, so the two Halloween uses cost
  members one re-prompt rather than two.
  ⚠️ **Re-prompted, but NOT gated.** New version `attack-logs-v1` is current, so every
  member sees the updated terms — but it is deliberately absent from `PURPOSE_VERSIONS`, so
  a member who has not re-accepted yet still has their key used. MonChoon confirmed with
  members that their keys may be used to extract attack information and told them in the
  faction's communications; the re-prompt exists so the written terms match what they were
  told. A gate would have left the archive short of keys during the busiest event of the
  year while re-acceptances trickled in. **Probed:** adding the gate fails a test.
  ⚠️ The row deliberately does not say "your key is skipped if you do not accept", as the
  Target Lookups row does — that would be untrue here.

## [3.221.0] - 2026-10-17

### Fixed
- ⚠️ **The Torn API client could hang for five minutes and had no idea Torn was down**
  (#963). Torn's API is down for hours every Halloween, and the event starts 25 October.
  `tornClient.fetch` had no timeout, no retry, no backoff and no HTTP status check, and
  called `res.json()` unconditionally.
  - **Every request times out** (15s default). Node's own default is five minutes for
    headers; on forge's two-minute attacks-sync that stacked overlapping runs during an
    outage, each holding a pooled key.
  - **Genuine blips are retried** with capped exponential backoff and full jitter:
    timeouts, dropped connections, 5xx, 429, non-JSON bodies and Torn code 17. ⚠️ Jitter
    because five tenants reach Torn from one box and would otherwise all retry in the
    same second when it comes back. ⚠️ Every retry passes through the rate limiter, so an
    outage cannot push a key past Torn's per-key rate the moment Torn recovers.
  - ⚠️ **Rate limits (5, 8) are never retried** — hitting one again a second later is how
    a soft limit becomes a longer one. **"API disabled" (9) is not retried** either: it
    lasts minutes to hours, so a retry seconds later only spends budget.
  - **Cloudflare and HTML responses raise `TornUnavailableError`**, never a JSON
    SyntaxError. Observed for real during research: `HTTP 403 error code: 1010`. The old
    client reported every outage as `Unexpected token '<'`, which reads as a bug in our
    own code. ⚠️ A 403 is not retried — the same request with the same signature cannot
    succeed.
  - The War Room ticker opts out of retries with an 8s timeout: it polls every second,
    so the next tick is the retry.
- ⚠️ **The scheduler could run two copies of one job at once** (#963). Nothing stopped a
  tick firing while the previous run of the same job was still in flight. It now skips
  that tick, per job. ⚠️ The guard is released in `finally` because of the early return
  for a DISABLED job — without it, switching a job off and on would skip it for the life
  of the process. My first test for this guarded nothing (it relied on a job throwing,
  but `withRun` never throws); a probe caught it and the test now exercises the real
  path.

### Changed
- **Torn's "try again later" codes are named constants** — `TORN_RATE_LIMIT_CODES`
  (5, 8: a routine soft stop) and `TORN_UNAVAILABLE_CODES` (9, 17: an outage, which should
  fail visibly). Four files spelled `[5, 8]` and `auth.ts` spelled `[5, 8, 9, 17]`, with
  nothing saying which concept each was. ⚠️ They are deliberately different: a run during
  an outage should be recorded as a FAILURE, not converted into a quiet success — the
  "not measured reads as healthy" trap. attacks-sync keeps its partial progress either way.

## [3.220.0] - 2026-10-11

### Fixed
- ⚠️ **Membership notes carry WHEN the event happened** (#942). The payload held only the
  name and the stint id, so the bot could date a join or a leave only by when the sweep
  queued it — the sweep's five-minute cadence at best, and arbitrarily late after a
  restart. A permanent log entry dated by when we noticed is not the same claim as one
  dated by when it happened.
  ⚠️ Found while chasing a worse bug on the bot side: **every `joined` and `left` note had
  been failing on every tick since #942 shipped**, because the drain was written for
  #943's war reports and refused any entry without a `war_id`. The dashboard queued three
  kinds and the bot handled one, and nothing anywhere compared the two lists. Nobody
  noticed until a new member joined forge and his thread never appeared.

## [3.219.0] - 2026-10-11

### Added
- **The member report carries the war's TYPE** (#943). `war_room_notes_v2.war_type` — the
  setting the leads actually pick — which is `real`, `termed` or `race`. MonChoon wants the
  header to read `MonChoon_616 — Romania Elite Kommando (Real)`.
  ⚠️ **Not the `is_termed` boolean**, which cannot express `race` at all and is a separate
  hand toggle on RW History.
  ⚠️ **Null when nobody set one, and null is NOT "real".** Three of forge's eleven wars
  have no War Room note; labelling those "(Real)" asserts a choice nobody made. `is_termed`
  only ever promotes to `termed` — ticking "Set Termed" is a positive signal worth
  honouring, while the untoggled default is just a default. **Probed:** promoting to
  `real` fails 3 tests.
  ⚠️ An unrecognised value becomes null rather than passing through: the column has no
  CHECK constraint, and a typo reaching a permanent per-member record as a war type is
  worse than saying nothing.

## [3.218.0] - 2026-10-11

### Fixed
- ⚠️ **A third faction reached Discord as `faction 21716`** while the War Overview page
  beside it showed the name — the same war, two answers. The page builds its lookup from
  `attacker_faction_name` / `defender_faction_name` on the attack rows;
  `warOverviewInternal` built a smaller one from the opponent plus revivers, and
  `memberWarReport` copied that smaller one. Neither endpoint even SELECTed the name
  columns.
  One resolver now serves both — `warOverview/factionNames.ts` — because there were
  nearly four. ⚠️ Three sources in order of trust: the row's own name (contemporaneous,
  which is what a post-mortem wants), the `factions` table that `factions-sync` maintains
  for exactly this, and the opponent from `ranked_wars` last so a stray spelling cannot
  override the name the war was fought under.
  ⚠️ **Faction 0 is never named** — it is "no faction", a real filterable id with six
  figures of rows behind it on the live box. **Probed:** naming it fails a test; dropping
  the attack rows fails 3; dropping the table backfill fails 1.
  ⚠️ An id with no name anywhere is **absent**, not guessed — the caller renders
  `faction <id>`, which is honest.

## [3.217.0] - 2026-10-11

### Fixed
- ⚠️ **A real zero was published as "not recorded"** (#943). `scoreMemberWar` returned
  null whenever a member had no scoring hits, so somebody who genuinely scored nothing
  appeared as *"Score · not recorded"*. MonChoon: *"if they had a 0, we should just show 0,
  not recorded makes it seem like a weird data loss issue."* He is right — it reads as a
  broken scraper rather than a quiet war.
  The discriminator is the **ledger**, not the member: no attack rows for the window means
  we can say nothing about anybody; rows present and this member absent from them means
  they scored nothing. The war wrap-up already refuses to queue until attacks have landed,
  so by the time a report posts the ledger is known complete. **Probed:** 3 tests.

## [3.216.0] - 2026-10-11

### Fixed
- ⚠️ **The member report published two facts as their opposites** (#943). The payload
  returned raw `war_room_roll_call_v2` and `war_stacks_snapshot` rows; the bot's formatter
  reads `responded` and `energy`. So a member who HAD answered the roll call — `on_at_start`
  true, `availability` `on_time`, sitting in the database — was published in his own
  permanent thread as *"no answer recorded"*, and 965 energy as *"0 energy"*.
  ⚠️ **Every test passed.** The formatter's 23 exercise a mock whose shape was invented
  before this endpoint existed, and nothing asserted that what the dashboard sends matches
  what the bot reads. Two keys drifted and the suites on both sides stayed green.
  The payload is now a stated contract (`MemberRollCall`, `MemberStacks`) rather than
  whatever the columns happen to be called, with `responded`, `energy`, `overdosed` and a
  derived `first_action_offset_sec`. New tests assert every key the formatter reads is
  present **and** that raw column names are absent. **Probed:** restoring the raw rows
  fails 6 tests.
  ⚠️ **`energy` is null when `has_reading` is false**, never 0. The column exists precisely
  because a blank energy cell reads as zero in a spreadsheet; sending 0 reproduced that
  error in a permanent per-member record. **Probed:** 1 test.

### Added
- **The member report carries its own chart** (#943). Binned attack/revive series, member-
  scoped, from the same `warOverview/series.ts` the page and `/rw overview` use — a second
  implementation of "which bin does this attack fall in" is what that module exists to
  prevent. MonChoon: *"I also want the graphs to be shown so I can see the incoming/outgoing
  attacks and revives over time in their bins."*

## [3.215.0] - 2026-10-11

### Added
- **War wrap-up: collect everything, verify it, then queue the roster** (#945, fourth
  slice of PRD #941). A `war-wrap-up` job runs every ten minutes, finds wars that have
  ended and are not finished, drives the final scrapes, confirms every source is actually
  present, and only then queues every current member's report.
  ⚠️ **It DRIVES the existing jobs rather than re-implementing them** — `attacks-sync`,
  `revives-sync`, `wars-sync` and `dibs-summary`, through the scheduler's own `runNow`, so
  each appears in Global Admin's Recent Runs. Calling the job functions directly would
  work and would be invisible, which is the worse kind of working.
  ⚠️ **Sequenced, not parallel.** `dibs-summary` classifies a claim by finding the attack
  that explains it, so running it before the final attack scrape records real conversions
  as "no swing" — permanently, in threads with members' names on them. **Probed:** moving
  it first fails a test.
  ⚠️ **Every CURRENT member is queued, participants and non-participants alike, termed
  wars included.** MonChoon: *"on a termed war most people do participate… if no one
  particiapted thats even more important, since it will determine whether we keep them or
  kick them."* A zero row is a keep/kick input, not padding. **Probed:** including former
  members fails 4 tests.
  ⚠️ **Nothing is queued until every source is confirmed.** Missing contributions inside
  the window retry; at the end of it the war **fails loudly and queues nothing**. MonChoon:
  *"I don't want jt to post scoreless reports because the wrap up never completed it should
  just fail loudly."*
  ⚠️ **`report_unavailable` fails IMMEDIATELY**, before the window is consulted. Torn is
  saying *never*, not *not yet*, and burning two hours of retries only delays the message
  to the human who has to decide what to do.
  ⚠️ **Attacks are checked separately from contributions.** Contributions come from Torn's
  war report; the scores in a member's thread come from our own ledger. A war with one and
  not the other would render every score as absent while the payout sheet showed figures —
  two sources disagreeing in public.
  ⚠️ **Dibs blocks only when the job is ENABLED.** It is off on four of five tenants, so
  blocking on it would mean the wrap-up never completes there; the report endpoint already
  reports `state: disabled` and the formatter omits the line.
  ⚠️ **The retry clock runs from FIRST SIGHT**, persisted in `war_wrap_up_state.first_seen_at`.
  Measured from the current run it would read zero on every pass and the window would never
  expire — a war waiting for ever with nobody told. **Probed:** 3 tests fail.
  ⚠️ **Re-runnable without double-queuing.** The roster insert is `DO NOTHING`, deliberately
  NOT the admin route's `DO UPDATE`: that one re-opens a posted entry because asking for one
  member's report again means "correct it", whereas a wrap-up re-run means "finish what you
  could not finish" — and re-opening there would re-post the whole roster. **Probed:** 1 test.
  The retry window is a **stated tunable** (`faction_settings.war_wrap_up.retry_window_minutes`,
  default 120), floored at a minute and capped at a week — zero would fail every war
  instantly and unbounded would reinstate the silent wait.
  ⚠️ **NO BACKFILL — the first run stamps a watermark and queues nothing.** Caught before
  this shipped: without it, switching the job on finds every war ever fought with no state
  row and wraps up the three most recent. On forge that is **~282 permanent messages**
  across `Romania Elite Kommando`, `Sport Club` and `Damage Inc`, and with two tenants
  enabled roughly 560 — none of them asked for, none of them unpostable. Exactly the
  lesson #942's watermark already taught. **Probed:** removing the gate fails all 19 tests.

- **Wrap up one named war on demand** (#945). `POST /api/admin/war-wrap-up { war_id }`,
  admin-guarded, which puts that war into `waiting` and runs the job at once.
  ⚠️ **This is the only way to wrap up a war that ended before the job was enabled**, and
  it is deliberately by id with no "latest" shorthand — it queues the whole roster.
  ⚠️ The mechanism is the same one a retry uses: a `waiting` state row IS the request, and
  `warsNeedingWrapUp` admits it regardless of the watermark. No second code path to keep
  in step. **Probed:** gating explicit rows by the watermark too fails 2 tests.
  ⚠️ It resets `first_seen_at`, restarting the retry window. Without that a war whose row
  is hours old fails on the first pass and the operator sees `failed` having had no retry.

## [3.214.0] - 2026-10-11

### Fixed
- ⚠️ **A correction could never be issued** (#943). `POST /api/admin/member-threads/war-report`
  used `ON CONFLICT DO NOTHING`, so once an entry had been posted nothing would ever pick
  it up again — the "edit on re-run" behaviour the whole subject-is-the-war design exists
  for could not fire at all. A re-queue now **re-opens** the entry (clearing `posted_at`,
  `claimed_at`, `attempts` and `last_error`) while **keeping `message_id`**, which is what
  turns the re-run into an edit of the existing post rather than a second embed in the
  member's thread. MonChoon: *"on a re-run for the same war I would edit the post. on a
  new war I would append."*
  The response now says which it did — `requeued` and `editing_message_id` — because an
  operator issuing a correction wants to see it is going to land on the existing message.
- ⚠️ **`claim` did not return `message_id`**, so the bot had no way to tell a correction
  from a first post and would have appended a second embed for the same war. The column
  is now selected and asserted.
  ⚠️ My own test had hidden both of these: it asserted "queueing twice makes one row",
  which was true and useless — one row that nothing will ever drain again. The test now
  posts the entry first and asserts it is re-opened with its message id intact.

## [3.213.0] - 2026-10-11

### Added
- **One member's post-war report, the data half** (#943, second slice of PRD #941).
  `GET /api/internal/member-threads/report?war=&member=` returns everything one
  member's report needs for one finished war: their score, the outgoing/incoming/revive
  summary, their dibs record, their roll-call answer and their pre-war stacks snapshot.
  ⚠️ **One endpoint carrying all five, not the bot calling five routes.** The bot reaches
  a dashboard through bearer-token internal routes only; roll call, dibs and contributions
  are session-authed and unreachable to it. Assembling here also keeps the decision about
  *what belongs in a member report* on the side where the data lives — the bot renders, it
  does not select.
  ⚠️ **400 on a live or unknown war, never a partial report.** A scoreless report in a
  permanent record cannot be unposted. MonChoon: *"I don't want it to post scoreless
  reports because the wrap up never completed, it should just fail loudly."*
  ⚠️ **A GET that claims nothing.** The mailbox entry is what gets claimed; this is just
  the data, so a failed render can be retried without waiting out the ten-minute claim.

- **Both score figures from our own attack ledger** (#943). `scoreMemberWar` returns
  `raw`, `normalised` and `bonus_reduction` — the normalised figure capping bonus-chain
  hits at 10, the basis every payout this faction has run.
  ⚠️ **Never one figure from Torn and the other from us.** The two sources drift, and the
  *difference* between them is the whole point of printing both: it is what the member
  lost to bonus caps. A pair taken from two sources has a meaningless difference.
  ⚠️ `war-member-score-parity.test.ts` runs the server and the payout sheet over one
  fixture and fails when they disagree — the only thing that makes a fourth copy of "what
  counts as a hit" survivable, since the bot cannot run browser JS. **Probed** three ways:
  dropping a chain from the bonus set fails 4 tests, admitting `Special` fails 3, and
  `Math.min`→`Math.max` fails 5.

- **Queue one report** (#943). `POST /api/admin/member-threads/war-report`, admin-guarded
  because what it queues is a permanent named performance record in a channel leadership
  reads. Idempotent on `(member_id, war_report, war:<id>)`, so a re-run is the same entry
  and the bot edits the message it already recorded rather than posting twice.

### Changed
- ⚠️ **Dibs has THREE states, not two** (#943). MonChoon, 2026-10-11: *"If dibs summary is
  disabled we can ship the war reports without it rather than wait. If it's enabled and
  the war wrap up has finished then we would know any member without a dibs summary row
  had no history in there."*
  A missing `war_dibs_summary` row could mean "claimed nothing", "not computed yet" or
  "this tenant does not run the job" — and those lead to **opposite** actions, so a bare
  `null` was not good enough:
  - `disabled` → ship the report now; the formatter omits the line entirely, because the
    absence says nothing about the member.
  - `pending` → the wrap-up is unfinished; "not counted yet".
  - `measured` → a missing row is a genuine zero, "no claims".
  ⚠️ **`disabled` is tested before `pending`**, because a tenant that does not run the job
  also has no state row — checking the state row first would report those wars as
  `pending` for ever, and a wrap-up gated on `pending` would never complete. **Probed:**
  swapping the two guards fails 2 tests.
  ⚠️ The difference is live, not hypothetical: `dibs-summary` is enabled on **one of five**
  tenants, so on the other four every member's missing row means "we never measured".
  `counts` is the only place in the payload a zero is legitimate.

## [3.212.0] - 2026-10-11

### Added
- **Member threads: the dashboard half** (#942, first slice of PRD #941). A registry
  of one Discord forum thread per member, plus the outbox Choonbot drains — a note
  when somebody joins the faction, another when they leave.
  ⚠️ **The bot POLLS this; the dashboard never calls the bot.** Chain Watch already
  works that way across five factions, and the bot is a Discord gateway client with
  no inbound HTTP server at all — pushing would mean a web server, an exposed port, a
  new token scope and dashboard-side handling of the bot being down. MonChoon:
  *"basically a mailbox from the dashboard that there are updates waiting to be
  posted."*
  ⚠️ **The first sweep queues NOTHING.** It records the moment this faction started
  being watched and stops. The roster sitting there is ~94 people whose real join
  dates nobody recorded — stints are only observed from #284 — so queuing them would
  write invented dates into permanent records and create 94 threads in one burst.
  Probed: removing the watermark fails three tests.
  ⚠️ **A fixed watermark, not an advancing one.** An advancing watermark has a race —
  a stint written between the read and the advance is skipped for ever — and the
  unique index on `(member_id, kind, subject)` already gives idempotency, so the
  advance buys nothing.
  ⚠️ **Keyed on the STINT, not the member.** A rejoin is a second stint for the same
  person and must produce a second note in the same thread; keying on the member
  swallows it as a duplicate and the log never shows they came back. Probed: it fails
  a test.
  ⚠️ **A leave is logged even when the join was not** — somebody who was here before
  we started watching still really left. It is the one place "no backfill" and "log
  what happens" disagree, and the observed event wins.
  ⚠️ Claims are a timestamp rather than a flag, so a crashed drain's rows can be
  reclaimed after a timeout instead of being stranded for ever — the quietest possible
  failure for a feature whose entire job is keeping a record.
  ⚠️ Its own token scope (`MEMBER_THREADS_TOKEN` = `HMAC(FLEET_METRICS_SECRET,
  "member-threads:<slug>")`), like the War Overview's: the same bot holds several, and
  keeping them apart stops a leak of one surrendering the rest. ⚠️ **This is the only
  one of the bot's three that grants WRITES** — its holder marks outbox rows posted
  against a permanent per-member record — so it is the most sensitive of them, not
  merely the newest.
  ⚠️ **The forum channel is NOT stored here.** It is the bot's setting, editable from
  Discord per tenant exactly like Chain Watch's board and ping channels.
  `chain_settings` draws that line in its own header: what the bot owns is *how it
  talks* — *"which channel things land in"* — while the dashboard owns facts about
  the faction. My first version kept a copy in `faction_settings`, which is precisely
  the "two places authoritative for one number" that note warns about, and the one
  that drifts is always the one nobody is looking at.

- **Somewhere to actually get that token from** (#942). The env var was wired but
  nothing issued it, which made the slice undeployable — `node
  db/member-threads-token.mjs [slug] [--write]`, the same three forms the other three
  tokens take, plus `MEMBER_THREADS_TOKEN` registered in the override rewriter, which
  **fails closed** on a variable it has no comment for.
  ⚠️ **The bot does not need it pasted at all.** `GET /api/internal/tenants?tokens=1`
  now derives and returns `member_threads_token` beside the other two, so a faction
  provisioned after the bot last restarted is reachable the moment its database
  exists — the thing that made `/chain tenant add` a retyping exercise that drifted.
  ⚠️ A test holds the scope string in `tenantRegistry.ts` against the module the CLI
  issues from, byte for byte. A drifted scope is a 401 with no hint which side is
  wrong, and another asserts all three tokens differ.
  New runbook `docs/runbooks/bot-tokens.md` tabulates the four tokens, what each
  reads, which one writes, and that ⚠️ `claim` is not a read — curling it against
  production hides the pending rows from the bot for ten minutes.

### Fixed
- ⚠️ **The queue ordered every join before every leave, which writes a false log.**
  For a rejoin — a leave from an old stint and a join from a new one in one batch —
  that produced *"joined · joined · left"* when what happened was join → leave → join.
  Now ordered by when each event actually occurred.
  ⚠️ **A unit test had enshrined the wrong rule**, and an integration test against
  real rows is what caught it. The unit test now asserts the chronological order and
  says why it used to say the opposite. Probed: restoring joins-first fails two.

### Internal
- Migration **0076** — `member_threads` and `member_thread_outbox`, additive, mirrored
  into the template and verified by the parity guard.
- `member-thread-sweep` runs every five minutes and costs **zero Torn API calls**.
- ⚠️ Timestamps compare at millisecond resolution and a collision with the watermark
  reads as pre-existing: under-report by at most one event in a window nothing real
  occupies, rather than invent a join date for somebody already on the roster.
- 13 unit tests on the planner, 14 against real Postgres for the mailbox.

## [3.211.0] - 2026-10-10

### Added
- **Three new userscript settings — Dibs, Assist overlay and Loadout capture — so a
  member can run only the parts they want** (#934). Requested by Pickles_616 via
  in-app feedback: *"could you release a 'lite' version of the script that does the
  loadout scraping without the rest of the war page modifications?"*
  ⚠️ **That was impossible before this.** All eight existing settings gated a
  DECORATION on the war roster — battle stats, the FF box, the status cell, tinting,
  the member count, the chain badge, the hospital toast. **None gated a feature.** A
  member could switch every checkbox off and still have dibs, the assist overlay and
  the loadout scraper running, so the request could not be met by configuration.
  ⚠️ **All three default ON.** A new setting defaulting off would silently take dibs
  away from the whole faction on the next script update, which reads as an outage
  rather than a preference. Probed: flipping the defaults fails a test.
  ⚠️ **No separate "lite" script.** A second file means a second update URL and a
  second copy of the capture logic to keep in step — and the capture is the delicate
  part. A **"Loadout capture only"** preset does the same job in one click and cannot
  drift.

### Changed
- **The settings panel is grouped by the page each setting acts on** — *Faction / war
  page* and *Attack page* — with `All` / `None` per group and for everything.
  ⚠️ Grouped by WHERE rather than by what: the request was a question about pages,
  and a member deciding what to run is asking the same thing. Probed: moving loadout
  capture out of the attack-page group fails two tests, because that grouping *is*
  the answer to the issue.
- ⚠️ **"Hide" is now a minimise glyph in the panel's top-right corner.** MonChoon:
  *"there was already confusion when opening the mini-page with what function the
  'hide' button does"* — and the reason is placement: it was a full-width button
  sharing a flex row with **Sign out**, so it read as something that hides *you*
  rather than the box. A minimise glyph in the corner is the convention every window
  on the screen already uses, and "Sign out" now has its row to itself. Padded to a
  real tap target rather than sized to the glyph, because the panel gets used on
  phones.
- Userscript `@version` **1.54.1**.

### Fixed before release
- ⚠️ **The minimise button never appeared on desktop.** It was inserted directly
  after `title.appendChild(tag)` — which sits inside `if (transport !== 'GM')`. On a
  Tampermonkey desktop install `transport === 'GM'`, so the branch never runs and the
  button was never created; it would have shown only on a phone or a browser with no
  GM bridge, the exact opposite of the common case. Caught by MonChoon from a
  screenshot before this shipped.
  ⚠️ The title bar has **two** optional branches — `if (version)` and the transport
  one — and landing in either is the same bug. My first regression guard checked only
  the transport branch, and a probe that reintroduced the fault in the version branch
  walked straight past it. The guard now checks both, plus the indentation, which is
  what actually separates "runs always" from "runs sometimes".

### Fixed
- ⚠️ **The repaint cache key now includes the feature toggles.** `settingsSignature()`
  is what `paintSignature` uses to decide whether anything affecting the paint has
  changed, and it covered only three of the settings. A toggle missing from it flips
  the setting and leaves every badge on screen exactly as it was until some unrelated
  change happens to bust the signature. Probed: omitting them fails a test.
- ⚠️ Switching Dibs off now **removes** any badge already painted, rather than merely
  skipping the next paint — otherwise the last badge sits there, still clickable, for
  a feature the member just turned off.

### Notes
- ⚠️ One coupling worth knowing: the roster's dibs cell carries the assist markers
  too, and `mode: 'assist'` wins over the dibs control. So turning **Dibs** off also
  hides those markers on the roster rows. The attack-page overlay is unaffected and
  has its own switch; the toggle's help text says so.
- ⚠️ Turning **Loadout capture** off stops feeding the War Room's gear shields. The
  help text says that out loud, because it is a choice with a consequence for other
  people rather than only for the member making it.

## [3.210.0] - 2026-10-09

### Added
- **A green target — Okay AND online — is outside the dibs system, and hitting one
  is no longer recorded as a steal** (#935). MonChoon: *"Whenever a player is online
  and okay they are fair game and not beholden to the farming/dibs system… We dont
  want them to try flying away or making them unavailable in anyway, so its
  encouraged to hit them ASAP."*
  ⚠️ **Claim-time status alone cannot answer this, and the first design was wrong
  because of it.** The sequence that actually happens: target in hospital and
  OFFLINE → somebody claims them, a real reservation → target logs in, still in
  hospital → they surface Okay and online → a teammate hits them. At claim time they
  were Hospital + Offline, so a claim-time-only rule calls that hit a steal — the
  exact dispute this exists to settle. Probed: restricting the rule to claim time
  fails nine tests.
  ⚠️ So the condition is recorded at **two** moments: `claim_state`/`claim_online` at
  the insert, and `surfaced_online`/`surfaced_at` when the dibs sweep observes the
  target leaving hospital — which it already detects within about a second to arm the
  #106 countdown.
  ⚠️ **The hitter is cleared on BOTH axes.** Not `taken_from` for the holder and not
  `took_from_others` for the teammate — that second column is the accusation, and
  clearing the victim while still charging the hitter would be the worst of both.
  Probed: dropping the gate fails two tests.
  ⚠️ **Claims predating this keep behaving exactly as before.** An unobserved claim
  can still be stolen, so promoting this does not retroactively clear a month of
  recorded steals. Probed: defaulting the unknown case to green fails twenty-six.
  ⚠️ A green claim the holder did not convert is **blameless** — bucketed as
  `green-means-go` rather than `no-swing`, because there was no reservation to follow
  through on. MonChoon: *"we really dont care too much about the person that claimed
  it."* A conversion still counts as a conversion.
  ⚠️ **`Idle` is not green** — Torn gives Online / Idle / Offline, and this is a
  stated tunable (`GREEN_ONLINE_STATES`) defaulting to Online alone. MonChoon's call;
  including Idle would widen the free-for-all by 8 of 190 on the live roster.
  ⚠️ The surfacing is stamped **once**. Farm mode cycles hospital → out → hit →
  hospital, and a later offline surfacing must not erase an earlier online one — that
  fact is what clears the teammate.

- **A `Green` column on the War Overview dibs table**, with `explainGreen()` behind
  it producing the sentence a lead can actually argue with: *"Target came out of
  hospital at 14:32:07 while online — green, so the claim no longer applied."*
  MonChoon: *"sometimes members claim 'my dibs was taken' or 'someone stole my kill'
  and we need to justify it that they were online."*
  ⚠️ Its **own** column rather than folded into `Other`, even though that keeps the
  table at ten. Buried in `Other` it settles no argument, and settling that argument
  is why the data is collected.

### Changed
- `DIBS_SUMMARY_VERSION` 1 → 2, so **every already-summarised war recomputes**. Wars
  counted under rule 1 contain steals this rule says never happened, and leaving them
  would keep an accusation standing.
- ⚠️ The job's version assertion now reads the exported constant instead of a literal
  `1`. A test pinning the number has to be edited on every rule change, which trains
  whoever edits it to stop reading why.

### Internal
- Migration **0075** — four columns on `war_room_dibs_v2` plus `green_means_go` on
  `war_dibs_summary`. Additive, `ADD COLUMN IF NOT EXISTS`, mirrored into the template
  and verified by the parity guard.
- 19 tests on the rule, 8 on the classifier, 6 against real Postgres for the sweep
  stamp, 4 on the column. Three probes run and reverted.

## [3.209.0] - 2026-10-09

### Fixed
- ⚠️ **The bonus percentage rule was anchored to the start of the description, and
  that lost the four specials that matter most.** Checked against the **1,301 real
  forge captures** rather than reasoned about: Eviscerate, Penetrate, Bloodlust and
  Execute all state their magnitude mid-sentence, so all four rendered as bare titles.

  | Description (real, with production frequency) | Before | Now |
  |---|---|---|
  | `Eviscerates opponent causing them 15% extra damage…` ×75 | — | **15%** |
  | `Ignores 26% of armor mitigation` ×32 | — | **26%** |
  | `Life regenerated by 10% of damage dealt` ×17 | — | **10%** |
  | `Instantly defeats a target if they're below 15% life` ×16 | — | **15%** |

  The rule is now **the first non-negative percentage anywhere in the description**.
  ⚠️ **Negative ones are skipped because they are penalties, not the bonus** — which
  is the whole reason it is not simply "the first percentage". `+1.75 Accuracy -30%
  Dexterity` (×45) and `+4 stealth, -5% damage` (×14) both lead with a cost, and
  reporting 30% there would advertise a drawback as a benefit.
  ⚠️ Still the FIRST, not the largest: `37% chance to Burn … causing 90% damage` is a
  37% proc, and 90% is what it does once it lands.

- ⚠️ **Percentages now show on the month of observations captured before the field
  existed.** The display derives the figure from the stored `description` when a
  capture carries no `percent` — every one of the 1,301 forge observations, since
  that field only arrives with userscript 1.52.0. Without it the War Room showed bare
  titles for data already in the database until every member updated their script.
  A recorded `percent` still wins where present: it is what the capture observed, and
  stays the historical record if Torn ever rewords a description.

  ⚠️ **A probe caught this going out untested.** Removing the fallback broke no test
  at first — the feature the whole change was for had no coverage. It now fails four.

### Internal
- `bonusPercentFromDescription` is exported from `warRoomLoadout.js` and **mirrored**
  in the userscript, which cannot import — it is a single file injected into Torn.
  `bonusPercentParity.test.js` asserts the two agree across **every description shape
  seen in production**, with the real occurrence counts in the fixture so the
  negative-percentage cases cannot be mistaken for edge cases. Probed both ways:
  diverging either implementation fails five.
- ⚠️ One prior assertion was **inverted**: `ignores a percentage that is not at the
  start` encoded the bug. Replaced with the two cases that actually matter —
  mid-string positives are taken, negatives are not.
- Userscript `@version` 1.53.0.

## [3.208.0] - 2026-10-09

### Added
- **Weapon bonuses now appear in the War Room** (#929). Each weapon in the loadout
  shield lists its bonuses underneath it, comma-delimited with the percentage Torn
  leads the description with — `Focus 16%, 30mW Laser 4%, Reflex Sight`.
  ⚠️ **The data had been captured correctly for a month with nothing showing it.**
  #616 (3.93.0) built `formatLoadoutTooltip`, `rankedLoadoutEntries`,
  `isNotableWeapon` and `usesNeedles`, unit-tested them, and **never imported any of
  them from a component**. `git log -p` on `LoadoutShieldIcon.jsx` confirms it had
  never referenced a bonus in any revision, so that changelog's "Display: notable
  weapons first" line described helpers rather than a display. Found by MonChoon
  looking at the War Room and seeing no specials anywhere.
  ⚠️ **A bonus with no percentage renders as its bare title.** Disarm carries no
  figure at all and attachments are frequently flat values (`+1.00 Accuracy`), so
  appending one unconditionally prints `Disarm undefined%` on a real capture —
  probed, and it fails three tests. Absent is never shown as `0%`, which would read
  as useless rather than unmeasured.
  ⚠️ **Specials and attachments stay mixed**, because Torn's DOM does not distinguish
  them — Burn and Reflex Sight are identical markup with identical attributes. The
  only discriminator is which side of the slot's `topMarker` they sit on, which the
  capture does not record. MonChoon saw the mixed list and approved it.
  ⚠️ The bonuses render on their **own row** under the weapon, not appended to the
  name cell: a special belongs to that specific item instance, and on one line the
  two run together while a long list shoves the right-aligned names out of column.

### Changed
- **Damage, accuracy and the bonus percentage are now captured** — recorded, not
  displayed. MonChoon: *"I would still record dmg/acc in case we ever decide to
  display it"*. Carried through `loadoutEntries` so surfacing them later is a
  one-line change rather than a re-plumb, and asserted NOT to appear in the panel.
  ⚠️ **Read positionally, never by id.** Torn ships a duplicate id: the `<i>` icon and
  the value `<span>` both use `accuracy_defender_primary`, so `getElementById`
  returns the empty icon and records nothing. Damage uses distinct ids and works,
  which is exactly what makes accuracy the one that fails silently — probed by
  switching to the id-based read, which fails five tests.
  ⚠️ These are **per item instance, not per item type**: Torn has already folded in
  the attachments and the quality tier, so two players carrying the same rifle do not
  report the same damage. Stored unrounded for that reason.
  ⚠️ The percentage is **not a proc chance** despite looking like one — a chance on
  `37% chance to Burn`, a magnitude on `84% increased Heart damage`. The full
  description is kept beside it rather than replaced by it. Anchored to the start of
  the string, because `37% chance to Burn … causing 90% damage` holds two.
- ⚠️ `LOADOUT_MAX_BYTES` 4,000 → 8,000, **measured rather than estimated**. The old
  comment claimed a capture was "a few hundred bytes"; a realistic nine-slot capture
  with every new field is **1,176**. It stays deliberately below what the per-field
  limits allow (~12,600 at the extremes): per-field limits describe one honest value,
  the ceiling describes an honest capture, and only a modified script satisfies the
  first and not the second.

### Internal
- Userscript `@version` 1.52.0. Both new helpers exported for test.
- Verified by replaying MonChoon's two real DOM captures (2026-10-09) through the
  shipped capture functions: 7 bonuses, both quality tokens, damage 57–77, accuracy
  42–74, the two-bonus Macana, and a populated vs empty temporary slot.

## [3.207.0] - 2026-10-09

### Fixed
- ⚠️ **A role change did not reach the UI until the member logged out and back in**
  (#927). Found by MonChoon after granting `warlead` and watching the War Room's notes
  clipboard stay hidden.
  The refresh machinery was never the problem: `/api/auth/refresh` already re-reads
  `role_assignments` and mints a token with fresh claims, and the client already calls
  it on every page load and every four hours on an open tab. So the **server** honoured
  the new role immediately.
  ⚠️ **But every permission gate reads the cached `user` object, not the token** —
  `user.isWarLead` and the rest — and `localStorage.setItem('tornUser', …)` happened in
  exactly one place: inside `login()`. The refresh swapped the token and nothing
  re-read bootstrap afterwards, so the API allowed the role while the UI kept hiding
  the controls for it. A successful refresh now adopts the server's view.
  ⚠️ **The revocation direction was worse.** Removing a role left the controls visible
  indefinitely; the server correctly 403'd, so nothing unauthorised happened, but the
  member saw buttons that failed — which reads as the app being broken rather than as
  access having changed.
  Landing: **immediate on page load, within four hours on an open tab**. No prompt and
  no re-login, because a banner would ask somebody to do what the app can do itself.

### Internal
- `frontend/src/utils/sessionUser.js` — `buildUserFromBootstrap` is now **shared**
  between login and the refresh. ⚠️ It was inline in `login()`; two copies of that
  shape would drift, and the symptom of a drift is a permission that works on one path
  and not the other.
- ⚠️ `lastLogin` is **carried, not restamped**. The refresh runs on a timer, so
  rebuilding it would redate a session nobody has logged into — and since it differs on
  every rebuild, counting it would make the change-detector fire forever. It is
  excluded from `SESSION_SYNC_FIELDS` and asserted both ways.
- ⚠️ The comparison is deliberately **wider than the roles**. `consentRequired` has the
  identical staleness bug: bumping the API Key Usage disclosure would not re-prompt a
  member with a tab open until their next login, which defeats the point of forcing a
  re-acceptance. Same mechanism, so it would be strange to leave it broken.
- ⚠️ The keepalive reads the current user through a **ref**. Keyed on the user object it
  would push the next check four hours out on every change; closing over a stale user it
  would compare against a value it had already replaced and rewrite an identical object
  every four hours forever. I wrote the second version first and caught it in review.
- 17 tests on the pure module, 7 on the context (its first). Probed: restoring the
  original bug fails five of the seven, and restamping `lastLogin` fails one.

## [3.206.0] - 2026-10-07

### Removed
- **The deprecated `visitor` role is gone** (#922). A read-only outsider profile for
  leaders of the other TNL family factions, superseded by per-faction
  `role_assignments`, and by the end a term every newly gated surface had to reason
  about ("is it acceptable for a visitor to see this?") for a role **nobody held**.
  Confirmed empty across all six databases before anything was deleted — ascension,
  capacityx, forge, forge_dev, mayhem, tnl.
  ⚠️ **`requireNotVisitor()` did two jobs**: it 403'd visitors AND it 401'd anonymous
  callers. On **eight routes it was the only `preHandler`**, so deleting it would have
  removed the authentication with it and published those endpoints. Each was converted
  to `requireAuth()`, and the authz matrix now asserts all eight by path — probed by
  stripping the guard, which answers 500 instead of 401 and fails the test.
  ⚠️ **Four read allow-lists narrowed** (`requireRole(..., 'visitor')` on the
  leadership overview reads, the OC planner, war-room history and the private war
  note). Two negative checks came out as redundant: both sat above a positive
  allow-list, so they only ever mattered for somebody holding `visitor` AND a real
  role, which the schema no longer permits.
  ⚠️ **Three login behaviours simplified**: key-pool enrollment now turns on faction
  membership alone, the auth cache no longer exempts anybody, and `is_visitor` is gone
  from the session token. `auth.test.ts` asserts the claim is **absent** rather than
  `false` — asserting `false` would quietly re-create the expectation that it exists.
  ⚠️ **Two routes widened in principle**: feedback and the grudge add had the visitor
  check as their only extra guard, so they are now open to any authenticated session.
  No practical change, since nobody held the role, but it is a real change and the
  tests that asserted otherwise were deleted rather than quietly adjusted.

### Changed
- Migration **0074** deletes any `visitor` assignment and narrows the
  `role_assignments` CHECK to the four real roles.
  ⚠️ **The DELETE runs first.** An assignment on a database nobody checked would make
  the narrowed constraint fail to apply, and one database failing aborts the deploy for
  every tenant — the 0070 outage shape. Probed: removing that line reproduces
  `check constraint "role_assignments_role_check" is violated by some row`.
  ⚠️ Idempotency comes from `DROP CONSTRAINT IF EXISTS` preceding the `ADD`, **not**
  from a catalogue guard. I wrote a `pg_constraint` lookup first, probed it, and found
  it never fires — so it came out. A dead guard is worse than none: it claims a hazard
  is handled somewhere other than where it actually is.
- `visitor` is no longer offered in the Settings role picker — a role nobody can be
  granted must not be selectable.

### Internal
- `db/test/migration-0074.test.mjs` — six cases, including a database that still holds
  a visitor assignment and a freshly provisioned one where the migration must no-op.
- Visitor actors in the test suites were **replaced with a plain member wherever the
  assertion was "this actor must be refused"**, so those refusals keep their value
  instead of being deleted. Where the premise was specifically "a read-only role may
  read but not write", the case was removed and the reason recorded in place.

## [3.205.0] - 2026-10-06

### Added
- **The dibs table on War Overview** (#530, slice 3 — the epic is now complete). Who
  called targets in a war, and what came of each claim: Claims, Converted, Tried, No
  swing, Taken from, Outside, Other, Took from others. Sortable, and served from the
  frozen summary — `GET /api/wars/:id/dibs-summary` reads, it never recomputes, so it
  cannot disagree with the stored row it came from.
  ⚠️ **"Not counted yet" and "nobody called anything" render differently**, because
  they are different facts. A war waits to be counted until its attacks have landed,
  and showing that as an empty table would tell a lead their faction ignored dibs in a
  war we simply have not finished counting. Probed — collapsing the two fails a test.
  ⚠️ **Every row adds up**: Claims = Converted + Tried + No swing + Taken from +
  Outside + Other, exactly. `Other` exists to carry the narrow buckets *including*
  `unknown` (claims from before 3.203.0 have no reason at all), because the first
  thing anybody does with a number about themselves is check the arithmetic.
  ⚠️ **`Outside` is visible and untoned**, not folded into a failure column. It is the
  target going down with no attack from our faction — another faction, or the target
  **self-hospitalising to dodge**, which is indistinguishable from a steal in the
  data. Neither reading is claimed.
  ⚠️ **`Took from others` is a different axis from `Taken from`, not its mirror.** One
  is losing a target, the other is finishing somebody else's; a member can lead both
  columns in one war, and the "who takes targets" question is the second.
  ⚠️ The grace window that produced the numbers is **shown with them**. Two wars
  counted under different windows are not comparable.
  ⚠️ The panel is war-level: deliberately NOT filtered by the faction checkboxes or
  the range slider, which narrow the plot above it. Re-filtering frozen numbers would
  make the table disagree with the row it was read from.

### Notes
- The panel sits behind War Overview's existing gate, which still includes the
  **deprecated `visitor` role** — acceptable only because nobody holds it. Filed as
  #922 to remove the role entirely: 15 server files, 24 frontend files and a
  `role_assignments` CHECK constraint. ⚠️ That issue records the two hazards, since
  neither is obvious: `requireNotVisitor()` is the read-only enforcement on many
  mutations, so a sweep that strips the `preHandler` rather than the role check would
  open those endpoints to everyone; and every tenant must be checked for live visitor
  assignments first.

## [3.204.0] - 2026-10-06

### Added
- **Per-war dibs summaries** (#530, slice 2 of 3). New `war_dibs_summary` and
  `war_dibs_summary_state`, filled by an hourly `dibs-summary` job for each war that
  has finished. No UI yet — slice 3 puts the table on War Overview.
  ⚠️ **It runs AFTER a war, never during.** `attacks-sync` runs every 30 minutes
  while the War Room's dibs sweep runs every second, so the attack row that explains
  a claim's death lands up to half an hour after the claim is gone. Live attribution
  is not available at this cadence, and chasing it would mean a far faster attack
  scrape during wars for a report nobody reads mid-fight.
  ⚠️ **Attacks outrank the release reason.** A successful conversion is recorded as
  `spent`, because the sweep frees a claim the moment the target stops being
  attackable and deliberately does not care who put them there. Reading the reason
  first would file every success under "target went down, nobody's doing" — probed,
  and it fails nine tests.
  ⚠️ **A war whose attacks have not landed WAITS.** Summarising early records real
  conversions as "no swing" against named members, and once the raw claims are
  pruned there is nothing left to correct it from. Coverage is read from the data
  (`max(started)` in `faction_attacks`) rather than from the run log, because an
  `attacks-sync` that hits a Torn rate limit mid-backlog **exits as a success**
  without having caught up.
  ⚠️ **"Stolen" is two columns, not one.** Taken *from* a holder and taken *by* an
  offender are different axes, a member can be on both sides in one war, and the
  top-offenders question needs the second. A taker who claimed nothing themselves
  still gets a row — otherwise the one member the report exists to surface is absent
  from it.
  ⚠️ **Blameless buckets stay separate.** `outside` (the target went down with no
  attack from us — another faction, or a self-hospitalisation to dodge) and
  `board-reset` are not failures to convert. `unknown` holds pre-0072 claims, which
  have no reason at all and must read as unexplained rather than fall through to a
  default.
  ⚠️ A steal needs the claim to have been live for `STEAL_GRACE_SECONDS` first — a
  stated tunable, not a hardcoded truth. Somebody who clicked attack in the same
  instant raced rather than stole, and an attack is matched on `started`, never
  `ended`: a fight already underway ends inside the window and would otherwise
  convict whoever was mid-attack.
  ⚠️ The grace window and a `summary_version` are stored **with** the numbers. A
  figure with no record of its inputs cannot be defended to the member it describes,
  and raising the version recomputes rather than leaving a war stale.

### Fixed
- ⚠️ `ranked_wars.start_at` / `end_at` are **bigint epoch seconds**, not timestamptz
  like nearly every other timestamp in this schema. Caught while writing the job —
  the `extract(epoch FROM …)` it started with would have thrown outright.

### Changed
- `WIN_RESULTS`, `LOSS_RESULTS` and `ASSIST_RESULT` are now **exported** from
  `server/src/warOverview/summary.ts` so the dibs summary reuses them instead of
  making a third copy. ⚠️ `war-overview-parity.test.ts` now asserts the **sets
  themselves** match the frontend's, not merely the numbers they produce — that is
  how `Special` drifted the first time, and the sets now reach a leaderboard with
  members' names on it.

### Internal
- `warDibsSummary.ts` is pure and takes **epoch seconds only**; every conversion
  happens in SQL, so no timestamp parsing exists in it to get wrong (#140).
- 37 unit tests plus 11 against real Postgres. Four probes run and reverted:
  reason-over-attacks (9 fail), no grace window (2), no settle gate (1), and
  trusting `war_id` alone (8 — it is client-supplied and nullable).

## [3.203.0] - 2026-10-06

### Added
- **Dibs claims now record WHY they ended** (#530, slice 1 of the call-activity
  report). New `war_room_dibs_v2.release_reason`, written by all five paths that
  tombstone a claim: `rehospitalised` (#107), `spent`, `window` (#106), `superseded`,
  `manual`, `admin`, `reset`.
  ⚠️ **This is the half that cannot be backfilled.** Whether a claim converted is
  answerable retroactively from `faction_attacks`, but the holder's *intent* — gave
  it back, hopped to another target, was overridden by a lead — exists only at the
  moment of release. Every war that runs without this column is a war whose intent
  data is gone, which is why it ships ahead of the report it feeds.
  ⚠️ `release_reason` is stamped in the **same statement** that sets `deleted_at`. A
  second UPDATE could be interrupted between the two, leaving a released claim with
  no reason — indistinguishable from pre-0072 history, and therefore silently
  dropped from the report.
  ⚠️ A lead releasing their **own** claim records `manual`, not `admin`. The reason
  is decided per row by who held it, not by which code branch ran; deciding it by
  branch files every lead's ordinary release under moderation.
  ⚠️ `reset`, `spent` and `rehospitalised` are marked **blameless** in
  `warDibsReasons.ts`. The board being wiped at war setup, and a target going down
  (frequently somebody else's hit, sometimes the target's own dodge), are not
  failures to convert, and a report that counts them as such accuses members of
  something the data does not support.

### Internal
- `db/test/template-matches-migrations.test.mjs` — **`template.sql` must not fall
  behind the migrations.** ⚠️ Asserts that applying the whole history to a freshly
  provisioned database adds no column and no table: on an up-to-date template every
  migration is a no-op, so any growth measures exactly how stale the template is.
  Probed — removing 0072's column from the template fails the test and names it.
  Framed this way rather than as "both paths agree" because there is no tenant built
  from the migrations alone: the history does not start at the beginning of the
  schema and references tables that exist only in the template.
  The 0047 and 0061 tests each check this for their own change — the right instinct,
  repeated per-migration, and therefore only as good as whoever remembers to write it.

## [3.202.0] - 2026-10-06

### Changed
- ⚠️ **The War Overview's Member dropdown is one alphabetical list again, with the
  quiet names greyed** — the two groups 3.201.0 introduced are gone. MonChoon:
  *"I'm still not sure that I like the setup currently with two split lists. Can we
  interleave it since we are sorting alphabetically? You mentioned about greying the
  names of people who had a score of 0. Can we do that instead?"* Splitting the list
  costs the one thing an alphabetical dropdown is good for — going straight to a name
  you already have in mind, without first working out which half it is in.
- ⚠️ **The grey is not load-bearing.** `option { color }` is honoured by Chrome and
  Firefox on desktop and ignored outright by native select menus on macOS Safari and
  on mobile, where the OS draws the list. So each quiet entry still carries a text
  marker: `— no events` or `— revives only`. The grey is the fast signal for the
  people whose browser renders it; the words are what everybody gets.
- The caveat the group label used to carry now lives on the selected member instead:
  a zero-activity name comes from TODAY'S roster, `members` records no join date, and
  so it means *no events in this war* and never *was here and did nothing*.

## [3.201.0] - 2026-10-06

### Fixed
- ⚠️ **The War Overview's Member dropdown could not offer a member who did nothing.**
  The list was derived from the loaded `attacks` and `revives` alone, so somebody with
  no outgoing hits, no incoming hits and no revive received had no row to be found in
  and never appeared. That made "not in the list" mean two different things at once —
  *did nothing in this war* and *was not in this war* — and telling those apart is
  what the member view is for. Reported by MonChoon: *"if a particular member has no
  outgoing or incoming it seems like they don't appear in the list, is that true?"* It
  was. The dropdown now unions the faction roster, and a zero-activity member renders
  a real all-zero breakdown rather than being absent.
- ⚠️ **Revives were matched on `target_id` only**, so a member who spent the war
  reviving teammates — never hit, never hitting — was also missing, even though
  `faction_revives.reviver_id` was already on the rows the page had loaded. Both
  halves of the revive are read now.

### Changed
- The Member dropdown is **grouped**: "In the war data" and "No events in this war".
  ⚠️ Split rather than mixed on purpose — `members` records no join date, so the
  second group is today's roster matched against a war that may be months old. It
  honestly says *no events in this war*, never *was here and did nothing*, and the
  group label is what carries that difference.
- A **revives-only** member is marked as such in the dropdown, and an empty member
  view now explains itself in one line instead of leaving three blank panels: no
  events at all, none inside the selected window, or revives performed — which no
  panel plots. ⚠️ Deliberately a sentence and not a fourth stat pill: the summary
  holds one shape across both views on purpose, and a pill on only one of them is how
  the two stopped agreeing last time.

### Internal
- `frontend/src/utils/warOverviewMembers.js` — the member list as a pure function,
  with 18 tests. Probed both ways: dropping the roster union fails three, dropping the
  reviver half fails one.
- The dropdown is extracted to `components/warOverview/MemberPicker.jsx` so the
  grouping rules are testable without mounting a view that carries Plotly and four
  network reads (8 tests).
- `loadMembersRoster()` in `warDataLoader` — one definition of the roster read; the
  live-contributions leaderboard had its own inline copy.

## [3.200.1] - 2026-10-04

### Fixed
- ⚠️ **Migration 0070 aborted the deploy for every tenant.** A new tenant database
  is provisioned from `template.sql` — which already carries the final shape — and is
  then run through the whole migration history, so every migration must be a no-op
  against a database that already looks finished. `CREATE TABLE IF NOT EXISTS` and
  `ADD COLUMN IF NOT EXISTS` do that for free, which is why this held for sixty-nine
  migrations. **`RENAME COLUMN` has no `IF EXISTS`**, and 0070 used the bare form:
  it threw `column "battle_stats" does not exist` and stopped the run — and because
  one database failing aborts the whole deploy, **production sat three versions
  behind** while `dev` fell five behind. The renames are now guarded by an explicit
  existence check.
- ⚠️ **Nothing caught it.** The suite applied `template.sql`, and separately
  applied migrations to an empty database; neither models provisioning. A new
  `migrations-over-template` test applies the entire history **on top of the
  template**, twice, which reproduces the exact production error when the guard is
  removed.

## [3.200.0] - 2026-10-04

### Fixed
- ⚠️ **The stats fetch on adding a target had never actually been exercised.**
  It worked, but the route resolved its spy-provider config from `process.env` and
  took no base-URL overrides, so it could not be pointed at a test fixture — and a
  third place was deciding where a faction's TornStats key comes from. The routes now
  take the same config the scraper and the war-room setup route already take.
- With that in place, there are now tests proving stats **do** land on the first
  insert: a TornStats reading with every stat checked individually, the BSP fallback
  when TornStats has no spy, and a dead provider that leaves the target added with
  its Torn data intact.
  ⚠️ Each stat is asserted separately because Fair Fight is a sum of square
  **roots** of the four — a transposition produces a plausible wrong answer rather
  than an obvious one.
  ⚠️ The capture-time assertion deliberately avoids `new Date()`: these columns
  are served as raw timestamptz with a bare "+00" offset, which `new Date` reads as
  NaN (#140). That trap caught this very test on its first run.

## [3.199.0] - 2026-10-04

### Changed
- **Battle stats on the Book of Grudges now use the SAME cell as the War Room**, not a
  lookalike. Hover or tap for the per-stat breakdown, the source and how old the
  reading is. ⚠️ `BattleStatsCell` was extracted in #355 precisely so the
  measured-versus-estimated distinction is made in one place; restating it a third
  time in different words is how two surfaces end up disagreeing about a player.
  A solid underline means measured, dotted means estimated, and no reading shows
  **???** rather than a zero that would read as a free hit.
  ⚠️ The API now returns `ts_spy_at` / `bsp_fetched_at` as **raw timestamptz**
  rather than epoch ms, because that cell ages them with `fmtAgo` → `parseDbTime`,
  which expects the bare "+00" string (#140). A number would have printed a dash.
- **The FF column header carries the War Room's explanation, verbatim** — the
  formula, the 3.00 saturation, what a dotted underline means, and that the column is
  personal. ⚠️ Copied word for word on purpose: the same number explained two
  different ways is how two surfaces drift apart.

### Added
- `SortableTh` takes an optional `info` panel, rendered as an **InfoDot beside** the
  sort button. ⚠️ Outside the button, never inside: the header is already an
  enabled control, so wrapping it would force one tap to choose between sorting and
  opening the panel — and a button inside a button is invalid markup.

## [3.198.0] - 2026-10-04

### Added
- **Severity can be set on a grudge that already exists.** ⚠️ The API accepted
  `severity_id` from the start — the edit form simply never sent it — so anything
  added before a faction configured its severities could never be given one.
  ⚠️ Clearing sends `null`, not `undefined`: the API reads an omitted field as
  "leave it alone", so undefined would make clearing impossible.
- **Severities are numbered and re-orderable**, most serious first — **1 is the top
  priority**. ⚠️ The number IS the row's position; there is no separate order
  field, because two sources of truth for one fact is two things to drift.
  ⚠️ Up/down buttons rather than drag-and-drop: they work on a phone, with a
  keyboard and with a screen reader, and a chain is not the moment to find out a
  drag handle does not.
  ⚠️ Reordering preserves every id, so no grudge is orphaned by a shuffle.

### Fixed
- ⚠️ **`grudge-stats` rebuilt its provider config from `process.env`** instead of
  using `deps.spy` — the same object the War Room's spy fetch uses, assembled once
  in `buildDeps`. That ignored the operator's base-URL overrides, so the job could
  not be pointed at a test fixture, and it meant two places deciding where a
  faction's TornStats key comes from. It now shares one source.

## [3.197.0] - 2026-10-04

### Changed
- **A target is fully resolved the moment it is added (#889).** The profile lookup
  already happened inline; the **faction name** and **battle stats** now do too, so
  the row is useful the instant it exists instead of showing a bare faction id and an
  empty FF column until the next sweep.
  - ⚠️ The three sources are fetched **in parallel and fail independently**. A
    TornStats outage must not cost us the faction name, which comes from Torn, and
    neither may fail the add — the grudge is the member's contribution and is kept
    regardless.
  - ⚠️ **No faction call at all for an unfactioned target.** There is nothing to
    name, and asking about faction 0 is a wasted call that would 404.
  - ⚠️ Stats use the same TornStats-then-BSP precedence as everywhere else,
    through the shared `spyProviders`, so a target added by hand and one filled by
    the nightly job are read identically.
  - One extra pair of calls on a deliberate human action is affordable where the same
    calls on a sweep would not be — which is why the nightly job still exists and
    still refetches only what is stale.
- ⚠️ **Re-adding a removed target now re-enriches it.** A target off the list for
  a month may have changed faction, name or stats entirely, and reviving the old row
  would have presented stale facts as current.

## [3.196.0] - 2026-10-04

### Added
- **Claiming a target (#892).** Migration **0071** adds `grudge_claims`. One live claim
  per target, so a chain does not waste hits on somebody already being handled.
  - ⚠️ **Claiming is a courtesy, not a lock**, and the page says so. It stops two
    people wasting hits; it cannot stop anybody attacking, and presenting it as
    something Torn enforces would be a lie.
  - ⚠️ **A partial unique index arbitrates the race**, not a read-then-write. Two
    people pressing Claim in the same second is the case this exists for, and a
    check-then-insert would let both through. The loser is told **who** has it —
    "could not claim" sends somebody to ask in chat for the answer we already had.
  - ⚠️ **The expiry rules are the War Room's, re-implemented rather than shared.**
    Each was earned in a live war; the dibs tables are war-scoped with their own job
    and broadcast, and the two must not be able to break each other.
    - Okay → anything else: the claim is **spent**.
    - Hospital → Hospital with the timer jumped: **spent**, somebody else got there.
    - Hospital → Okay: the claim is **kept** and a 30-second head start armed — the
      holder waited for exactly that moment.
    - ⚠️ **A missing status reading releases NOTHING.** One failed sweep would
      otherwise free every claim on the board at once, mid-chain, with no
      explanation. Verified by probe.
  - Leadership can free a claim somebody forgot about: mid-chain a stuck reservation
    on a good target costs the whole faction.
  - ⚠️ Unclaimed targets sort **first** — those are the ones you can take.
  - ⚠️ A pending target cannot be claimed, which would otherwise leak the existence
    of a held own-faction target to anybody who guessed its row id.
  - Claims are **never hard-deleted**; the release reason is recorded, because "the
    claim went away" is useless mid-chain where "spent — they went to hospital" is not.

## [3.195.0] - 2026-10-04

### Added
- **Watch mode on the Book of Grudges (#889).** Leadership can turn continuous
  refreshing on for a chain and off again afterwards, the way the War Room gates its
  own polling — the same idea, its own state, nothing shared.
  - ⚠️ **The refresh rate is COMPUTED, never configured.** It falls out of how
    many factions are on the list and how many members have consented, and is shown
    in plain words. A box saying "every 30 seconds" would be a promise the key budget
    might not keep, and a cadence that silently fails to happen is worse than one
    that is simply stated.
  - ⚠️ **At most a quarter of each key.** The pool is shared with OC tracking,
    the War Room and member stats; a watch that spends a key's whole minute starves
    them, which is the shape of the 2026-09-10 incident.
  - ⚠️ **A sweep too big for one tick is SHARDED**, cycling from the clock with
    no stored cursor — a persisted one is a thing that can jam. Factions are taken
    first so a tight budget buys the most coverage.
  - Because `/faction/{id}/members` returns every member's status in one call, cost
    scales with **factions, not targets**: 150 targets across 40 factions is 70 calls
    a pass and still refreshes every minute on four consented keys.

### Changed
- ⚠️ **Our own faction is always watched**, read from `faction_config` at request
  time rather than stored. This stack serves five factions from one codebase, so a
  literal id would watch TNL's roster on forge, mayhem and capacityx. It is added on
  read, not seeded, so it cannot be edited away — nobody should be able to switch off
  the gate that stops a teammate appearing on a public target list.
- `grudge-refresh` now ticks every minute and decides for itself whether to work:
  sharded and fast with watch mode on, one pass a quarter-hour with it off. One job
  rather than two, which would double-refresh whenever both were due.

### Fixed
- ⚠️ The refresh fetched `/faction/{id}/basic` **every sweep** for a faction name
  it already had, doubling the cost of every grouped faction for a string that
  almost never changes.

## [3.194.0] - 2026-10-04

### Added
- **Book settings (#889, slice 6).** Severities and watched factions were SQL-only,
  which made the approval gate unusable — it worked and nobody could tell it what to
  watch. Leadership can now edit both from the page.
  ⚠️ **Renaming a severity keeps its id**, so no grudge is orphaned and the column
  keeps rendering a label rather than a raw slug.
  ⚠️ **Removing one clears it from any grudge using it**, and the editor says how
  many BEFORE you save. The old value stays readable in the history, so a removal is
  recoverable rather than a quiet data loss.
- **History view (#889, slice 7).** The audit trail has been recorded since slice 1
  and visible nowhere. ⚠️ It shows what a value changed **from**, not just that it
  changed, and attributes an automatic rename to the lookup rather than to a person.
- **Live hospital timers.** The status column counts down, and says **"Out now"** the
  moment a timer expires — without waiting for the server, which refreshes every
  fifteen minutes and would deliver that moment up to fifteen minutes late.
  ⚠️ The countdown ticks locally from the stored `until` and needs no request;
  the one-minute poll is only for state the server has newly learned.
  ⚠️ "Hide anyone in hospital" now keeps somebody whose timer already expired —
  otherwise it hides exactly the target you were waiting for.
- The list defaults to **"who can I hit soonest"**. ⚠️ A target with no deadline
  sinks rather than sorting first: unknown is not "available now".

### Fixed
- ⚠️ **Two sortable columns had no header.** `until` was unreachable entirely and
  `added` could be sorted away from but never back to. `until` is replaced by the
  availability sort; `added` has a header.
- The target's **level** was fetched and stored since slice 4 and never displayed.

## [3.193.0] - 2026-10-04

### Added
- **Per-viewer Fair Fight on the Book of Grudges (#889, slice 5).** The FF column is
  **personal**: it is what *you* would earn, so the same list reads differently for
  everyone looking at it. A dotted underline marks a number built on a bare stat
  total, where an even split was assumed.
  ⚠️ A dash means "we cannot work it out", not "bad target", and the page says so
  — the two read identically otherwise.
- **Battle stats for targets**, TornStats first and BSP for the rest, via a new
  daily `grudge-stats` job. ⚠️ Daily, not quarter-hourly like the status refresh:
  these are third-party servers we do not own, spy stats move on the order of weeks,
  and the job refetches only what is stale (a stated 7-day tunable).
- The battle-stats column shows its **source and the spy's own capture date** — not
  our fetch time, which can be months newer and would make a stale figure look current.

### Internal
- `spyProviders.ts` extracted from `spyFetch.ts`: fetch and parse with **no database
  writes**, so the War Room and the grudge list share one "TornStats first, BSP for
  the rest" implementation while writing to their own tables.
  ⚠️ **The war-room suite did not cover the per-stat mapping.** Swapping
  `defense` for `speed` in the parser left all 10 spy tests green — they assert only
  `bsp_total`, `spy_source` and `ts_spy_at`. Since Fair Fight is a sum of square
  roots of the four individual stats, that transposition would have produced a wrong
  FF everywhere. 13 new tests pin each field, verified by re-running the probe.
- Migration **0070** renames the grudge stat columns to `bsp_*` so
  `fairFight.js#targetBattleStats` reads a grudge row with no adapter. Naming
  convergence, not coupling — nothing here touches war-room tables.

## [3.192.0] - 2026-10-04

### Added
- **Book of Grudges targets are now looked up (#889, slice 4).** Adding a target
  resolves their name, level, faction and status immediately, and a `grudge-refresh`
  job keeps status current every 15 minutes.
  - ⚠️ **Purpose-scoped.** Both the inline lookup and the job claim with
    `purpose: 'target-lookup'`, so a member who has not accepted the Target Lookups
    disclosure is skipped for these calls and for nothing else. If nobody has
    accepted, the job does nothing — a legitimate state, not a failure, so it does
    not raise a job-failure alert.
  - ⚠️ **The add path FAILS CLOSED.** If the target cannot be looked up we cannot
    rule out a watched faction, so leadership rules on it. The form says which of the
    two reasons applies rather than claiming a watched faction it never verified.
  - ⚠️ **A client-supplied `faction_id` is ignored.** Trusting it would let
    anybody bypass the watched-faction gate by simply not sending one.
  - ⚠️ **The gate is re-evaluated on every sweep.** A target's faction is only
    known after a lookup and can change afterwards, so an active target who joins a
    watched faction goes back to pending — but never the reverse, because
    un-approving somebody would undo a human decision unasked.
  - **Renames are recorded.** The refresh writes an `edited` audit row on
    `target_name`, so the history shows "was X, now Y" with no new schema.
    ⚠️ Identity changes only — auditing status would write a row per hospital
    timer and bury the three events the trail exists for.
  - ⚠️ Grouped by faction: `/faction/{id}/members` covers every target in it in
    one call, and a faction holding exactly one target is routed to the individual
    lookup instead, since that costs the same call and drags back far less.

## [3.191.2] - 2026-10-04

### Changed
- **CI now runs ESLint on the frontend**, with only the four rules whose failure is a
  crash: `no-undef`, `react/jsx-no-undef`, `react/jsx-uses-vars` and
  `react-hooks/rules-of-hooks`. ⚠️ Neither `vite build` nor vitest catches an
  undeclared name; it is a runtime ReferenceError. Both of today's production
  crashes were that (`raceGroupHeaders` on War Payouts, `renderCtx` on Member
  Overview, #900), and this fails on each when they are put back. It also catches
  the hooks-after-early-return bug fixed in 3.191.1. Zero standing failures, and it
  should stay that way: `npm run lint -w frontend`.

## [3.191.1] - 2026-10-04

### Fixed
- **Member Overview crashed on open (#900)** with `renderCtx is not defined`. The
  cell-render context had been pasted inside the `memberRows` memo's callback, out of
  scope of the table that reads it (and a hook inside a callback besides). Moved to
  component scope.
- ⚠️ **Four tables from the sort epic called `useTableSort` after an early return**
  — Saved RW Payouts (`WarPayoutHistory`), Competition leaderboards, the Loaned
  Items modal and the OC Joint plan. Each would throw *"Rendered more hooks than
  during the previous render"* the moment its loading/empty branch flipped to the
  table (for example, Saved RW Payouts finishing its load). The hook now runs first.
- **RW Payouts → `Effort %` header sorted nothing.** It had no `effort_share`
  column. Also removes a stray, never-used `SortTh` the epic left above the imports
  of `RWPayoutsView.jsx`, and puts the modal's headers on the shared `SortableTh`
  as that block intended (real `aria-sort`, keyboard-operable).

## [3.191.0] - 2026-10-04

### Added
- **API Key Usage now discloses target lookups (#889, slice 0), and every member is
  asked to re-accept.** A new *Target Lookups* row explains that a key may be used to
  read the public profile of somebody a teammate added to the shared target list, and
  that person's faction member list.
  ⚠️ **These are people outside your faction**, chosen by whichever member added
  them, rather than your own teammates — which is the part the existing wording did
  not cover, and the reason this needs saying rather than relying on the endpoint list.
  ⚠️ **Disclosed before the lookups ship.** Slice 4 is not built yet; members get
  time to accept before anything uses it.
  ⚠️ **Declining costs nothing else.** A key whose owner has not accepted is
  skipped for these calls and for nothing else; every other scraper is unaffected.

### Fixed
- ⚠️ **Logging in would have reset a member's consent and re-prompted them
  forever.** `auth.ts` stored a hardcoded `'login-v1'` and `keyPool.store` overwrites
  `consent_version` on every login, so accepting the new disclosure and then logging
  in again would silently undo it. Login now records the current version — which is
  correct in its own right, since the login modal will not submit until the member
  ticks the disclosure beside it.

## [3.190.0] - 2026-10-04

### Fixed
- **The API Key Usage re-prompt now exists (#894).** It previously did nothing:
  `config.js` declared `consentVersion` with the comment "bump to re-prompt the
  disclosure", **nothing read it**, the server stored a hardcoded `'login-v1'`
  instead, and no comparison happened anywhere. The page could be rewritten and no
  member was ever asked again.
- ⚠️ A second, separate correction: `calendar.ts` claimed bumping the version
  "gates every scraper". It does not — the key pool filters on `consent_at IS NOT
  NULL` in four places and never on the version. That comment was repeated as fact
  when advising on timing, which is why this was checked.

### Added
- **Purpose-scoped consent.** `pool.claim({ purpose })` restricts a claim to keys
  whose owner accepted a disclosure covering that purpose. ⚠️ **Omitting it is the
  baseline and changes nothing**, so every existing scraper is untouched — a member
  who has not re-accepted keeps serving everything the disclosure they DID accept
  covered. A re-prompt never halts the faction's data collection.
- **A guard that makes the rule structural.** Each entry in `DISCLOSURE_VERSIONS`
  carries a fingerprint of `ApiKeyDisclosure.jsx`'s rows. Editing the disclosure
  without adding a version **fails CI**, and adding a version is what re-prompts
  everybody — so *"anytime we adjust the API Key Usage page, force a re-approval"*
  is enforced rather than remembered. Verified by probe.
- `/api/health` reports `consent_version`; bootstrap reports what the member
  accepted and whether it is stale. ⚠️ The app build version and the disclosure
  version are **separate fields**: shipping a release must not re-prompt anybody, and
  bumping the disclosure must not force a reload.
- `POST /api/auth/consent` records acceptance. ⚠️ It takes **no version from the
  client** — a stale tab must not be able to accept wording that has since been
  replaced.
- `ConsentGate` overlays the dashboard when the disclosure has moved on. ⚠️ It does
  not block the app and does not reload the tab; it says plainly that nothing stops
  working, and can be deferred.

### Internal
- ⚠️ **Shipping this changes nothing for anybody.** The version list contains only
  `login-v1`, which is what every enrolled key already stores, so no member is
  prompted until a disclosure actually changes. There is a test asserting exactly
  that.

## [3.189.0] - 2026-10-04

### Added
- **Faction column on the Book of Grudges**, linked to the faction profile. Sorts
  on the name where there is one and falls back to the id, so an unenriched faction
  still groups with itself. ⚠️ Unfactioned sinks in both directions — absent is
  not "last alphabetically" (#351).
- **Every data column on that table now sorts**, including the grudge column, which
  sorts by **count** rather than reason text: "who has upset the most of us" answers
  something, prose sorted alphabetically answers nothing. ⚠️ Attack stays a plain
  header — it is an action, not data, and a header that looks clickable and reorders
  nothing is worse than one that plainly does not.

### Changed
- ⚠️ **The add form no longer asks for the target's name, and the API no longer
  accepts one.** The enrichment lookup becomes the single source for it, so a rename
  is something observed rather than a guess somebody typed once — and nobody can
  label a target whatever they like. Until the lookup lands the list shows the id.

## [3.188.0] - 2026-10-04

### Added
- **The Book of Grudges — the page (#889, slices 2 and 3).** Members → Book of
  Grudges: add a target by profile link with a required reason, and a filterable,
  sortable list with a one-click attack button.
  - ⚠️ **The reason is required in the form as well as the API**, and the
    button asserts it by not posting rather than only by looking disabled.
  - ⚠️ **Severity renders only where a faction has configured one.** No
    hardcoded Low/Medium/High — an absent control is honest, three invented tiers
    are not.
  - ⚠️ **A watched-faction target reports that it was HELD**, not simply
    added. "Added to the list" for something nobody can see would be a lie.
  - Leadership see the approval queue above the list, because a notification
    nobody sees is not a notification. A failure fetching it leaves the list
    intact.
  - Filters by name, faction or reason text; a hospital toggle; attack opens
    Torn's loader in a new tab with `rel="noopener"`.

### Internal
- ⚠️ **Battle stats, status and Fair Fight columns are deliberately empty**,
  and the page says why. Each needs a Torn call, and every Torn call in this epic
  waits on #894. An unexplained blank column reads as a broken scrape and gets
  reported as a bug.
- Every sort column on the new table declares its `kind`. Verified by probe: the
  `sortColumnKinds` guard added in 3.184.0 fails when one is removed.

## [3.187.0] - 2026-10-04

### Added
- **The Book of Grudges — schema and API (#889, slice 1).** A perpetual,
  faction-wide shared target list where a target earns its place by a stated
  grudge. Migration **0069** adds `grudge_targets`, `grudge_entries` and
  `grudge_audit`.
  - ⚠️ **One target, many grudges.** Two members can independently hold one
    against the same person, and the list shows that person once with both
    reasons rather than twice.
  - ⚠️ **A reason is mandatory at three layers** — route, core module and a
    `CHECK (btrim(reason) <> '')` constraint. A target on the list for no stated
    reason is the one thing this feature exists to prevent.
  - ⚠️ **Targets in a watched faction land `pending_approval`**, visible only
    to leadership and their author until ruled on. The watched list is a faction
    setting, not a hardcoded own-faction check, so the faction family and allies
    go through the same gate.
  - ⚠️ **Nothing is hard-deleted.** `grudge_audit` is append-only and keeps the
    removed text readable; re-adding a removed target revives the same row so its
    history stays attached.

### Internal
- ⚠️ **Slice 1 makes no Torn API calls, deliberately.** Every call this epic
  needs is gated behind the API Key Usage disclosure update and the forced
  re-accept, because pointing an already-disclosed endpoint at arbitrary players
  and factions is a change of USE even though it is not a new endpoint.
  `target_name` is nullable for the same reason — resolving it needs a call.

## [3.186.0] - 2026-10-04

### Changed
- **Hall of Fame ties now order by Torn rank, not alphabetically.** Positions are
  shared, so an entire faction at level 100 sits at rank 1 together — ties are the
  norm on this board, not an edge case, and ordering them by name said nothing.
  280th in Torn now sits above 3,089th.

### Added
- `sortRows` accepts a LIST of tie-break columns, applied in order. A tie column
  that is also the sorted column is skipped rather than ending the list, so sorting
  *by* global rank still falls through to the name.
  ⚠️ A member Torn gave no global rank for still sinks within their tie group
  (#351: absent is not "worst placed"), with the name settling the unplaced among
  themselves. All 18 existing callers pass a single key and are unaffected.

## [3.185.0] - 2026-10-04

### Changed
- **Hall of Fame travel time reads as a duration.** `9,849,600` is accurate and
  unreadable; it now renders `114d`, and `72,489,600` renders `2y 109d`. The unit is
  chosen per value, so each row reads at its own scale instead of the whole column
  being flattened to the largest one in it. The exact seconds stay on hover.
  ⚠️ The header no longer states a unit. The value carries its own now, and
  "(seconds)" above a cell reading `114d` is a contradiction.
  ⚠️ Sorting still runs on the raw number. Formatting first would reintroduce
  the lexical sort 3.184.0 just fixed, with `2y 109d` against `114d`.

### Fixed
- `formatDuration` carried a rounded unit instead of rendering `114d 24h`, `5h 60m`
  or `60m`. All three branches had it.

### Internal
- `formatDuration` moved from `utils/occupancyReport` to `utils/duration` and grew a
  year branch — a coverage window never reaches one, a travel-time board does.
  `occupancyReport` re-exports it, so its callers are unchanged and its existing
  assertions are pinned in the new suite.

## [3.184.0] - 2026-10-04

### Fixed
- **Hall of Fame sorted every number as text.** `compareValues` falls through to a
  text comparison when a column declares no `kind`, and the board declared one only
  on the member name. So `#` came out `1, 10, 11 … 19, 2, 20 … 29, 3`, racing skill
  `9.77, 9.32, 8.94, 77.35, 7.91`, racing wins `97, 94, 933, 93, 89, 8,775`, and
  travel time likewise. All four columns now state `kind: 'number'`.
  ⚠️ The existing tests could not have caught this: the fixture ranked three
  members 1, 2, 3, and single digits sort identically as text and as numbers. The
  new cases use two-digit ranks and decimals, so text order and numeric order
  disagree.

### Added
- `sortColumnKinds` guard — a sort column with an `accessor` must declare a `kind`
  or a `compare`. A missing `kind` is silent: the accessor returns a number, the
  header sorts, the arrow moves, and the order is simply wrong. Every other table
  in the app already declared one, so this only holds the line.
- The Hall of Fame travel-time header now states its unit. Torn's spec says
  *"Traveltime is shown in seconds"*; worth labelling, because the live values are
  all exact multiples of 86,400 and read far more like a day count.

## [3.183.0] - 2026-10-04

### Fixed
- **War Payouts crashed with `raceGroupHeaders is not defined`.** Reported by
  MonChoon. #836 (the shared-sort epic, 2026-10-01) deleted the function and
  left both call sites, so the page had been broken for three days. Its
  companion `raceColHeaders` survived the same commit, which is why only one of
  the two header rows went missing and the diff looked harmless.

### Added
- A guard test: every `{name(...)}` in a `.jsx` file must be declared or
  imported in that file.

### Notes
- ⚠️ **Nothing in the repo could have caught this.** There is no eslint config
  at all, and `vite build` does not catch it either — an undeclared identifier
  is a runtime `ReferenceError`, so the bundle compiles cleanly and the page
  explodes when it renders. Build passed, every test passed, page was broken.
- The Participation column count is now derived from the surviving
  `raceColHeaders` instead of a bare `12 : 7`, which could drift from the
  columns beneath it without anything noticing.
- ⚠️ **The guard was wrong the first time it was written**, and the probe caught
  it: re-deleting the function still passed. It stripped string literals, but
  **JSX prose is not a string literal** — an apostrophe in ordinary text opens a
  quote that runs until the next one, which swallowed more than half of
  `WarPayoutManagement.jsx` (120,632 chars down to 57,351) including the call
  sites it was looking for. It now strips comments only, and provably fails
  when the definition is removed.

## [3.182.0] - 2026-10-03

### Added
- **Faction Hall of Fame board (#872)** at Members → Hall of Fame, open to
  everyone. Where each member sits inside the faction, with their position in
  all of Torn beside it — *"3rd in forge, 48,000th in Torn"*.
- Migration **0068** — `member_hof_snapshots`, one row per member per day.
- Scraper job `member-hof`, daily at 01:35.

### Notes
- ⚠️ **Bragging rights, not analytics.** Singularity, asked whether this was
  for screening applicants or spotting anomalies: *"no it was more so to
  promote competition within the faction, bit of bragging rights."* So there
  are no thresholds, no compliance colouring, and deliberately **no reuse of
  the Member Overview's machinery** — importing it would drag the assessment
  framing along with it.
- ⚠️ **Battle stats are absent and must stay absent.** Torn returns that
  category as `null` for anyone but the requester, so a roster-wide battle-stat
  board cannot be built by anyone. It is excluded rather than rendered as an
  empty column that would read as a scrape failure — and the tooltip says why,
  because an unexplained gap gets reported as a bug.
- `working_stats` leads the categories: it is the likeliest target of the
  request, and unlike battle stats it *is* available for other players.
- ⚠️ **One jsonb column, not fourteen typed pairs.** Torn adds HoF categories,
  and a column-per-category schema turns every addition into a migration.
- ⚠️ Faction position is computed **on read**, never stored — it changes
  whenever a *different* member's value changes.
- ⚠️ Tied members share a position (1, 2, 2, 4). Telling two people with
  identical numbers that one is ahead is a lie the data does not support.
- ⚠️ Members with no reading are **left out, not ranked last** — absent is not
  "worst", the same rule the roster sort follows for unspied battle stats.
- ~1 call per member, so daily is affordable and per-page-load is not; the
  cadence is stated in the job rather than implied.

## [3.181.0] - 2026-10-03

### Changed
- **Member Overview numbers now say what they are a rate OF (#866).** Every
  per-day figure carries a `/d`, a **120d** window joins the list, and one
  toggle switches the whole table between per-day rates and window totals.

### Notes
- ⚠️ **The arithmetic was never wrong and is untouched.** `perDay = delta /
  daysCovered` divides by the days actually covered, never by the window
  length, so a short history is not diluted. Singularity read `80 (2,400 in
  30d)`, took the large unlabelled figure at face value, and concluded the
  system was understating them — a legibility failure, not a maths one, and
  worth taking seriously because the reader was competent and still misread it.
- ⚠️ The `/d` goes on the **value**, not only the column header: the table
  scrolls horizontally, so a header-only label is invisible exactly when a
  reader is deep in the right-hand columns. The chain-watch grid settled the
  same argument by spelling out `TCT` on every row.
- ⚠️ One `RateCell` now renders every per-day column **including gym energy**.
  They were two near-identical render paths, which is how the gym header ended
  up with a `/d` the stat headers never got.
- ⚠️ A member whose history is shorter than the window shows an **amber**
  bracket on the cell being read. The signal used to be an underline on the
  far-left name cell, which somebody studying the Xanax column never looks at.
  No per-cell tooltip — thirty hover targets per row is worse than the problem.
- ⚠️ Sorting follows the **displayed** figure. With totals showing, sorting by
  the per-day rate would order the table by a number nobody can see.
- Per-day stays the default: it is the only basis on which a 6-day member and a
  300-day member are comparable, and it is what the thresholds check.
- 90d is unchanged and still available.

## [3.180.0] - 2026-10-03

### Added
- **A member can download their own stat history as CSV (#867).** On the
  Dashboard: pick a range, get one row per day of your personal stats and gym
  contributions. Prompted by Singularity, who maintains their own workstat
  script and would rather have the raw series than read our table.

### Notes
- ⚠️ **The route takes no member parameter and no table parameter.** The id
  comes from the verified session and nowhere else. A `?member=` that is merely
  *checked* is one refactor away from an IDOR, so there is nothing to check.
- ⚠️ `member_daily_stats` **stays `role: 'leadership'`**. This adds a narrower
  door rather than widening the existing one — relaxing that registry entry
  would hand the whole roster to anyone with a session. A test pins it.
- Visitors are refused with a reason rather than handed an empty CSV, which
  would read as "you have no stats".
- ⚠️ The client **verifies the completion marker before saving**. The status
  line goes out with the headers, so a stream that dies halfway still arrives
  as a 200 and opens perfectly with most of its rows missing. A truncated file
  that saves cleanly is worse than one that fails.
- Gym columns start from the day a member joined this dashboard and can never
  be backfilled — they come from a current-only endpoint. The tooltip says so,
  because an unexplained blank column gets reported as a bug.

## [3.179.0] - 2026-10-03

### Fixed
- **A settled OC payout week is now a static sheet (#871).** Reopening one
  rebuilt its item breakdown from live crime data and **re-priced it at the
  current market** — so a week settled in July, reopened in October, showed a
  pot nobody received. It now renders exactly what it showed when it was saved.

### Added
- Migration **0067** — `oc_payout_weeks.item_breakdown` and `crime_values`,
  holding the sheet as displayed at save time, unit prices included.

### Notes
- ⚠️ The re-pricing hid behind a comment claiming the opposite. The restore
  path called `enrichItemBreakdown` under *"for display only … names"*; the
  enricher returns **current market** unit values and replaced the breakdown
  wholesale. That call is gone.
- ⚠️ **Nothing recalculates a saved week** any more — not on open, not on a
  payout-mode change, not on an item-price edit. A `savedWeekRef` guards the
  calculation effect and `recalculateWithItemPrices` returns untouched. This is
  the same path that re-split TNL week 5 by tickets on a week marked `equal`.
- ⚠️ `min_time_for_full_tickets` / `min_time_for_any_payout` are now **written**.
  They were allowlisted on the server from the start but never sent, so every
  stored row silently carried the table default regardless of what the week was
  computed under.
- ⚠️ **Weeks saved before 0067 are not backfilled** and do not fall back to live
  prices. They open on their stored payouts — which are correct and complete —
  with a notice that itemised prices were never recorded. A past market price
  cannot be recovered, and inventing one is what this change exists to prevent.
- **RW payouts were already correct** and are unchanged. `war_payouts` stores
  the cache prices as used, every weight, and `total_reward` — the pot itself —
  and restores them as inputs. Tests now pin that, so RW cannot drift into the
  OC bug.
- Preparing a new, unsaved week is behaviourally unchanged.

## [3.178.0] - 2026-10-03

### Changed
- **Dibs now release when an Okay target enters ANY unreachable state** — jail
  and travel as well as hospital. Broadens 3.177.0, which covered hospital
  only. MonChoon, 2026-10-03: *"once okay any state change off of okay should
  release the dibs."*

### Notes
- The claim's only job is "this target is mine to hit". The moment they cannot
  be hit it has no job, and holding it blocks everybody else. Nobody converted
  on a jail or a flight, but the target is just as unreachable.
- ⚠️ **`Hospital → Okay` deliberately does NOT release** — that is the
  reservation paying off, and the 30s window arms as before. You claimed
  somebody *because* they were in hospital; releasing when they surface would
  kill the claim at the exact moment it becomes useful.
- ⚠️ **A missing status reading is not a downstate.** The rule requires an
  actual state string, so a sync hiccup that left rows without a status cannot
  read as "not Okay" for every target at once and tombstone every live claim in
  one tick. Unknown is not down.
- #376's disarm is now largely unreachable rather than wrong: an armed
  countdown implies the target was recently Okay, and a recently-Okay target
  that goes down is dropped outright. Kept as a cheap guard.

## [3.177.0] - 2026-10-03

### Fixed
- **Dibs now release when the target goes down.** Reported mid-war: claims were
  sticking to hospitalised targets. On forge, 20 of 22 live claims sat on
  people already in hospital, most of them naming the *holder* in "Attacked
  by" — the oldest held for 33 minutes, blocking everyone else from a target
  its holder had already converted.

### Notes
- ⚠️ **This reverses a deliberate rule, not a broken one.** The sweep released
  claims the holder *failed* to convert and deliberately **kept** the ones they
  converted, so they could farm the same target. In a war that turned every
  successful hit into a permanent reservation:

  > out of hospital → 30s window armed → holder hits → back to hospital →
  > countdown disarmed → claim held → repeat forever

- ⚠️ The existing "hospital time increased" rule (#107) was real and working,
  but only fires on **Hospital→Hospital**. A target who is hit after surfacing
  passes through Okay, so that check was skipped entirely — which is why
  neither mechanism covered the common case.
- A claim is now spent whether the holder landed the hit or somebody else did.
  Either way the target is down. A farmer who wants the next cycle re-claims,
  which puts them back in the queue instead of ahead of it.
- ⚠️ **Accepted trade:** a spurious `Okay` poll reading followed by `Hospital`
  is indistinguishable from a real hit, so a flicker now costs a re-claim. The
  two errors are not symmetric — a flicker costs seconds on a target still in
  hospital, where not dropping cost half an hour of a blocked target. Telling
  them apart needs the last hospital `until` remembered across the Okay gap,
  which is a column on the claim rather than a one-tick snapshot.
- #376's disarm still governs every other way a target stops being attackable
  (jail, travel) — nobody converted there, so the claim survives.
- **Unrelated to load**: the VPS was at 2.47 on 4 cores with 4.8 GB free and
  the roster poll holding 1.5s. This was never a cadence problem.

## [3.176.0] - 2026-10-03

### Added
- **Two copy buttons on the War Room's Roll Call section.** "Copy missing" and
  "Copy maybes" put a pasteable list on the clipboard — name, ID, battle stats,
  the reason they are on the list, and a profile link, one per line, strongest
  first.

### Notes
- ⚠️ **Two lists, deliberately not one.** "No to the start" is not the same
  question as "not coming": somebody who said no to the start but yes to
  self-hospitalising needs a ping five minutes before the war, and somebody who
  said no to both needs replacing. A single list of every "no" mixes the people
  worth chasing with the people worth writing off.
  - **Missing** — no response at all, not available, or needs a merc.
  - **Maybes** — said no to the start but *can* self-hospitalise.
- ⚠️ **A non-responder counts as missing, not as unknown.** Silence is the most
  common way somebody fails to turn up, and leaving the silent ones off makes
  the chase list look reassuringly short.
- ⚠️ `can_self_hospital` is NULL whenever `on_at_start` is true — the server
  nulls it on write, because the question only applies to a "no". Reading it
  without checking `on_at_start` first would put the entire attending roster in
  the missing list.
- Battle stats are merged in at the panel, not assumed on the roster: the War
  Room passes down the raw poll result and only the roster *table* runs it
  through `withBattleStats`. An unread total shows as `???`, never `0`.
- Links go to the **profile**, not an attack page — these are our own members,
  and the profile is what answers "have they self-hospped yet".

## [3.175.0] - 2026-10-03

### Added
- **Faction upgrades panel (#458)** at Members → Upgrades, open to everyone.
  Shows which perk branches are **actually in effect** — Torn splits the tree
  into war and peace sets and only one side does anything at a time, so the
  active set is primary and the other is collapsed and labelled as giving
  nothing. Core unlocks sit apart, since they are always on.
- `GET /api/faction/upgrades`, serving the newest daily snapshot.

### Notes
- The data layer for this shipped back with #395 (migration 0038, the
  `faction-upgrades` scraper job). **No migration and no new API calls** — the
  panel reads the raw `payload` already being stored.
- ⚠️ Every effect string is Torn's own `ability` text, verbatim. Nothing
  re-derives a bonus from a level: a wrong percentage on a gym-gain display
  looks exactly like a right one.
- ⚠️ When Torn does not report war/peace state, **no side is shown as active**
  rather than guessing one — a wrong "in effect" list is worse than none.
- ⚠️ War and peace share branch names (forge carries Aggression, Toleration and
  Voracity on both sides), so the two sets are never merged or deduplicated.
- ⚠️ `unlocked_at` is epoch **seconds** from Torn, not a Postgres timestamp. It
  is converted to milliseconds server-side and named `unlockedMs` so no caller
  has to guess the unit.
- The Steadfast parser's "never verified against a live response" caveat is now
  resolved: checked against live forge data, it reads str 10 / def 16 / speed 15
  / dex 10 with nothing unparsed.

## [3.174.0] - 2026-10-02

### Added
- **A padlock on the War Room's Name column header freezes or unfreezes it.**
  #841 shipped the frozen column always-on; this makes it a choice. Closed
  padlock means frozen, open means it scrolls with the board. The setting is
  per-user and rides along with the rest of the board's preferences, so it
  survives a reload mid-war.

### Notes
- Defaults to **frozen**, which is what 3.173.0 shipped — anything else would
  read as the feature having regressed on first load after this deploy.
- ⚠️ The padlock stops the header's click **and** its Enter/Space handler.
  The whole `<th>` sorts on both, so without the keyboard guard, tabbing to the
  lock and pressing Enter would freeze the column and re-sort the board
  underneath whoever was reading it.
- ⚠️ Unfreezing drops the stripe class as well as the sticky one. Leaving the
  stripe behind would paint an opaque name cell over a translucent row — the
  exact seam the compositing in #841 exists to avoid, with none of the benefit.

## [3.173.0] - 2026-10-02

### Added
- **The War Room's Name column stays put when you scroll right (#841).** Checking
  med and booster cooldowns meant scrolling past the name of the person whose
  cooldowns you were reading. The Name column, its header and the corner cell
  now freeze to the left edge.

### Notes
- Three things had to line up, and only the first is obvious:
  - **Stacking.** A sticky cell paints in the positioned layer, where `<tbody>`
    comes after `<thead>` — bug #331. Frozen cells sit at z-10 (above the
    scrolling body, below the z-20 header) and the corner at z-30, above both.
  - **A `<tr>` background does not paint behind a positioned `<td>`,** so the
    frozen cell carries its own, in both themes, and the row stripe and hover
    are restated on it so highlighting still crosses the frozen boundary.
  - **The stripes here are translucent.** Copying the tint onto the cell as a
    background-color leaves a visible seam down the boundary — glaring in dark
    mode. The tint goes in `background-image` over an opaque `background-color`
    instead, so the browser composites it to exactly what the row shows.
- A hovered or focused frozen cell lifts to z-30 so its popovers can escape:
  the Name cell holds three (the OD tooltip, the loadout shield, the note
  button) and a stacking context clamps all of them — `position: fixed` does
  not get out either.
- **Scope: the War Room only** for now. It is the widest table in the app and
  the reported case. Every other table needs its own first-column audit — what
  pops out of column one, and whether its stripes are translucent — so they are
  not being changed blind.
- Mobile is unchanged: `MobileWarRoomView` is a card list, not a wide table.

## [3.172.0] - 2026-10-02

### Fixed
- **OC payouts: equal mode now redistributes when a member is marked ineligible.**
  Withholding somebody's pay on an equal week left every other figure untouched
  and the excluded member's share simply vanished from the sheet — the pot no
  longer added up. The tiered and flat-weighted modes were correct, which is
  why this went unnoticed.
- The split had drifted into **five copies** across the payout screen, which
  disagreed three ways. Two more faults fell out of consolidating them:
  - editing a single item price on an equal week silently **re-split it by
    tickets**, abandoning the even split the faction had chosen;
  - a member who was both ineligible *and* carrying a sit-out penalty was
    **paid anyway**, because the penalty pass recomputed their tickets from
    scratch and undid the exclusion.

### Added
- `payoutShare()` in `payoutCalculations.js` is now the only place the OC split
  is computed, with a guard test (`payoutSplitSingleSource.test.js`) that fails
  if anything derives `sharePercent` anywhere else.
- Migration **0066** persists `ticket_time_spent` per saved payout row. It
  decides who draws an equal share (#389) and was previously computed in the
  browser and discarded, so a reopened equal week could not recalculate itself.
  Nullable by design — pre-0066 rows fall back to `time_spent`, which is what
  those weeks were actually paid on.

### Note
- Chain Watch pay is unchanged and still **does not** redistribute: it is a flat
  rate per slot, not a pot. The two policies are now pinned by tests on both
  sides so they cannot be conflated.

## [3.171.1] - 2026-10-01

### Added
- **Tests pinning Chain Watch pay as a flat rate per slot**, not a pool.

### Notes
- ⚠️ **The two payout sheets are deliberately different, and nothing said so.**
  OC splits a fixed pot, so withholding somebody **raises** everybody else.
  Chain Watch pays per slot served, so withholding somebody lowers the **total**
  and touches nobody else's number. Anyone "aligning" the two would be
  introducing a bug; these tests are what tells them.
- ⚠️ No behaviour changed. Chain Watch has always been flat-rate —
  `payout = (slots + bonus) * payout_per_slot`, computed per member with no
  denominator. The 3.171.0 release note said withholding redistributes "on both
  sheets", which was wrong for Chain Watch.
- ⚠️ **A hazard the tests surfaced:** withholding a member does not change
  anybody's raffle ticket COUNT, but ticket ranges are contiguous over the
  sorted rows, so every range after them renumbers. Changing eligibility after a
  raffle has been drawn against published numbers invalidates the draw.

## [3.171.0] - 2026-10-01

### Added
- **Manual pay eligibility on the OC weekly payout sheet** — an Eligible column
  per member, saved with the week. Migration `0065`.

### Notes
- ⚠️ **The ticket penalty was not a substitute.** Sitting out costs tickets,
  which is proportionate on a ticket-weighted week — but on **equal** and
  **flat-weighted** tickets do not enter the arithmetic at all, so there was no
  way to withhold pay short of deleting the row, which also deletes the record
  that the member was there.
- ⚠️ **An excluded member leaves the DENOMINATOR**, so their share goes to
  everybody else. The pot is fixed: zeroing somebody without removing them means
  the sheet pays out less than the pot and nobody can see where it went. This
  matches `war_payout_members.is_eligible` — two payout sheets that answer "is
  this member paid" differently is how a leader learns one screen and is wrong
  on the other.
- ⚠️ Applied **before** the ticket total is summed, not after. Zeroing tickets
  once the denominator exists strands the share.
- ⚠️ Restoring a saved week rehydrates the eligibility **set**, not just the
  flag on each row. The flag is what the table renders; the set is what the
  recalculation reads, and restoring one without the other looks right until
  something triggers a recompute.
- ⚠️ The column defaults TRUE and is read as `!== false`, so weeks saved before
  this migration are unchanged — they were paid on the old rules.

## [3.170.0] - 2026-10-01

### Changed
- **A finished, empty slot reads "Not filled"** instead of offering a Sign-up
  button — to leadership as well. ⚠️ A leader filling a slot after the fact is
  *assigning somebody*, which the person button beside it does; "Sign up" would
  claim it for the leader themselves.
- **The flag queue and the removed-slots log are leadership only.** ⚠️ The queue
  names members beside a flag, and "absent while the chain was at risk" is an
  accusation until somebody has ruled on it; the removed log is a moderation
  record. Showing a member the rows without the buttons was still showing them
  the charge sheet.

### Added
- **A blanket eligibility switch** on the Chain Watch payout sheet — withhold or
  restore a member's pay for a whole event in one click.

### Fixed
- ⚠️ **The ×2 bonus tooltip looked half-transparent.** Past rows were dimmed
  with `opacity-60`, which applies to the whole subtree and cannot be undone by
  a child — and `InfoTooltip` renders inline rather than in a portal, so the
  panel inherited it. Past rows are dimmed with colour now; the tooltip sets its
  own, so it is unaffected.

### Notes
- ⚠️ The eligibility switch is a **blanket** over the per-slot decisions, not a
  second mechanism beside them. Two answers to "is this slot money" is the drift
  that made the old spreadsheet pay 59 slots where 31 were marked.
- ⚠️ Restoring sets `pay_decision` back to **null**, not `'paid'`. Null is
  undecided-and-payable, the default; `'paid'` would override a genuine flag and
  quietly pay an hour somebody was abroad for.
- ⚠️ It leaves **removed** slots alone and 404s when a member holds nothing — a
  silent 200 on zero rows reads as "withheld" when nothing happened.

## [3.169.0] - 2026-10-01

### Fixed
- ⚠️ **A member could be paid for hours they never watched.** The Chain Watch
  history tab rendered its "Sign up" button unconditionally, and the server's
  `checkSlot` only asked whether an hour was inside the event window — never
  whether it had already run. `is_payable` only asks whether an hour fell
  before the chain ended, so a back-filled claim on an open event was paid
  `payout_per_slot` like any other.

  Not exploited: checked read-only on forge — 1 sign-up total, 0 claimed after
  the hour ran.

### Changed
- **A finished hour is read-only for members**, in the UI and on the server.
  ⚠️ The boundary is the hour's **end**, not its start: claiming the hour you
  are in is legitimate, because you are watching it.
- **Leadership keeps the back-fill**, deliberately — slots need correcting after
  the fact, and no-shows need removing. `created_by` and `created_at` already
  record who did it and when, so it is auditable rather than invisible.
- The grid shows **when a slot was claimed**, and flags one claimed after its
  hour ran.

### Notes
- ⚠️ The DELETE route already had this guard, refusing once an hour has *begun*,
  with leadership exempt and the reasoning documented. Only the claim path was
  missing it — and that asymmetry is how it survived.
- ⚠️ `created_ms` is served alongside `created_at` for the same reason as
  `hour_ms`: the timestamptz arrives with a bare two-digit offset that
  `new Date()` reads as NaN (#140).
- ⚠️ Two existing tests needed their **fixtures** changed, not their
  assertions: both claimed a finished hour as a member to set up a scenario the
  app will no longer produce.

## [3.168.0] - 2026-10-01

### Added
- **Batch pay on the Chain Watch payout sheet** — one link paying everybody
  owed, in the same `batbal_` shape the OC and RW payout sheets use, plus a
  copy button.
- **A payout settings panel** for leadership: payout per slot, bonus hours,
  bonus multiplier and what the bonus applies to, editable from the sheet.
- **Dates on the Dashboard strips** — the war range (start → end, or "Ongoing")
  and each crime's execution date, both sortable.

### Notes
- ⚠️ **The settings panel adds no new authority.** `PATCH /api/chain-events/:id`
  was already leadership-gated and validates every field; this is a frontend
  surface on an existing route. The bounds it checks are copied from that route
  verbatim so the two agree.
- ⚠️ **Changing a setting recalculates hours already served**, which is the
  point — every figure is derived from the event, never stamped onto a sign-up.
  The save reloads rather than patching state locally, or the sheet would show
  numbers that disagree with what was just saved.
- ⚠️ **Batch pay drops rows owed nothing** rather than sending a zero. Torn
  accepts a zero and does nothing, but it pads the link with members who were
  never owed anything, which a leader scanning the result cannot distinguish
  from somebody they expected to pay.
- ⚠️ The war Dates column sorts on `start_at`, not the rendered range; the crime
  Executed column is epoch **seconds**, not a Postgres timestamp.
- ⚠️ `SortableTh` now passes `style` through. It did not, so a caller setting a
  column width was silently ignored — invisible, because the table just lays out
  differently.

## [3.167.0] - 2026-10-01

### Fixed
- ⚠️ **Chain Watch's Bonus column did not sort.** Its accessor read `r.bonus`
  where the field is `r.bonusSlots`, so every value was `undefined`, the
  comparator treated them all as blank, and the tie-break produced the **same
  order in both directions** — the arrow flipped and nothing moved. Ticket range
  had the same fault (`r.first` for `r.firstTicket`).

### Added
- **A guard that every sort accessor reads a real field**, built from the actual
  row producers rather than hand-written fixtures.

### Notes
- ⚠️ This is the gap #840's guard does not cover: that one asks whether a table
  *has* sorting, and cannot tell whether an accessor reads a field that exists.
  Reading a missing one is not an error — it is `undefined`.
- ⚠️ The rows in the new test come from `payoutRows` and `summariseWarPayoutRow`
  themselves. A fixture written beside the accessor would carry the same typo
  and pass.

## [3.166.0] - 2026-10-01

### Added
- **A guard so this cannot happen again** (#803, slice #840). A test scans
  `frontend/src` for a `<table>` with header cells and no sort wiring, and fails
  naming the file. Its allowlist is **empty**.
- **The three OC Simulator panels sort** — Guidance, Joint and Observed. ⚠️ They
  were on #839's list and I missed them; the new guard is what found that, on
  its first run.

### Notes
- ⚠️ **The allowlist must stay empty.** A guard that ships listing the remaining
  offenders documents debt instead of preventing more.
- ⚠️ **What the guard cannot catch**, stated in the test itself: a table whose
  headers come from an unrecognised component, a sort helper imported under
  another name, or a column wired to a sort that does nothing. It catches the
  careless case — a new table with plain `<th>` and no wiring — which is the
  case that actually happened, eight times.
- ⚠️ Comments are stripped before counting headers. `BattleStatsCell` matched
  `<th` twice from prose inside a block comment, which is how a non-table ended
  up on the audit's list of unsorted tables in the first place.
- ⚠️ The guard accepts per-file header adapters, not just the shared component.
  `GlobalAdminView` and `WarRoomViewV2` keep their own for stated reasons; the
  question it asks is whether a table sorts, not whether it was written the
  same way.
- Guidance opens on **impact** descending ("where does training pay off most"),
  Observed on the **CPR band** ascending (it is read as a curve), and Joint
  alphabetically — the order `Object.keys(...).sort()` already gave it.

## [3.165.0] - 2026-10-01

### Added
- **The eight tables that had no sorting at all now sort** (#803, slice #839):
  the Dashboard's OC and war strips, the OC Planner, Chain Watch payouts,
  Competition standings, saved War Payout history and the faction Roles table.

### Notes
- ⚠️ **Chain Watch payouts keep their documented opening order** — slots
  descending, member id ascending, which `chainPayout.ORDER` states has to be
  stable. A first draft opened on payout and would have silently changed what a
  leader sees.
- ⚠️ **Faction Roles: Torn ID sorts numerically.** It is `text` in
  `role_assignments` and `bigint` in `members`, and a lexical sort puts
  `1712182` before `873341`. `Roles` sorts by **count** — "who has the most
  access" is the question that table answers.
- ⚠️ **Ticket range sorts on its first number**, not the rendered `first–last`
  span, which would order "10–19" before "9".
- ⚠️ **The Dashboard's war Score sorts on the member's own contribution**, which
  is what the cell renders — not the faction scoreline.
- ⚠️ **The OC Planner's keys are stable ids, not header text.** Two of its
  headers carry a horizon that changes with a control, and sort state keyed on
  the rendered label would break when the horizon changed.
- ⚠️ Competition standings tie constantly — live forge data has two members on
  15 — so the tie-break is what stops rows swapping on every re-render.

## [3.164.0] - 2026-10-01

### Added
- **RW History: the Type column sorts**, so termed and real wars group (#803,
  slice #838). It had no sort at all.
- **The War Room's headers are keyboard-operable** and announce their sort
  state. A click handler on a `<th>` was invisible to a keyboard.

### Fixed
- ⚠️ RW History's scores were coerced with `|| 0`, making an ongoing war showing
  a genuine **0** indistinguishable from one with no score recorded. An absent
  score now sinks; a zero is a number.

### Notes
- ⚠️ **The War Room's comparator is deliberately NOT on the shared primitive.**
  It ranks activity, roll-call and flags by meaning rather than value, sinks
  unknown FF and missing stat readings in both directions, falls back through
  status → activity → name for timers, and returns 0 for revive chance until the
  fetch lands so the prior order stands. The shared comparator cannot express
  any of that, and the roster table was already fully sortable — 13 columns,
  with only Dibs and Action plain, both correctly so.
- ⚠️ **`MobileWarRoomView` keeps its sort chips** and gains no tappable headers.
  It is a card list, and an explicit control is the better pattern at phone
  width — the decision #838 asked to be stated either way.

## [3.163.0] - 2026-10-01

### Added
- **The Global Admin scraper tables sort** (#803, slice #838, first part). Jobs
  and runs had no sorting at all — on the screen somebody opens *when something
  is already wrong*.

### Notes
- ⚠️ The `activity-sample` failure earlier this cycle ran for two days across
  477 runs. Being able to order that table by status would have surfaced it
  immediately; that is the case this change is for.
- ⚠️ `started_at` here IS a Postgres timestamp string (`fmtDbTime` renders it),
  so it is a real `date` column — unlike the epoch-seconds timestamps in the OC
  and Members tables. A string sort on a `+00` offset is the #140 trap.
- ⚠️ A run that wrote **0 rows** is a finding, not a missing value — it is how a
  silently-failing job looks — so zero stays a real number and sorts as one.
- ⚠️ Runs with no error sink in **both** directions when sorting by Error;
  dragging healthy runs to the top would bury the ones that failed.
- ⚠️ `GlobalAdminView` had its own `SortableTh`, a **fifth** sort convention,
  shadowing the shared component's name. It is a thin adapter now.
- `sortKeyPoolRows` delegates to the shared comparator with its 8 tests
  unchanged, as the proof the behaviour is identical.

## [3.162.0] - 2026-10-01

### Added
- **Qualification and Next Tier are sortable** on Tier Management (#803, slice
  #837). They are derived from `config.tierRequirements`, so the columns are
  built inside the component rather than at module scope.

### Changed
- `CrimesView`, `InventoryManagement`, `TierManagement` and the OC crime
  ranking now use the shared comparator, completing slice #837.

### Fixed
- ⚠️ **Inventory would throw on an item with no name.** Its comparator called
  `aVal.toLowerCase()` with no guard, so one null name blanked the whole table.
- ⚠️ `CrimesView` had **no coercion at all** — a raw `<` / `>` on whatever the
  API returned, so nulls returned 0 and scattered, and every lower-case crime
  name sorted after every upper-case one.

### Notes
- ⚠️ `sortRanking` stays **key-agnostic**. `sortRows` returns rows unchanged for
  a column it does not know, so narrowing it to the declared set would mean a
  caller passing any other field silently gets no sort. A test caught that.
- ⚠️ Tier Management keeps `?? 6` rather than `|| 6`: tier 0 is "Review" and
  must not coalesce, and a member with no tier is deliberately treated as the
  lowest band rather than as missing data.
- ⚠️ Qualification sorts on a **ratio**, not the met count — tiers have
  different numbers of requirements, so "3 met" means something different per
  tier and the raw count would compare unlike things.

## [3.161.0] - 2026-10-01

### Added
- **Sorting on the three Members detail tables** (#803, slice #837, first part):
  a member's crime history, their weekly payout history and their loaned items.
  None of them could be reordered before.

### Changed
- `MembersView`'s roster now uses the shared comparator. ⚠️ Its `id` column was
  coerced with `parseInt(x) || 0`, which collapses a real zero and a missing id
  into the same value.

### Notes
- ⚠️ **Correction to the audit on #803:** the roster is **three** columns
  (Member, Tier/CPR, Actions) and was already sorting both that make sense. The
  recorded "2 of 26" counted all four tables in the file. The gap was the three
  detail tables, which had nothing.
- ⚠️ The crime table's `executed_at` is **epoch seconds**, not a Postgres
  timestamp — the same trap as the OC payout screen.
- ⚠️ The payout table's Week cell renders a date **range**; it sorts on
  `week_start`, because sorting the rendered string orders by text.
- ⚠️ `Diff` can be negative and is the column that shows somebody was paid less
  than theoretical, so nothing in its path coerces with `|| 0`.
- ⚠️ Loaned items sort Type by the **category order** (armour, weapons,
  temporaries, …), not alphabetically — which is how the list has always read.
  That order is kept as the table's default.

## [3.160.0] - 2026-10-01

### Changed
- **The two payout management sheets now use the shared sort primitive** (#803,
  slice #836, second half) — `WarPayoutManagement` and `PayoutManagement`,
  completing the slice.

### Notes
- ⚠️ **`userId` sorted lexically before this**, so `1712182` came before
  `873341`. `PayoutManagement`'s comparator coerced only `name` and let every
  other column fall through to a raw `<` / `>` — the exact defect this epic was
  filed about.
- ⚠️ A **28-case switch** in `WarPayoutManagement` is gone. Its `default` fell
  through to payout, so any key not listed — including a typo — sorted by payout
  and looked like it worked.
- ⚠️ Race wars add dual-block columns keyed `pre.warHits` / `post.partScore`.
  Both windows are generated **always**, not discovered from the rows: deriving
  them from data looked tidier and was wrong, because before the payout loads
  the column would not exist and a sort held on it would silently do nothing.
- ⚠️ `pre.partScore` reads `m.pre.partScore`, **not** the `participationScore`
  that the flat `partScore` column maps to. The two differ on purpose, and the
  difference is pinned by a test.

## [3.159.0] - 2026-10-01

### Added
- **Sorting on six payout tables** (#803, slice #836, first half). `RWPayoutsView`
  and `PayoutsView` — the RW payout modal's member and pre/post breakdown
  tables, and the OC weekly payout, per-member crime and week-comparison tables.

### Changed
- ⚠️ **An ineligible member with no payout now sorts LAST**, in both directions.
  The old comparator read `a[sortCol] ?? 0`, so somebody excluded from a payout
  sorted among the people who earned nothing — and descending, that put them
  above anybody on a genuine zero.
- ⚠️ A member present in only **one** of two compared weeks sorts to the end
  rather than counting as zero. "Earned nothing" and "was not here" are
  different answers.

### Notes
- ⚠️ **Correction to the audit on #803:** `PayoutsView`'s main table was already
  fully sortable. The recorded "1 of 18" counted all three tables in the file
  and missed that its headers are `SortHeader` components rather than raw
  `<th>`. The real gap was the two detail tables, which had nothing.
- ⚠️ `executed_at` in the crime detail table is **epoch seconds**, not a
  Postgres timestamp string. Declaring it a `date` would hand `parseDbTime` a
  number, which it rejects, and the column would silently sort nothing.
- ⚠️ Reward sorts on what the cell **shows** — zero unless the crime succeeded —
  because a failed crime renders "-" while `rewards_money` may still hold a
  figure, and would otherwise outrank a successful one.
- ⚠️ A switch statement with eight cases and a `default` that fell through to
  `payout` is gone: a column added to it later sorted by payout and looked like
  it worked.

## [3.158.0] - 2026-10-01

### Changed
- **The other two sort conventions are gone** (#803, slice #835).
  `StacksSnapshotSection` and `MemberOverview` now use the shared primitive, so
  the app has one way to sort a table instead of three.

### Notes
- ⚠️ `sortSnapshot` is kept as a named export that delegates to `sortRows`,
  because its 19 tests are what prove the shared comparator reproduces that
  table's behaviour exactly — nulls sinking in both directions, member name
  always breaking the tie.
- ⚠️ **Column kinds are now declared rather than sniffed per comparison.** Both
  files previously asked `typeof value === 'string'` on each pair, which falls
  back to a different comparison the moment one row's value is a different type.
- ⚠️ **One deliberate behaviour change:** an identity column whose value is the
  empty string (a member with no property) now sorts **last** rather than first,
  because the shared comparator treats `''` as missing. Stat columns are
  unaffected: they fall back to `-Infinity`, which is a real number and still
  sorts first ascending, exactly as before.

## [3.157.0] - 2026-10-01

### Added
- **A shared table sort primitive** — `utils/tableSort.js` and
  `components/SortableTh.jsx`. First slice of the sortable-tables epic (#803,
  slice #834). `RollCallResultsTable` now uses it, and its existing tests pass
  **unchanged**, which is what proves the lift was faithful.

### Notes
- ⚠️ **Lifted, not designed.** `RollCallResultsTable` already had the right
  shape — a per-column comparator map and a header that renders its own
  affordance — while three other conventions grew up elsewhere in the app.
- ⚠️ **The affordances were never the real defect.** The audit counted 22 tables
  missing sort controls, but the damage was in the comparators: a column with no
  explicit coercion fell through to a raw `<`/`>`, so `null` returned 0 and
  scattered rows to arbitrary positions, `"10" < "9"` sorted lexically, and
  `parseInt(x) || 0` collapsed a real zero into a missing value.
- ⚠️ **Blanks are resolved BEFORE the direction is applied**, which is what
  keeps them last in both directions. Reversing a sort reverses the rows that
  have data; it does not haul the empty ones to the top, where they read as a
  broken sort rather than as missing data.
- ⚠️ **The tie-break runs in a fixed direction**, never the sort's — otherwise a
  live table reshuffles as rows arrive.
- ⚠️ Dates go through `parseDbTime`, and an unparseable one sorts as unknown
  rather than as epoch zero, which would place it in 1970 and therefore first.
- ⚠️ Comparators take the **value**, never the rendered cell: `DashboardView`
  renders Score as `"42015 - 54904"`, and sorting that string is a lexical sort
  on a composite.

## [3.156.0] - 2026-09-30

### Added
- **The tenant registry can mint the Discord bot's own tokens.**
  `GET /api/internal/tenants?tokens=1` now returns each faction's
  `chain_watch_token` and `war_overview_token` alongside its URL.

### Notes
- ⚠️ **Derived, never stored.** A tenant's bot token is
  `HMAC(FLEET_METRICS_SECRET, "<scope>:<slug>")`, so the same computation that
  issued the tenant its value reproduces it on demand. Nothing is generated,
  nothing has to be kept in step, and nothing can be lost.
- ⚠️ **This removes an SSH session from adding a faction.** Previously the
  operator had to run `node db/chain-watch-token.mjs`, paste the result into the
  bot's `.env` and restart it — which is not something anybody can do from a
  phone, so in practice it did not get done and the bot listed factions it could
  never poll.
- ⚠️ **Opt-in**, so the default answer carries no credentials: a consumer that
  only wants to know which factions exist is not handed the means to read them.
- ⚠️ **The fleet secret never leaves the admin container** — only values derived
  under the bot's two scopes. Holding those cannot mint anything else, so losing
  the registry token costs the bot's own access rather than the fleet's. That is
  the property that makes answering this at all defensible.
- ⚠️ The scope strings are duplicated from `db/chainWatchTokenLib.mjs` and
  `db/warOverviewTokenLib.mjs`, and a test imports both and asserts equality. A
  drifted scope is a 401 with no hint as to which side is wrong.

## [3.155.1] - 2026-09-30

### Added
- **`TENANT_BASE_DOMAIN` reaches the admin container.** 3.155.0 added the tenant
  registry and read this variable, but nothing passed it through compose — so it
  was always unset and every `base_url` came back null. Declared on the admin
  service and documented in `.env.example`.

### Notes
- ⚠️ Defaulted to empty like every other value in that block, deliberately.
  Compose interpolates every service when it parses the file, so a `:?` here
  would break `docker compose` for an operator who has not configured the admin
  plane — which is `update.sh`, and would take the whole fleet's deploy down for
  an optional container.

## [3.155.0] - 2026-09-30

### Added
- **A tenant registry for the Discord bot.** `GET /api/internal/tenants` on the
  admin control plane's **local** surface returns every faction in the fleet and
  its public URL. The list is not stored anywhere: `discoverTenants` already
  reads `pg_database`, so a faction appears the moment it is provisioned and
  goes when its database does. This replaces every consumer keeping its own
  copy — the bot's faction command required somebody to retype a slug and a URL
  the control plane already knew, and the two drifted the first time a tenant
  was renamed.

### Notes
- ⚠️ **The public URL is derived, and the domain is a stated tunable.** Every
  tenant vhost is `server_name <slug>.*`, so the domain appears nowhere in the
  nginx config and cannot be read back from it. `TENANT_BASE_DOMAIN` supplies
  it. Unset, the endpoint reports the slugs with a null `base_url` and says why
  — a guessed hostname is only discovered as a connection failure somewhere
  else.
- ⚠️ **Token-authed despite being local-only.** The local port is kept off the
  internet by how it is published, which is a deployment property rather than a
  guarantee this code can make.
- ⚠️ **Its own HMAC scope** (`fleet-tenants`), not a tenant's metrics token:
  knowing which factions exist and reading a faction's metrics are different
  privileges, and one credential should not grant both.
- ⚠️ A missing token answers **503, not 401**. "Not configured" and "wrong
  token" have different fixes, and conflating them sends whoever is debugging to
  rotate a credential that was never the problem.

## [3.154.0] - 2026-09-29

### Added
- **War Overview endpoint: a `bin` argument.** `/api/internal/war-overview` now
  takes `bin=<whole seconds>` (or `bin=auto`, the default), so the Discord bot's
  `/rw-overview` can offer the same Bin size choice the page does — Auto, 1m,
  5m, 1h, 6h, 1d, or a width typed by hand. The resolved width comes back as
  `bin: { seconds, auto }` so the bot can label the chart with what was actually
  used, and `auto` is echoed because "1 h" and "1 h (auto)" answer different
  questions.

### Changed
- **A refused bin width is reported, never clamped.** A width that is not a
  positive whole number of seconds, or that would draw more than `MAX_BINS`
  bars, comes back as an `error` naming the narrowest width that would work.
  Quietly widening a bin the caller named produces a chart whose bars are not
  the width its caller believes — and the bot prints that width. The check runs
  whether or not a chart was asked for, so `summary_only` cannot silently accept
  an argument the same command rejects one keystroke later.

### Notes
- `MAX_BINS` is 20,000, deliberately far above anything the UI offers: the
  narrowest preset (1m) is 2,880 bars across a 48-hour war and 10,080 across a
  week. A tighter bound would start refusing the page's own presets on long
  wars, which is a worse failure than a slow chart. The first draft used 2,000
  and its own test caught it rejecting 1m on a two-day war.

## [3.153.0] - 2026-09-29

### Added
- **`/api/internal/war-overview?chart=1` returns pre-binned series** for the
  Discord bot's chart (#811 slice 4) — three panels (outgoing, incoming,
  revives) of stacked, coloured series.
  ⚠️ **Binned here, not in the bot.** Binning, faction ranking, colour
  assignment and the event classifier all stay beside the summary they must
  agree with; shipping raw rows and binning in Python would be a THIRD
  implementation of logic that has already drifted three times in this repo.
  ⚠️ One colour map across both attack panels, so a faction is the same colour
  top and bottom — two independently ranked maps would recolour the opponent
  between panels, which reads as two different factions. A merc that appears in
  only ONE panel still gets its own colour.
  ⚠️ Factions past the eighth roll into "Other" but their events are still
  counted, so stacked bar heights match the summary printed beside them.
  ⚠️ Opt-in: the summary-only path is the common one and every autocomplete
  keystroke hits this endpoint.

## [3.152.0] - 2026-09-29

### Added
- **`GET /api/internal/war-overview`** — the Discord bot's read-only view of a
  war, for `/rw-overview` (#811). Faction or member mode, an optional
  `warring_only` filter, the participant list for the bot's autocomplete, and
  the recent wars for its picker.
  ⚠️ Its own HMAC scope, `war-overview:<slug>`, **not** a reuse of
  `chain-watch:<slug>`. The same bot holds both; scoping them apart is what
  stops a leak of the board credential also surrendering a war's full attack and
  revive history (#609). Mint with `node db/war-overview-token.mjs`.
  ⚠️ Absent token ⇒ route **unregistered**, not open.
  ⚠️ Every time crosses as epoch **milliseconds**. Postgres serves timestamptz
  with a bare two-digit offset that `new Date` parses to NaN and Python's
  `datetime.fromisoformat` rejects outright.
  ⚠️ `warring_only` excludes `(no faction)` as well as third parties — it is the
  filterable id `0`, and six figures' worth of faction-less rows is most of the
  noise the flag exists to remove.
  ⚠️ Revives are never faction-filtered, whatever `warring_only` says, matching
  the page. `is_termed` is passed through but never gated on: it is set by hand,
  so an untoggled real war is indistinguishable from a termed one here.

### Changed
- `server/src/warOverview/summary.ts` is a **deliberate second implementation**
  of `frontend/src/utils/warOverviewSummary.js`. The page must compute locally —
  it re-renders on every drag of the range slider — and the bot cannot run
  browser JS, so the numbers necessarily exist twice.
  ⚠️ `server/test/war-overview-parity.test.ts` runs BOTH over the same fixtures
  and fails when they disagree, so drift is a red build rather than a Discord
  embed quietly contradicting the page it claims to mirror. Three mutations
  verified: `Special`, revive filtering, and the no-faction key.
## [3.151.0] - 2026-09-29

### Removed
- **The "Fetch Revives" button** on RW History, with its war-picker modal.
  `revives-sync` runs `0 5,35 * * * *` — twice an hour, continuously — so
  `faction_revives` is already populated for every war without anyone pressing
  anything, and the War Overview reads it by war window.
  ⚠️ `POST /api/sync/wars/:id/revives` is **kept**. It is a bounded backfill and
  remains the only way to fill a gap for an old war the continuous cron never
  covered; removing a working endpoint is a bigger decision than removing a
  button nobody needs to press.

## [3.150.1] - 2026-09-29

### Changed
- The War Overview's **per-member** summary now names the opponent too —
  `Marnix0126 [2932241] vs Damage Inc [20747]`, matching the faction view.
  ⚠️ Worth the line because these get screenshotted into a post-mortem weeks
  later, where "which war was this?" is the first thing anybody asks and the
  member's own name answers none of it.
## [3.150.0] - 2026-09-29

### Added
- `scripts/resolve-version-conflict.mjs` — resolves the one merge conflict this
  repo produces on purpose. ⚠️ Every PR bumps `VERSION`, the four `package.json`
  files and adds a dated `CHANGELOG` heading, which is what makes `main`'s
  version strictly increase on every merge (3.143.0 → 3.149.0, no repeats). Two
  PRs cut from the same base therefore always collide on exactly those six
  files. The convention is worth keeping, so the collision is now mechanical:
  the HIGHER version wins, the package files re-sync from it, and BOTH changelog
  entries are kept newest-first.
  ⚠️ Higher, never simply "theirs" — a rebase replays onto the other branch, so
  one side is not reliably the newer one; taking a side blindly can move the
  version backwards.
  ⚠️ It exits non-zero and names any SOURCE conflict it deliberately left alone,
  so a half-finished rebase cannot be committed behind a tidy success message.

### Fixed
- ⚠️ **`docs/agents/delivery-workflow.md` told agents to do the opposite of the
  rule.** It described accumulating lines under `## [Unreleased]` and bumping
  once per release, while `CHANGELOG.md` states there is no `[Unreleased]`
  section and every PR bumps. Agents follow that file. Corrected, with the stale
  batching note replaced by a record of why it is wrong.

## [3.149.0] - 2026-09-29

### Added
- **Revives are split by outcome** on the War Overview — blue *Revived*, orange
  *Failed revive* — and the summary reads Success / Fail / Total.
  ⚠️ A failed revive cost somebody a slot and left the target in hospital, so
  counting it beside the successes overstated how much help actually arrived.
  Anything that is not an explicit `failure` counts as a success: an old row
  with the column unset is far likelier to be one, and defaulting the other way
  would invent a problem that is not there.
- **"(no faction)" is a real entry in the faction filter**, keyed `0` and sorted
  last. ⚠️ Faction-less players rendered as an unfilterable bar — you could
  narrow the plot to one opponent and still be looking at rows you never asked
  for, with no checkbox to turn them off. There are 113k such defender rows.
  ⚠️ `0` is falsy and both trace builders branched on `if (!fid)`, which would
  have routed it straight back into the unfilterable bucket; they now test
  `fid == null`, and the leftover branch is renamed `(unknown)` because it can
  only catch genuinely malformed rows now.

### Fixed
- ⚠️ **The revives legend read `Incoming revives [__revives__]`** — an internal
  key on screen. The label builder appended `[id]` unconditionally; it now does
  so only for real numeric faction ids, which also prevents `(no faction) [0]`.

### Changed
- **The summary is three stacked rows** — Outgoing, Incoming, Revives — matching
  the three plot panels above it, and identical in the faction and member views.
  It was a single wrapped row of pills, and the faction view carried a different
  shape from the member one.

## [3.148.0] - 2026-09-28

### Fixed
- ⚠️ **The War Overview summary ignored the faction filter.** It counted every
  attack in the time window whatever was ticked, so the plot and the numbers
  beneath it could disagree with nothing to say which was right. It now takes
  the same selection the plot uses.
  ⚠️ An INCOMING attack is filtered by its attacker, not by us — testing our own
  faction id would make the filter a no-op in one direction, which reads as a
  display bug rather than a filter.
- ⚠️ **The faction view appeared to have no revives chart.** It built one, but
  revives were stacked by REVIVER faction and an unticked faction contributes no
  trace — so narrowing the filter to the war opponent silently emptied the whole
  panel while the summary still reported the total.

### Changed
- **Revives are bundled into one series and are never faction-filtered**, in
  both views. Being revived by a stranger is not something you choose and the
  reviver is almost never the faction you are warring, so asking which one did
  it was never a question worth a checkbox.
- **Revivers no longer appear in the faction filter list**, which is what made
  it enormous — it now lists only factions that attacked or were attacked.
- **The faction summary splits like the member one**: Attack / Assist / Loss /
  Total for both directions, plus Revives. The same question used to get a
  different answer depending on which toggle you were on.
  ⚠️ `total` counts every attack in scope including results the classifier does
  not recognise, so the three named columns can sum to less — a result type Torn
  adds later shows as a gap rather than being filed under "loss".
- `classifyEventType` moved into `utils/warOverviewSummary` so the plot and the
  summary cannot drift apart about what an event is.
## [3.147.1] - 2026-09-28

### Fixed
- ⚠️ **A Chain Watch UI test failed at random on CI and blocked the 3.147.0
  promotion.** "Test timed out in 5000ms" on a test that takes ~380ms on a
  quiet machine; the same commit passed on a re-run. That is the expensive kind
  of flake, because a test failing at random teaches everyone to wave through a
  red check that might be real — and CI caught two genuine bugs the same day
  that local runs missed.
  The file renders a multi-day hour grid twice in that test, and the CI job runs
  all three workspaces together (the failing run spent 57s in `environment` and
  52s in `collect` alone), so a >13x stretch is contention, not a hang.
  `testTimeout` is raised to 20s **for that file only** — raising it globally
  would hide a genuine hang everywhere else.
  ⚠️ Not `asyncUtilTimeout`: the first fix attempted was a `waitFor` budget,
  which was the wrong knob — the suite passes with that set to 60ms, because
  every `waitFor` there resolves on its first check.

## [3.147.0] - 2026-09-28

### Fixed
- ⚠️ **A live war's Our/Their Score went stale for up to three hours.**
  `attacks-sync` does not touch `ranked_wars` scores — only `wars-sync` does,
  and it runs every three hours. So the attack rows behind the scoreboard could
  be two minutes old while the scoreboard itself was hours out of date, and no
  amount of refreshing the page helped, because the staleness was in the
  database. The only thing that fixed it was the RW History **Fetch Attacks**
  button, which quietly runs `wars-sync` afterwards for exactly this reason —
  so running the attacks job from Global Admin did nothing visible.
  `war-lifecycle` (every 3 minutes) now writes live scores from the
  `/rankedwars` payload it **already fetched and threw away** — no extra Torn
  call, no extra key claim.
  ⚠️ Live wars only. A finished war's score is settled by `rankedwarreport`,
  which is authoritative; the guard holds even when Torn's list endpoint still
  reports a war as live after the row has been closed.
## [3.146.2] - 2026-09-28

### Fixed
- ⚠️ **Assists and Losses read zero for every member.** Torn only sets
  `is_ranked_war` on attacks that **scored**, so a non-scoring attack is never
  flagged — measured on the live Damage Inc war, `0` of 2,714 outgoing assists
  and `0` of 1,236 losses carry it. Filtering on the flag dropped 100% of both.
  They are now scoped the way the Hit Report and payout code already scope war
  attacks: `isWarAttack`, which falls back to **who was attacked**. 2,713 of
  those 2,714 assists are against the opponent faction, so the scope is exact.
  ⚠️ Wins deliberately stay on the strict flag, because Score has to agree with
  `calculateCutoffScores`, which tests it directly. The two scopes differ by 3
  hits in 1,869; a 0.16% disagreement with payout is worth more than those 3.
- ⚠️ **The live contributions table never refreshed.** `openContributions`
  cached per war id for the lifetime of the page, so once a war's numbers had
  loaded they never changed again — the attacks scraper could run every two
  minutes and the modal still showed what it saw first. That reads as "the
  scraper isn't working". An ongoing war now re-fetches on every open; a
  finished war stays cached, because Torn's report is final.

## [3.146.1] - 2026-09-27

### Added
- ⚠️ **CI now checks that `VERSION` matches all four `package.json` files**, and
  fails the PR when it does not. This shipped undetected once: PR #804 branched
  before another bump landed, so its `sed` looked for a version string that was
  not in the file and left `VERSION` at 3.146.0 while every package file still
  said 3.144.1 — with CI green, because the changelog gate only ever verified
  that `CHANGELOG.md` had *changed*. It was caught by hand during a rebase,
  which is not a control.
  It matters because the two are read in different places: `VERSION` feeds the
  footer and `/api/health`, the package files feed npm and the Docker builds —
  so a mismatch means the dashboard reports a version that was never built.
  - `scripts/check-version-sync.mjs`, with `--fix`. ⚠️ Blocking, unlike the
    warn-only changelog gate beside it, and with no escape hatch: a test-only
    PR legitimately needs no changelog line, but there is no such thing as a
    legitimate version mismatch.
  - The same assertion runs in the normal test suite
    (`db/test/version-sync.test.mjs`), so `npm test` catches it before a PR
    exists.
  - The gate now also runs on PRs into `main`. A `dev → main` promotion is
    exactly when a mismatch would reach production, and it was the one PR shape
    never checked.

## [3.146.0] - 2026-09-27

### Added
- **The pre-war stacks sheet now records who was actually AWAKE**
  (`last_action_epoch`, `status_state`), read from `war_room_state_v2` at
  capture — no new Torn call, and nothing borrowed from Chain Watch's sampler,
  which stays a separate feature with its own table.
  ⚠️ **Not backfillable.** `war_room_state_v2` is overwritten in place every
  sweep, so wars whose snapshot is already taken can never gain this. The
  section says so once, at the top, rather than showing a column of dashes that
  would read as "nobody was online".
- **An Outcome column** — the reason the sheet exists. Showed / No-show /
  Turned up / As stated, derived from the roll call answer against actual
  activity. ⚠️ "Turned up" is called out separately: somebody who said they
  could not make it and was there anyway is worth seeing, and filing them under
  the same label as somebody who merely did as promised throws that away.
- **Every column sorts**, with the conventions the recent tables settled on:
  null sinks in both directions, name breaks every tie in a fixed direction,
  and energy sorts numerically (as text, "1000" comes before "750").

### Changed
- **The CSV and the table are now generated from one column list**, so the
  sheet you download cannot disagree with the one you are looking at. That
  drift is why the CSV had eight columns and the table five.
- Three columns removed: `Reading` (the Energy cell's own caveat, already shown
  there as "unknown"), `Max Energy` (never read alone — the cell shows
  `795/150`), and `Said online`. ⚠️ `Said online` and `Availability` were the
  same statement twice: "yes" and "on_time" meant one thing, and a row could
  show `no` + `on_time`, which reads as a contradiction rather than as the
  revision it is. One **Roll call** column now uses the #793 labels.
- `OD before war` is now `OD`, with the scope in a tooltip instead of the
  header: overdosed since this war was MATCHED, not ever.
- Energy shows a single number (`750`), not `750/150`. Every member's maximum
  is the same, so the denominator was a column of noise — and with a constant
  denominator a stack-ratio sort is the raw number scaled, which sorts
  identically anyway.
- The Outcome header tooltip spells out all five values. "Turned up" versus
  "As stated" is not guessable from the labels, and it is the distinction the
  sheet exists to surface.

### Notes
- Filed #803 to audit every table for sortability, rather than keep retrofitting
  one at a time (#793, #794 and this were each found by somebody hitting them).
## [3.145.0] - 2026-09-27

### Added
- **War Contributions (live wars) now shows Assists and Losses**, alongside
  Attacks. Both count war attacks only — ours, outgoing, inside the war — so
  they are comparable with the Attacks column.
  ⚠️ "Loss" follows the model already used by the Hit Report and the war
  timeline: `Lost`, `Timeout`, `Interrupted`, **`Stalemate` and `Escape`**. A
  third meaning of the word would be worse than any one of them.
  ⚠️ A member who only assisted used to be **invisible** here: the result
  filter ran before aggregation, so forty assists and no wins read as having
  done nothing at all.

### Changed
- **The live Score column reads `1,606.13 (1,402.00)` under the header
  "Score (Normalized)".** The badge said "bonus-normalized" but the table
  showed a single number, so there was no way to tell a normalised score from a
  raw one. The leading figure is the respect Torn reports as that member's war
  score; the bracketed one caps each chain-bonus hit at 10 and is what payout
  shares are computed from. Sorting stays on the bracketed figure — it is the
  one that decides who is near a threshold.
  A finished war is unchanged: Torn reports one whole number and it stays
  single.
- `LOSS_RESULTS` and `ASSIST_RESULT` are exported from
  `warPayoutCalculations.js` and imported by `WarOverviewView`, which carried
  its own copy of the loss list. "Loss" could have drifted between the timeline
  and the Hit Report with nothing failing.
  ⚠️ `WIN_RESULTS` deliberately still excludes `Special`, and now says so: every
  payout path tests that set directly, so adding it would silently change what
  people are paid. The timeline opts in locally instead.

## [3.144.1] - 2026-09-27

### Fixed
- ⚠️ **The `activity-sample` scraper threw `RangeError: Invalid time value` on
  every run once it had latched its first departure**, so Chain Watch stopped
  recording who was around and who was in the air — 477 consecutive failures on
  staging over two days, and nothing in the UI said so.
  `src/db.ts` installs a process-wide `setTypeParser` for timestamptz, so the
  column arrives as `2026-09-25T00:25:41.074+00` — a bare two-digit offset,
  which is not ISO-8601. `new Date()` rejects it, `.getTime()` yields NaN,
  `NaN == null` is false, and the NaN reaches `new Date(NaN).toISOString()`,
  which throws. Both timestamps are now converted to epoch milliseconds **by
  Postgres**, the way the same query already handled `sampled_at`.
  ⚠️ `globalDb.ts` carries a comment warning about this exact trap; this is the
  second time it has been walked into, so the rule is now "format in SQL", with
  no exceptions.
  ⚠️ The write is also guarded with `Number.isFinite` rather than `!= null`.
  Every member goes in ONE insert, so a single unrenderable value does not
  spoil one row — it throws and loses the whole roster's sample. That is what
  turned one member's timestamp into two days of nothing for 94 people.

## [3.144.0] - 2026-09-27

### Added
- Chain Watch's push-a-redraw socket can now be wired into the **production**
  fleet. Staging has pushed instantly since #785; production never did, because
  its per-faction services live in a `docker-compose.override.yml` generated on
  the box that nothing in the repo could reach — so a faction pointed at its
  real dashboard silently fell back to the five-minute poll, and a board that is
  merely late is not something anybody reports.
  `node db/chain-notify-wire.mjs --write <slug>` adds it to existing services
  (with a backup); `db/new-faction.mjs` now writes it for new ones.
  ⚠️ `CHAIN_NOTIFY_SOCKET` is derived from `CHAIN_NOTIFY_DIR` with compose's
  `:+`, so one variable turns it on and a socket path can never be set with
  nothing mounted at it. Unset, every tenant behaves exactly as it does today.

### Changed
- The Chain Watch runbook gains the production path, the permissions the bot
  needs in Discord (including that a **thread** needs Send Messages in Threads
  rather than Send Messages, and that both are set on the parent channel), and
  a section on which dashboard a slug actually reads — a bot tenant named
  `forge` pointed at `dev.monchoon.me` reads staging, and nothing on the board
  says so.

## [3.143.1] - 2026-09-26

### Fixed
- **Chain Watch: the projection's hit rate is served as `hits_per_hour` (#785).**
  ⚠️ `projectChain` returns `hitsPerHour` because it is internal TypeScript, and
  letting that through made the projection the **one camelCase key** in an
  otherwise snake_case payload. The Discord bot read `hits_per_hour`, the board
  raised `KeyError`, and — because the board is drawn before the pings — the
  whole tick aborted and nobody was told their shift had started.
  - ⚠️ **It worked for days first.** An unmeasurable projection never touches
    that field, so the crash only arrived once the chain had 24 hours of
    history and the band became computable.
  - `hitsPerHour` is still emitted alongside it, so a bot deployed before this
    fix and one deployed after both keep working.
  - ⚠️ A new test walks the whole payload and fails on **any** camelCase key. A
    field only one side of the contract can read shows up as a crash days
    later, not as a failing test.

## [3.143.0] - 2026-09-26

### Added
- **War Room: each member's roll call answer, on their roster row (#793).** A new
  sortable **Roll Call** column between Name and Activity, so "who is actually
  turning up at opening, and how big are they" stops being two pages and a
  memory. Reported by Goosey.
  - ⚠️ **Seven states, not six.** `RollCallOverlay` submits
    `availability || null`, so a member can answer "not on at start" and never
    pick how late — that renders as **Late**, not **N/A**. They *did* respond,
    and a lead chasing non-responders would otherwise chase them for nothing.
  - Order is `Here → 1-2 → 3-5 → 6+ → Late → Unavailable → N/A`, with the full
    wording in a tooltip: `3-5` means nothing to anybody who has not filled the
    survey in.
  - ⚠️ **`N/A` sinks in BOTH directions**, the rule `ff` and the member-stat
    columns already follow. A non-response is not "least available", it is
    unknown, and parking it at either end asserts something untrue.
  - ⚠️ Our-roster only, and registered in `OUR_ROSTER_SORT_COLS` — `sortCol` is
    persisted, so sorting by it and toggling to the opponent would otherwise
    leave every row comparing equal with no header arrow.
- **The roll-call results table sorts by every header (#793).** Member, Start,
  Self-hosp and Availability, in the leadership notes panel and the "responded"
  modal alike.
  - ⚠️ **Availability sorts by how late, never by label text.** Alphabetical
    gives `1–2 Hours Late, 3–5, 6+, On time, Will not be available` — which
    buries the people who are turning up in the middle of the list.
  - ⚠️ Sort state lives in the component, so both callers get it; and name
    breaks every tie in a fixed direction, or the table reshuffles under a lead
    as responses arrive.
  - One shared ordering in `rollCall.js` serves both surfaces — two orderings of
    the same seven states would drift, and the one that drifts is the one
    nobody is looking at.
  - Stats filtering and sorting were already shipped; no change there.

## [3.142.2] - 2026-09-25

### Fixed
- **Chain Watch: travellers no longer render as "somewhere" (#785).**
  ⚠️ **Torn writes `Traveling from Torn to UAE`, not `Traveling to UAE`.** The
  parser was written against a form Torn never sends, so every traveller on the
  board showed as "✈️ somewhere" — which read as missing data rather than a
  broken regex. Caught only by dumping the raw `status_description` from a live
  faction.
  - ⚠️ A flight **home** still reports `Torn`, not the country being left:
    naming the country would tell a lead somebody is flying OUT at the exact
    moment they are flying back in.
  - The old regex was also unanchored, so `In` could match mid-sentence.
  - The phrasings it was originally written for still parse, since a silent
    null here is a board that says "somewhere".

## [3.142.1] - 2026-09-25

### Fixed
- **Staging's Chain Watch config now survives a redeploy.**
  `DEV_CHAIN_WATCH_TOKEN` and `DEV_CHAIN_NOTIFY_DIR` are read from
  `deploy/.env` (and, failing that, the previous `.env.dev`) rather than only
  from the command line.
  - ⚠️ **Passing the token once appeared to work and then silently stopped.**
    `.env.dev` is regenerated on every deploy, so the `--if-changed` cron wiped
    it on the next push to `dev`; the endpoint returned to 404 and the Discord
    board simply stopped updating, with nothing to say why. Hit live.
  - Same precedence the sticky `DEV_SLUG` and `DEV_HTTP_PORT` already use:
    environment, then `deploy/.env`, then the previous `.env.dev`.
  - ⚠️ `DEV_CHAIN_NOTIFY_DIR` should be a directory the bot's own user owns.
    `/run` is root-owned, so creating it needs `sudo` — and it is a tmpfs, so it
    is empty again after a reboot and the socket would vanish on restart.

## [3.142.0] - 2026-09-24

### Added
- **Chain Watch: the dashboard nudges the Discord bot when a sign-up changes
  (#785 follow-up).** The board redraws in seconds instead of on the bot's
  5-minute poll — somebody claiming a slot sees it appear rather than staring at
  an unchanged board wondering whether it worked.
  - ⚠️ **Over a bind-mounted unix socket, not a TCP port.** A container cannot
    reach the host's `127.0.0.1`, and the obvious fix — binding `0.0.0.0` —
    would put a control channel for a process holding a Discord token and five
    tenant bearers on the public internet. A socket has no port, needs no
    firewall rule, and carries no credential that could leak.
  - ⚠️ **Fire and forget.** A member clicking "sign up" never sees an error, or
    waits, because the bot is down. Every failure is swallowed and the bot's
    polling remains the backstop, so the worst case is the board being one poll
    stale — where it was before this existed.
  - ⚠️ **One `onResponse` hook, not a call per route.** There are eight mutating
    routes and more will be added; a nudge that must be remembered per-route
    gets forgotten, and the symptom — a board stale only after one particular
    action — is invisible in testing. Fires on success only, so contention on a
    slot does not generate Discord load.
  - `CHAIN_NOTIFY_SOCKET` unset disables it on both sides. Staging wiring and the
    reasoning are in `deploy/DEV.md`.

## [3.141.2] - 2026-09-24

### Added
- **Staging can serve the Chain Watch bot endpoint (#782).** `DEV_CHAIN_WATCH_TOKEN`
  passes a token through `dev-deploy.sh` to the staging instance, so the Discord
  bot can be tested against the `_dev` copy instead of waiting for the endpoint
  to reach a live tenant.
  - ⚠️ **Unset leaves the route unregistered**, not merely unauthenticated — a
    staging instance nobody asked to expose exposes nothing.
  - ⚠️ Use a value of its own, not the live tenant's token: both read the same
    faction's data, but a token that only opens the copy cannot be turned on
    production.
  - ⚠️ `.env.dev` is regenerated on every deploy, so the token must be passed on
    each `dev-deploy.sh` or exported in the cron's environment. Documented in
    `deploy/DEV.md`, including in the blast-radius table.

## [3.141.1] - 2026-09-23

### Added
- **Chain Watch: the roster rides along for the bot's identity map (#784).**
  `/api/internal/chain-watch` now carries `members` — current faction members,
  id and name.
  - ⚠️ **Without it the auto-match can only read a Discord nickname that
    literally contains `Name [123456]`**, and everyone else falls to the manual
    `/chain link` escape hatch. Linking ~100 people by hand is the chore that
    does not get done, and a half-populated map sends pings that reach some
    members and not others — worse than none, because nobody can tell which.
  - ⚠️ **Served even with no event running.** The identity map is standing
    state, not per-event; linking that only worked mid-chain would mean the
    first chain of the year starts with an empty map.
  - ⚠️ **Current members only.** Someone who left stops being pinged — the bot
    keeps their link, since people rejoin, but they are not roster.
  - No new exposure: the same ids and names already ride in `hours[].watchers`,
    and both are public Torn data.

## [3.141.0] - 2026-09-23

### Added
- **Chain Watch: a read endpoint for the Discord bot (#782).** `GET
  /api/internal/chain-watch` serves the board the bot renders — the open event,
  every hour in the next day *including the ones nobody signed up for*, each
  watcher's travel state, the chain projection band, and the gap horizon.
  - ⚠️ **It derives nothing new.** The projection comes from `projectChain`, the
    travel facts from the same `member_activity_samples` series the review flags
    read. Two implementations of "is this slot at risk" drift, and the one that
    drifts is the one nobody is looking at.
  - ⚠️ **`gap_horizon_hours` is served, not assumed.** `GAP_HORIZON_HOURS` now
    has one definition (`server/src/chain/chainHorizon.ts`); the bot is
    forbidden its own copy, so the page and the channel cannot disagree about
    what "soon" means.
  - ⚠️ **Its own scoped token**, `HMAC(FLEET_METRICS_SECRET, "chain-watch:"+slug)`,
    deliberately *not* `FLEET_METRICS_TOKEN`. The bot runs off the box and sits
    in servers full of people; reusing the metrics token would hand it key-pool
    depth — reconnaissance, per #609 — as a side effect of wanting sign-up
    times.
  - ⚠️ **No event → 200 with a null event, never a 404.** "Nothing is running"
    is the right answer most of the year; an error looks like an outage and puts
    the bot in a retry loop. The same applies the moment `actually_ended_at` is
    set: an empty-slot ping for a finished chain wakes somebody at 3am for
    nothing, which is how a channel learns to mute a bot.
  - ⚠️ **Every time crosses as epoch milliseconds.** The #140 trap bites Python
    too — `datetime.fromisoformat` rejects Postgres' bare two-digit offset.
  - `db/chain-watch-token.mjs` provisions tenants; runbook at
    `docs/runbooks/chain-watch-discord.md`.

## [3.140.1] - 2026-09-23

### Changed
- **Chain Watch: the bold hour now says `TCT`.** The sign-up grid prints the
  canonical hour in bold with the viewer's own clock in grey underneath, but the
  bold line carried no unit — so it read as "some timezone", and the obvious
  guess is the reader's own, which is the line *below* it. The unit is spelled
  out on every row rather than in a column heading: the grid scrolls for a
  twelve-day chain, so a heading is off-screen for all but the first few hours.

### Fixed
- **Member metrics: staleness no longer depends on the time of day.** `stale_days`
  subtracted a DATE (`snapshot_date`, parsed to 00:00Z) from a live clock, so the
  time of day rode along as a fraction of a day and `Math.round` tipped it at
  12:00 UTC — the same snapshot read as 10 days old in the morning and 11 in the
  afternoon. Both ends now snap to UTC midnight. Caught because the existing
  `#764` test for it had started failing on `dev` every afternoon.

## [3.140.0] - 2026-09-23

### Added
- **Chain Watch: payout and raffle ranges (#773).** The last slice of the #768
  epic — the half of the spreadsheet that turns served hours into money.
  - One row per watcher: slots, bonus slots, raffle tickets, a contiguous ticket
    range, and **one payout number** carried verbatim by the
    `addMoneyTo` link. ⚠️ The sheet showed Warwinds `35,000,000` beside a link
    paying `34,500,000`; two numbers on a row, one of which is never the amount
    sent.
  - ⚠️ **The total is computed from the rows.** The sheet's totals row read
    `189.5` bonus slots — exactly half the slot count, a stray `/2` — where its
    own member rows summed to 59.
  - **Ticket ranges** cover `1..total` exactly once, assigned in a stated order
    (slots descending, then member id) so the numbering does not reshuffle
    between renders. Drawing the winner stays out of scope, as the sheet had it.
  - **A flag queue**, at-risk rows first. ⚠️ `pay_decision` is nullable and
    **null means "not looked at yet", which is neither paid nor unpaid** — an
    undecided flagged slot still counts as payable, because a flag asks a
    question rather than withholding money on its own. Only an explicit `unpaid`
    and `abroad` withhold pay, and a leader can overrule even `abroad`: the app
    records, it does not adjudicate.
  - **Removed slots on hours that had already run** are shown struck through
    with who removed them and why. ⚠️ Removed is not the same as never signed
    up, and this panel is the only place anyone looks.
  - ⚠️ **A dropped chain gets a post-mortem**, naming who was on watch for the
    final hour, and **withdraws the raffle while still paying the slots**.

### Fixed
- ⚠️ **The chain's end is now derived from `chain_samples`, which #774 said it
  would be and did not do.** `chainOutcome` reads the cooldown transition back
  out of the series — the entire reason it is append-only rather than a
  singleton — so the end can be established hours later, when the payout is
  actually reconciled. A leader's explicit `actually_ended_at` still wins, and
  both feed **one** SQL expression so the grid and the payout panel cannot
  disagree about which hours were real.
  ⚠️ "Dropped" is decided by the **peak**, not by which sample caught the
  timer: Torn reports chain `0` once a chain closes, so reading the last sample
  as the peak would call every completed chain a drop.

## [3.139.1] - 2026-09-23

### Added
- **Chain Watch: a way to open one (#772 follow-up).** The page could say "no
  chain watch is open yet" and offer nothing to do about it — the only way to
  create an event was a `POST` from a terminal, which is a dead end on a page
  built for a leader at 2am.
  - ⚠️ **Takes a number of DAYS and a TCT start, never an end date.** The
    server derives `ends_at` keeping the start hour, and the window grows a day
    at a time from there. The 2025 sheet was generated for 25 Oct 10:00 → 1 Nov
    16:00 TCT and the chain outran it; sign-ups were extended through 3 Nov by
    hand.
  - The chosen TCT start is echoed back **in the viewer's own time**, so nobody
    opens a fortnight of sign-ups twelve hours off by accident.
  - Bonus hours are entered as **hours of the day** and are changeable later.

## [3.139.0] - 2026-09-23

### Added
- **Chain Watch: chain and activity sampling, travel, and the review flags
  (#774).** Slice 4 of the #768 epic — what turns "they signed up" into "they
  were there", without letting the app decide.
  - **Two samplers, both append-only.** `chain-sample` records the chain counter
    and its timer every 4 minutes; `activity-sample` records the whole roster's
    `last_action` and status every 5.
    ⚠️ **Neither reuses the War Room's chain poller**, and the reasons compound:
    it only runs during a war (`!cfg.faction_id` — a chain has no opponent),
    `war_room_chain_v2` is a singleton whose every poll overwrites the last, and
    its 5-second cadence would cost ~200,000 Torn calls over a twelve-day event.
    4 minutes is enough *because payout is hourly*.
  - ⚠️ **One roster call covers everything.** `/v2/faction/members` returns
    `last_action` **and** the full status object (including `plane_image_type`),
    so sampling costs the same whether 2 people signed up or 40 — and it records
    who was awake at 04:00 and did **not** sign up, which is the recruiting list
    for the next night's gaps.
  - **The flags**, surfaced on the event read for a leader to confirm:
    *absent*, *absent while the chain was at risk*, and *abroad*.
    ⚠️ **Zero attacks is deliberately not a flag.** During a healthy chain a
    watcher with no hits did the job; flagging on attacks would fire across most
    of a *successful* event and leadership would click through hundreds of amber
    rows without reading. The signal is activity, not attacks — and it detects
    **absence, not attention**.
    ⚠️ An hour with no samples yields **no flag**: "we were not looking" must
    never render as "they were not there".
    `abroad` is the only one that moves `is_payable`, because a watcher overseas
    could not have hit anything.
  - **The projected finish**, from the delta in `faction_attacks.chain` — the
    chain counter itself, not a count of attacks, since only qualifying attacks
    advance a chain. ⚠️ Measured over **whole days**, because hit rate is
    violently diurnal and a six-hour window extrapolated at 03:00 says something
    wildly different from the same chain at 19:00. Returned as a **band**, and
    refused outright below a day of data — an absent projection is fine, a
    confident wrong one is not.

### Fixed
- ⚠️ **The #140 trap, server-side (`server/src/chainWatch.ts`).** Flag evidence
  was keyed on `new Date(row.hour_start)`, and Postgres serves timestamptz with
  a bare two-digit offset (`2026-09-23T03:00:00-05`) that parses to **NaN**. Two
  consequences, both silent: every flag was computed against an invalid hour, so
  a watcher who *was* around read as absent; and because both sides of the
  lookup stringify to `"NaN:9200"`, **one member's flagged hours collapsed into
  a single key** — one hour's verdict could be stamped on another. Both queries
  now hand epoch ms out of SQL and nothing parses a DB timestamp in JS.

## [3.138.0] - 2026-09-22

### Added
- **Chain Watch: the sign-up grid, in TCT and the viewer's own time (#772).**
  Slice 2 of the #768 epic — a **Chain Watch** tab on the Members page, beside
  Calendar. Two tabs: **Sign up** (the current hour onward) and **History**
  (what has run, where #773's payout and flags will live).
  - ⚠️ **The local-time column is formatted per row, from that row's own
    instant** — never by adding a fixed offset. The spreadsheet typed three
    zone rows by hand, the 2025 event crossed the US DST change, and rows
    100–101 of the workbook still list `2:00-3:00` twice where somebody patched
    the fold. Two rows showing the same local clock time across a fold is
    **correct**, and there is a test pinning it: 05:00 and 06:00 TCT on 7 Nov
    both read `01:00` in New York because they are two instants an hour apart.
  - ⚠️ **"Elapsed" is decided by the server's clock, which now travels with
    the event payload.** A viewer with a skewed system time would otherwise be
    shown still-claimable hours as gone — and that viewer is the half-asleep
    person at 3am this page exists for.
  - **Add a day / Remove last day.** No confirmation on add (harmless,
    reversible, and the most frequent action on the page); remove confirms, and
    a server refusal names who is still on the last day rather than failing
    generically. The reload is quiet, so the reader keeps their scroll position.
  - ⚠️ **The coverage headline leads with the next unstaffed hour**, and any
    count is scoped to a 48-hour horizon. An unbounded total would leap the
    instant somebody clicks *Add a day*, reading as the roster collapsing at the
    exact moment the window grew.
  - **The six-hour warning counts slots, not hours**, at one severity — an hour
    holding one of two watchers alerts exactly as an hour holding none does. The
    sentence still marks the fully naked hours (`17:00 (both)`), because one
    severity is a decision about alarm, not about information.
  - **Leadership can assign, replace and remove anyone**, on elapsed hours too.
    ⚠️ The picker keeps whoever holds the other slot of that hour in the list,
    **disabled with the reason**, rather than dropping them — a leader hunting
    for a missing name concludes the picker is broken.
  - A member may drop their own slot until the hour starts, and the control is
    not buried.

### Changed
- **API errors carry `status` and `body` (`frontend/src/utils/apiClient.js`).**
  Callers had to match on the message text to tell a `409` "somebody just took
  that" — a normal race — from a real failure, and a structured refusal body was
  discarded entirely. `apiDelete` also takes an optional payload; existing
  single-argument callers are unaffected.

### Fixed
- ⚠️ **`InfoTooltip`'s `label` is the visible trigger and `children` is the
  panel.** Passing them the other way round renders the explanation as permanent
  body text and drops the trigger altogether — caught here on the bonus-hour
  badge, which had become the sentence "05:00 pays 2× raffle tickets" in the
  grid.

## [3.137.0] - 2026-09-22

### Added
- **Chain Watch: the schema and API behind the hourly sign-up sheet (#771).**
  First slice of the #768 epic — nothing user-facing yet. It replaces a Google
  Sheet that worked, so the shape is driven by the three things that sheet
  could not do:
  - ⚠️ **Sign-ups key on the Torn player ID, never a display name.** The
    workbook matched watchers with `COUNTIF` over the grid; its own roster tab
    now reads `Muttley_616` where its frozen 2025 grid says `Muttley`, and a
    rename returned `0` with no error at all.
  - ⚠️ **Bonus hours are hours-of-day, derived at read time.** The sheet pinned
    its bonus to spreadsheet *columns* H:I — 05:00–07:00 TCT on one block and
    17:00–19:00 on the next — and paid 59 slots where only 31 were marked.
    Leadership can now correct the hours mid-event and the correction applies to
    hours already served.
  - ⚠️ **The window grows a day at a time, server-side.** The 2025 grid was
    generated for 25 Oct 10:00 → 1 Nov 16:00 TCT and the chain outran it; the
    real sheet carries sign-ups through 3 Nov, extended by hand. `POST /days`
    moves `ends_at` forward 24h *preserving the start hour* — an event does not
    begin at midnight, and snapping to one would have added 14h on the first
    click.
  - ⚠️ **Giving up a slot is a soft delete.** A sign-up drives money; deleting
    the row destroys the only evidence that someone held the hour. `removed_by`
    is what separates "I dropped it" from "I was dropped", which must not read
    identically at payout. The slot uniqueness index is therefore **partial**
    (`WHERE removed_at IS NULL`) so a freed slot can be re-claimed while the
    history survives.
  - ⚠️ **One member cannot hold both slots of an hour**, enforced by a second
    partial unique index rather than a handler check — the race is real (two
    tabs, or a leader assigning as the member claims). Consecutive hours stay
    allowed. The 2025 sheet never doubled up: 0 of 211 served hours.
  - ⚠️ **A member may always drop their own slot until the hour starts**, and
    is refused after. Someone who knows at 22:00 they will not make 04:00 must
    be able to say so while there is still time to refill it — otherwise the
    silent no-show is the path of least resistance, and that is what costs a
    chain.
  - Every mutation of the event is `requireRole('leadership','admin')`, written
    on each route with a test per route, because the bonus fields retroactively
    change what members are owed.
  - Also lands the append-only `chain_samples` and `member_activity_samples`
    tables that #774 will write — deliberately **not** `war_room_chain_v2`,
    which is a singleton with no history whose poller only runs during a war.
## [3.136.2] - 2026-09-26

### Added
- **War Room: the Flags column sorts.** Click it to group the roster by what is
  wrong with somebody — everyone overdosed together, everyone flying together.
  - ⚠️ **Ranked by severity, not alphabetically.** Alphabetical would put
    "early discharge" above "overdosed", and finding the people who cannot
    fight is the entire reason to group this column.
  - ⚠️ **Keys on a member's MOST significant flag**, not their first.
    `memberFlags` pushes flying before overdosed, so taking the first would
    file somebody flying-and-overdosed under "flying".
  - ⚠️ **Unflagged members sink in both directions**, the same rule `ff`
    follows — reversing the sort shows the other end of the interesting rows
    rather than a screen of people with nothing wrong.
  - The comparator builds each member's flags exactly as the cell does, from
    the same two inputs, so what the column shows and what it sorts by cannot
    drift apart.

## [3.136.1] - 2026-09-22

### Fixed
- **CI: the Compose job read its host port before the last thing that rebinds
  it.** The port-0 change in v3.136.0 closed a TOCTOU race by letting the kernel
  assign at bind time and reading the number back with `docker compose port` —
  but it read it once, right after the first `up`. ⚠️ The faction bring-up a
  few steps later **recreates nginx** (the override file and the new forge vhost
  change its config), and with `HTTP_PORT=0` the kernel hands out a *fresh* port
  on that second bind. Every probe then hit the stale number: `curl: (7) Failed
  to connect to localhost port 32779` eleven times over, while nginx sat healthy
  on a port nothing was asking for. The ports are now re-read after the
  recreate, and the comment on the first readback says outright that it is not
  the last bind.

## [3.136.0] - 2026-09-22

### Fixed
- **Member Overview: the window's delta could cover the wrong days and still
  report itself complete (#764).** Two defects, both silent — the row showed
  `data_complete: true` with no amber flag in each case.
  - ⚠️ **The delta could reach PAST the window.** `pickOldestInWindow` returns
    the first snapshot at or before the boundary, and with a scraper gap that
    can be far older. Snapshots today and 45 days ago under a 30-day window gave
    `days_covered: 45, data_complete: true` — **a column headed "30d" showing 45
    days of gain**. Because `daysCovered >= windowDays` was the completeness
    test, overshooting made a row look *more* complete, and a member could pass
    a 30-day requirement on 45 days of activity.
  - ⚠️ **The window was not anchored to today.** `newest` is whatever
    `snaps[0]` happens to be, so a member whose key died ten days ago reported
    "the 30 days ending 10 days ago" as the last 30 — the case that most looks
    like somebody going quiet.
  - ⚠️ **`classifyRow` no longer turns either into a confirmed failure.** A rate
    measured over the wrong days is not a verdict about a person. Both now land
    in *inconclusive* (amber), which asks a human to look. The stale case is the
    dangerous direction: somebody who stopped playing still carries their old
    rate, and this module's rule is that missing data is never a silent pass.
    Point-in-time thresholds (tenure, streak) are unaffected — they do not
    depend on the delta — and so are the non-threshold red flags.
  - The reasons are named separately rather than collapsed into "partial":
    *too short* means wait, *spans longer* means the scraper has a gap, *stale*
    means this member is no longer being measured. Three different actions.
  - `MAX_SNAPSHOT_AGE_DAYS = 2` is a stated tunable: `member-stats` sweeps once
    a day, so calling a one-day-old snapshot stale would paint the whole roster
    amber every morning before the job runs.

## [3.135.0] - 2026-09-22

### Added
- **The OC Simulator shows when we actually take our seats (#744).** Slice 3,
  which closes the issue's scope.
  - The headline is the thing nothing surfaced before: *"Our 6th seat in a
    6-role crime is taken 55h before it is needed — about 5.7 person-days per
    crime, freed with no training and no scope cost."* ⚠️ It says what the
    earliness **buys**, not just that it exists: "55h early" is a fact, and the
    person-days are the reason to act on it.
  - Each seat is drawn on one axis against the hour it is needed, because the
    distance between the two marks *is* the finding.
  - ⚠️ **Late seats are shown, not hidden.** capacityx's first two seats are
    late. A panel drawing only the early side would imply a faction is
    uniformly early and make the advice wrong for exactly the seats it is wrong
    about.
  - ⚠️ A faction already on schedule is told so rather than handed a number to
    chase, and seats dropped for too few runs are named — a table missing seat 4
    with no explanation reads as "nobody ever sits there", which is a far more
    alarming claim than "we could not look".
  - Placed **above** the crime cards: seat timing is a property of how the
    faction runs crimes rather than of any crime, and it is the only lever on
    the page that costs nothing. Burying it under six cards would put the
    cheapest win last.
  - ⚠️ Its own file and its state in the outer component, per the v3.97.0 crash
    — a panel declared inside the view it serves is a temporal-dead-zone throw
    that builds cleanly and dies on render.

## [3.134.0] - 2026-09-20

### Changed
- **`g` was never a "join gap" — renamed to `slackPerSeat`, and the published
  guidance now says the right thing (#744).** Slice 2.
  - ⚠️ **The published wording was backwards.** The guidance table said
    *"Join gap of 12h between members"*, explained in `docs/oc-cpr-algorithm.md`
    as "nobody joins the instant the previous role's 24h expires" — people
    arriving **late**. Measured, the opposite happens: capacityx takes its sixth
    seat at hour 65 for a slot not needed until 120. The old wording sent a
    reader hunting for a way to fill faster; the real lever is to stop taking a
    seat before it is needed. It now reads *"Each seat after the first held 12h
    beyond its schedule"*, and says whether that is measured or assumed.
  - `GAP_DEFAULT_DAYS` → `SLACK_DEFAULT_DAYS`, `GAP_MAX_DAYS` →
    `SLACK_MAX_DAYS`, and the `gap` / `gapIsAssumed` fields → `slackPerSeat` /
    `slackIsAssumed` through the person-day model, the guidance pipeline, the
    guidance table and the spawn simulation. No arithmetic changed.
  - `docs/oc-cpr-algorithm.md` carries the correction as its own section, with
    the measured seat table for all three factions and the two reasons one
    number cannot stand in for two mechanisms: tnl's wall-clock excess is
    *larger* than forge's while its person-day excess is far smaller, and
    netting early against late calls tnl's 11.3h of early seating "2.6h".
  - The test guarding the published wording was tightened: it matched
    `/12h|gap/i`, which the corrected string passes and the wrong one does too.
    It now asserts the new phrasing **and** that "join gap" is absent.

## [3.133.0] - 2026-09-20

### Added
- **Seat timing: when members actually sit down, against when the seat is
  needed (#744).** Slice 1 — the measurement and its endpoint; no UI yet.
  - ⚠️ #687's `g` conflates two mechanisms — members queueing up at the front of
    a crime, and the crime itself running long — and **only the first is
    something a faction can change tomorrow**. One number cannot separate them:
    tnl's wall-clock excess is *larger* than forge's while its person-day excess
    is far smaller. This measures the seating on its own.
  - A crime completes `24h × n` after the first join and all slots are open from
    the start, so seat `s` is not needed until hour `24 × (s − 1)`. capacityx
    takes its sixth seat at hour 65 for a slot not needed until 120 — 55 hours
    of lock-in that buys nothing, because a member cannot be in two organized
    crimes at once.
  - ⚠️ **Early and late are reported separately, never netted.** tnl is the case
    that shows why: seats 2 and 6 are 11.3h early between them and the rest are
    8.7h late, so a signed sum calls the whole thing 2.6h and reports a faction
    as nearly fine when it is not.
  - ⚠️ Seat 1 is never counted early — that join *starts* the clock, so there is
    no earlier hour it could have been taken.
  - ⚠️ Seat order comes from `joined_at`, and the baseline is `min(joined_at)`
    over the crime's own slots rather than `planning_at` or `created_at`.
    Measuring from `created_at` reports recruitment lag instead, which is the
    mistake an earlier draft of #744 made.

### Fixed
- **#744 contradicted itself and has been corrected.** It carried both a
  "pausing IS real" correction and the first draft's "not pausing,
  `ready_at → executed_at` is 0.0h median" claim that the correction refutes.
  The stale section is rewritten: pausing is real, it lives in
  `planning → ready`, and the 0.0h median was a useless statistic on a
  long-tailed distribution rather than a wrong one.

## [3.132.1] - 2026-09-20

### Fixed
- **CI's Compose job raced itself for a host port.** ⚠️ PR #746 failed with
  `failed to bind host port 0.0.0.0:36580/tcp: address already in use` during a
  run of back-to-back merges — not a code failure, and an error that looks
  nothing like its cause. The workflow picked a random port and checked it with
  `ss`, then spent minutes building images before Compose actually bound it: a
  time-of-check/time-of-use window a concurrent run can walk straight into. The
  same code also let both services draw the **same** port, since neither was
  bound when either was checked.
  Both host ports are now published as `0`, so the kernel assigns them **at bind
  time** and there is no reservation to lose; `docker compose port` reports what
  was actually handed out. ⚠️ The Postgres port reaches `new-faction.mjs` as an
  exported `PGPORT` rather than being written back into `deploy/.env` — that
  file is the container's published-port config, and rewriting it mid-run would
  have the next `compose up` want to recreate the very database the step had
  just provisioned into.

## [3.132.0] - 2026-09-20

### Changed
- **Scraper Jobs shows cadences in English, and edits them with a picker
  (#756).** Slice 3 of 3 — the editor is now on the page.
  - ⚠️ **The schedule cell is a reading surface, not a control.** It was an
    always-live text input on every one of 19 rows, for a value changed maybe
    twice a year, and it put raw six-field cron on screen — where
    `*/5 * * * *` (five minutes) and `*/5 * * * * *` (five **seconds**) differ
    by one character and a factor of sixty in Torn API traffic. It now reads
    "Every 30 minutes"; the expression is one hover away. **Dropping the input
    chrome makes the row shorter than it was**, so the editor that opens
    underneath is not paid for out of the resting state.
  - **The editor opens inline, one at a time** — not in a modal. ⚠️ An offset is
    chosen *relative to the other jobs*, and a modal covers the table you are
    choosing against.
  - **New: a minute-occupancy strip** under the table, showing how crowded each
    minute of the hour already is. `:00` is by far the busiest, which is exactly
    the pile-up `crime-occupancy` sidesteps by living at `:30` — the strip turns
    picking a quiet offset from guesswork into a glance.
  - "Use default" is offered only where there **is** an override to revert;
    without that guard the button would write null over null and read as a
    no-op that did something.

## [3.131.0] - 2026-09-20

### Added
- **`CronEditor` — the schedule sentence, as a component (#756).** Slice 2 of 3;
  still not wired into a page, so nothing changes on screen yet.
  A period dropdown plus chip rows for minutes, hours, days and **seconds**,
  with the expression, the plain English and the next four fire times live
  underneath.
  - ⚠️ **It never rewrites a schedule it cannot say.** A cadence using a field
    the sentence has no control for — a day-of-month, a range — opens straight
    in a text box with the expression untouched and a note saying why. Rounding
    it off to the nearest thing the picker can express would be worse than the
    box it replaces, because it would look like it worked.
  - ⚠️ **A chip row can never be emptied.** An empty minute list is not a
    schedule: cron would reject it, the scheduler would fall back to the code
    default, and the page would then show a cadence nobody chose.
  - ⚠️ **"Use default" sends null, not the default's text.** Null means "follow
    the fleet default" — a live instruction that keeps tracking it. Writing the
    value back would pin the faction to whatever the default happened to be that
    day (`scheduleResolution.ts`).
  - A sub-minute cadence prints its own cost: picking a second second on an
    every-minute job shows "≈ 2,880 Torn calls a day, per tenant — that is twice
    a minute, on a shared key pool". Two clicks double a job's traffic on every
    tenant at once, so the figure belongs on screen before Save rather than in
    the key pool afterwards.

## [3.130.0] - 2026-09-20

### Added
- **The schedule model behind a human-friendly cadence editor (#756).**
  `utils/cronSentence.js` turns a cron expression into a *sentence* — "every
  day", "at minutes 5 and 35" — and back again. Slice 1 of 3; no UI yet.
  - ⚠️ **It always writes six fields.** `node-cron` reads a leading seconds
    field when given six and standard cron has five, so `*/5 * * * *` is every
    five *minutes* while `*/5 * * * * *` is every five *seconds* — a 12× jump in
    Torn API traffic against a shared key pool, from one extra asterisk, with
    nothing to reject it because both are valid. Emitting one shape removes the
    whole class of mistake. Five-field values already in the column are read as
    seconds-zero rather than refused.
  - ⚠️ **Refusing to parse is a feature.** The sentence cannot say "the 1st of
    the month" or "9–17", so `parseCron` returns null for those and the caller
    falls back to a raw text box. Rounding a cadence off to something the editor
    *can* say would be worse than the text box it replaces — the text box at
    least fails loudly.
  - The load-bearing test is a round trip over all 19 shipped schedules, checked
    against `registerJobs.ts` itself rather than a transcription: a job that is
    opened and closed untouched must write back the bytes it started with.
    `crime-occupancy` keeps its `:30`.
  - `minuteLoad` counts how crowded each minute of the hour already is — what an
    admin is really choosing against when they pick an offset. ⚠️ Every-minute
    jobs are counted separately, since one of them occupies all sixty and would
    flatten the chart, hiding exactly the quiet minutes it exists to reveal.

## [3.129.0] - 2026-09-19

### Fixed
- **The Fair Fight header's spacing fix never reached the file (#612
  follow-up).** ⚠️ 3.128.0 claimed to rewrite both the Fair Fight and Revive %
  column explanations as real paragraphs. The edit script did Fair Fight, threw
  on Revive, and — writing only at the end — saved neither; the follow-up patch
  then covered Revive alone. So Fair Fight kept its source-wrapped array the
  whole time, with a paragraph gap through the middle of one sentence. Applied
  for real, and verified in the file rather than in the intent.

### Changed
- **Torn user IDs render without grouping separators (MonChoon).** The Find
  Target explanation said "4,200,001–4,300,000" for a range Torn itself always
  shows bare. A second format for a number the reader already knows the shape of
  is a small tax on every read; the gear popover's "Defaults:" line had it too.

## [3.128.0] - 2026-09-19

### Fixed
- **Paragraph gaps landed mid-sentence in two tooltips (#612 follow-up).**
  ⚠️ `tipLines` turns every `\n` into a paragraph break, so its input has to be
  whole sentences. The Fair Fight and Revive % column explanations were arrays
  of **source-code-wrapped lines** — a habit from the native `title`, which did
  not wrap on its own — so "…only a stat total" / "was known for one side…" got
  a paragraph gap through the middle of one sentence while the real wrapping
  stayed tight. Both are written as actual paragraphs now, with the formulas as
  a tight monospace block, which is the structure they always wanted.
  `tipLines` passes non-strings straight through, so a caller with real
  structure to express hands over JSX instead of pretending it is text.

### Changed
- **The battle-stats panel stops explaining what its own footer says
  (MonChoon).** An own-key reading carried "Exact — read from this member's own
  key", one sentence that widened the whole panel to repeat the solid emerald
  underline beside it. Our own roster has exactly one exact source, so the
  source token now reads **`API`** next to the enemy side's `TS` / `BSP` — three
  short labels that read alike — and the sentence is gone.

## [3.127.0] - 2026-09-16

### Fixed
- **Tooltip text ran outside its own box (#612 follow-up).** ⚠️ The panel paints
  at fixed viewport coordinates but is still a **DOM descendant** of its
  trigger, so it inherited from whatever it sat in. In the War Room that meant a
  column header's `uppercase tracking-wide whitespace-nowrap`: the Fair Fight
  explanation rendered in caps and **could not wrap**, so it overflowed the
  rounded panel entirely. Table cells carry `whitespace-nowrap` too. The panel
  now resets the typography it inherits — the same `text-left normal-case` the
  old `group-hover` panel in PayoutManagement carried, for exactly this reason.
- **Every tooltip was painted at the full 340px.** `PANEL_MAX` was being used as
  a width rather than a cap, so a four-word tooltip was 340px of mostly empty
  box, and the battle-stats breakdown went from a tidy ~150px table to a banner.
  It is now a `max-width` over a shrink-to-fit panel, so each one is as wide as
  its content needs and no wider. The right-edge clamp uses the **measured**
  width, so a narrow panel no longer floats away from the cell it belongs to.

### Changed
- **Fewer, quieter tooltips in the War Room (#612 follow-up, MonChoon).**
  - The member-name tooltip is **gone**: it repeated the text under the cursor,
    on every row of a 100-row board.
  - **Fair Fight** and **Revive %** are explained once in their column headers
    and no longer per row. Both columns sit at the right-hand edge, where a
    per-row panel had nowhere to open. The FF header absorbed what the cells
    used to say, including what a dotted underline means — that mark stays on
    the values, because "this one is an estimate" is the one thing a header
    cannot say about an individual row.
  - **Energy** and the three **cooldown** columns keep only what the header
    cannot say: how stale the reading is, and whose key failed. The colour
    legend was constant across every row.
  - The revivable flags say **"Revivable"** / "Revivable by friends & faction
    only" rather than a sentence. The glyph already implies a reviver; what
    matters is the restriction.

## [3.126.0] - 2026-09-16

### Changed
- **The last of the native tooltips are gone (#612).** Slice 6 — Competitions,
  Inventory, the revive-services modal, the version chip, the calendar, the four
  small `warroom/` widgets, Faction Settings, Global Admin and War History.
  **There is now no `title` attribute on a DOM element anywhere in the app.**
  - The revive-services modal was the densest remaining case: all six of its
    field explanations sat on an `<input>` or `<select>`, including which JSON
    key each service expects — the thing you actually need when wiring one up.
  - Global Admin's schedule provenance ("this faction overrides the default")
    moves onto the source pill, where it is visible rather than buried on the
    input; the two truncated error columns now open their full text.
  - Resolving a competition gets its own ⓘ, because the action is irreversible
    and what it is about to do has to be readable *before* pressing it.
  - ⚠️ `InfoTooltip` gained a `style` passthrough for the calendar's multi-day
    band: the band is placed by inline `gridColumn`/`gridRow`, and once wrapped,
    the **wrapper** is the grid item — leaving the placement on the child would
    drop every band into the first cell of its row.

## [3.125.0] - 2026-09-16

### Changed
- **War Room controls off native tooltips (#612).** Slice 5 — the toolbar, the
  leadership config panel and the row action buttons, 30 sites. The desktop
  table cells went in 3.122.0; this is everything around them.
  - ⚠️ The seven leadership cadence settings had their explanation on the
    `<input>` itself — the least useful place in the app for one. An `<input
    title>` is unreachable on a touchscreen *and* invisible to a screen reader,
    so text describing a control that costs real Torn API calls ("one call per
    enrolled member per cycle") was effectively unwritten. Each now has a ⓘ on
    its own label.
  - Disabled reasons that are now tappable: Enable War Room and Update Spies
    with no opponent faction ID set, the 3x FF filter with no stats on record,
    the Revives button with no service configured, and an inert dibs badge.
  - Find Target and Farm mode get their own ⓘ, since both buttons are live and a
    single tap cannot both explain and activate.
  - ⚠️ A disabled quick link was carrying its name in `aria-label` on a bare
    `<span>`, which is not exposed to a screen reader at all — it had no
    accessible name. It is now a wrapped tooltip with a real one.
  - Deleted: seven `title`s duplicating an `aria-label`, the assist link's
    "click to assist" (the button face reads "⚔ Assist {name}"), and the stats
    filter's disabled reason, which already renders as visible text beside it.

## [3.124.0] - 2026-09-16

### Fixed
- **War payouts: five column explanations were rendering nowhere at all (#612).**
  `SortHeader` never accepted a `title` prop, so "War wins excluding war mugs",
  "Mugs that happened during war hits" and three more were passed in and
  silently dropped — not hidden on mobile, *absent*. They now render as a ⓘ
  beside the column name.

### Changed
- **Payouts and Members pages off native tooltips (#612).** Slice 4 — 45 sites.
  - The RW payout sheet's participation cells carried their arithmetic
    (`12 war hits × 2.5`) in a `title`; that is now readable on a tap.
  - `TimeCell`'s banked-time breakdown came off CSS-only `group-hover`. Like the
    loadout shield, the ⚑ still rendered on a phone — announcing banked time
    with no way to account for it.
  - ⚠️ Anything that sorts on click gets its ⓘ wrapped in a `stopPropagation`
    span, so reading a column's meaning never re-sorts the sheet underneath the
    reader.
  - ⚠️ `TierBadge`'s override marker became a wrap: it renders inside the
    button that opens the CPR modal, where a nested button is invalid markup.
  - Member Overview's two stat-filter inputs lose their duplicate `title` hints
    in favour of one ⓘ on the "Stats" label.
  - Deleted: the visitor-mode disabled reasons whose buttons already read "Save
    disabled (visitor)" on their face, and six icon-only `title`s that were
    accessible names (now `aria-label`).

## [3.123.0] - 2026-09-16

### Changed
- **OC pages: the reward story is no longer hidden in a `title` (#612).**
  Slice 3 of the native-tooltip sweep — the Simulator, the crime ranking table,
  the Planner's feed queue, the Crimes page and the crime picker. 23 sites, and
  the Simulator's endings list was the densest: the drop-by-drop item
  breakdown, the observed payout range, the `n=` sample size, and the reasons an
  ending is contested, starved or unmapped all lived in `title` text.
  - ⚠️ The item breakdown keeps `whitespace-pre-wrap` rather than being folded
    into paragraphs. `rewardTooltip` lays the drops out with indentation and
    blank-line separators, and reflowing it would throw away structure that was
    written deliberately — including the "could not price" line, which is what
    stops the total reading as an estimate rather than a floor.
  - "What matters?" gets a separate ⓘ instead of a wrapped tooltip: the button
    is live, and one tap cannot both explain it and press it.
  - ⚠️ `TierTag` had to become a wrap rather than a button trigger. It renders
    inside the Crimes page's "coming out in 24h" pill, which is an `<a>` — a
    button inside an anchor is invalid markup that still renders, and it would
    have swallowed the link's tap. Same for the crime picker's "wip" tag, which
    sits inside the row's select button.

## [3.122.0] - 2026-09-16

### Changed
- **War Room: every explanation in the rows is now readable on a phone (#612).**
  Slice 2 of the native-tooltip sweep — the table cells and the target cards,
  where the `title` attribute failed hardest: mobile browsers show one on
  neither tap nor long press, so on the mobile board *every* explanation was
  unreachable on the only device that screen exists for.
  - Desktop columns converted: travel ETA (all three states), Energy, the three
    cooldowns, Revive %, Fair Fight, the OD badge, and the sortable column
    headers. ⚠️ A column header's explanation gets its own ⓘ with
    `stopPropagation` — the whole `<th>` sorts on click, so without it reading
    the explanation would re-sort the board out from under the reader.
  - Mobile cards converted: flag pills (each now also named for a screen
    reader), the Fair Fight badge, the OD badge, and the disabled reasons on the
    dibs button and the filter chips.
  - ⚠️ On the Fair Fight cells the dotted underline is **not** the tooltip
    affordance — it means "this is an estimate, only a stat total was known for
    one side". Those pass `decoration` explicitly so the component's own dotted
    mark cannot claim a second meaning for it.
  - `BattleStatsCell` and `LoadoutShieldIcon` moved off CSS-only `group-hover`
    onto the same component. The shield was the worse of the two: it still
    rendered on mobile, advertising that a target's gear was known, with no way
    to read it.
  - Deleted rather than converted: `title`s that only repeated an existing
    `aria-label` or the control's own visible label ("Back to desktop",
    "tap to assist", the revive tile's state echo).

## [3.121.0] - 2026-09-16

### Changed
- **InfoTooltip gained the trigger shapes the native-tooltip sweep needs (#612).**
  The component could only render a `<button>` trigger with a fixed dotted
  underline, which covers a label and nothing else. Three additions:
  - a `decoration` prop, so a caller replaces the affordance instead of fighting
    it. Passing `underline decoration-solid` through `className` put two
    text-decoration utilities of equal specificity in one class list and let
    Tailwind's generated order decide the winner — the War Room's flag glyphs
    were relying on exactly that coin flip and now pass `decoration="no-underline"`.
  - `wrap` mode, a `<span>` trigger that goes AROUND a control which has to stay
    itself — a link, an input, a disabled button. Nesting a button in a button is
    invalid and swallows the control's own click. ⚠️ A disabled control
    dispatches no pointer events at all, so a wrapper around one never sees the
    tap either; `.tip-wrap > :disabled { pointer-events: none }` hands those
    events to the wrapper, which is the only reason a disabled-reason
    explanation is readable on a phone.
  - `InfoDot`, a small ⓘ that sits BESIDE an enabled control. Wrapping one would
    force a single tap to choose between opening the panel and pressing the
    button, and it has to press the button.

## [3.120.0] - 2026-09-15

### Added

- **The join gap is measured per tenant, not assumed** (#687). `g` is the only
  free parameter in `personDays(n, g) = n(n+1)/2 + (n-1)·g`, which is the
  denominator of every per-person-per-day figure the OC model produces — so every
  published minimum-CPR threshold inherited a guess.

  ⚠️ **The guess was wrong, and wrong differently per faction.** Median gap over
  180 days, measured 2026-09-15:

  ```
                n=4     n=5     n=6     p10-p90 at n=6
    tnl        12.4h   12.9h   14.3h     7.6 - 24.2
    forge      24.4h   26.0h   24.4h    12.9 - 44.7
    capacityx  34.1h   40.6h   48.2h    29.0 - 65.0
  ```

  So tnl was close to the assumed 12h, **forge runs at twice it**, and
  **capacityx at four times**. For a 6-role crime that is `personDays` of 23.98,
  26.08 and **31.04** against the assumed 23.50 — capacityx's $/person-day
  figures were **32% optimistic**, forge's 11%.

  `GET /api/oc-simulator/join-gap` returns the median, p10, p90 and spread per
  role count, plus one weighted figure. Per tenant, never shared: this is a
  measurement of *a faction's* filling behaviour.

  ⚠️ **`g` is FITTED, not observed.** Rather than timing intervals between joins,
  it solves for the value that reconciles the formula with the person-days
  actually consumed: `g = (measuredPersonDays − n(n+1)/2) / (n−1)`. The formula is
  what consumes `g`, so the useful number is whichever makes it match reality —
  it absorbs late joins, re-fills and whatever else Torn does that we have not
  modelled.

  ⚠️ **Absent, not the assumption, below `MIN_CRIMES_FOR_GAP`** — "we measured
  12h" and "we assumed 12h" are different claims, and the guidance table already
  says which it had.

  ⚠️ The **distribution** is reported, not just the median. forge spans 12.9h at
  p10 to 44.7h at p90; a gap that bimodal is a different planning problem from a
  consistent one, and a median alone would hide it.

### Fixed

- **⚠️ A near-repeat of the v3.97.0 page crash, in the same file.** The first
  version of this declared `joinGap` inside `CrimeCard` and referenced it from
  `OCSimulatorView`'s joint-solve callback — an undefined reference that builds
  cleanly and throws on render, which is exactly how v3.97.0 replaced the whole
  OC Simulator with an error boundary.

  The state now lives in the outer component, **above every use**, and the card
  receives it as a prop. `OCSimulatorCrimeCard.test.jsx` mounts the card with a
  measured gap, an unmeasured one and none at all.

### Notes

⚠️ **This corrects figures reported earlier in this session.** forge's Advanced
economics were quoted at `$6,694,467` per person-day over 180 days using the
assumed gap; measured, it is **`$6,013,704`**, and occupancy is **65%** rather
than 58%. tnl moves from `$8,663,828` to `$8,289,604` and 97% to 98%. The
`$/member/week` figures are unaffected — they never used `g`.

---

## [3.119.0] - 2026-09-14

### Added

- **Estimating a role's CPR for a crime the faction has never run** (#602).
  `ocCprTransfer.js` plus a fitted coefficient table for all 20 Elaborate roles.

  ⚠️ **What crosses the tenant boundary is the COEFFICIENT TABLE, not member
  rows.** The original plan needed a classifier matching members across factions —
  the one thing this architecture prevents, and why #602 sat in triage for months.
  It was never necessary: CPR is deterministic given the member, so a fit of
  `target = slope × source + intercept` on a faction running **both** crimes,
  applied to the subject's own readings, lands at the rounding floor.

  Donor chosen **per role** by held-out MAE — 200 shuffles, 50/50 split. 18 roles
  land at **0.28–1.36** from tnl (n = 73–87). CPR is integer-valued (7,464
  readings, zero fractions), so that *is* the floor.

  ⚠️ **A slope, not an offset** — Crime Experience multiplies the other factors
  (`oc-cpr-mechanics.md`): 0.86–1.2 between nearby difficulties, **2.0** across a
  large gap.

  ⚠️ **The two Driver roles are weak and always will be.** Driver runs on
  **Racing**, the only stat no other role uses, and tnl runs no crime containing a
  Driver — it cannot donate one at any sample size. capacityx can, with seven
  members. Below n=25 the **stat family** breaks the tie, because a holdout over
  n=7 fits on 3–4 points and cannot separate candidates. Both flagged
  `low_confidence`.

  Guards, all tested: a member with no source reading is **absent, never zero**; a
  member outside the fitted range is flagged; a steep slope mapping below zero is
  **dropped rather than clamped** (Driver's slope of 2.0 sends CPR 20 to −75 —
  the model failing, not a weak member); a role with no coefficient is **unmapped**,
  not empty.

- **`$ per person-day` beside E(x) on every crime card** (#602). `perPersonPerDay`
  has existed since #690 with **no call site in any view** — consulted only inside
  `ocThresholdSearch`'s scoring, so the metric the whole model optimises was absent
  from the page built to compare crimes.

  A 4-role crime and a 6-role crime are not comparable on E(x): the 6-role one
  locks 23.5 person-days against 11.5. Forge's Break the Bank pays 2.8× Clinical
  Precision per run and **1.4×** per person-day.

  ⚠️ Absent rather than zero where the crime reports no cash — a chain root pays
  nothing itself, and `$0 per person-day` reads as worthless (#351/#713).

- **`docs/oc-elaborate-audit.md`** — the decision record, including a section on
  the six things that were wrong along the way.

### Notes

**The verdict: yes, but crewing was never the gate.** Forge can crew the Elaborate
roots at close to tnl's quality — 13 crews on Stacking the Deck at a uniform 65,
10 on Lock Stock. What it cannot afford is the **scope**:

```
                                    Advanced  Elaborate   regen    net /180d
tnl (runs both)                         +274       -160    +180         +293
forge today, Advanced only               -16          0    +180         +164
forge + Elaborate at tnl's volume        -16       -208    +180          -44
```

⚠️ **tnl's Advanced generates +274 scope; forge's generates −16**, and the whole
difference is success rate — 89.7% and 97.0% on Blast from the Past and Window of
Opportunity against forge's 79.0% and 86.7%. tnl pays for Elaborate out of a
surplus forge does not have, so dropping the cheap crimes, unlocking Elaborate and
running it at volume are **mutually exclusive** at current rates.

⚠️ And Elaborate is an **occupancy** play more than a rate play: tnl stripped of
Elaborate sits at **73% occupancy — exactly forge's**. Decomposing tnl's 2.06×
advantage per member per week: rate 1.55× × occupancy 1.32×.

---

## [3.118.1] - 2026-09-14

### Added

- **`docs/oc-cpr-mechanics.md`** — what Torn actually uses to compute CPR, collated
  from the community's reverse-engineering and cross-checked against our own tenant
  databases. Sources cited; provenance marked throughout, because Torn publishes no
  formula and most of this is inference rather than fact.

  ⚠️ **It records a mistake we made from our own data.** Measuring one member's CPR
  spread across the roles *within* a crime gave `Break the Bank 1.82` against
  `Ace in the Hole 10.67`, which reads as "CPR is a property of the crime". It is not —
  Break the Bank's roles are all battlestat roles so they move together, while Ace in
  the Hole contains **Driver**, which runs on **Racing**, a skill nothing else in the
  game uses. The apparent per-crime behaviour was *same stat family*, on a donor faction
  whose members happen to be evenly developed.

  ⚠️ **Crime Experience acts as a MULTIPLIER**, which is why a CPR mapped from one crime
  to another needs a slope rather than an offset. Measured: 0.93–1.04 between adjacent
  difficulties, **~2.0** across a large gap.

  Independently confirms three things this repo had already derived: chains pay only at
  the terminal link, scope is `cost = tier, reward = tier + 1` with a cap of 100, and
  weak members belong in lenient/low-weight roles — the carry-role rule from #692/#694.

  ⚠️ And one warning against the Advanced-only plan: the community expects level-8+
  factions to cycle back to cheap crimes to farm scope. Our own measurement put forge's
  floor at ~75% average success funded by regeneration alone; both are recorded.

### Notes

`oc-cpr-algorithm.md` now points at it: that file decides what bar to publish and takes
a member's CPR as given; this one explains where the number comes from.
## [3.118.0] - 2026-09-13

### Fixed

- **⚠️ A chain root the crime's own model had not mapped got no guidance**
  (#738). Lock Stock showed *"No CPR guidance: this crime's payouts are not
  fully priced"* — for the crime tnl spawns more than any other, at 21% of all
  decisions (#715).

  The gate read the crime's own per-ending mapping:

  ```js
  const chainsTo = goodEndings.map((e) => e?.reward?.chainsTo).find(Boolean)
  ```

  Lock Stock's is `null`, because that mapping is authored in
  `crimeshub-facts.json`, which covers 26 crimes and predates Torn's newest.

  ⚠️ **The edge was never actually missing.** `ocChains.js` has carried
  `'Lock Stock': 'Hostile Takeover'` in `KNOWN_CHAINS` all along, tnl's history
  confirms it independently — **34 of 34** Hostile Takeover runs came from a
  Lock Stock parent, and Lock Stock paid **$0 across 44 runs** — and
  `hostiletakeover.json` is complete at **$572M–$828M** per good ending.
  `computeChainEconomics` already walked that index. The machinery, the mapping
  and the value were all present; only the gate was looking in the wrong place.

  ⚠️ **Only when the crime pays nothing itself.** A crime can both pay and spawn
  something, and valuing that at the chain would double-count its own payout.

- **A known zero recorded as unmeasured** (#738). `paysOnlyByChaining` read the
  model's per-ending `chainsTo`, so a link with a child and unpriced good
  endings recorded `null` rather than `0`. `chainedValue` uses `== null` to mean
  "unmeasured", so that marked the whole chain incomplete and hid a genuine gap
  in the terminal link behind the noise.

### Added

- **Where a chain link came from, at the index's own strength** (#738).
  `chainSource` is `model`, `observed` or `known`, and the card says so:
  *"The link is from our own history, not this crime's model"* against *"from
  Torn's fixed chain mechanics — we have not watched it ourselves."*

  ⚠️ Those are different strengths of claim and must not be flattened into one.
  The label is the chain index's own, not one invented at the call site.

### Notes

⚠️ Lock Stock's model is `isComplete: false` — 180 observed paths. The chain's
**value** is solid because the terminal link is complete, but the root's
**success chance** is provisional and will move as the model fills in. The card
already carries "Model still in progress".

**Cleared for Takeoff is not fixed by this** and cannot be: it has no model file
at all, and waits on tornprobability publishing one.

---

## [3.117.1] - 2026-09-13

### Fixed

- **⚠️ A tiny outcome side was reported as a measurement** (#735). Lock Stock on
  tnl — 44 runs, 39 successes, **5 failures** — rendered:

  > success tracked Muscle (−0.7), Smuggler (−0.7), Assassin (−1.3), Hacker (−2.2)

  **Every role negative**, which invites the reader to conclude lower CPR is
  better. Those deltas were a 39-run mean against a 5-run mean.

  The #728 guard fired only when a side was **empty**. A side of five is just as
  uninformative and looks considerably more authoritative, so the module built
  to prevent exactly this misreading had a hole in it. `MIN_OUTCOME_RUNS` now
  applies to **both** outcomes, under its own reason `one-sided`.

  The overall rate and buckets survive — a crime that nearly always succeeds is
  exactly the one whose rate is worth knowing — and the panel explains the gap
  as *"too few failures to compare crews against. That is a good problem."*
  rather than as a fault in the crime.

- **⚠️ One label covered three different roles** (#735). `crime_slots.position`
  carries only Muscle, Robber and Thief for six-role Break the Bank, so
  `Muscle (−0.1)` averaged Muscle 1, 2 and 3 — directly above a guidance table
  listing them separately. Two vocabularies for the same roles on one card.

  `position_number` is populated and distinct, so a label is numbered when the
  crime has more than one slot carrying it. **Derived from the data, not
  declared** — a crime gaining a second Muscle numbers itself. A unique role
  stays bare: "Robber #1" is noise, and Torn does not number a unique role
  either.

### Notes

⚠️ **A correction to #728's headline claim.** It stated that Break the Bank
showed "no measurable gain across the range Forge operates in". That was an
artifact of coarse bucketing — lumping 65–70 into one bin of 145 runs hid the
gradient inside it. The feature's own equal-count buckets found the error:

```
crew CPR 62-67    85 runs    69.4%
crew CPR 67-71    85 runs    78.8%
```

**+9.4 points.** Break the Bank responds to crew CPR, less steeply than Clinical
Precision or Window of Opportunity but not flat. The related claim that it
"cannot field a crew at 75" was also about a UNIFORM bar: at the published
non-uniform vector (72/72/70/69/67/0) the roster fields **8 crews**, because the
carry at 18 costs nothing and the high-impact roles at 72 are affordable.

⚠️ A backtick inside a SQL template literal closed the string and broke every
server test — the same hazard that once broke a userscript's stylesheet.

---

## [3.117.0] - 2026-09-13

### Added

- **Select a whole category at once in the crime picker** (#730). Forge is
  moving to Advanced-only spawning, which makes the per-crime ceiling actively
  misleading — at a uniform 75 the five Advanced crimes want **198 seats against
  a 94-member roster**. The joint solve is the only view that tells the truth
  about a set of crimes, and reaching it meant hand-ticking five of them.

  Each category header now carries `Select all <category>` / `Clear <category>`.

  ⚠️ **Appends rather than replaces.** The selection order IS the page order —
  `toggleSelection` exists to preserve it — so rearranging somebody's existing
  picks to satisfy a bulk add would shuffle the screen under them.

  ⚠️ **A partial selection completes, it does not clear.** Ticking two of five
  and then pressing the category button means "give me the rest"; clearing would
  throw away the picks just made.

  ⚠️ An empty category is not "fully selected", or the control would render in
  its active state for a group with nothing in it.

- **A mount test for `CrimePickerModal`**, which had none. Same reason as
  `OCSimulatorResultPanel` and the guidance panel: v3.97.0 took the whole OC
  Simulator down with a temporal-dead-zone throw that every pure helper's tests
  passed straight through.

### Notes

The other two halves of #730 were already in place and are confirmed by this
work rather than changed:

- `solveForSelection` already drives `spawnsPerDay` from #715's **measured**
  mix, falling back to the declared default only when the faction has fewer than
  `MIN_SPAWNS_FOR_MIX` real decisions.
- `ocSpawnSimulation` already nets scope regeneration against drain
  (`shortfallPerDay = max(0, drain − regenPerDay)`), so a plan inside the +1/day
  regen budget is correctly reported as solvent rather than as a shortfall.

---

## [3.116.0] - 2026-09-13

### Added

- **The guidance table says how many crews the roster can field** (#729), and
  refuses to publish quietly when the answer is none.

  ⚠️ **The per-role "can fill" counts cannot be composed into this by eye.** The
  eligible sets OVERLAP, so six roles with nine candidates each may still seat
  one crew. `ocRosterFit.js` has carried a warning that it deliberately does not
  check disjointness since it was written; this is that gap finally reaching the
  table, via `maxDisjointCrews` (#689).

  ⚠️ **Forge's Break the Bank falls from 3 crews to 0 between a uniform 72 and
  75** — and it is the highest earner on the roster at $9.79M per person-day.
  Nothing on screen hinted at it:

  ```
  threshold      60   65   70   72   75   78   80
  Break the Bank 10    7    5    3    0    0    0
  Clinical Prec. 17   14   10   10    9    4    1
  Window of Opp. 16   15   15   14   12   11   10
  ```

  A vector that seats nobody now shows a red warning naming the role that ran
  out first — **a bar nobody can meet is not a high standard, it is a crime you
  have stopped running.** A single crew is called out as a knife edge, since one
  person joining another crime takes the crime off the board.

  ⚠️ **Scored at the vector the MODEL used, never the published one.** A carry
  role publishes 0, and counting crews at 0 would say everyone can fill it and
  report a depth the crime does not have — the #716 defect in a new place.

  ⚠️ **The roster is not the constraint.** At a uniform 75 Forge's five Advanced
  crimes could field 198 seats against a 94-member roster. What binds is depth
  in specific roles on specific crimes, so a warning about roster size would be
  the wrong warning — the failure is always one role running out.

---

## [3.115.0] - 2026-09-13

### Added

- **The faction's own crime history, beside the model's prediction** (#728).
  Every success figure on the OC Simulator came from tornprobability's model.
  Forge has **370 Advanced runs in 120 days** where we know both the crew's CPR
  and the outcome — ground truth the Simulator had never consulted.

  ⚠️ **They disagree on Forge's highest earner.** Break the Bank returns
  $9.79M per person-day, and bucketed by crew CPR over 240 days:

  ```
  mean crew 62-65    21 runs    76.2%
  mean crew 65-70   145 runs    73.8%
  mean crew 70-71     4 runs    75.0%
  ```

  **No measurable gain across the range Forge actually operates in** — while the
  published guidance pushes its bar toward 75, where the roster can field
  **zero** crews (10 at 60, 5 at 70, 3 at 72, 0 at 75). That is not a tuning
  error: it is the model being consulted where measurement was available.

  `GET /api/oc-simulator/observed/:scenario` returns runs bucketed by crew CPR
  with the success rate in each, plus per-role CPR in successful against failed
  runs. Not restricted to current members — this is history, and a leaver's run
  still happened.

  ⚠️ **Bucket edges are derived from the observed range**, never a fixed CPR
  grid. A faction operating at 40-50 gets 40-50 buckets, not empty ones spanning
  55-80.

  ⚠️ **Counted by RUN, not by slot.** A six-role crime is one observation, not
  six; counting slots would inflate every sample sixfold and make noise look
  like evidence.

  ⚠️ **A slot with no reading is skipped, never scored as 0** — treating it as
  zero would drag the crew mean down and manufacture a correlation.

### Fixed

- **⚠️ Restriction of range, guarded explicitly** (#728). The correlation
  between a role's CPR and success measures where the faction has **varied** the
  crew, not which role matters. Forge holds Blast from the Past's Muscle at ~77
  in every run, so Muscle shows a −0.36 "effect" — not because it is
  unimportant, but because there is nothing to see. Reported as a number, that
  ranks the crime's heaviest role as ignorable.

  A role whose p90−p10 CPR spread falls below `MIN_INFORMATIVE_SPREAD` reports
  `informative: false` and **`delta: null` — withheld, not zero.** A 0.0 in that
  column reads as "measured, no effect", which is the precise misreading this
  exists to prevent. The panel says *"we have run it at almost the same CPR
  every time — that says nothing about how much it matters"*.

  Three ways of having nothing to say are kept separate, because they call for
  different responses: `too-few-runs`, `one-outcome`, `narrow-range`.

- **A crew we have never fielded is not compared** (#728). `compareToObserved`
  returns `out-of-range` when the published bar sits more than
  `MAX_EXTRAPOLATION_CPR` outside the observed span, rather than dressing an
  extrapolation as a measurement. "No history" and "agrees" are separate states
  for the same reason — the first says nobody checked, the second says the model
  was corroborated.

---

## [3.114.0] - 2026-09-13

### Fixed

- **⚠️ Suggested CPRs priced downstream chain links at the slider default**
  (#725). `OCSimulatorView` passed `chainCpr: meanCpr(cprs)` into the guidance
  run, and the sliders sit at `DEFAULT_CPR = 50` until somebody drags them.
  There is no apply-guidance-to-sliders path, so the terminal link of every
  chain was priced at whatever the reader last touched.

  That was never necessary. tnl has **81-87 readings per role** for Ace in the
  Hole, and the roster sustains **70-75** across all five — ten deep, so not
  fragile. The link was being priced ~22 CPR below what the faction can field,
  and everything downstream of it was pessimistic: the completion rate, the
  per-link average, and the scope verdict.

  Bounded from a real screenshot: re-pricing only the ROOT moved the chain from
  $21,495,123 to $45,881,074, a 2.13× lift, so at the published floor it
  completes **~29% rather than the 13.7% shown** — before the downstream link is
  touched at all. Correcting the link as well lands scope near **−1.5 rather
  than −4.18**.

  ⚠️ The verdict likely stays negative: break-even is 91.3% per link and the
  best crew Ace can field is 70-75. But **scope is reported, not enforced**, so
  the number has to be right rather than merely alarming. −4.18 and −1.5 are
  different decisions.

  Each link is still probed **once** and reused across every candidate — the
  call budget against tornprobability does not move.

  ⚠️ **Falls back to the flat CPR when a link has no readings, and says which.**
  A tenant that has never run the terminal link must not silently inherit a
  roster number it does not have.

- **Two figures on the same card both said "worth" and differed by 2.1×**
  (#725). The chain panel's total (root at the sliders) sat directly above the
  guidance table's (root at the searched vector) with nothing to reconcile them.
  The guidance table now names the crew each downstream link was priced at, and
  marks an assumed one amber.

  ⚠️ **The chain panel keeps its sliders, deliberately.** Dragging them to see
  the effect, and comparing against what the faction actually fields, is a
  separate and legitimate use — the two are not required to agree. Only the
  *suggestion* path takes the roster-derived crew.

---

## [3.113.1] - 2026-09-13

### Fixed

- **⚠️ Four crimes Torn runs were missing from the scenario model, and one of
  them was mispriced** (#723). From `select distinct name, difficulty from
  oc_crime_types` across all five tenant databases on 2026-09-13:

  | Crime | Difficulty | Seen in | Category |
  |---|---|---|---|
  | Cleared for Takeoff | 7 | forge, tnl, capacityx, mayhem | advanced |
  | Lock Stock | 8 | tnl, capacityx | **elaborate** |
  | Hostile Takeover | 9 | tnl, capacityx | elaborate |
  | Guardian Ángels | 5 | all five | intermediate |

  **Lock Stock is the one that did damage.** `makeCategoryResolver` falls back
  to difficulty for a name it does not know, and `CATEGORY_FALLBACK_ORDER` is
  ordered so difficulty 8 lands on **Advanced** — the right guess for most
  factions and the wrong one here. Lock Stock is Elaborate, and it is tnl's
  most-spawned crime at 21% of every decision (#715). It was priced at
  `scopeCost 4 / scopeReward 5` instead of `5 / 6`, so the chain break-even it
  drives read **89.4% when it is 91.3%** — 1.9 points too lenient, on the crime
  spawned more often than any other.

  The other three landed on the correct category by fallback; what they lost was
  `participants` and any name-keyed lookup.

  ⚠️ **Guardian Ángels was a spelling bug, not a missing crime.** Torn spells it
  with an accented **Á**. It has never matched on any tenant. Both spellings are
  now present — we cannot be sure every tenant reports the accent.

### Added

- **The difficulty fallback now says when it is guessing** (#723). The Advanced
  and Elaborate ranges overlap, so for a difficulty both claim, a name we do not
  know cannot be placed — and until now nothing said so, because for every other
  crime the fallback happened to be right.

  `makeCategoryResolver(...).detail(name, difficulty)` returns
  `{ category, source: 'name' | 'difficulty' | 'none', ambiguous, candidates }`.
  The plain call signature is unchanged, so no call site had to move.

  ⚠️ It still **answers** when ambiguous. Returning null would strip the crime
  of a scope cost altogether, and free reads far more wrong than mis-tiered.

  ⚠️ The overlap is **derived from the category ranges**, not written down as
  "8" — Torn can ship a category above Elaborate and move it.

- **A coverage test built from the tenant databases, not the wiki**
  (`ocScenarioCoverage.test.js`). Every one of the 28 crimes our factions have
  actually run must resolve by NAME. A crime Torn adds tomorrow fails this the
  first time any tenant runs it, instead of being quietly mis-tiered for months.

---

## [3.113.0] - 2026-09-13

### Fixed

- **⚠️ Chain children were being planned for as spawn decisions, and charged
  scope for it** (#715). From an audit of tnl's own `crimes` table on
  2026-09-13, 30-day window:

  ```
  Lock Stock             25   21.0%    <- chain ROOT
  Hostile Takeover       21   17.6%    <- chain CHILD, 39/39 lifetime from a parent
  Ace in the Hole         7    5.9%    <- chain CHILD, 128/128 from a parent
  ```

  **23.5% of "spawns" were not decisions.** A crime with `previous_crime_id` set
  appeared because its parent succeeded — nobody chose it. Two separate kinds of
  damage followed:

  - the planner apportioned roster capacity to a choice that does not exist;
  - `simulateSpawns` charged the child `scopeCost`, when scope is paid **once at
    the root** and repaid only at the terminal link (`ocChains.js`).

  Chain children now cost no scope, are dropped from the plan with their own
  reason, and their appearances come off the spawn count. A chain child is never
  blocked by an empty bank either — it costs nothing, so a faction with no scope
  can still finish a chain it has already paid for.

### Added

- **The spawn mix is measured, not assumed** (#715). The scenarios payload now
  carries each crime's spawns and how many came from a chain over a 30-day
  window, per tenant — tnl's mix is not forge's, and a fleet average would
  describe neither.

  ⚠️ tnl's real mix is **12-fold uneven** — Lock Stock 21%, Cleared for Takeoff
  1.7% — against the uniform weight the planner assumed. And the rate is
  **decisions** per day, not appearances: 91 real decisions in 30 days, not the
  119 rows a naive count gives.

  ⚠️ **Absent rather than fabricated.** Under 20 observed decisions the mix
  reports `measured: false` and the caller keeps its defaults — and the panel
  says which of the two it had, because a plan built on a guess that reads like
  a measurement is the worse of the two.

  ⚠️ Judged **per crime**, so a crime usually chosen but occasionally chained is
  still choosable; only one whose *every* appearance came from a parent is a
  child. Its chained runs still come off the count.

---

## [3.112.0] - 2026-09-13

### Fixed

- **⚠️ A chain root got no CPR guidance at all, and it is the crime people
  actually join** (#713). v3.107.1 refused it — *"set thresholds on Ace in the
  Hole and treat this as the way in"* — which is half right and the wrong
  conclusion.

  **Ace in the Hole cannot be spawned on its own.** #585 verified it across the
  fleet: 128 of 128 runs came from a parent, zero standalone. So that advice
  asks a leader to publish bars for a crime nobody can choose, while Stacking
  the Deck — where the crew is actually assembled, and where tnl has readings
  for 97 members — got nothing.

  A chain root is now valued at **the whole chain**. Its own E(X) is zero by
  design, so searching on it would rank every vector identically; what varies
  with the crew is the root's **success chance**, which decides how often the
  chain is reached at all. So the search scores `chainedValue` recomputed with
  each candidate's success.

  ⚠️ **Downstream links are priced ONCE**, at a flat CPR, and reused across every
  candidate. Pricing them per candidate would multiply the call budget by the
  chain length to refine an assumption already flagged as one — the links have
  different role counts, so the root's crew cannot carry across them anyway.
  There is a test asserting exactly one downstream call.

  ⚠️ It still refuses when the chain **cannot be priced** — a terminal link with
  an unpriced ending makes the whole chain a lower bound, and published guidance
  cannot rest on one. The panel says the value is the chain's and the thresholds
  are this crew's, so the figure is not read as this crime's own payout.

---

## [3.111.0] - 2026-09-13

### Fixed

- **⚠️ A carry role published `0` while being SCORED at 83.** Spotted by
  MonChoon on the live table:

  > when we are looking at a carry role like Picklock 2 in the screenshot, if it
  > was truly at the floor then wouldn't it have 69 of 69 that can fill the crime
  > at the floor?

  Exactly right. The table said *"no training needed"* on a 2.9%-impact role
  while the E(X) beside it assumed **forty-seven of sixty-nine people had
  cleared 83**. The guidance and the number were describing different crews.

  Two individually reasonable decisions, jointly incoherent: the search raises
  roles in weight order, so the lowest-weight role is raised **last** and keeps
  whatever the matching leaves it — and the table then overrode it to `0` **at
  render time**, without the search having ever scored that vector.

  **Carry roles are now pinned to the roster floor in every candidate**, not
  offered as an optional variant. That is what the source document asks for in
  as many words: *"set it to the lowest actual member of the faction like Andrew
  so its not literally zero in the simulator, but in the official guidance just
  put zero"*. On a 70-member roster the carry now reads **70 of 70 can fill**.

  ⚠️ **This LOWERS reported E(X), and that is the correction rather than a
  regression.** The old figure was optimistic by exactly the amount the carry
  role was silently assumed to be trained. It also frees the strong members that
  role was hoarding, so the roles that actually move success chance can go
  higher — the carry trade, now the default rather than an option.

  The weight threshold is a single shared constant, because a table publishing
  zeros for a different set of roles than the search pinned is the same bug in a
  new place.

- **⚠️ The "expected crew" could come out below the published floor** (v3.110.1,
  same investigation). `maximalCprVector` is Hall-safe for **one** crew, but the
  search's `k=1` rung starts there and is raised above it — so the blend target
  sat under the chosen bar and ran backwards. It is now
  `maxSustainableCpr(readings, chosenCrews)`, and clamped to the floor
  regardless.

---

## [3.110.1] - 2026-09-13

### Fixed

- **⚠️ The "expected crew" could come out BELOW the published floor.** Found by
  MonChoon asking what the floor and ceiling were actually based on — a good
  question to have been asked.

  The expected column blends `floor + 0.5 × (ceiling − floor)`, and the ceiling
  was `maximalCprVector` — the highest bar with `n` candidates per role, which is
  Hall-safe for **one** crew. But the search's `k=1` rung *starts* there and is
  then greedily raised above it, so the "ceiling" was not a ceiling:

  ```
  ceiling (slice 3):  {P1: 92, P2: 92, P3: 92, P4: 92}
  chosen (k=1 rung):  {P1: 95, P2: 93, P3: 94, P4: 92}

  P1  floor=95  ceiling=92  expected=93.5   ← below the floor
  ```

  An expected crew weaker than the minimum we told people to train to is not a
  thing that can happen.

  The blend target is now `maxSustainableCpr(readings, chosenCrews)` — the best
  people who could fill that seat while still fielding the chosen number of
  crews, ignoring what the other roles want. That is the honest upper end, and
  it is `>= floor` by construction. Clamped to the floor regardless, because a
  silent inversion is worse than a conservative number.

---

## [3.110.0] - 2026-09-13

### Added

- **The joint plan is on screen** (#714, wiring #710). A "Solve together" panel
  below the crime cards works out what the selected crimes can run *at the same
  time*, and shows **what each one gave up** — "39 pts → +4 crews" — beside what
  it kept. A set of lower numbers with no reasoning attached will not be trusted
  or followed.

  ⚠️ **Scoped to the crimes on screen, deliberately.** Solving all 31 scenarios
  would mean 31 roster fetches and ~250 requests to tornprobability. The
  Simulator already has a selection the operator controls, so the cost is theirs
  to choose — and the panel states it before they pay it.

  ⚠️ **A skipped crime says which kind of skip it is.** tnl has readings for
  exactly the ten crimes it has run recently; the other eleven in its history
  last ran in 2025 and have none. "Never observed anyone in this role — a gap in
  what we have measured, not a verdict" is a different sentence from "nobody
  clears the bar" (#351).

  Both known gaps are printed under the table rather than buried: the spawn mix
  is assumed even when it is not (#715), and occupancy is overstated by about
  half because a member is held for the crime's whole duration.

### Fixed

- **A duplicated chain-edge state.** v3.108.0 added `chainEdges` next to the
  `chains` state that already held the same payload. One of them now.

---

## [3.109.0] - 2026-09-13

### Added

- **`solveJointThresholds()`** (#710) — CPR thresholds for **all crimes at
  once**, against one shared roster.

  ⚠️ **Why the per-crime numbers came out too high.** #707 skips the spawn
  simulation, so `searchThresholds` maximises `$/faction-member/day` for ONE
  crime with the ENTIRE roster available — and the optimum for that question is
  "take the strongest people". Every crime reaches it independently, so the
  published sets are **individually optimal and jointly unfillable**. The
  per-crime number is a *ceiling*; this descends from it.

  **It costs no extra probability calls.** `E(X)` for a crime at a vector does
  not depend on the other crimes, so each crime's candidates are priced once —
  the same handful #707 already pays for — and the joint search runs entirely on
  cached values. Verified by a test asserting the search adds none.

### Fixed

- **⚠️ A single-step descent parks in a valley, and the score landscape has a
  deep one.** `filled` is a **step function**: a crew locks `n` members for `n`
  days, so the bar has to fall a long way before a second crime fits alongside
  the first, and every rung in between is strictly worse. Measured on 24 members
  with one four-role crime:

  | rung | filled | score |
  |---|---|---|
  | k=1 | 8/30 | 990,741 ← a one-rung-ahead search stops here |
  | k=4 | 8/30 | 814,815 |
  | k=5 | **16/30** | **1,611,111** ← 63% better, never reached |

  So the search moves each crime to its **best rung over the whole ladder**, not
  its next one, iterated to convergence — plus a lockstep move that steps every
  crime down together, because coordinate descent cannot see an improvement that
  needs several crimes to concede at once.

  ⚠️ **Still greedy and named as such.** The exact joint optimum is
  combinatorial over a shared roster. A leader needs a readable answer with a
  reason for every concession more than the last 1% of throughput.

### Performance

- The inner loop runs on a **12-day horizon** while the reported simulation runs
  the caller's full one. Ranking is stable well before thirty days, and the
  simulation is the hot loop — eight crimes over thirty days at two spawns a day
  is ~15,000 crew matchings per pass. With memoisation on the pick tuple this
  took the solve from **11.5s to 7.1s** on eight crimes against a 94-member
  roster.

  ⚠️ Seven seconds is still the heaviest thing in this codebase's UI path, which
  is why it belongs behind an explicit button — the guidance button froze the
  browser for 44 seconds once already (v3.107.1), and there is now a regression
  test with a hard bound.

### Reported, not just computed

- **What each crime gave up, and for what** — `stepsGivenUp`, `pointsGivenUp`,
  `crewsGained`, and the vector it started from. *"Crime6 gave up 39 points for
  4 more crews"* is the insight; a table of lower numbers with no reasoning
  attached will not be trusted or followed.
- ⚠️ **`no-readings` stays distinct from `not-crewable`** through the whole
  solve (#351) — a crime we have never observed is skipped for a different
  reason than one nobody can crew, and a measurement gap must never read as an
  infeasible crime.

---

## [3.108.0] - 2026-09-13

### Added

- **Chain economics on the crime card** (#712). `ocChains.js` has known all of
  this since #585 and the OC Simulator never imported it — so a chain link
  showed as a crime paying nothing, with no hint that its value lives two crimes
  downstream or that its scope maths is completely different.

  ⚠️ **The break-even is the number that surprises, and it is why this exists.**
  Scope is paid once at the root and repaid only at the terminal link, only if
  **every** link succeeded — so the reward stays flat while the probability of
  collecting it **compounds**:

  | | Elaborate break-even |
  |---|---|
  | standalone | 83.3% |
  | over two links | **91.3% per link** |
  | over three | **94.1% per link** |

  The standalone scope verdict shown elsewhere on the page is therefore the
  wrong number for a chain, and until now nothing said so.

  The panel shows the full chain, what spawning the root is worth across all of
  it, the chance the chain completes, and the scope verdict on the **per-link**
  bar. ⚠️ It compares `equivalentSuccess` (the geometric mean per link) against
  `breakEvenPerLink` — comparing the *chained* probability against a per-link
  bar is the natural mistake and makes every chain look doomed.

  ⚠️ **The crew assumption is stated on screen.** Links have different role
  counts, so the sliders cannot be carried downstream; every link is priced at a
  flat CPR, the mean of the crew on screen by default.

  ⚠️ **A chain parent paying nothing is a known zero, not a measurement gap.**
  `chainedValue` distinguishes the two with `== null` so a chain reads as a
  lower bound only when something is genuinely unpriced — and conflating them
  would mark every chain incomplete and bury a real terminal-link gap in the
  noise.

  One probability call per link, on demand, reusing what the card already knows
  about the root. The panel only appears on crimes that actually chain — showing
  it elsewhere would imply economics a crime does not have.

  Unobserved edges are flagged: at the time of #585 only capacityx had seen all
  five, so a tenant falling back to the known-chains table is told the link is
  unverified there.

---

## [3.107.1] - 2026-09-13

### Fixed

- **⚠️ "Suggest minimum CPRs" froze the browser for 44 seconds.** Reported from
  the live page, reproduced on a 94-member six-role roster: **43,873ms** of
  synchronous, main-thread-blocking work. Not a missing spinner — the page was
  genuinely locked, which is why the faded "Working…" only appeared seconds
  after the click.

  Three compounding faults, each measured:

  | | |
  |---|---|
  | as shipped | **43,873ms** |
  | binary-search the greedy raise instead of walking every distinct CPR | 10,620ms |
  | ask "does `k` fit" instead of "what is the maximum `k`", and sort each role's candidates once instead of once per slot | **769ms** |

  **57x, with byte-identical output** — same candidates, same crew counts. The
  three faults: the raise did one matching per distinct reading per role per
  crew count (~90 × 6 × 8); each feasibility probe ran `maxDisjointCrews`, which
  walks `k` up from 1 and so did eight matchings to answer one question; and
  `seat()` re-sorted a ~90-member adjacency list per SLOT using a numeric-aware
  `localeCompare`.

  ⚠️ Nothing caught it because every existing test used a 12-member roster,
  where the cost is invisible. There is now a test on a real-sized one.

- **The busy state is real.** A spinner, `aria-busy`, and a yield to the browser
  before the synchronous work so React can actually paint it. The table dims
  while recomputing, so stale numbers are not read as fresh.

### Changed

- **⚠️ The guidance table now says it is one crime at a time**, above the
  numbers rather than in a footnote. Every threshold is computed as if that
  crime had first claim on the whole roster — which is why the values come out
  higher than the faction actually uses. They are a **per-crime ceiling**, not a
  set to publish across all crimes. The joint solve is #710.

- **⚠️ Chained crimes are shown as what they are, not as "unpriced" —
  everywhere.** Stacking the Deck pays no money or items at all: every good
  ending spawns **Ace in the Hole**. "Unpriced" describes a gap in *our*
  measurement and sends somebody hunting a number that does not exist, when the
  value is known perfectly well and simply lives on another crime.

  #585 established this is what the crime **is** rather than a bonus on top:
  124/124 successful Stacking the Deck runs spawned a child, and Ace in the Hole
  has **zero** standalone runs.

  Three places now say so:

  - **The endings list** renders `→ Ace in the Hole` in place of `unpriced`.
  - **The expected-value summary** swaps *"N endings unpriced... the real value
    is higher by an unknown amount"* for a note naming the crime it spawns and
    saying to judge the pair together. ⚠️ A mixed crime — some links chained,
    some genuinely unmeasured — still gets the unpriced warning, so the chain
    message cannot swallow a real measurement gap.
  - **The CPR guidance panel** says thresholds belong on the *downstream* crime,
    and the pipeline detects the chain **before** the search so it spends no
    probability calls learning nothing.

  ⚠️ An ending that chains *and* pays keeps its figure — suppressing a real
  number to show an arrow would be the opposite mistake.

---

## [3.107.0] - 2026-09-12

### Added

- **The CPR algorithm is now visible in the OC Simulator** (#707). #688 shipped
  six slices and **zero call sites** — the algorithm was complete and the
  feature had not started. This is the join.

  A **"Suggest minimum CPRs"** button on each crime card runs slice 3 → 4 → 6
  against the live roster and renders the guidance table: what to publish per
  role, the bar the model actually scored at, the expected crew, the cliff, how
  many members have ever been read for that role, and who is within a few points
  of qualifying.

  **Frontend only — no server changes.** Everything needed was already on the
  page: roles and weights from the committed model, readings from
  `/api/oc-simulator/roster-cpr`, and `/api/oc-simulator/calculate` as the probe.

  ⚠️ **On demand, never on a slider drag.** Every candidate vector is a request
  to tornprobability, a small third-party server this codebase already counts
  calls against — so it is a button, the panel says so, and there is a test
  capping the calls.

  ⚠️ **Absent stays absent.** A crime with no readings says *"we have never
  observed anyone in this role — that is a gap in what we have measured, not a
  verdict on the roster"*, which is distinct from *"nobody clears the bar"* and
  from *"payouts are not fully priced"*. forge is currently the first case on
  several roles (#351). An incomplete `E(X)` yields **no table at all** rather
  than a lower bound: the Simulator can show a partial figure with a warning
  beside it, published guidance cannot, because nobody reads a footnote before
  training for a month.

  ⚠️ **Assumptions render inline, never behind a toggle.** An assumption
  somebody has to click to find is one nobody reads, and the failure mode here
  is a table that quietly goes stale.

### Fixed

- **⚠️ A mount test for `CrimeCard`, the component #707 added hooks to.**
  `OCSimulatorResultPanel.test.jsx` exists because v3.97.0 shipped a
  temporal-dead-zone crash that replaced the whole Simulator with an error
  boundary — but it mounts `ResultPanel`, and this work added state to
  `CrimeCard`, which nothing was mounting. Same gap, one component along.

  Verified by reintroducing the exact v3.97.0 shape — a hook whose dependency
  array names a `const` declared below it — which now fails with
  `ReferenceError: Cannot access 'guidance' before initialization`.

---

## [3.106.0] - 2026-09-12

### Added

- **`publishGuidance()`** (#694, slice 6 of #688) — the CPR table members
  actually read, and the last slice of the algorithm.

  ⚠️ **Two numbers per role, because one of them would lie.** The published bar
  is a *floor*, not a prediction — members bring whoever is free to a seat,
  usually above the minimum. A table showing only the floor understates what the
  crime really returns, and understates it most on exactly the carry roles
  published as zero. So each role carries `published`, `floor` and `expected`,
  where `expected` defaults to **halfway between the floor and step 1's
  ceiling** — precisely what the source document proposes for the same problem
  in step 5. It is a guess about behaviour in the same family as `g`, so it is a
  tunable and the table states it as an assumption.

  ⚠️ **Carry roles publish `0`, deliberately.** "You do not need this role
  trained" is the true instruction, and *any* number invites somebody to train
  toward it. The bar the simulator actually scored at stays visible as `floor`,
  because hiding it would make the table unauditable — the two surfaces
  disagree **by design**, and anyone reconciling them later should not "fix" it.
  The carry is chosen by **weight**, never because a bar happened to come out
  low.

  Also in the table:

  - **The cliff** — a bar of 92 with four clearing it and three clearing 93 is a
    knife edge one departure invalidates, a different instruction from the same
    number with headroom.
  - **Reading counts per role**, because absent is not failing (#351).
  - **Near misses** — who is within N points of qualifying, so a faction-wide
    table becomes a personal action. ⚠️ Never offered for a carry role: telling
    somebody they are two points off a bar published as zero is the exact
    pointless training this table exists to prevent.
  - **Ordered by weight**, so the roles that decide the outcome are read first
    rather than whichever happens to be called P1.
  - **Its own assumptions**, stated — a table that presents itself as permanent
    truth will be stale within a month and nobody will notice.

  `value.uplift` is **null** rather than 0 when either crew went unpriced: a
  zero would read as "the expected crew is worth nothing extra", which is a
  claim we have not made.

---

## [3.105.0] - 2026-09-12

### Added

- **`simulateSpawns()`** (#693, slice 5 of #688) — does the roster survive
  contact with how crimes actually spawn?

  Slice 4 optimises ONE crime in a steady state. This checks what that cannot
  see: spawning is lumpy, partly outside our control, and ⚠️ **members are
  shared across every crime in flight**. A threshold set that is optimal per
  crime can be unfillable the moment three crimes want the same six people.

  Crewing goes through the #689 matching against members who are **actually
  free** — never a per-role headcount, which cannot see overlap and is
  optimistic by up to 5x. Removing the busy-member filter fails two tests.

  **Deterministic, on purpose.** Spawns are allocated by weight in a
  largest-remainder round robin and interleaved, so a heavily-weighted crime
  cannot monopolise the first half of the horizon and flatter itself on
  availability. A leader asking "are we short?" needs a reproducible answer, not
  a sample; variance is a separate question from feasibility.

  ⚠️ **Occupancy is conservative and says so.** A committed member is reserved
  for the crime's *full* duration, though in reality the last joiner is held one
  day — 36 reserved person-days against the 23.5 actually consumed on a six-role
  crime, a **1.53× overstatement** that makes the roster look tighter than it
  is. That is the safe direction for a feasibility check but not a free
  assumption, so the result carries `reservedPersonDaysPerCrime`,
  `truePersonDaysPerCrime` and the ratio rather than burying it. Modelling the
  stagger properly is a scheduling problem, and a refinement rather than a
  correction.

  ⚠️ **Scope is tracked across the portfolio and never vetoes a spawn**, per the
  #701 decision. The output is `solvent` plus `shortfallPerDay` — actionable,
  because "this many scope a day short" tells a leader how much cheap spawning
  covers the gap, where "disallowed" does not.

  ⚠️ **Reports `no-readings` separately from `below-bar`.** A crime nobody can
  crew names its own reason, so the Elaborate "1 we cannot do" needs no special
  handling — and forge's current state on those roles is a **measurement gap,
  never an infeasible tier** (#351).

  Tier-agnostic throughout: scenarios arrive with their own `spawnWeight` and
  `category`, so the Advanced 25%-each and Elaborate 2:2:1 are *data*, and a
  tier added above Elaborate is a config entry.

---

## [3.104.0] - 2026-09-12

### Fixed

- **⚠️ The threshold search was starving a role chosen by ALPHABETICAL ORDER**
  (#692). Setting out to add the source document's carry trade turned up a
  bigger bug underneath it.

  The roles share a member pool, so in `candidateVectors` whoever is raised
  first takes first claim on the strongest members and whoever is raised last
  gets the leftovers. **The greedy raise was already making a carry choice** —
  it just sorted by position id, so the sacrificed role was whichever happened
  to sort last. On a six-role crime that is P6, for no reason at all.

  Ordering by **weight descending** makes the sacrifice deliberate: the role
  that moves success chance most gets the best people, and the least important
  absorbs the shortfall. That IS the document's carry trade, applied to every
  candidate rather than only an explicit one. Same roster, same code:

  ```
  position order:  {P1: 95, P2: 94, P3: 93, P4: 92}   ← P4 starved for sorting last
  weight order:    {P1: 95, P2: 93, P3: 94, P4: 92}   ← P3 (32.5%) outranks P2 (30.0%)
  ```

### Added

- **An explicit carry candidate** — the lowest-weight role pinned to its roster
  floor — generated **only when it lifts another role**. ⚠️ E(X) is monotone in
  CPR (verified 2026-09-12), so a vector that merely lowers the carry and
  changes nothing else can only score worse, and every candidate costs a
  probability call. Generating it unconditionally would double the budget to
  evaluate vectors we already know lose.

- Weights thread through `searchThresholds` and are optional — without them the
  order falls back to a stable numeric-aware sort and behaviour is unchanged.

### Known gap, now recorded

- ⚠️ **Publishing `0` on a carry role is a PRESENTATION decision, not a scoring
  one, and that half is not implemented here.** The bar is a floor, not a
  prediction: members bring whoever is free to that seat, so scoring a vector at
  its pinned-low CPR understates what happens, and the search will almost always
  prefer the un-pinned vector. The publication rule belongs to #694.

  More generally: **scored E(X) is a lower bound on what a crime really
  returns**, because every seat is scored at exactly the published bar. The
  source document raises the same point about scope in step 5 — *"it assumes
  each crime is undertaken with the exact minimum CPR levels"*. The gap is
  widest on exactly the carry roles #694 will publish as zero.

---

## [3.103.2] - 2026-09-12

### Documentation

- **✅ `E(X)` monotonicity in CPR is VERIFIED** — the one unproved assumption
  behind #692's candidate generation. Swept flat CPR vectors at 60/70/80/85/90/95
  against the live probability service and priced each response from the
  committed model. Monotone in all six scenarios, across three role counts and
  both reward types:

  | scenario | roles | reward | range |
  |---|---|---|---|
  | Blast from the Past | 6 | cash | 70.6M → 162.8M |
  | Break the Bank | 6 | cash | 179.6M → 363.9M |
  | Ace in the Hole | 5 | cash | 258.5M → 541.1M |
  | Clinical Precision | 4 | cash | 54.0M → 114.2M |
  | Window of Opportunity | 5 | items | 4.33 → 12.86 |
  | Crane Reaction | 6 | items | 1.15 → 2.88 |

  ⚠️ **The result is tenant-independent, which makes it stronger than planned.**
  The probability model and payout table are *global* — the model ships in the
  image and is identical for every faction (#606) — so this is a property of
  Torn's crime graph, not of anyone's roster. It did not need tnl.

  ⚠️ Item crimes were priced on **`itemCount` as a proxy**, since real prices
  live in the global item catalogue. That tests the *shape* of the risk, not its
  magnitude: a crime whose cheap items become likelier as CPR rises would still
  slip through.

- **✅ Two earlier fixes independently confirmed by the same sweep.** For Ace in
  the Hole and Window of Opportunity the service returns good endings the model
  does not know, and **every one has probability exactly 0** — so
  `withoutEndingPadding` (v3.95.0) is filtering genuine padding, not real
  endings. The unknown *bad* endings do carry real mass (0.088, 0.101) and
  contribute nothing, which is what `BAD_ENDINGS_PAY_ZERO` accounts for. **E(X)
  is complete.**

- **⚠️ Recorded a gap in slice 4: carry-role optimisation is NOT implemented.**
  `candidateVectors` raises every role as high as it independently can and never
  deliberately *sacrifices* one to lift the others, so an unequal vector like
  `{carry: 30, others: 90}` is never considered — and the source document says
  that shape is usually the better trade. The importance bands are unused for
  the same reason. **Slice 4 is incomplete until this lands**, and it should land
  before #693 builds on its output.

### Changed

- **The >30% importance band is 65–70**, not the interim 70–75. ⚠️ Noted in the
  record that this is narrower and lower-topped than the 25–30% band beneath it,
  inverting the otherwise monotone pattern — that is as specified, and written
  down because it looks like a typo and is not.

- **`g` stays at 12h.** It is our specified buffer. #687 goes ahead as a
  *measurement* to check the assumption; a measured value replacing the default
  is a separate decision, not an automatic consequence of measuring it.

---

## [3.103.1] - 2026-09-12

### Changed

- **⚠️ The scope break-even no longer disqualifies a CPR vector** (#692). v3.103.0
  treated it as a hard floor and refused any candidate below it, before scoring,
  so that money could not argue its way past.

  **That was wrong, because scope is a PORTFOLIO question, not a per-crime one.**
  MonChoon, 2026-09-12:

  > I am okay to have the higher paying crimes scope negative in the hopes that
  > some lower ones balance it out (since we cant control spawning) and if things
  > get to a point where we need to fill up scope a bit, we can always spawn some
  > lower level crimes, so im not worried about that, whatsoever.

  Scope is fungible across the whole spawn mix and cheaply replenished by
  running easier crimes. Refusing a lucrative crime because *that one crime* is
  scope-negative optimises a sub-problem nobody has — and we do not control what
  spawns, so a per-crime veto buys nothing anyway.

  Every candidate now carries `netScope` and `aboveBreakEven`, and **none is
  refused for it**. The only remaining rejection is a candidate we cannot price,
  which is "unmeasured" rather than "worthless" (#441/#473/#351). Solvency across
  the mix belongs to #693, which simulates the spawn distribution and can
  actually see the portfolio.

  ⚠️ Worth watching there: scope caps at 100 and regenerates +1/day, so if the
  chosen mix bleeds faster than the easy crimes replenish, the constraint
  reappears at portfolio level — which is exactly where #693 should catch it.

### Documentation

- **Carry roles publish `0`, confirmed deliberate** — the simulator uses the
  lowest real member's CPR so it does not model a literal zero, while the
  published guidance says zero, because "you do not need this role trained" is
  the true instruction and any number invites people to train toward it. ⚠️ The
  two surfaces disagree **by design**; anyone reconciling them later should not
  "fix" it.

- **"Which crimes can we not do" is now an OUTPUT, not an input.** #688's open
  question about *which* Elaborate crime is the "1" in 2:2:1 dissolves: a role
  with fewer readings than the crime has roles returns `null` from #691 and
  names itself in `limitingRoles`, and a vector yielding `k = 0` is not
  fieldable. ⚠️ The reason is kept distinct — "nobody is good enough" versus "we
  have never observed anyone in this role". forge is currently the second case,
  which is a measurement gap and not a verdict.

- **How to verify the model**, recorded in `docs/oc-cpr-algorithm.md`: forge
  lacks the readings and tnl has them, so every module in slices 1–4 is pure and
  injectable and can be run against either tenant. First thing to check is the
  one unproved assumption — `E(X)` monotonicity in CPR.

---

## [3.103.0] - 2026-09-12

### Added

- **`searchThresholds()` and `candidateVectors()`** (#692) — the core of the CPR
  algorithm (#688): descend from slice 3's ceiling and pick the vector that
  maximises `$ per faction member per day`.

  **The search is bounded at both ends**, and the lower bound is the part that
  was not in the source document:

  | bound | what it is |
  |---|---|
  | ceiling | `maximalCprVector` (#691) — above it the crime cannot be **crewed** |
  | floor | the scope break-even — below it the crime cannot be **sustained** |

  ⚠️ **The floor is not about money, and money must never win that argument.**
  Spawning costs scope up front and only success pays it back, so each category
  breaks even at `scopeCost / scopeReward`. `ocScope.js` has said so since #442:
  *"A crime paying enormous money below its break-even is still a crime the
  faction cannot afford to keep spawning, and money alone will never say so."*
  A candidate is disqualified **before** it is scored, so a huge payout cannot
  argue its way past. Disabling that check makes a 50%-success candidate paying
  `1e12` win three tests.

  **Why it is affordable.** ⚠️ Every candidate vector costs a call to
  tornprobability — a small third-party server this codebase already counts
  calls against — so a grid over six roles was never on the table. The structure
  rescues it: for one crime the objective reduces to `k × E(X)`, where `k` is a
  step function that is **free** to evaluate (#689) and `E(X)` is monotone and
  **expensive**. So the candidate set is **one vector per achievable crew
  count** — the highest vector that still seats `k` crews — which is a handful,
  not millions. **One probability call per crew count.**

  Generating those vectors extends Hall's theorem from slice 3: `k·n` candidates
  per role guarantees `k` crews by the same argument slice 3 uses for `k = 1`.
  That bar is conservative because it cannot see how disjoint the pools are, so
  each role is then greedily raised while the matching still holds — free,
  because matching is local. Every candidate carries `verifiedCrews` so the
  claim is checked rather than assumed.

  ⚠️ **`E(X)` monotonicity is an assumption, not a proof.** Raising a bar shifts
  probability mass toward better endings, but ending payouts are not ordered — a
  shift could land on a good ending that pays less, especially where the reward
  is items. Verify against a tenant with real readings before calling the result
  an optimum rather than a good heuristic.

  **The incumbent is a seed, not a tiebreak.** It orders the candidates so the
  search converges sooner, and has no influence on the outcome: if the roster
  degraded, the published bar is now impossible and must fall. `movement`
  reports what changed and the near-tie flag says when the pick was arbitrary.

  ⚠️ **Agnostic to the tier ladder, deliberately.** No tier name, tier count or
  role count appears in this module — the break-even is derived from the
  caller's category record, which lives in config. A tier added above Elaborate
  is a config entry, never a change here. There is a test that runs the same
  search against Advanced, Elaborate, and a hypothetical 9/10 tier.

  Two tests pin the interior optimum from opposite sides: the **same roster and
  the same code** picks one strong crew under a steep payout decay and three
  weaker ones under a gentle decay. A search hardwired to either endpoint would
  be wrong half the time.

---

## [3.102.1] - 2026-09-11

### Added

- **`docs/oc-cpr-algorithm.md`** — the working record for #688: the source
  document reproduced verbatim, then every decision taken about it and every
  mistake made along the way.

  ⚠️ **The mistakes are recorded deliberately.** Two were made twice in one
  sitting, by both of us, and one shipped a plausible formula that was 21% wrong
  in a direction that biased the whole tier hierarchy. A file holding only
  conclusions would let us re-derive them:

  - the **cumulative slack term** — `g·n(n-1)/2` instead of `(n-1)·g`, an error
    that *grows with `n`* so it never cancels;
  - the **Engineer off-by-one** — 86 in both the source document and a later
    screenshot, where only 5 members clear it and a six-role crime needs 6;
  - reading a **per-role headcount as a crew count**, wrong by 5× and always
    optimistically;
  - and a **withdrawn hysteresis requirement** that would have published CPR
    targets nobody could hit.

  Each entry says how it is now caught in a test.

### Changed

- **Step 3 of the CPR algorithm is deleted, not implemented** (#692). The source
  document asks for a hand-set hierarchy floor — *"Like maximum of the crime
  below x 90% or something"* — and flags it unresolved in the same breath.

  It **dissolves under the objective**: once we maximise `$/faction-member/day`
  across the whole spawn mix, a tier that does not beat the one below simply
  will not be chosen, so the constraint falls out of the optimisation rather
  than being imposed on it.

  ⚠️ What that loses is recorded rather than waved away: step 3 also carried the
  author's point that a higher tier *"could probably be slightly lower because
  easier CPRs at higher levels mean more flexibility in practice"*, and
  flexibility has real value a point estimate of throughput misses. If the
  optimiser starts recommending we abandon a tier and that feels wrong, this is
  the first place to look — and the fix is to model flexibility explicitly, not
  to reinstate a 90% fudge.

---

## [3.102.0] - 2026-09-11

### Added

- **`personDays()` and `perPersonPerDay()`** (#690) — what a crime is worth per
  person per day, which is the metric the whole CPR algorithm (#688) optimises
  against and the only honest way to compare crimes with different role counts.
  A bigger crime ties up more people for longer, so ranking on raw E(X) silently
  favours it.

  A crime completes `24h × n` after the first member joins — each member adds
  24h in their role and the roles run back to back — so one run consumes:

  ```
  personDays(n, g) = n(n+1)/2  +  (n-1)·g
  ```

  ⚠️ **The slack term is `(n-1)·g` and is NOT cumulative.** The gaps do not
  delay the crime; it completes at `24h × n` whatever happens. Joiners arrive
  *early* and idle rather than the crime finishing *late*, so each non-first
  joiner is held exactly `g` longer than ideal, **once**. Modelling the gaps as
  pushing completion out gives `g·n(n-1)/2`, which over-charges a six-role crime
  by 21% — and because the error grows with `n`, it biases the tier-against-tier
  comparison the algorithm is built on. I made exactly that mistake in review;
  the test that catches it walks the join schedule by hand and is deliberately
  not the closed form under test.

  **Two figures, both reported:**

  - `perParticipant` — what somebody in the crew earns for their time
  - `perFactionMember` — the same income across the whole roster, so an idle
    member counts as the cost they are

  ⚠️ They coincide at full utilisation and diverge exactly when the CPR bar is
  too high to crew a second crime. That is the whole tension the algorithm
  resolves: optimising the first alone sets every bar to the ceiling and leaves
  most of the faction earning nothing.

  `g` is **faction behaviour, not a game rule** — the only free parameter in the
  figure, defaulting to 12h, clamped to `[0, 24h]`, and flagged `gapIsAssumed`
  until #687 measures our real value. It moves the answer by ~22% across that
  range, and every threshold the algorithm produces inherits it.

  Absent, never zero, wherever an input is missing (#441/#473/#351) — a crime
  with no reward coverage has no value we can state, and a zero would read as
  "worthless". `missing` names what was unavailable, and the parts that *can* be
  computed still come back.

---

## [3.101.0] - 2026-09-11

### Added

- **`maximalCprVector()`** (#691) — step 1 of the CPR algorithm: the highest bar
  we can set on each role while at least `n` members can still fill it, where
  `n` is the crime's role count.

  ⚠️ **This is the CEILING of the search space, not the answer we publish.** The
  algorithm document frames it the same way ("This sets the upper limit of the
  potential income for each crime"); #692 descends from here looking for the
  vector that maximises $ per faction member per day. Publishing it directly
  would ask the whole faction to train to a bar that lets us run exactly one
  crime.

  ⚠️ **Why `n`:** Hall's marriage theorem. If every one of `n` roles has at
  least `n` candidates then for any subset S of roles |N(S)| >= n >= |S|, so a
  crew of *distinct* members always exists. Not a heuristic — provably
  sufficient for a single crime, and exactly the condition that closes the
  disjointness gap `ocRosterFit.js` has documented since #442.

  **No safety margin, deliberately.** The output is fragile by construction — on
  Blast from the Past one CPR point costs six of seven eligible members on three
  of six roles — and that is fine because nothing is published from it.

  Reports the **cliff** (how many members one more point costs) alongside each
  threshold, because a bar of 87 with seven clearing it and one clearing 88 is a
  different object from one with headroom, and #692 needs to know which it has.
  Keeps the per-role reading count too: the denominators genuinely differ
  (92, 88, 92, 92, 91, 91 live), and a member with no reading is absent rather
  than failing (#351).

  Pinned against the real Blast from the Past table from forge, including the
  off-by-one that MonChoon and I both made in an earlier pass — **Engineer at 86
  has only 5 eligible, below the bar for a six-role crime, so the answer is 85.**
  Requiring `n-1` instead of `n` fails seven assertions.

  ⚠️ One test pins the pipeline's sharpest edge: the *same* maximal vector seats
  **seven** crews against independent per-role pools and **one** against an
  overlapping roster. Step 1 cannot see overlap — that is `maxDisjointCrews`
  (#689), and it is why step 1 is a ceiling rather than an answer.

---

## [3.100.0] - 2026-09-11

### Added

- **`maxDisjointCrews()`** (#689) — how many organised crimes we can actually
  crew at once, by bipartite matching on real per-member CPR readings rather
  than by counting heads per role.

  ⚠️ **A per-role headcount can be wrong about this by 5x, always in the
  optimistic direction.** On Blast from the Past every role has 7–9 eligible
  members, which reads as "seven crews". If the same nine strong members are the
  ones clearing every bar, the roster seats **one**. A member cannot be in two
  crimes at once, so a seat filled on one role is a seat unavailable on every
  other — and no per-role number can see that.

  This is the assignment problem `ocRosterFit.js` has carried a warning about
  since #442:

  > ⚠️ Deliberately does NOT check that the eligible sets are disjoint. One
  > member can be the only person clearing the bar for three roles, and this
  > would call that crime crewable.

  For a *single* crime the gap is harmless — Hall's marriage theorem says that
  if every one of `n` roles has at least `n` candidates then a crew of distinct
  members always exists. The guarantee dies at two concurrent crimes, which is
  exactly where #688 needs it.

  Returns the seating, not just the count, so the team builder (#443) can build
  on it instead of reimplementing it. Reports `limitingRoles` — which roles ran
  dry — so #693 can relax the right threshold instead of lowering every bar.

  ⚠️ "Never observed in this role" and "observed, below the bar" are reported
  **separately and never summed**: the first is a gap in our measurement, the
  second a gap in the roster, and confusing them sends someone training a member
  who is already fine (#351). An absent reading excludes a member rather than
  passing them — treating unknown as eligible would inflate the count on exactly
  the roles we have measured least.

  Deterministic by construction, because a leader comparing two runs must not
  see crews reshuffle when nothing real changed.

  **Verified against exhaustive search on 600 random rosters.** Replacing the
  augmenting-path search with the naive greedy version — the classic way to get
  this subtly wrong — fails that cross-check immediately.

---

## [3.99.0] - 2026-09-10

### Added

- **`scraper-runs-prune`** (daily, 01:50) — retention for the run log itself.
  It has been append-only since the first tenant went live, at **~2,250 rows a
  day per tenant**, and nothing ever removed one. On 2026-09-10 that growth
  turned an inefficient fleet-metrics query into a live outage: ten abandoned
  copies of it piled up on one tenant and took a four-core box that also serves
  production to a **load average of 13.5**. The query is fixed and no longer
  cares about table size — this is so nothing else inherits the trap.

  ⚠️ **What must SURVIVE the prune is the whole difficulty.** A plain
  "delete older than 30 days" silently corrupts both figures the fleet-metrics
  endpoint computes from history, and corrupts them in the direction of looking
  healthier than the truth:

  - `lastSuccessAt` is `null` for a job that has **never** succeeded, which is
    deliberately distinct from "succeeded a long time ago". Prune an old success
    and a quiet-but-working job starts reporting as one that has never worked.
  - `consecutiveFailures` counts back to the last success. Prune any of those
    failures and the number quietly *shrinks as the outage deepens*.

  So two classes of row are kept regardless of age: **each job's newest
  success**, and **every failure after it**. What that leaves is genuinely dead
  history, and nothing reads it — every other consumer (`admin.ts`,
  `runLog.ts`) asks for the most recent N runs, never a date range.

  ⚠️ A job that has **never** succeeded therefore keeps its entire streak
  forever, by design rather than by oversight. Capping it would mean reporting a
  number smaller than the truth about the most broken job on the fleet — the one
  case where the count matters most. It is bounded by fixing the job: one
  success makes the whole history prunable on the next run. A job failing every
  five minutes for a year costs ~105k rows, which the rebuilt query answers from
  an index in milliseconds.

  In-flight `running` rows are never deleted: a later `UPDATE` finishes them,
  and an old `started_at` is exactly what a hung job looks like.

  Eight tests, six of them about what the prune must *not* touch — including
  round-tripping `collectFleetMetrics` before and after to prove neither figure
  moves.

---

## [3.98.2] - 2026-09-10

### Fixed

- **⚠️ The fleet-metrics endpoint took 13–25 seconds, on every tenant — and the
  collector gives up at 3.** Measured live on `forge`: an unauthenticated caller
  is rejected in milliseconds, a valid one waits **13.7s, 15.2s, 20.9s** across
  three consecutive calls, and two earlier attempts exceeded a 25s ceiling
  outright. `TENANT_TIMEOUT_MS` is **3s**, so no measurement has ever landed:
  the status page reported `metricsError` for every tenant, which reads as
  *"not measured"* — the exact shape #645 hid in for thirteen days.

  So the monitoring #632 built to catch #645 has been down since it shipped. A
  health check that answers four to eight times too late is worse than none,
  because it occupies the slot where a working one would go.

  ⚠️ And it was getting worse on a clock: `forge` logs **2,248 scraper runs a
  day**, all of them kept forever.

  The consecutive-failure query expressed the streak as a correlated `min(rn)`
  subquery **re-evaluated per row** over a CTE spanning all of `scraper_runs` —
  a table that is append-only and has never been pruned. Its growth, measured:

  | rows | old query | rebuilt query |
  |---|---|---|
  | 5.5k | 412ms | 2ms |
  | 10.5k | 765ms | 2ms |
  | 20.5k | 1,865ms | 3ms |
  | 50.5k | 8,793ms | 3ms |
  | 504k | **still running at 60s** | 14ms |

  Rebuilt as two indexed lookups per job — find that job's newest success, then
  count the failures after it — which is O(jobs × streak length) rather than
  O(table). Semantics are unchanged, including the case that matters most: a job
  that has **never** succeeded reports every failure it has ever logged, which is
  capacityx's shape in #645.

- **`SET statement_timeout` on the metrics path** (5s), on a dedicated
  connection and reset in `finally`. ⚠️ The admin collector gives up on a tenant
  after 3s, but Postgres does not stop because the client walked away — the
  tenant kept burning CPU on an answer nobody was waiting for, once a minute,
  forever. `db` is a *pool*, so a bare `SET` would have left this endpoint's
  ceiling on one random connection serving ordinary application queries.

### Added

- **Migration 0061** — `idx_scraper_runs_job_status_started` on
  `(job_name, status, started_at DESC)`, which is what keeps the rebuilt query
  O(jobs): 250ms without it, **14ms** with, on 504k rows.

  ⚠️ A bare `(started_at DESC)` index was tried alongside it and deliberately
  left out. It looks helpful — the 24-hour window count goes 55ms → 4ms — but
  the planner then prefers it for the per-job "newest success" probe and walks
  the whole index filtering by `job_name`, putting the query that matters back
  to **370ms**. A 26× regression on the hot query to save 50ms on the cold one.
  The migration test asserts it stays absent.

- **A scale regression test.** The old query was fine on the dozen rows the
  other tests insert and could not answer in production. `fleet-metrics.test.ts`
  now seeds 40,000 runs across 12 enabled jobs and asserts the call returns
  under 2s — reverting the query to its old form fails it at 3,885ms.

- **A migration test asserting `db/template.sql` and migration 0061 agree**, so a
  newly provisioned faction cannot silently be the slow one. Two hand-edited
  files; nothing else checked.

---

## [3.98.1] - 2026-09-10

### Fixed

- **The intermittent red build.** Every server test file booted its **own**
  embedded Postgres cluster — `initdb`, `start`, apply `db/template.sql`, `stop`
  — 83 times a run. Measured on an idle box that is ~1.6s of pure lifecycle per
  file, ~900ms of it `initdb`, which is I/O-bound and CPU-hungry. Vitest runs
  one worker per core, so four fire at once.

  ⚠️ The runner has **four cores**, hosts **all five production tenants**, and
  carries a **second Actions runner** — so two suites can overlap and ask that
  box for eight simultaneous cluster bootstraps while it is already busy. That
  is the whole mechanism: the symptom was never an assertion, always
  `Hook timed out` in whichever file happened to be starting when the box was
  busiest. `admin-provisioning`, `scrapers-jobs`, `oc` and `crime-participation`
  each drew the short straw at least once, and every one of them passes in
  seconds when run alone.

  There is now **one cluster for the whole run** (`test/globalPostgres.ts`,
  a vitest `globalSetup`) with two prepared TEMPLATE databases. A test stack
  costs one `CREATE DATABASE ... TEMPLATE`, which Postgres implements as a file
  copy: **~44ms against ~1.6s**, and no `initdb` at all. 81 of the 83 files use
  it; the two that create cluster-scoped **roles** keep their own cluster, and
  say why in place.

  Measured on four pinned cores — the runner's actual shape — with the server
  suite run three ways:

  | harness | worker threads | duration |
  |---|---|---|
  | per-file clusters | 2 (the #663 cap) | 153.9s |
  | per-file clusters | 4 | 124.0s |
  | **shared cluster** | **4** | **66.1s** |

  1961/1961 passing in every cell. ⚠️ Wall clock on the real runner is NOT a
  usable measure of this: across ten recent pre-change runs the vitest step
  ranged 149–364s (median 264s), and the first run on this branch came in at
  263s — indistinguishable from noise, because that box is also serving five
  production tenants and a concurrent compose build. The controlled measurement
  above is the evidence; the CI number is not.

- **⚠️ The `maxThreads: 2` cap from #663 is gone.** It was the first attempt at
  this same flake and it made things *worse* — ~100–150s slower — because
  starving the parallelism never stopped 83 cluster bootstraps from
  oversubscribing the box, it only made them queue. With the bootstraps gone, a
  worker that loses the CPU race runs slower instead of blowing a hook timeout.
  Capped explicitly at 4 rather than left undefined, so a future runner with
  more cores cannot stampede the production containers sharing the box.

  The two changes were measured apart: dropping the cap is worth 154s → 124s,
  and the shared cluster the remaining 124s → 66s.

---

## [3.98.0] - 2026-09-07

### Changed

- **A role whose name and slot disagree between sources is now matched on its
  name, instead of being refused.** `matchRolesToPositions` cross-checks
  tornprobability's role name against its position id, and where the two pointed
  at different Torn slots it produced no match at all — so the OC Simulator
  showed *"This role's name and slot disagree between sources, so its readings
  are not trustworthy enough to count"* and no headcount.

  ⚠️ That was the wrong trade. A disagreement is nearly always tornprobability
  numbering its slots differently from Torn — precisely the case the **name**
  lookup is immune to, and the same signal the single-source branch has always
  preferred for the same stated reason. The refusal bought protection against a
  name collision that has never been observed, and paid for it with a real
  headcount on every affected role plus a warning no reader could act on.

  The disagreement is still reported in `conflicts` for diagnosis, and the match
  records `via: 'name'` so it never claims corroboration it lost. The Simulator
  warning is gone.

### Added

- **`node db/fleet-metrics-token.mjs --write`** — writes each tenant's
  `FLEET_METRICS_TOKEN` straight into `deploy/docker-compose.override.yml`,
  replacing the value where the key exists and inserting it into the
  `environment:` block where it does not.

  ⚠️ This is the half of #632 that provisioning could never cover.
  `new-faction.mjs` bakes the token in at creation time, which serves factions
  created *after* `FLEET_METRICS_SECRET` is set — but the secret is generated
  once, later, against a fleet that is already running, so **every existing
  tenant predates it**. Rotating the secret has the same shape: it changes all
  the tokens at once, and a partial rotation is the worst state, because a
  tenant on a stale token 401s and reports as *"not measured"* — the exact
  shape #645 hid in for thirteen days.

  Refuses to write anything if any slug has no `api-<slug>` service, keeps a
  timestamped backup (the file is gitignored, so there is no `git checkout` to
  undo a bad write), and rejects a token that is not a 64-char hex digest — a
  `$` in a compose value is silently interpolated away.

---

## [3.97.1] - 2026-09-07

### Fixed

- **⚠️ HOTFIX: the OC Simulator crashed on every render.** v3.97.0 shipped a
  `useMemo` whose dependency array named `collapsed` from *above* its own
  declaration. A dependency array is evaluated **immediately**, not deferred
  with the callback, so that is a temporal-dead-zone throw the moment the result
  panel renders — surfacing in production as
  **"Cannot access 'o' before initialization"** and replacing the whole page
  with the error boundary. `goodProbabilities` now sits below `collapsed`.

  ⚠️ Not device-specific, despite first being reported on a phone: it threw for
  every user on every browser.

### Added

- **A rendering test for the result panel** (`OCSimulatorResultPanel.test.jsx`),
  and `ResultPanel` is exported so it can be mounted.

  ⚠️ This is the gap that let the crash ship. Every pure helper in the chain —
  `withoutEndingPadding`, `collapseAliasedEndings`, `endingValueBreakdown`,
  `expectedValue` — had tests, and all of them passed. **Nothing mounted the
  component**, so a fault in how those helpers were wired together was invisible
  to a suite of 1,743 tests. The new file asserts the folding and the padding
  trim, but its real job is the render itself: reverting the fix reproduces
  `ReferenceError: Cannot access 'collapsed' before initialization` in four of
  its five cases. The loading, calculating, error and items-paying branches are
  each mounted too, since any of them could carry the next one.

## [3.97.0] - 2026-09-07

### Changed

- **The Simulator's endings list folds alias rows into the ending they belong
  to.** Blast from the Past listed `goodEnding3`, `goodEnding35` and
  `goodEnding310` as three rows with identical payouts — noise, since they are
  one outcome the probability service labels three ways. Its list goes from 13
  rows to 9.

  ⚠️ **The probability MOVES; it is not discarded.** `goodEnding3` now reads
  **17.778%**, which is what Crimes Hub's simulator gives that terminal. Hiding
  the alias rows instead would have left it reading 10.526% and the column no
  longer summing to 100% — a worse lie than the noise it removed. A `×3` marker
  names the merged labels on hover.

  E(x), the payout spread and expected respect are unchanged: an alias prices
  from the same node as its target, so summing rows that share a payout gives an
  identical total. Blast from the Past stays at $122,489,526.

- **An items-paying ending says "in items", not "+items".** ⚠️ Nothing is being
  added. Measured across all 31 scenarios, **21 crimes pay purely in cash, 8
  purely in items, and not one pays both** — so on those eight this figure *is*
  the payout, priced at current market rates. The old label read as a bonus on
  top of a cash reward that does not exist.

### Added

- **Every ending shows the spread behind its averaged figure**, where there is
  one, and the reward detail on hover: which drops make up an item value, how
  often each lands, what each contributes, and how many observed runs the whole
  thing rests on.

  Cash and item value carry different kinds of uncertainty and are reported
  separately rather than flattened into one ±. Cash is an observed min/avg/max
  over the node's runs — Blast from the Past's `goodEnding1` averages
  $172,408,913 across **$158,585,000 – $215,676,000**, a $57M swing that was
  previously invisible. Item value is an expectation, `Σ dropRate × qty × price`.

  ⚠️ The item **floor counts only drops seen on every observed run**. A drop that
  landed 780 times in 781 is not a floor, and rounding it into one would present
  a near-certainty as a guarantee. Neither bound is a promise the game makes,
  which is why the observation count is stated on the same line as the range —
  a floor from two runs and one from six thousand otherwise render identically.

  ⚠️ A drop the catalogue cannot price is **excluded from every figure and named**,
  so the total is a floor rather than a silent underestimate.

- `priceNodeItems()` returns `min`, `max` and a per-drop breakdown alongside
  `value`; the API ships `item_value_min`, `item_value_max` and `item_drops`
  (capped at 8, sorted by contribution — the totals cover every drop).

## [3.96.0] - 2026-09-07

### Added

- **The Simulator says when the two sources disagree about whether an ending is a
  success**, instead of resolving it silently in either direction.

  Counter Offer is the case. Crimes Hub's four good terminals match ours
  one-to-one — 45.625/15.208/19.011/5.070 against 45.62/15.21/19.01/5.07, every
  one inside 0.005 points — so there is no deficit and nothing for our
  `goodEnding4` and `goodEnding5` to fold into. They are **extra success mass**:

  ```
  our success 91.588  −  hub success 84.91  =  6.678
  goodEnding5  5.407  +  goodEnding4 1.267  =  6.674
  our failure   8.412  +  6.674             = 15.086   vs hub failure 15.09
  ```

  It closes to 0.004 points, and Crimes Hub's flowchart draws exactly two bad
  ends we do not have — the two it labels **"Bad End #5?"** and **"Bad End #6?"**,
  the only endings on the crime it marks with a question mark.

  ⚠️ **Deliberately not resolved.** The probability service counts those two as
  successes; Crimes Hub counts them as failures; both models are internally
  consistent and sum to 100%. Adopting either would swap one confident number for
  another, on the say-so of a source hedging with its own "?". The endings carry
  `disputedKind` (`disputed_kind` over the API) recording what the *other* source
  says, and `kind` is untouched.

  ⚠️ **This is why the aliasing was not generalised.** In our data Blast from the
  Past and Counter Offer look identical — starved good endings holding real
  probability. They mean opposite things: Blast's belong to good terminals it
  already draws, Counter Offer's belong to *bad* ones. Aliasing Counter Offer's
  onto good terminals, which the Blast precedent suggested, would have invented
  about **$1.4M** of expected value that does not exist.

  The panel derives the alternative figure **live** — our success chance minus the
  contested endings' probability — rather than reading the recorded one, so the
  caveat holds at every crew instead of only the one it was captured at. The
  recorded `disputedSuccessChance` is kept as the anchor proving the derivation
  reproduces Crimes Hub's published 84.91% at all-75, and a test pins it.

  ⚠️ **The expected value is unaffected** — a failure pays $0 and a starved ending
  is priced $0, so E(x) is identical either way. What moves is the success chance
  and the **scope verdict** that reads off it: at Intermediate (costs 3, pays 4)
  this crew nets 0.66 scope per run at 91.59% and 0.40 at 84.91%. The panel now
  says to treat that margin as the optimistic end of a range.

### Changed

- A contested ending's row shows **"Crimes Hub: failure"** in place of the
  starved tag. "No diagram match" describes a *gap*, and this is not one — the
  other model has the ending, it just files it on the other side.

## [3.95.0] - 2026-09-07

### Added

- **`server/src/oc/model-overrides.json`** — recorded corrections to the OC model
  that the build cannot derive for itself, each carrying its evidence.

  ⚠️ This file exists because the corrections are **not re-derivable**. The probe
  sweep that produced the ending→node mapping ran against tornprobability's live
  API and no longer runs, and the tenant export carries only its *result*
  (`resolved` / `starved`), not the per-ending probabilities it decided from. A
  correction therefore has to be written down or it is lost on the next rebuild.

  Two entry kinds. `aliasEndings` folds a surplus API ending label onto the
  diagram terminal it actually shares; `rewardFrom` says which Crimes Hub ending
  holds a given ending's published reward, for the cases where the two services
  number their endings differently.

### Fixed

- **Blast from the Past's expected value was understated by 10% and presented as
  exact.** Crimes Hub draws four good terminals for that crime; tornprobability
  reports eight good endings. The surplus four — `goodEnding35`, `45`, `310`,
  `410` — were starved, and because a starved ending is priced-at-$0-*by
  definition* (#473) the panel reported the crime as fully priced: a firm
  **$111,028,512**, with 9.67% of the probability silently valued at nothing.

  Crimes Hub's own simulator settles it. At all six CPRs at 75:

  | Crimes Hub | | tornprobability |
  |---|---|---|
  | Good End #3 = `_B8S1_` | **17.78%** | `goodEnding3` 10.526 + `35` 6.316 + `310` 0.936 = **17.778** |
  | Good End #4 = `_B8S2_` | **5.93%** | `goodEnding4` 3.509 + `45` 2.104 + `410` 0.312 = **5.925** |

  Good Ends #1 and #2 match one-to-one, as do all three bad ends — the two
  services agree everywhere except this grouping. The four now resolve to the
  terminals they share and price from the same observations, giving
  **$122,489,526**.

- **Counter Offer's published reward sat on the wrong ending.** Crimes Hub
  numbers endings by reward rank; tornprobability numbers them its own way, and
  the reward was joined by key name. Matching the hub's published respect against
  each terminal's *observed* respect identifies the join exactly — `_A7S_` 171 ↔
  170, `_A7S2_` 153 ↔ 155, `_A5S_` 137 ↔ 136, `_B5S_` 120 ↔ **122** — so the
  hub's `goodEnding4` is our `goodEnding6`. By name it landed on our
  `goodEnding4`: the one starved ending on the crime, and therefore the only one
  with no observation to check it against.

  ⚠️ A hub key claimed through `rewardFrom` is **consumed** by that mapping and is
  no longer joined to the ending that merely shares its name — otherwise the
  reward would be attached twice, once correctly and once back where it started.

### Changed

- Endings carry **`aliasOf`** (`alias_of` over the API), and the Simulator shows
  a quiet `= goodEnding3` beside an aliased row. Without it the reader sees two
  rows with identical payouts and no reason for it, which reads as a duplicate
  row rather than as one terminal reported under several labels.

  ⚠️ An alias is **not** a duplicate to filter out. It carries its own
  probability, and the labels together are what the terminal is worth.

## [3.94.2] - 2026-09-07

### Fixed

- **The OC Simulator no longer badges endings whose mapping cannot matter.** A
  bad ending pays $0 by the game's rules, so whether it resolved to a diagram
  node changes nothing anyone can act on — but the per-row badge asked every
  ending, not just the good ones, and **97 of the fleet's bad endings are
  unmapped**. Clinical Precision showed five amber "unmapped" flags on a crime
  whose pricing is complete. `pricingQuality()` had scoped its own summary line
  to good endings all along; the row badge was the one place still asking.

  Across all 31 scenarios there are now **zero** unmapped good endings, which is
  the number that was always being reported — just buried under the bad ones.

- **The Simulator no longer lists ending slots the crime does not have.**
  tornprobability answers with a fixed number of ending slots and pads the
  unused tail with exact zeros. Window of Opportunity has six good endings and
  no bad ones; the response carries `goodEnding1..10` **and** `badEnding1..10`,
  so **fourteen of its twenty rows described endings that do not exist** — four
  reading "unpriced", ten reading "$0". The four also reached
  `expectedValue()`'s `missing`, so the panel announced a lower bound on a crime
  it had priced in full.

  The server already trims this when building the model (`realEndingKeys`), but
  the live `/calculate` response is passed through verbatim by design, so
  `withoutEndingPadding()` does it again client-side.

  ⚠️ The test is **"unknown to the model AND exactly zero"**, never either alone.
  Zero alone would hide a real ending that is merely unreachable at these CPRs,
  making it blink in and out of the list as the sliders move. Unknown alone
  would hide a genuine disagreement — if the service puts real probability on a
  key we have never heard of, that is precisely what a reader needs told, and it
  stays on screen as unpriced.

  ⚠️ Deliberately **does not** touch Blast from the Past's `goodEnding35` /
  `45` / `310` / `410`. Those are in the model, carry 9.67% of that crime's mass
  between them, and are a separate open question — hiding them behind a fix for
  a different problem would have buried it.

- **The unpriced-coverage figure is the mass on the unpriced endings, not the
  leftover.** It was rendered as `1 - pricedProbability`, which is a different
  number whenever the service's own probabilities do not sum to 1 — and they
  often do not. Window of Opportunity's come to 0.99675, so the panel read
  **"4 endings unpriced, covering 0.33% of the probability"** about four endings
  sitting at exactly 0.000%. The residual is upstream mass loss; attributing it
  to our unpriced endings pointed the reader at the wrong problem.
  `expectedValue()` now returns `missingProbability` alongside
  `pricedProbability`.

## [3.94.1] - 2026-09-07

### Fixed

- **The attack-page assist overlay scrolls with the page instead of hanging in
  the viewport.** It was `position: fixed`, so it stayed in the same place on
  screen while the page moved underneath it and covered whatever happened to be
  behind — the same complaint the faction-page settings panel had before #590,
  and fixed the same way. Userscript `@version` 1.51.0.

  ⚠️ The trade is deliberate: park it high, scroll a long way down, and it
  scrolls out of view where a fixed panel would have followed. That is the
  requested behaviour; the drag handle and the remembered position are what
  make it workable — put it beside the fight and it stays beside the fight.

  ⚠️ Positions are now stored in **page** coordinates while pointer events and
  rects arrive in **viewport** coordinates, so both are converted at each seam.
  Clamping still happens in viewport space: the clamp exists to stop a position
  saved on a wide desktop stranding the panel off-screen on a phone, and
  clamping to the document instead would permit exactly the off-screen position
  it exists to prevent.

  ⚠️ The `visualViewport` **scroll** listener is removed. It re-clamped the
  panel into the current viewport, which is right when the window changes size
  and wrong on a scroll — it would have dragged the panel along and undone the
  whole change. Resizing can orphan a position; scrolling cannot.

- **The overlay no longer covers Torn's chat.** It sat at `2147483000`, above
  every layer Torn has including its own `2000000000` recaptcha bubble.

  ⚠️ The replacement is **read from the live page**, not hard-coded: Torn sets
  `#chatRoot`'s z-index in its own stylesheet, so it is absent from any saved
  copy of the page, and a capture shows values from 10 to 2000000000 with no
  way to tell which layer is which. The overlay now computes one below the
  chat's own, which also survives Torn changing the number. Falls back to 9000
  when there is no chat, or when it reports `auto` — parsing that as 0 would
  bury the panel under the attack UI it has to sit above.

## [3.94.0] - 2026-09-07

### Removed

- **`oc-scenarios-mirror` and its three per-tenant tables are gone (#606 slice
  3).** Scenario structure is Torn game data — the flowchart for Crane Reaction
  is identical for every faction and changes when Torn ships an update, perhaps
  a few times a year. Mirroring it per tenant on a schedule spent API budget and
  scraper slots on a constant, and let two tenants disagree about a fact that
  cannot differ between them.

  ⚠️ Worse, it ran only where somebody had enabled the job: on 2026-09-06
  **three of five live tenants held zero scenarios** and their Simulator was
  silently empty — an empty table looks exactly like a crime with no data.

  Migration `0060` drops `oc_scenarios`, `oc_scenario_roles`,
  `oc_scenario_endings` and `oc_scenario_node_stats`, after creating and
  backfilling their replacement.

### Changed

- **The model now carries per-node money/respect/item aggregates and
  `observed_paths`.** ⚠️ Both were global all along — the mirror wrote them
  straight from tornprobability's feed — so dropping those tables without
  carrying them first would have stripped the per-node payouts, E(x) and
  success figures the Simulator renders, and an empty stats map looks exactly
  like a node nobody has run. `observed_paths` in particular is how many paths
  **tornprobability** observed, not us, despite an old comment in `oc.ts`
  calling it ours.
- **Our own probe measurements moved to `oc_scenario_quality`.** The four
  `ending_map_*` columns are genuinely per-tenant — derived by the maintainer
  probe sweep (#471/#473) against a tenant's own data — so they stay in the
  tenant database, now in a table with no dependency on the dropped mirror.
- **`fetched_at` is always null and stays in the response shape.** It meant
  "when we last fetched from tornprobability"; with no fetcher there is no
  honest value, and a build timestamp would assert a freshness the data does
  not have.
- A crime with no model — a newly released OC that neither tornprobability nor
  Crimes Hub has mapped — simply does not appear in the Simulator. MonChoon's
  call, 2026-09-07.

⚠️ **Refreshing the model now requires the export to include `node_stats` and
`observed_paths`.** An export without them builds a model that looks complete
and shows no money. The runbook SQL is updated and says so.

## [3.93.0] - 2026-09-07

### Added

- **Loadout capture now records weapon specials, item quality and needle
  sightings (#616).** Userscript `@version` 1.50.0.

  - **Specials and attachments.** Read from `data-bonus-attachment-title` /
    `-description` — Torn's own words — never from the class, which carries a
    slug that would need a lookup table for every bonus in the game.
    ⚠️ `blank-bonus-25` is an EMPTY bonus slot with a blank title; Torn draws
    four per weapon as padding, so counting them would give every weapon —
    including Fists — four phantom specials. Skipped at capture and refused by
    the validator.
  - **Quality.** ⚠️ Rarity is Torn's own glow, not item circulation. An earlier
    analysis proposed `circulation < 5000`, which measures how many exist and
    tracks quality only by accident. Matched by PREFIX (`glow-yellow___B37GS`
    carries a CSS-module hash that changes on Torn's next rebuild; pinning it
    would silently report every rare weapon as ordinary).
    ⚠️ One capture showed a weapon carrying both `glow-yellow` and a separate
    `orange` token. That is probably the real tier, but it rests on a single
    sample — so both are stored as observed and **neither is interpreted**.
  - **Needles.** ⚠️ Recorded as "seen using needles", not as live state.
    Fighters roll them — inject, fight, switch, inject — so the temp slot shows
    only whichever was loaded at that instant. Absence is explicitly not
    evidence: a miss means "not caught mid-injection", never "does not use
    needles", and the UI renders no negative from it.
  - **Display: notable weapons first, ordinary ones kept.** Sorted, never
    filtered — a hard filter would make "genuinely unarmoured" and "not
    captured yet" look identical to a lead.
  - **Armour is listed in full**, unchanged. Torn paints no quality on it and
    exposes no bonuses for it, so there is nothing to rank on; a rare-armour
    list is a later hard-coded follow-up.

  All fields are best-effort, the same rule #528 set for `item_id`: a weapon
  with no bonuses is ordinary, not broken, and a capture is never rejected for
  lacking them.

## [3.92.0] - 2026-09-07

### Changed

- **Payout time now comes from the crime-occupancy poller whenever it ran at
  all, instead of being discarded over jitter (#665).** The gate was "was this
  window perfectly watched"; it is now "did we watch at all".

  ⚠️ Measured over 30 days of production: forge and tnl each poll ~1435 of 1440
  minutes a day — **99.97% coverage** — and each still accumulate **four** gaps
  over the 180s tolerance, the worst 240s, totalling about 13 minutes. Since
  roughly one lands per week, a week-long payout window almost always contained
  one and almost always fell back to the legacy `crime_slots` calculation. That
  fallback is structurally lossy: the table is snapshot-keyed, so a seat change
  or a leave-and-rejoin silently overwrites `joined_at` and the earlier stint is
  gone. Thirteen minutes of jitter was throwing away a month of minute-accurate
  data in favour of a source that loses whole stints.

  Ambiguous gaps are credited rather than reconciled. With a worst gap of 240s
  the error is bounded at about four minutes; the fallback's error is unbounded.

- **Gaps of an hour or more are surfaced in the Occupancy panel**, separately
  from ordinary jitter. ⚠️ An hour unwatched can hide an entire stint from start
  to finish — someone joined and left inside it and left no trace — so the
  resulting payout is wrong in a way nobody can see from the number. Short gaps
  cost a few minutes of one member's credit and stay silent.

### Fixed

- The Occupancy panel claimed a window was "fully watched" whenever occupancy
  drove the payout. Since those are no longer the same statement, it now says
  what it actually knows.

⚠️ **Saved payout history is unaffected.** `oc_payout_weeks` / `oc_payout_members`
store computed results and are read back verbatim, so every already-saved week
displays exactly what it displayed before. The no-polls fallback is retained for
one reason: occupancy data begins 2026-08-13 and **22 of forge's 25 saved weeks
predate it**, so a pure-occupancy rule would credit those windows zero and a
re-save would overwrite a real historical payout with zeros.

## [3.91.2] - 2026-09-07

⚠️ 3.91.1 was cut from `main` as a hotfix (the userscript `@version` bump for
#617) while this was in flight, which is why the numbers interleave. It is
listed below, having arrived here with the `main` → `dev` merge-back.

### Fixed

- **CI: cap vitest workers so embedded-Postgres suites stop timing out.** Every
  server and db test file boots its own embedded Postgres, and vitest defaults
  to one worker per core — so the 4-core runner tried to `initdb` four clusters
  at once. That box also hosts the five production tenant containers and a
  second Actions runner, so two suites can overlap: up to eight clusters
  competing for four already-busy cores.

  ⚠️ The symptom was never an assertion. It was `Hook timed out in 180000ms` in
  whichever file happened to be starting when the box was busiest —
  `admin-provisioning`, `scrapers-jobs` and `oc` each drew the short straw
  during this session's work, and every one of them passes in seconds when run
  alone. The failing file moves around, which is what makes it read as a real
  bug in whatever changed rather than as contention.

  Capped at two workers on CI, left uncapped locally. ⚠️ This is usually
  *faster*, not slower: four starved `initdb`s finish later than two that get
  real CPU. The full server suite ran 265s uncapped on CI and 103s capped
  locally.

## [3.91.1] - 2026-09-07

### Fixed

- **Userscript `@version` bumped to 1.49.0 so #617's rewrite actually reaches
  installed copies (hotfix).** #617 rewrote the war-room userscript but left
  `@version` at 1.48.0, and Tampermonkey updates only when that number changes —
  so every member kept running the old script against the new server. The
  deploy said so (`userscript changed but @version is still 1.48.0`) and the
  warning was not acted on.

  ⚠️ That pairing is broken rather than merely stale, which is why this goes
  straight to `main`:

  - **Hold-to-take-back fails outright.** The old script posts
    `{target_id}` with no `kind`; since #617 the server requires it and
    answers 400.
  - **Every assist badge renders wrong.** The old script reads `row.kind` and
    `row.wanted` off a row shape that no longer carries them, so any assisted
    target shows a generic life-buoy at "×1" whatever is actually wanted — and
    the old `assistCount` floors unusable values to 1, so it cannot even show
    the true count.

  The dashboard UI was unaffected: it ships in the image and updated with the
  deploy. This is specifically the Torn attack-page overlay — which is where
  these buttons are actually pressed.

## [3.91.0] - 2026-09-07

### Added

- **Payouts for six more OC scenarios (#606).** Leave No Trace, Sneaky Git Grab,
  Plucking the Lotus Petal, Mob Mentality, Thou Shalt Not Steal and Stage
  Fright — 30 endings that previously priced as unknown. The model now carries
  rewards for all 26 scenarios Crimes Hub has pages for.
- **`server/src/oc/crimeshub-facts.json` is now committed**, as the build's
  reviewable input. ⚠️ It was not before, and that was a latent trap: the
  original capture existed only as a transient file, so the committed model
  could not be rebuilt without re-scraping all 26 pages — and a rebuild
  attempted without it would have destroyed the data it could not recover. The
  20 scenarios captured earlier were reconstructed out of the model files to
  close the gap.

### Fixed

- **Three wrong claims in the model refresh runbook (#606).**
  - The 20-requests-an-hour cap is **our fetch tooling's, not Crimes Hub's**.
    The origin served 200s to `curl` throughout a window in which every fetch
    was refused; the refusal was a pagefetch bug (a `rate_limited` verdict
    cached under the robots.txt TTL, turning one exhausted hour into a 24-hour
    lockout with the quota reading empty — pagefetch#21).
  - **Five** scenarios have no Crimes Hub page, not three: Hostile Takeover,
    First Aid and Abet, Lock Stock, Pet Project and Best Of The Lot. Two
    conflicting lists of three were in circulation and neither was right. All
    five are listed on the index but unlinked — registered, not yet mapped.
  - Crimes Hub's slug for Plucking the Lotus Petal is `lotuspetal`. A wrong
    slug returns 200 with a "NOT FOUND" body, so nothing throws and the
    scenario just arrives unpriced — indistinguishable from having no data.

## [3.90.0] - 2026-09-06

### Added

- **Admin credential rotation prints a scannable QR, and `--rotate` edits
  `deploy/.env` in place (#646).** Rotating meant copying four values by hand
  and typing a 32-character base32 secret into an authenticator — friction that
  makes rotation something to avoid, which is the opposite of what a rotation
  tool is for.

  - ⚠️ The QR is drawn **locally**, never through an image service. A
    `chart.googleapis.com`-style URL would send the TOTP secret — half the
    admin credential — to a third party in a query string, where it would sit
    in their request logs. A strange thing to do while rotating out of concern
    about exposure.
  - `--password-only` keeps the existing TOTP secret and is the common case: a
    leaked password and a lost phone are different incidents, and forcing both
    to rotate together means every password change costs re-enrolling the
    authenticator.
  - ⚠️ `ADMIN_SESSION_SECRET` is never rotated as a side effect — that
    invalidates every live admin session, which is correct when intended and
    baffling when not. `--rotate-session` asks for it explicitly.
  - The in-place edit is its own tested module (`db/adminEnvFile.mjs`), because
    `deploy/.env` holds every faction's database password and is not in git. It
    replaces keys where they sit rather than appending (two copies would work by
    accident — dotenv and compose both take the last — while leaving the old
    credential visible with no way to tell which is live), preserves comments
    and ordering, guards the missing-trailing-newline trap, and writes via temp
    file + rename.

### Fixed

- A dead check in the admin credential generator (#646): the `$`-in-credentials
  guard looped over `{ hash, totpSecret: '', sessionSecret: '' }` with both
  secrets declared *after* the loop and passed as empty strings, so two of the
  three values it claimed to check were never examined. Base32 and hex cannot
  produce a `$`, so nothing slipped through — the check simply was not doing
  what it said.

## [3.89.0] - 2026-09-06

### Added
- **Fleet monitoring can finally see key-pool depth and failing scrapers
  (#632).** The two numbers that would have caught #645 on **day one** instead
  of day thirteen.

  ⚠️ **What the existing health checks do not report: whether anything
  SUCCEEDS.** `/api/health/ready` covers database connectivity and whether the
  scheduler is *armed*, so capacityx — which ran zero Torn-backed jobs for
  thirteen days — answered `ok` throughout, as did Docker's healthcheck and the
  #609 status page (`5/5 tenants up`). Meanwhile `members-sync` logged
  `no pooled key available` 312 times into a table nobody was reading.

  New authenticated `GET /api/internal/fleet-metrics` on each tenant, reporting
  claimable/enrolled/disabled keys and each enabled job's consecutive-failure
  streak, last success and last error.

  ⚠️ **`claimable` mirrors `keyPool.claim()`'s condition exactly**, not
  `disabled = false`. That difference is what capacityx turned on: it held one
  *enabled* key that `claim()` would never return, because the key had no
  faction access. A looser count would have reported the pool as fine.

  ⚠️ **Not one shared secret pasted into every tenant.** Each tenant holds only
  its own token, derived as `HMAC-SHA256(FLEET_METRICS_SECRET, slug)`; the admin
  container holds the secret and derives what it needs. A shared secret would
  mean a leak from **any** faction's environment reads **every** faction's
  metrics — one faction's compromise should be one faction. An intermediate
  version of this change passed the fleet secret to each tenant so it could
  derive its own token, which defeated the entire point; tenants now receive a
  literal `FLEET_METRICS_TOKEN` and never see the secret.

  ⚠️ **The endpoint is genuinely public and is authenticated accordingly.** The
  generated tenant vhost proxies `location /api/` wholesale, so living on the
  compose network protects nothing. Comparison is constant-time and
  length-checked first, because `timingSafeEqual` throws on a length mismatch —
  a short token would 500 rather than 401, which is itself an oracle.

  New alert rules: `keys-empty` (urgent — self-sustaining, since `members-sync`
  is the only job that can refill the pool and it needs a key from the pool it
  just emptied), `keys-low` at one key (how #123/#124 started), and
  `scraper-failing` per job after three consecutive failures.

  ⚠️ **Unmeasured is not "fine".** A tenant with no `metrics` — no secret
  configured, or too old to serve the endpoint — produces **no alerts at all**
  rather than alerts reading zero. Treating unmeasured as zero would have fired
  on every tenant the moment this shipped, for a fact nobody had established.
  Same rule as the null item-sync timestamp in v3.77.0.

  ⚠️ Alerts name the failing **job**, not a count. "3 jobs failing" is not
  actionable at 3am; "members-sync has failed 12 times and never succeeded" is.
  Job names are identical on every tenant and reveal nothing about a faction —
  the reconnaissance concern #609 raised is member ids and key material, and the
  payload carries neither.

  `db/fleet-metrics-token.mjs` prints the token for an existing faction;
  `db/new-faction.mjs` writes it for new ones. Unset `FLEET_METRICS_SECRET`
  leaves the endpoint unregistered everywhere.

---

## [3.88.0] - 2026-09-06

### Changed

- **Assist requests now accumulate on the TARGET, not on whoever typed them (#617).**
  A target can need a smoke AND a tear AND a body at once, and several people
  asking for the same thing add up instead of overwriting each other.

  #523 built assists around one live request per requester, enforced by a
  partial unique index. Two rules followed from that and both were wrong: a
  second person raising a hand on a target REPLACED the first request, and a
  different kind from the same person replaced their previous one. The
  reinforcement case makes it plainest — whoever joined a fight is now in it
  and is best placed to say more help is needed, and under the old rule their
  request cancelled the one that brought them.

  - New `war_room_assist_counts_v2`: one row per target, a count and a
    `raised_at` per kind (migration `0059`). The old table is kept and simply
    stops being read — a live war may be in flight at deploy, and those rows
    are the only record of what people asked for. Dropping it is a later
    migration, the same discipline #606 used for the mirror tables.
  - Expiry is per kind: a smoke asked for four minutes ago and a tear asked
    for just now no longer age out together. An expiring kind clears outright
    rather than decaying a unit at a time on a clock matching neither raise.
  - Taking one back (the overlay's long press) is open to anyone and now
    requires the kind. There is no owner to check any more, and a dib can
    expire while a long fight runs on — whoever is actually in it is best
    placed to say "we're fine now".
  - Clearing a target outright is leads-only (was: the requester, or an admin).
    A stray clear drops every outstanding call on that target, and nobody
    watching a badge can tell it was cleared rather than answered.
  - The badge names nobody. A count is the sum of everyone who asked, so there
    is no one person to name and picking one would print an arbitrary choice as
    fact. It shows the most urgent live kind — help, then smoke, then tear —
    and spells the rest out in the title.
  - The attack-page overlay lights up what the TARGET still needs rather than
    only what you personally asked for, which is the thing you want to know
    before pressing.

### Fixed

- Clearing a target's assists was gated on the `admin` role, putting a war-room
  action out of reach of the war leads who run it (#617).

## [3.85.0] - 2026-09-06

### Fixed
- **⚠️ `members-sync` could adopt another faction's roster and permanently lock
  a tenant out of its own key pool (#645).** This ran on `capacityx` for
  **thirteen days** and needed manual SQL to recover.

  A Torn key answers for its owner's **current** faction. When a member leaves,
  their key stays in the pool until something notices — and the round-robin
  eventually claims it. On 2026-08-24 that happened:
  `/v2/faction/members` returned *their new faction's* roster and this job wrote
  it as ours. 95 real members marked departed, 31 strangers inserted, and every
  real key disabled as "not in faction". The run recorded **`rows=32,
  status=success`**.

  It then deadlocked: with no usable key, the only job that could re-enable
  those keys was this one, which needs a key from the pool it had just emptied.
  Every Torn-backed scraper failed hourly while `/api/health/ready`, the Docker
  healthcheck and the #609 fleet status page all reported the tenant healthy.

  Three guards, deliberately independent so no single failure removes them all:

  - **The claimed key must still answer for our faction.** `/v2/faction/basic`
    is compared against `faction_config.torn_faction_id`; on a mismatch **that
    one key** is disabled and the run stops without touching the roster —
    dropping the key was always the right response, not retiring ninety-five
    members. One extra call per hourly run.
  - **No run may retire more than half the roster** (above a 20-member floor, so
    a small faction losing two of three is unaffected). Needs no API call, and
    catches a truncated or otherwise wrong response from a *valid* key.
  - **No reconcile may leave the pool with nothing claimable.** This is the one
    that turns a bad hour into a bad hour rather than thirteen days: the bad
    roster was recoverable, the deadlock was not.

  ⚠️ **The obvious cheaper check does not work, and a test says so.** "The key
  owner must appear in the roster it returned" needs no extra call and looks
  sufficient — I nearly shipped it. It fails on the actual incident: the
  departed member *is* in the roster their key returns, because it is their new
  faction's. Only the faction id separates the two.

- **⚠️ Two more ways the key pool could empty itself (#645 follow-up).** Raised
  by MonChoon: some Torn errors mean *wait*, not *act*, and acting on a
  transient one costs a donor's key.

  **Code 13 is no longer treated as fatal.** Torn's own wording is *"The key is
  temporarily disabled due to owner inactivity"* — it returns by itself when the
  owner logs in. Treating it as fatal disabled the key, the roster reconcile
  re-enabled it on the same run because the member is still in the faction, and
  re-verification disabled it again an hour later: a flap that made the pool
  look smaller than it was and wrote a misleading `last_error` on a good donor's
  key. ⚠️ It had a sharper edge too — a faction quiet over a holiday can have
  most of its keys answer 13 at once, which empties the pool and reaches the
  #645 deadlock by a completely different route.

  **Re-verification will no longer disable the last claimable key.** ⚠️ That
  pass runs *after* the roster reconcile commits, so the pool-exhaustion guard
  above does not cover it — it could empty the pool on its own. A key that
  errors is not necessarily dead, and even when it is, leaving it enabled makes
  each job fail loudly rather than every job failing with the indistinguishable
  `no pooled key available` that hid the original incident for thirteen days.
  The error is still recorded and the next run re-checks it.

  ⚠️ The identity check **fails open on a transient error and closed on a
  definite mismatch.** Refusing to sync whenever `/v2/faction/basic` is
  unavailable would let a Torn hiccup stop member syncing fleet-wide — trading a
  rare guarded failure for a frequent unguarded one. The other two guards need
  no API call and still stand.

---

## [3.84.0] - 2026-09-06

### Changed
- **The OC Simulator reads the built-in model (#606).** All four call sites in
  `oc.ts` — the scenario listing, the roster lookup, the ranking and the
  parameter-count guard — now assemble from the dataset committed in the image
  instead of the three per-tenant mirror tables.

  ⚠️ **This is the change that fixes the live symptom.** Measured on the fleet
  on 2026-09-06, `tnl` and `forge` held 31 scenarios and **mayhem, ascension and
  capacityx held zero**, because `oc-scenarios-mirror` only populated where
  somebody had enabled the job — and an empty table looks exactly like a crime
  with no data. A test now runs the whole simulator surface against a database
  with `oc_scenarios` emptied and asserts every scenario, role and ending still
  comes back.

  ⚠️ **The model is the floor; our observations are an overlay.** Node stats are
  queried independently rather than joined through `oc_scenarios` — joining
  would have reproduced the very bug being fixed, since a tenant with no mirror
  rows would get no observations either, though its own crime history is intact.
  An ending with no observations keeps its row with `money_avg: null`, which
  `expectedValue()` already reports as unpriced and therefore a lower bound.

  ⚠️ `observed_paths` and the ending-map quality columns are **still read from
  `oc_scenarios`**: those are ours, derived from our own runs, and are rehomed
  by a later migration. Keeping this change to the read path alone means the
  mirror tables and the job are removed only once the switch has run in
  production — never delete the old source before the new one has been proven.

  ⚠️ The model is **injectable** (`ServerOptions.ocModel`) and the suite drives
  a fixture. Asserting against the committed dataset would couple every OC test
  to its exact contents, so a routine refresh — Torn adds crimes — would break
  tests unrelated to the change.

  Endings now also carry `reward`, the model's published payout, kept distinct
  from `money_avg`, which is what this faction has observed. Two different
  claims about the same ending, and the client must be able to tell them apart.

---

## [3.83.0] - 2026-09-06

### Added
- **The built-in OC scenario model (#606, first slice).** The 31 scenarios —
  graph, roles with weights, endings, and per-ending rewards where known — are
  now committed under `server/src/oc/model/`, with a loader and a maintainer
  build script. Nothing reads it yet; the read path moves in the next slice.

  ⚠️ **The live symptom this exists to fix**: measured on the fleet on
  2026-09-06, `tnl` and `forge` held 31 scenarios and **mayhem, ascension and
  capacityx held zero**. The per-tenant mirror only populates where somebody
  enabled the `oc-scenarios-mirror` job, so the Simulator was silently empty for
  three of five factions — and an empty table looks exactly like a crime with no
  data. A file shipped in the image cannot be present on some tenants and absent
  on others.

  ⚠️ **The dataset may be incomplete; it may never be wrong.** Crimes Hub's
  reward display has at least six shapes — cash, item counts, "one from each
  pool", ranges (`x14-15`), probabilistic drops (`x4 (43%)`), and bad endings —
  and each was discovered by a scenario breaking the parser written for the
  previous ones. The first parser was positional and recorded Crane Reaction's
  good endings as `money: 0`, which asserts *"this ending pays nothing"* when
  the truth is *"it pays in items we have not priced here"*. A fabricated figure
  in a committed file is strictly worse than an absent one, so the extractor now
  refuses any shape it does not recognise and the build publishes `null` — the
  same rule as `item_value_unmatched` (#441), unpriced endings (#473) and
  null-not-zero (#351). Four of Gaslight the Way's good endings are unpublished
  on exactly these grounds, and a test asserts no good ending is ever recorded
  as paying nothing.

  ⚠️ **Two sources, deliberately not interchangeable.** tornprobability supplies
  the graph, ending probabilities and `successChance`; Crimes Hub supplies
  per-ending money, respect and item counts. Crimes Hub carries no success
  probabilities at all — the percentages it does show are *item-drop* odds — so
  it cannot replace the first, and tornprobability carries no payouts, so it
  cannot replace the second. Every file records which source gave what.

  ⚠️ **23 Crimes Hub endings are dropped, and the build says so.** Our upstream
  reports only good endings for some crimes while Crimes Hub draws the bad ones:
  Ace in the Hole loses 11, Counter Offer 6, Dish It Out 6 — from the 11
  scenarios captured so far. Placing them needs the graph structure, so it is
  the next slice; reporting the count keeps the gap from looking like it does
  not exist.

  Diagrams live in sibling `.mmd` files (1.1 MB, against 404 KB for everything
  else) so a refresh produces a reviewable diff rather than a one-line JSON blob
  — which is most of the reason for committing this rather than scheduling it.

  ⚠️ Permission to use the Crimes Hub data was obtained from its author and is
  recorded on #606.

  ⚠️ **A seventh reward shape: the payout IS the next crime.** Stacking the
  Deck's good endings render as `Good End #4 / Ace in the Hole`. Without
  handling it the crime name was swallowed as a role label and four good
  endings read as unparseable — and the ending must carry `money: null`, never
  0, because valuing it needs the chain maths in `ocChains.js` (#585) rather
  than a figure here.

  ⚠️ **That yielded independent corroboration of #585's chain table.**
  `KNOWN_CHAINS` was derived entirely from our own observed `previous_crime_id`
  edges; Crimes Hub is a wholly separate source, and **every edge it reports
  agrees**: No Reserve → Bidding War, Stacking the Deck → Ace in the Hole,
  Manifest Cruelty → Gone Fission, Gone Fission → Crane Reaction. The fifth
  edge, Lock Stock → Hostile Takeover, is uncorroborated for a consistent
  reason: both of those scenarios are absent from Crimes Hub.

  ⚠️ **Three scenarios are not on Crimes Hub at all**: First Aid and Abet
  (predicted by the issue), plus **Hostile Takeover and Lock Stock**, which were
  not. That matters beyond coverage — Hostile Takeover has 7 of 14 endings
  unresolved and First Aid and Abet 7 of 13, the two worst in the fleet, so the
  role labels that would resolve them are not available from this source.

  20 of 31 scenarios currently carry rewards (183 endings); the source
  rate-limits at 20 requests an hour, so the remaining 8 follow.

---

## [3.82.1] - 2026-09-06

### Fixed
- **Reconciled the two independent fixes to `update.sh`'s self-modification.**
  `dev` carried the brace group alone (v3.82.0); `main` carried the hotfix
  (v3.79.1), which has the brace group **and** the hand-over that re-execs the
  newly-pulled script. Merging the branches conflicted on the same region of the
  same file.

  ⚠️ Resolved onto **`main`'s** version rather than dev's, because the two are
  not equivalent: the brace group only makes the *parse* safe, while the
  hand-over is what makes a change to `update.sh` take effect on the deploy that
  ships it rather than one deploy later. Keeping dev's copy would have silently
  dropped the more important half. The admin-container rebuild and the argument
  parsing from v3.80.0 were re-applied on top.

---

## [3.82.0] - 2026-09-06

### Fixed
- **⚠️ `update.sh` could corrupt its own execution when a deploy changed it.**
  Found while reviewing whether v3.80.0 was safe to promote — it is exactly the
  shape that triggers this.

  Bash does not read a script into memory up front. It reads a chunk (8KB),
  executes what it has, then reads the next chunk **from a saved byte offset**.
  `update.sh` overwrites itself partway through, at its `git merge`, and the
  script is ~20KB with that merge at byte ~7000 — so bash is still reading from
  disk when the file is replaced. Any change adding lines *above* the merge
  shifts every later offset, and bash resumes mid-statement or re-runs commands
  it already ran.

  Reproduced with a 15KB stand-in that inserted 1.5KB above its own rewrite
  point: it printed `PHASE 1`, then died with `line 100: adding: command not
  found`, and never ran the rest. In `update.sh` that region holds the
  migrations, the rebuild, readiness and the marker — so the realistic outcomes
  are a hard failure with an error naming nothing real, or, if the offset lands
  on text that happens to parse, running only *part* of a deploy. Restarting
  containers while skipping migrations is inside that envelope.

  The fix is two lines: the body is wrapped in a `{ … }` group, because bash
  parses a compound command **completely** before executing any of it, so the
  whole script is in memory before the merge can touch the file.

  ⚠️ The closing brace must be preceded by an `exit`, or bash still reads past
  the group for more input and hits the same stale offset — that variant ran
  every phase correctly and *then* emitted a spurious `command not found`.
  `exit "$fail"` already sat at the bottom and is what seals it.

  ⚠️ An earlier attempt — hash the file, `exec` the new version if it changed —
  was written, tested, and **discarded because it does not work**: the guard has
  to be read before the file changes, and the guard is precisely what straddles
  the boundary. It failed the same reproduction.

  The body is deliberately not re-indented, so this stays a two-line change that
  never obscures a real edit in `git blame`.

---

## [3.81.0] - 2026-09-06

### Added
- **Tests pinning what happens on a week the faction sits out matchmaking.**
  MonChoon asked whether the war-lifecycle automation copes when the check after
  matchmaking finds no war. It does — `upcoming = wars.filter(w => w.start > 0
  && !w.end)[0] ?? null` followed by `if (upcoming)` makes the whole auto-setup
  and auto-enable path a clean no-op — but nothing asserted it, and that is one
  refactor away from no longer being true on a job that runs every three
  minutes.

  Five cases now cover it: no wars at all, only wars that have already ended
  (the realistic shape of a week off), a matched war whose opponent cannot be
  identified, and a response with no `rankedwars` key at all.

  ⚠️ The assertion that matters is not "it did not throw" but that the war
  room's configuration comes back **byte-for-byte unchanged** — including
  `faction_id`, the opponent the room points at. A quiet week must not arm the
  room, and must not disarm one a leader armed by hand: the absence of a ranked
  war says nothing about whether a human wanted the room on, and one of the five
  cases exists solely to hold that line.

---

## [3.80.0] - 2026-09-06

### Changed
- **`update.sh` now rebuilds the admin control plane on every deploy.** ⚠️ This
  reverses the #609 slice 2 decision to keep it a deliberate, separate act
  (*"a bad push here is fleet-wide"*), at MonChoon's request — the cost of
  remembering had bitten twice, most visibly as a stale admin UI mistaken for a
  missing feature.

  Most of the original safety survives the reversal, by construction rather than
  by care:

  - ⚠️ It runs **after tenant readiness**, so tenants are already deployed and
    verified. A broken admin build cannot delay, block or roll back a tenant
    deploy — which was the actual content of "fleet-wide", and it still holds.
  - ⚠️ It is **non-fatal** and never touches the deploy's exit code. Failing the
    deploy would leave the `--if-changed` marker stale, and cron would then
    rebuild the whole fleet every five minutes over an optional container. Now
    that #609 slice 4 alerting exists, an admin container that is down is
    exactly what should page — that is the right channel, not a deploy's exit
    status.
  - ⚠️ It is **skipped entirely** when `ADMIN_PASSWORD_HASH` is unset, because
    the container refuses to start unconfigured by design; building it on a host
    that never ran the setup would manufacture a permanent, meaningless warning.

  `./deploy/update.sh --no-admin` (or `NO_ADMIN=1`) opts out for one run.
  Argument parsing now accepts flags in any order and rejects unknown ones
  rather than silently ignoring them.

---

## [3.79.1] - 2026-09-06

### Fixed
- **⚠️ HOTFIX: `update.sh` mis-executed itself whenever a deploy changed it, and
  changes to it took effect one deploy late.** Branched from `main` and merged
  straight back, because every future deploy-script change depends on this one
  being in place first.

  **The corruption.** Bash does not read a script into memory up front. It reads
  a chunk (8KB), executes what it has, then reads the next chunk **from a saved
  byte offset**. This script overwrites itself at its `git merge`, and it is
  ~20KB with that merge at byte ~7000 — so bash is still reading from disk when
  the file is replaced. Any change adding lines *above* the merge shifts every
  later offset, and bash resumes mid-statement. Reproduced with a 15KB stand-in
  inserting 1.5KB above its own rewrite point: it printed `PHASE 1`, died with
  `line 100: adding: command not found`, and never ran the rest. Here that
  region holds the migrations, the rebuild and the readiness check, so the
  outcomes are a hard failure naming nothing real — or, if the offset lands on
  text that happens to parse, running only *part* of a deploy.

  **The staleness.** Even parsed safely, the deploy that ships a change to
  `update.sh` would still run the OLD script end to end, so new deploy behaviour
  only took effect on the *next* deploy — including a fix to this very problem.

  Two changes, and they only work together:

  - The body is wrapped in a `{ … }` group. Bash parses a compound command
    **completely** before executing any of it, so the whole script — including
    the hand-over below — is in memory before the merge can touch the file.
    ⚠️ The closing brace must be preceded by an `exit`, or bash reads past the
    group and hits the same stale offset; that variant ran every phase correctly
    and *then* emitted a spurious `command not found`.
  - After the merge, if `git hash-object` shows this file changed, the script
    **execs the new copy**. The flock on fd 9 is inherited, so the lock holds;
    it runs before the backup and every mutating step, so nothing happens twice;
    and the marker is only written on a clean finish, so the second pass still
    sees the deploy as outstanding and runs it in full. `TNL_UPDATE_REEXEC`
    bounds it to one hand-over.

  ⚠️ The hand-over alone is **not** sufficient, and was tried first: without the
  brace group the guard itself straddles the read boundary, so it is corrupted
  before it can fire. It failed the reproduction identically. The wrap is what
  makes the hand-over trustworthy.

  Verified end to end: the old script starts, detects the change, hands over,
  and the new script runs to completion with a clean exit and empty stderr.

---

## [3.79.0] - 2026-09-06

### Changed
- **CI: a PR's wall clock was three-quarters queueing, not testing.** Measured
  on this repo's own runs — Node Tests execute in ~3 min, the compose check in
  ~4 min, the changelog gate in 4 seconds, so ~7 minutes of work took **12–14
  minutes**. The two jobs were already declared parallel (no `needs:` between
  them); there is one self-hosted runner, so everything serialised, including
  across PRs. One run showed the compose check starting five minutes after the
  node tests finished, purely waiting for a slot.

  Two changes, both prerequisites for adding a second runner rather than
  speed-ups on their own:

  - **`concurrency` with `cancel-in-progress` on both workflows.** A superseded
    run is worse than wasted on a single runner: it queues *ahead* of the run
    you care about. A force-push during review kept the previous run burning a
    slot for its full ~7 minutes. `github.ref` is `refs/pull/<n>/merge`, so each
    PR gets its own group and concurrent PRs never cancel one another.
  - **⚠️ The compose check is now safe to run concurrently.**
    `COMPOSE_PROJECT_NAME` was the fixed string `tnl-dashboard-ci` and the ports
    were hardcoded 55432/18088 — safe only while exactly one such job can ever
    exist. Two concurrent runs would share the project, fight over the same
    containers and ports, and each finish with `down -v`, tearing down the
    other's stack **on the box that also runs production**. The project name now
    carries `github.run_id`, and both ports are allocated at run time from a
    wide range and checked against what is actually listening — so a run cannot
    collide with another run, with staging, or with production.

### Added
- **`deploy/docker-prune.sh`** and a runbook section for it. This box runs
  production, staging and the CI runner on one Docker daemon, so every PR leaves
  build layers behind: 4.0 GB of build cache and 4.7 GB of unreferenced images
  against 22 GB free, whose first symptom would be a deploy failing to build.

  ⚠️ **A per-run project name would have leaked images**, so the compose check
  now tears down with `down -v --rmi local`. A constant name meant each run
  overwrote the previous run's images; a per-run name means every run leaves its
  own `tnl-dashboard-ci-<id>-api-forge` behind forever — and those are TAGGED,
  so a dangling-image prune never touches them. The isolation fix would quietly
  have become a disk leak of several GB a day. `local` removes only images
  compose built itself, never a pulled one like `postgres:17-alpine`, and the
  build cache survives so the next run rebuilds just as fast.

  The prune script also sweeps abandoned `tnl-dashboard-ci-*` projects, because
  that teardown does not always get to run: `cancel-in-progress` kills
  superseded runs mid-job and a cancelled job's cleanup has only a grace period.
  ⚠️ The pattern is anchored to `tnl-dashboard-ci-` deliberately — production is
  `tnl-dashboard` and staging is `tnl-dashboard-dev`, and that sweep is the one
  place in the script that deletes volumes.

  ⚠️ The script's value is as much in what it refuses to do. It never passes
  `--volumes` — every faction's database and the backup archive are named
  volumes, and Docker calls a volume "unused" whenever no container is attached,
  which is true of any stack that is stopped, mid-deploy or mid-restore. And it
  never passes `-a` to the image prune, which would drop base images and turn
  the four-minute compose check into a fifteen-minute one on every PR until the
  cache warmed again — a permanent runner's whole value being that cache.

---

## [3.78.0] - 2026-09-06

### Fixed
- **⚠️ Provisioning would have failed at its last step, every time (#609 slice
  6 follow-up).** The host agent ran
  `docker compose -f deploy/docker-compose.yml up -d --build api-<slug> nginx`,
  but every `api-<slug>` service lives in `docker-compose.override.yml` — which
  `db/new-faction.mjs` writes moments earlier in the same function — and compose
  auto-loads an override **only when no `-f` is passed at all**. So the command
  dies with `no such service: api-<slug>` *after* the database, the role, the
  scoped credential and the deploy artifacts have all been created correctly.
  The agent now builds its invocation exactly as `deploy/update.sh` does, and a
  test asserts the shape.

  ⚠️ The same omission is dangerous in a second way, now documented in the
  runbook: with only the base file, compose reports all five running tenant
  containers as **orphans** — so `--remove-orphans` on that invocation would
  **delete every tenant API container on the box**. Nothing passes that flag,
  and a test asserts that too. `docs/runbooks/admin-control-plane.md` now
  exports `COMPOSE_FILES` up front and uses it throughout, because the wrong
  invocation is the natural thing to type.

### Changed
- **`member-stats` now defaults to once a day, not every 4 hours.** The job
  spends **one Torn call per member per run**, so a ~90-member faction costs
  ~90 calls a run — 540/day at four-hourly against 90/day here, and roughly
  2,700 against 450 across five tenants, all on the same pooled keys every other
  job shares.

  ⚠️ The intraday cadence was never what made competition results correct, which
  is why it looked load-bearing. #230 added `captureBoundarySamples`: a one-off
  timer fires at a competition's exact start and end and stamps a sample at that
  instant (re-armed after a restart by `rearmAll`), and that is what resolution
  reads. A coarser cadence costs mid-competition standings refreshing daily
  rather than six times a day, and a wider fallback if a boundary capture ever
  misses — which the resolver already flags as `partial`.

  ⚠️ No tenant changes cadence unexpectedly. Four of the five factions were
  already running daily; their stored value now equals the code default, so the
  #609 slice-5 adoption clears it and they follow the default from here. The
  fifth (forge) had already adopted the 4-hourly default and now follows the new
  one. All five converge without a manual step.

---

## [3.77.0] - 2026-09-06

### Added
- **The item catalogue moves to the control plane (#609 slice 7/7).**
  `/v2/torn/items` is public, so the admin container's single key serves every
  faction — one of exactly two of twenty scraper jobs the #608 audit found
  movable, and a straight rate-limit win of four API calls a cycle. New
  `ADMIN_TORN_API_KEY`; new `items` table in `global` (migration `0005`, schema
  version 5). ⚠️ Unlike the alerting and provisioning tables, tenants **keep**
  SELECT here — reading it is the entire point.

  ⚠️ **Centralising trades five-fold redundancy for one key, and the failure is
  silent.** Today each tenant fetches from its own hourly re-verified pool
  (#309) and survives any single key dying; fed by one key, prices quietly stop
  updating and every faction keeps valuing payouts off a stale table — the decay
  that ran unnoticed for months in July (#123/#124). #609 requires **both**
  mitigations, not either/or, and both are here:

  - **Tenants fall back to their own pools.** A tenant adopts the fleet copy
    only while `items_synced_at` is under 6 hours old; past that it claims a
    pooled key and syncs itself exactly as before. Every failure path — control
    plane unreachable, prices stale, the copy readable but the query failing
    partway — falls through to the pool rather than up to the run logger.
  - **Stale prices are refused with a reason, never silently used.** Once *both*
    sources have failed for a week the OC Simulator withholds item values and
    says why, rather than valuing rewards at a week-old price. The same house
    rule as `item_value_unmatched` (#441), unpriced endings (#473) and
    null-not-zero (#351): absent beats confidently wrong.

  ⚠️ **The tenant's own `items` table stays the read path.** Nothing queries
  `global.items` at request time, deliberately — that would put the control
  plane in every tenant's read path and break the one guarantee the whole
  architecture rests on: kill the admin container and every tenant keeps working
  on its last-consumed data.

  ⚠️ **The refresh cadence (2h) must stay comfortably inside the freshness
  window (6h), and the first draft had them equal.** With both at six hours the
  fleet copy would reach the staleness boundary at the exact moment the next
  refresh was due, so every tenant would spend the tail of each cycle falling
  back to its own pool — the feature would cost one Torn call per faction and
  save nothing, while appearing to work. A test now asserts the relationship
  rather than trusting two constants to stay in step.

  ⚠️ **A response below 100 items is refused.** A handful is not a small
  catalogue — it is a partial read, a changed shape, or an error body that
  happened to parse. Publishing those rows and stamping `items_synced_at` would
  tell every tenant the prices are current while the table held almost nothing,
  which is worse than the outage it came from. The timestamp is also the last
  write inside the same transaction as the rows, so a crash halfway leaves the
  previous timestamp standing rather than a fresh stamp over a half-written
  table. And a Torn error **body** returned with HTTP 200 is treated as a
  failure, not as an empty catalogue.

  Withholding is expressed as an *empty* catalogue, so it travels the path #441
  already built — every drop comes back in `item_value_unmatched` — rather than
  through a second, parallel notion of "unpriced" the client would have to
  learn. The OC Simulator gains a banner explaining the refusal, since without
  it a page full of "unpriced" looks like a data problem rather than a
  deliberate, fixable refusal.

### Fixed
- **⚠️ `readFleetMeta` would have reported the control plane as permanently
  unavailable to every tenant, from the moment `items_synced_at` became
  non-null.** `server/src/db.ts` installs a *process-wide* `setTypeParser` for
  `timestamptz` so the tenant API can serve PostgREST-shaped strings, so that
  column arrived as `2026-09-06T07:00:00-05` — not ISO-8601 (`-05`, no minutes)
  and rejected by `new Date()`. Calling `.toISOString()` on the resulting
  Invalid Date **throws**, and the throw landed in `readFleetMeta`'s own
  `catch { return null }`, which means "control plane unavailable". Nothing
  would have looked broken; the fleet fast path would simply never have engaged.

  It had not bitten yet only because slice 7 is the first thing that ever writes
  that column. It was invisible to the slice-1 tests because they fake the pool
  with `Date` objects, which node-pg does not produce in this process — so the
  fix comes with an end-to-end test against a real connection, and the fake has
  been corrected to return what the query actually returns. `readFleetMeta` and
  `itemsSyncIsDue` now format these columns as UTC ISO text in SQL, independent
  of any installed parser. Same defect and same fix as the incident store in
  v3.74.0.

---

## [3.76.0] - 2026-09-05

### Added
- **Provision a faction from the admin console (#609 slice 6/7).**
  `admin.monchoon.me` now takes a slug, display name, Torn faction id and
  optional leader/operator ids, and brings the faction up — database, schema,
  seed, `faction_config`, first role grants, scoped `app_<slug>` credential,
  compose override, nginx vhost and container. No SSH.

  ⚠️ **The admin container does not provision anything, and that is the whole
  design.** Doing so needs Postgres superuser, write access to the deploy
  directory and Docker — on the one container that accepts logins from the
  internet. So it validates the form and writes a row to `provision_requests`;
  a new host-side agent (`deploy/host-agent.mjs`, systemd unit included) runs
  outside every container, claims the row, and executes **one known command
  with schema-validated arguments**. A fully compromised admin container can ask
  for a faction to be created and nothing else. **No container mounts the Docker
  socket**, and mounting it would collapse exactly this bound.

  ⚠️ Every subprocess is spawned with an **argv array and no shell**, so a slug
  containing shell metacharacters is an argument rather than a command — an
  independent defence from the validation, on purpose.

  ⚠️ **These are the only writes on the internet-facing surface.** The #608
  audit recommended keeping provisioning a CLI; MonChoon reversed that
  deliberately, and it holds because provisioning is *additive and recoverable*
  — a wrongly-created faction can be decommissioned, while a wrongly-dropped one
  cannot be un-dropped. Decommissioning stays off the web permanently.

  ⚠️ **The slug is re-validated at the API boundary and again in the agent.**
  `db/new-faction.mjs` interpolates it into `CREATE DATABASE faction_${slug}`
  and `CREATE ROLE app_${slug}`; that guard used to protect a human at a CLI and
  now protects a web form. The rules are duplicated on purpose — "the API
  validated it" stops being true the day anything else writes to that table, and
  the agent is the process holding superuser and Docker. A test compares the two
  implementations against each other rather than assuming they agree.

  ⚠️ **A length cap of 21, because Postgres truncates identifiers at 63 bytes
  SILENTLY** — two different `faction_<62 chars>` names land on the same
  database with no error, discovered much later.

  ⚠️ **Slugs ending in `_dev` are refused.** The staging stack's databases are
  `faction_<slug>_dev` and the fleet monitor deliberately excludes them, so a
  real faction slugged that way would be a tenant the monitor never reports on.

  ⚠️ **Failure is visible, re-runnable, and not rolled back.** The page shows
  which step failed and the captured log, and offers Retry. If `new-faction.mjs`
  succeeded and only the container failed to come up, the database, role and
  deploy artifacts are correct — undoing them would throw away the expensive,
  correct work and leave the retry nothing to adopt. `new-faction.mjs` is
  idempotent, so a retry walks the same path. Only a **failed** request may be
  retried: re-queueing a running one would hand the same slug to a second agent
  run mid-flight, which a partial unique index also blocks at the database.

  ⚠️ **The captured log is redacted on the way in.** `new-faction.mjs` states
  that the generated credential is never printed, and it is not — but this log
  is served over the admin API, so `KEY=`/`SECRET=`/`PASSWORD=` lines and
  connection-string passwords are masked here rather than relying on a promise
  made in another file.

  ⚠️ A hung `docker build` is killed after 15 minutes and the request marked
  failed. Left running it would hold the row forever, and the partial unique
  index would then block every retry for that slug.

  New in `global`: `provision_requests` (migration `0004`, schema version 4),
  revoked from `app_global_ro` — it names factions that do not exist yet and
  carries operator identity.

### Changed
- The status page's "no fleet data" assertion now matches a real database name
  (`faction_tnl`) rather than the bare substring, which the provisioning card's
  `torn_faction_id` column label would otherwise have tripped permanently. A
  field label is not data; loosening the check to keep a bare substring test
  passing would have meant quietly deleting the assertion instead.

---

## [3.75.0] - 2026-09-05

### Added
- **Feature flags: fleet default, tenant override (#609 slice 5/7).** The
  control plane can now set a baseline that every faction follows, and any
  faction can override it for itself. Fleet defaults live in `fleet_flags` in
  the shared `global` database; per-faction overrides live in a new
  `feature_flags` table in each tenant.

  ⚠️ **"Unset" is a distinct state from "set to a falsy value", and the whole
  design turns on it.** The obvious `local || global` is wrong the moment a
  tenant sets a cadence to `0` or a flag to `false` — and in this codebase that
  is not hypothetical: `member_stats_poll_interval_sec = 0` already means "off"
  (`warLifecycle.ts`) and `chain_poll_interval_*_sec = 0` means "never poll". A
  faction that had deliberately switched something off would silently inherit
  the fleet's "on". So the signal is the **row's existence**, never its value;
  both tables carry `CHECK (jsonb_typeof(value) <> 'null')` so a JSON null
  cannot be written as a pretend-unset; and clearing a flag is a `DELETE`. Same
  bug class as `Number(null) === 0`, which bit `chainedValue` in #585.

  ⚠️ **An unreachable control plane serves the last known fleet defaults, not
  an empty set.** An empty set is not neutral — it silently reverts every
  fleet-set value to the code default, so a blip in the admin container would
  change how a tenant behaves. Keeping the previous snapshot means an
  unreachable control plane changes nothing at all, which is what the #608
  "tenants read `global` directly" architecture promises.

  ⚠️ **Writing a fleet flag is a tunnel-only operation** (`PUT`/`DELETE
  /api/admin/local/flags/:key`), while reading is on the public surface.
  Provisioning was allowed onto the public surface because it is additive and
  recoverable; a fleet flag is neither. It takes effect on every tenant within a
  minute, and the dangerous value is not a malformed one — those are rejected —
  but a perfectly **valid** one: `* * * * * *` on a scraper cadence would have
  five factions calling Torn every second on their own pooled keys, a
  fleet-wide rate-limit ban from one typo with no undo that gives the keys back.

### Changed
- **Scraper cadence is the first consumer.** A job's schedule now resolves
  through three layers: this faction's `scraper_jobs.cron_schedule`, then
  `fleet_flags['scraper.schedule.<job>']`, then the code default in
  `JOB_TABLE`. Global Admin shows the effective cadence **and which layer
  supplied it** — without that, a fleet-wide change looks like a local one
  nobody remembers making, and the first instinct on seeing an unfamiliar
  cadence is to type over it, silently converting a managed default into a
  permanent per-faction override. Clearing the field and saving sends an
  explicit `null`, which is "follow the default" — a real instruction, distinct
  from omitting the field, and previously there was no way back from an override
  short of a database edit.

  ⚠️ `scraper_jobs.cron_schedule` is now **nullable**, and NULL means "follow
  the fleet default" — a real setting that `NOT NULL` made unsayable. New rows
  are created NULL rather than seeded with the code default, which used to make
  every job look permanently customised.

  ⚠️ **One-time adoption of previously-seeded rows**, performed in the
  application rather than in migration 0058: a row whose schedule exactly equals
  the code default was written by the old seeding and never touched, so it is
  cleared to NULL and follows the fleet from now on; a row that differs was
  edited by an operator and is left alone. That inference — "equal to the
  default means nobody chose it" — is the kind this project usually refuses, and
  it is sound in this one case because the only two ways the column could hold
  exactly the default string are the old seed and an operator deliberately
  typing the default, and for the second the behaviour is identical either way.
  SQL could not do it: it has no idea what the code default is.

  ⚠️ **A malformed cron expression falls back instead of throwing.**
  `cron.schedule()` throws on a bad expression and the scheduler registers jobs
  in a loop, so one typo would abort the loop and leave every job after it
  unscheduled. Through a **fleet** flag that is worse again: one bad character
  typed once would stop scraping for every faction at once, with the only
  symptom being that data quietly stopped arriving. The invalid value is
  reported on the Global Admin page and in the logs instead.

  `GET /api/admin/scraper/jobs` now returns `cron_schedule` as the faction's
  override (may be `null`), plus `effective_schedule`, `schedule_source`,
  `default_schedule`, `fleet_schedule` and `rejected_schedule`.

---

## [3.74.0] - 2026-09-05

### Added
- **Fleet alerting (#609 slice 4/7).** The control plane now polls itself on a
  timer, turns the status report into incidents, and tells someone. Three
  channels, split by how fast a human has to act: a **Discord webhook** for
  urgent (tenant down or degraded, no recent backup, disk critical, item prices
  stale), a **daily email digest** for everything else, and the status page —
  which now leads with an open-incidents card and a last-24-hours log — for the
  full picture, always.

  ⚠️ **Most of the work here is about NOT sending.** #598 is the standing
  lesson in this repo: surge alerting had to be turned off by default because a
  termed war pushed on every hospital churn, so *"the room cries wolf all week
  and people mute it, which then costs them the alert in the war where it
  mattered"*. A fleet monitor with three channels has three times that
  opportunity, so four separate mechanisms stand between an observation and a
  message:

  - **Confirm before announcing.** An alert must be seen twice before anything
    is sent. A container restarting during `update.sh` is unreachable for a few
    seconds; announcing on the first miss would page on every routine deploy.
  - **Sticky clear.** An incident is not resolved until it has been absent
    twice. A container in a restart loop answers every other poll, and resolving
    on the first success gives an up/down/up/down stream — the loudest possible
    way to report one ongoing incident.
  - **No re-announcement.** An incident produces exactly one message when it
    opens and one when it clears. A week-long outage is still one Discord
    message; the daily digest carries what is *still* open.
  - **Storm rollup.** The cycle that opens twelve incidents at once is Postgres
    dying and taking every tenant with it, so a batch larger than ten becomes a
    single summary — and every cycle is one HTTP request regardless, rather than
    one per incident into Discord's rate limit.

  ⚠️ **Incident state is persisted in `global`, not held in memory.** An
  in-memory map is empty after every restart, so a redeploy would re-announce
  every open incident — turning "one incident, one message" into "one message
  per deploy", triggered by the exact operation an operator performs while
  fixing the thing that alerted.

  ⚠️ **A `NULL` item-sync timestamp means "not in service", never "infinitely
  stale".** `items-sync` does not move to the control plane until slice 7, so
  that column is null on every fleet running this code; reading null as stale
  would fire on every cycle from the moment this shipped, for a feature that
  does not exist. Same bug class as `Number(null) === 0`, which bit
  `chainedValue` in #585.

  ⚠️ **A faction with no backup at all is a notice, not a page.** Provisioning
  creates a database immediately and its first dump only at the next nightly
  run, so the urgent version would page someone minutes after every new faction
  was created. The danger it guards against takes weeks to matter.

  ⚠️ **The digest is sent every day, including the quiet ones.** Mailing only
  when something is wrong makes silence ambiguous: an empty inbox means either
  "the fleet is healthy" or "the monitor died three weeks ago". The key pool
  decayed to a single key in July (#123/#124) precisely because nothing was
  supposed to announce anything. A daily digest is its own heartbeat.

  New: `alert_incidents`, `alert_events` and `control_state` in the `global`
  database (migration `0002-alerting.sql`, schema version 2). ⚠️ All three are
  **revoked from `app_global_ro`** — `ALTER DEFAULT PRIVILEGES` would otherwise
  hand every tenant SELECT on the fleet's outage history, and a compromised
  tenant container has no business holding a fleet-wide situation report.

  New routes: `GET /api/admin/alerts` and `GET /api/admin/digest` (a preview,
  no mail sent) on the public surface; `POST /api/admin/local/digest/send` on
  the **tunnel-only** surface — sending mail on demand is the one route that
  makes this container reach outward, which is an amplifier in anyone else's
  hands, and it is how an operator proves SMTP works without waiting for 08:00.

  Configuration is entirely optional and unset degrades rather than fails:
  `ADMIN_DISCORD_WEBHOOK_URL`, `ADMIN_SMTP_URL`, `ADMIN_DIGEST_TO`,
  `ADMIN_DIGEST_FROM`, `ADMIN_DIGEST_HOUR_UTC`, `ADMIN_ALERT_INTERVAL_MS`,
  `ADMIN_PUBLIC_URL`, `ADMIN_HOST_LABEL`. Unlike the credentials, a missing
  value here means the status page is the only place alerts appear — visible
  and safe — so it must not take the control plane down.

- **`docs/runbooks/admin-control-plane.md`** — the operator runbook for this
  container: generating credentials, deploying, and a **shell-safe** login
  sequence. ⚠️ The login commands build their JSON body with `node` and read
  the password with `read -rsp` rather than interpolating it into a
  double-quoted string. Interactive bash performs history expansion on `!`
  *inside* double quotes, which aborted the command before `curl` ever ran and
  produced a bare `LOGIN FAILED` on the live box with nothing wrong with the
  application. Any password containing `!`, `$`, `"` or a backtick hits this.

### Fixed
- **⚠️ Control-plane timestamps could come back in a format `Date.parse`
  rejects.** `server/src/db.ts` installs a *process-wide* `setTypeParser` for
  `timestamptz` so the tenant API can serve PostgREST-shaped strings — so a
  column read anywhere in this process comes back as a `Date` or as
  `2026-09-05T07:01:00-05` depending on nothing more principled than whether
  something in the import graph pulled that module in. The second shape is not
  ISO-8601 (`-05`, no minutes) and `Date.parse` returns `NaN` for it, so a
  plain `String(value)` would have leaked an unparseable local-offset string
  into the digest and the status page. The incident store now formats these
  columns as UTC ISO text in SQL, which is independent of any installed parser.
  Caught by the store's round-trip test against real Postgres.

---

## [3.73.0] - 2026-09-05

### Fixed
- **⚠️ The local admin surface was unreachable through its published port.** It
  bound to the container's own `127.0.0.1`, on the reasoning that loopback is
  tighter — but Docker forwards a published port to the container's **network
  interface**, never to its loopback, so `127.0.0.1:8091:8091` reached a port
  nothing was listening on. Every request died with a connection error rather
  than an HTTP status (`curl` returned `000`). Found on the live box.

  The listener now binds `0.0.0.0` inside the container, and **the host-side
  publication is the boundary**: the port exists only on the host's loopback,
  unroutable from the internet, reachable over an SSH tunnel.

  ⚠️ The honest cost: the local surface is now reachable by anything else on
  the compose network, so a compromised tenant container could send requests to
  it. It is not defenceless — the same password + TOTP gate applies, and a
  local-surface token is rejected on the public surface and vice versa — but it
  is a real difference from *"only reachable via SSH"*. What the split still
  buys is that destructive routes are not registered on the internet-facing
  listener at all.

- **⚠️ The admin password hash was silently truncated by Docker Compose.** The
  conventional scrypt format (`scrypt$N$r$p$salt$hash`) is delivered through
  `deploy/.env`, and Compose performs variable interpolation on those values —
  so `$FJjI...` and `$xe8` were substituted as undefined variables and the
  container received a **truncated** hash. Every login would have failed.
  Found by a crash-loop on the live box, and only *noticeable* because the
  fail-closed boot check refused to start rather than serving with a broken
  credential.

  The format is now dot-separated: `.` is outside the base64 alphabet, so it
  stays unambiguous, and Compose passes it through untouched. `$$` escaping
  also works but is a footgun no operator should have to remember on the one
  credential that fronts every tenant. **Legacy `$`-separated hashes still
  verify**, so nobody is locked out by the upgrade, and the generator now
  refuses outright if a value it produced ever contains `$` again.

### Added
- **The fleet status page (#609, slice 3 of 7)** — `admin.monchoon.me` now shows
  every tenant, Postgres, backup freshness and disk headroom, refreshing every
  30 seconds behind the slice-2 login.

- **⚠️ Tenant discovery costs nothing and breaks no isolation.** The writer role
  can read `pg_database` — a shared catalog — so the tenant list comes from the
  cluster itself rather than a config file that would drift the moment a faction
  was added. Verified on the live cluster that the same role **cannot CONNECT**
  to any `faction_*` database: it learns the names and nothing else. No Docker
  socket, no per-tenant credential, no cross-tenant database access, exactly as
  the #608 audit required.

- **Monitors chosen for what actually goes wrong, not what is easy to check:**
  - **Backup freshness**, and a named list of factions with **no dump at all**.
    ⚠️ Computed against the known tenant list, not against the files present — a
    check that only looked at existing files reports a never-backed-up faction
    as perfectly healthy, because its absence is invisible. A job failing for
    three weeks is worse than no backup, because you believe you have one.
  - **Disk headroom**, free from the same read-only `/backups` mount.
  - Per-tenant DB, scheduler and ticker state, plus which global schema and OC
    model version each tenant is reading.

- **Everything degrades rather than throwing.** Postgres down still produces a
  report — *"the control plane's own database is down"* is the headline finding,
  not a reason to return a blank page during the incident. One dead tenant does
  not hide the healthy ones, and a wedged tenant is timed out at 3s rather than
  stalling the page.

  ⚠️ A tenant reporting `global: "unavailable"` is **not** counted as degraded.
  Tenants are designed to work with the control plane down, and marking it a
  fault would make this page report the fleet as unhealthy whenever the box
  rendering the page is the thing that is broken.

- The page is one self-contained HTML string — no build step, no framework, no
  frontend workspace in the image. A status page is a table and a login form,
  and the simplest thing that can work is the most likely to be working when it
  is needed. Served unauthenticated because it contains **no data**: it is a
  login form plus the script that calls the authenticated status endpoint.

---

## [3.72.0] - 2026-09-05

### Added
- **The admin control plane's security boundary (#609, slice 2 of 7).** The
  container, its authentication, and the two-listener split. Nothing here does
  anything yet beyond authenticating — health checks are slice 3, provisioning
  slice 6 — deliberately, so the security surface gets reviewed on its own
  rather than buried in a feature PR.

- **Two listeners, split structurally rather than conditionally.** The public
  surface (`admin.monchoon.me`, behind nginx) registers read routes; the local
  surface (`127.0.0.1:8091`, reached over an SSH tunnel) registers those plus
  the destructive ones. ⚠️ A destructive route is unreachable from the internet
  because it **was never registered there** — it returns 404, not 403. A
  misconfigured `preHandler` is a plausible mistake that reviews miss; a route
  absent from the router cannot be called by any request, header or bug.

- **Username + password + TOTP, nothing Torn-related.** A Torn key is pasted
  into userscripts, rotated and occasionally leaked, so tying fleet-wide access
  to its lifecycle would make every rotation an access incident.
  - `scrypt` from `node:crypto` (N=2¹⁷, ~128 MiB/hash), **not** the `sha256hex`
    helper in `auth.ts` — that one fingerprints API keys, where a fast hash is
    right, and reusing it for a password is the classic mistake.
  - ⚠️ **TOTP is required**, which is more than was asked for: this is a public
    login page in front of the one box that can create factions and rewrite what
    every tenant reads. Verified against the RFC 6238 test vectors so real
    authenticator apps agree.
  - Rate limiting on its own bucket, plus lockout keyed by **username, not IP**
    — behind nginx every request shares one proxy address, so locking on that
    would let an attacker lock out the real operator.
  - ⚠️ **A session secret separate from the tenant `JWT_SECRET`**, cross-checked
    at boot. Sharing it would make any tenant admin's token — or any single
    compromised tenant container — a valid fleet credential. The audience claim
    is a second, independent guard.

- **Refuses to start unconfigured.** No default credentials, and a plaintext
  value in `ADMIN_PASSWORD_HASH` is rejected with an explanation rather than
  silently failing every login. An admin surface that comes up with no gate is
  worse than one that does not come up.

- `npx tsx db/admin-password.mts` generates the credentials and the `otpauth://`
  URI. Written as `.mts` so it imports the **real** hashing code rather than a
  second copy — two implementations of a password hash is how you get
  credentials that verify in one place and not the other.

### Fixed
- ⚠️ **A compose trap that would have broken every deploy.** Docker Compose
  interpolates **every** service when it parses the file, *including services
  behind a profile* — so a single `${ADMIN_SESSION_SECRET:?...}` on the profiled
  admin service made every `docker compose` command fail for an operator who had
  not configured the control plane. That is `update.sh`, and one optional
  container would have taken the whole fleet's deploy with it. Every admin
  variable now defaults to empty in compose, and fail-closed lives in the
  application, where it is loud, immediate and contained to one service.

---

## [3.71.0] - 2026-09-05

### Added
- **The shared `global` database — foundation of the admin control plane
  (#609, slice 1 of 7).** Torn-wide facts that are identical for every faction
  get one home instead of N copies that can disagree.

  ⚠️ **The organizing principle came out of the #608 audit and is not what the
  issue originally assumed.** The question is not *"is this data Torn-global"*
  but ***can one API key fetch it*** — every faction-scoped endpoint needs that
  faction's own pooled keys, so members, crimes, wars, attacks and revives can
  never move here however much duplication they cause. Checked against all 20
  scraper jobs' real endpoints, **exactly two qualify**: the OC scenario model
  (needs no Torn key) and the item catalogue (public `/v2/torn/items`).

- **Two Postgres roles, and the split is load-bearing.** `app_global_ro` for
  every tenant (SELECT only) and `app_global_rw` for the admin container. The
  audit chose *tenants read `global` directly* over push or pull because it
  keeps the control plane out of every tenant's read path — which makes
  "killing the admin container leaves every tenant fully functional" true by
  construction. That only holds if a tenant **physically cannot write**: a
  shared table corrupted by one faction is read by all of them. Proved against
  real Postgres, including that a tenant can read a table added by a *later*
  migration but still cannot write to it.

- **A separate migration lane** (`db/migrations-global/`, `node db/migrate.mjs
  --global`) and `db/new-global.mjs` to provision the database and both roles.
  `update.sh` runs the lane, and **skips it when the database does not exist**
  — the control plane is opt-in, and a deploy on a host that has never
  provisioned it must succeed exactly as before.

- **Tenants report what they are reading** on `/api/health/ready`: global schema
  version, OC model version, and item-price freshness. This is what a fleet
  status page will poll, and satisfies #609's "a tenant reports which version it
  is running" ahead of the page existing.

  ⚠️ **An unreachable control plane reports `global: "unavailable"` and stays
  HTTP 200.** Failing readiness would turn the one degradation this architecture
  guarantees is survivable into a paged outage — and an operator would learn to
  ignore the alert.

- **A staleness rule for shared item prices, ahead of the data moving.**
  Centralising `items-sync` will trade five-fold key-pool redundancy for a
  single key, and that failure is silent: prices stop moving and every faction
  keeps valuing payouts off them. `itemsAreFresh` treats **"never synced" as
  stale rather than fresh** — NULL and "synced long ago" are the same answer to
  *may I price a payout with this?*, and defaulting the unknown case to yes is
  exactly how a silent mis-valuation happens (the #351 rule, and the shape of
  the key-pool decay that ran unnoticed for months in #123/#124).

---

## [3.70.0] - 2026-09-05

### Fixed
- **⚠️ Roles named only in the possessive are no longer treated as taking part
  in a checkpoint (#473).** Manifest Cruelty's *"Reviver curses Interrogator's
  overexuberance and tries to revive the manager"* is Reviver's checkpoint;
  Interrogator is why the manager needs reviving. Averaging the two together
  made a fatal Reviver failure look survivable — at Reviver CPR 1 the simulator
  predicted a 0.4888 chance of the good ending against the service's 0.0193.
  Measured across all 31 scenarios: **8 improved, 0 worsened**, with Manifest
  Cruelty falling 0.113 → 0.041 (out of the loose-fit group entirely) and
  Plucking the Lotus Petal 0.061 → 0.005.
- **Two collective references now resolve to the roles they name.** Lock Stock's
  *"The bruisers feign defeat"* means Muscle #1 and Muscle #2; Bidding War's
  *"The Humvee crashes into the wall"* means the Driver. Bidding War's residual
  fell 0.076 → 0.001.

### Added
- **A mass-weighted ending-map residual, which is what the per-ending money can
  actually be trusted on.** The existing residual is scale-free by design —
  right for choosing an assignment, misleading for judging E(x), because an
  ending at 1e-4 simulated at 3e-4 moves it as much as the dominant ending being
  wrong by half. The two disagree in **both** directions: Mob Mentality reads
  0.145 plain (flagged a loose fit) and 0.003 weighted, while before this
  change Plucking the Lotus Petal read 0.061 plain (comfortably "confident")
  and 0.108 weighted, with the error in the ending carrying 98% of the mass.
  Stored as `ending_map_money_residual` / `ending_map_money_confident` and
  reported separately by the mirror job.
- **A measurement harness** (`npm run oc:measure`) that caches the whole probe
  sweep once and re-measures all 31 scenarios locally, so testing a hypothesis
  costs no calls to tornprobability. Reports movement **per scenario**, never
  only the mean, so a change that fixes eight crimes and breaks two is visible
  as exactly that.
- **⚠️ A role-level fidelity check — the oracle we had been asking at only one
  point (#473).** `successChance` at all-high is exact for **all 31** scenarios,
  which is why this went unnoticed for so long. Asked at a *dropped* CPR,
  **twelve of the thirty-one** disagree with their own flowchart, several
  badly: Window of Opportunity's Looter 1 at CPR 1 reads **0.9804** from the
  service and **0.3897** from the diagram. Stored per scenario as
  `role_fidelity_error` / `role_fidelity_roles` and reported by name, because
  "this crime is wrong" is unactionable and "Looter 1 and Looter 2 are wrong"
  tells you which sliders to distrust.

  ⚠️ This is an **upstream disagreement between the two things we mirror, not a
  bug in this code**, and the ruled-out list is part of the finding: not role
  attribution (the checkpoints name the Looters explicitly), not parameter
  ordering (verified P1..P5 against `GetRoleNames`), not terminal
  classification (`_B5F_` really is a failure — confirmed against the diagram's
  own `fill:#C62828`), and not an incomplete diagram (768 observed paths and
  `is_complete`, the best-observed scenario in the set). Engineer and Muscle 2
  in that same crime match the service to **four decimals** across the whole
  curve, so the walk, the CPR/100 rule and the multi-role average are sound.

  It also catches what neither residual does: **Snow Blind** (fidelity 0.699)
  and **Ace in the Hole** (0.480) are both marked "confident" today.

### Changed
- The simulator's documented "nickname" hypothesis is retired as **falsified**.
  Eight of the ten loose fits contain no checkpoint that names no role, and four
  of the six that exist genuinely mean the whole crew. Both mis-attributed ones
  sat in scenarios that already fit tightly, so resolving them improved nothing
  that was loose. The fault in the loose group is the opposite one —
  over-attribution, not under-attribution.

---

## [3.69.0] - 2026-09-05

### Added
- **⚠️ Crime chains are priced as chains, so the crimes that pay $1–1.7B a run
  stop ranking as worthless (#585).** Torn's own API has carried
  `previous_crime_id` since the first scraper run and nothing downstream ever
  read it. Five edges now derive from our own spawn history — No Reserve →
  Bidding War, Lock Stock → Hostile Takeover, Stacking the Deck → Ace in the
  Hole, and the two-hop Manifest Cruelty → Gone Fission → Crane Reaction. A
  chain parent's value becomes the whole chain's expected value instead of the
  $0 it genuinely pays by itself.
- **A known-chains table as a floor under the observed data.** Chain history is
  per-tenant and no tenant sees all of it: at the time of writing ascension had
  observed no chains at all, Forge and Mayhem only No Reserve, and capacityx
  alone had all five edges. Without the fallback a faction prices Manifest
  Cruelty at $0 purely for never having run it. Observation still wins over the
  table, so our own data is what notices if Torn rewires a chain.
- **The chained scope economics, which are the real finding.** MonChoon
  confirmed the rule: scope is spent once at the root and repaid only at the
  final link, only if every link succeeded. The reward stays flat while the
  chance of collecting it compounds, so the break-even climbs from 83.3% for a
  standalone Elaborate to **91.3% per link over two links and 94.1% over
  three**. Measured against TNL's own rates every Elaborate chain is
  scope-negative — Manifest Cruelty → Gone Fission → Crane Reaction completes
  30.0% of the time and runs at −3.20 scope a spawn — while remaining excellent
  money. Value and scope point opposite ways for these crimes and the table now
  shows both rather than implying either is the answer.

### Changed
- **Chain children are dropped from the ranking.** Ace in the Hole has 0
  standalone runs against 124 spawned and Crane Reaction 0 against 7 — they
  cannot be spawned, so listing them offers a decision nobody can make and
  double-counts the pipeline beside their own parent. They keep their cards in
  the Simulator, where their crew and success chance are still real and still
  worth optimising separately from the parent's.
- The ranking compares a chain's **per-link geometric mean** against the
  per-link break-even. Comparing the end-to-end probability against a per-link
  bar is the natural mistake and makes every chain look far worse than it is.

### Fixed
- `chainedValue` distinguishes a crime that pays **nothing** from one we have
  not **priced**. `Number(null)` is `0` and `Number.isFinite(0)` is true, so the
  obvious coercion reports "no prices for this crime" as "this crime pays
  nothing" — the same trap `expectedValue()` guards against with `== null`. An
  unpriced link now makes the chain a lower bound and says so.

---

## [3.68.0] - 2026-09-05

### Fixed
- **⚠️ The userscript no longer destroys DOM nodes React owns, which is what
  was blanking Torn's faction page (#613).** Caught on a live page: a
  `removeChild` trace running straight through react-dom 19's own
  `commitDeletionEffects` recursion, with the script's own state log showing it
  stood down correctly a moment later. Torn's faction page is React; React
  keeps references to the nodes it created and calls `removeChild` on exactly
  those later. Destroy one in the meantime and that call throws inside React's
  commit phase, and React tears down the whole subtree.
- Four places did it, all through operations that look like edits and are not:
  `el.textContent = 'x'` **replaces** an element's child text node rather than
  editing it, `el.textContent = ''` removes every child, and `el.replaceWith()`
  removes the element itself. The status cell was the worst — that write ran
  every second across every row on the page. The sort headers, the Attack cell
  and the header relabelling did the same thing less often.
- Nothing of Torn's is touched now. Our own element is **appended alongside**
  and theirs is hidden with CSS — `font-size: 0`, because Torn keeps the status
  as a bare text node and there is no other way to hide one of those. React
  stays free to update or delete its own nodes whenever it likes.
- Torn's own text is read live rather than from a copy squirrelled away before
  we overwrote it. That copy went stale the moment Torn updated a cell we had
  taken, which is why `tornStatusKind` could disagree with what was on screen.
- The assist count is centred by **line-height** rather than by flex, on the
  dashboard's War Room badge as well as the userscript's roster badge — the
  same miss, twice, because both put small digits beside a slightly taller icon
  in a centred flex row.
  Boxing 9px text in a 14px flex item centres the line box, but a glyph does
  not sit centred within its own line box — the font's ascent and descent are
  asymmetric, so the digits still read high.

- **Observed assist actions are reported even when the page never names the
  defender (#618).** A live smoke sat uncounted for twenty seconds with every
  other part of the chain working. The reporter gated on
  `attackTargetName()`, which scrapes `a[href*="profiles.php?XID="]` — a link
  the attack page does not reliably render, and a guess flagged as unverified
  when it was written. When it came back null the function returned early and
  **not one event was ever sent**.
- The subject is now carried on each event and checked **server-side**, on ids
  against the roster — the same place and for the same reason the actor's
  faction already is. The attack page has no roster and its names are
  attacker-controlled text, so the client was never able to answer this
  honestly. A report with no subject is still accepted, so an older userscript
  in the wild is not switched off by an upgrade it did not take.
- Every bail-out in the reporter now logs why. That path is invisible from
  outside — a count that does not move looks identical whether the log went
  unread, the parse failed, or the server declined everything — and narrowing
  it down last time took a live war and a screenshot.

- **The userscript runs on OUR faction's war page only (#619).** `factions.php`
  serves every faction on Torn and the war route is not ours alone —
  `?step=profile&ID=9357#/war/rank` is somebody else's war, with the same hash
  and the same roster markup. Matching on the path alone lit the whole script
  up there, badging enemies of a war nobody in our faction is in. `step=your`
  is what separates the faction you belong to from one you are merely looking
  at. `type=N` is deliberately not used: it is a per-faction layout id that
  moves when a faction reorders its own tabs.

Userscript **v1.48.0**.

## [3.65.1] - 2026-09-05

### Fixed
- **⚠️ The userscript no longer blanks Torn's faction page (#610).** The
  stylesheet was armed off the URL alone, and the URL lies: Torn routes faction
  tabs client-side and can re-render the content area into another tab while
  `#/war/rank` is still in the address bar — firing neither `hashchange` nor
  `popstate`. `isWarRankPage()` then answered "yes" about a page showing
  Armory, so the sheet stayed live and its deliberately broad rules
  (`.white-grad`, `.table-header`, `ul.members-list`, `.table-body` — all Torn
  component classes reused across every tab) forced Torn's own furniture to
  `display:flex; width:100%` and collapsed the content region. Arming now also
  requires the roster to actually be **in the DOM**: if there is nothing to lay
  out, there is nothing our layout rules should be touching, whatever the URL
  claims.
- **The mystery "FACTION" bar was Torn's own section title.** `.white-grad` is
  on two completely different things — the war roster's column header, which
  the rule was written for, and the page's section title above the tab strip.
  Given `display:flex; width:100%` the title inflated into an empty full-width
  bar. It was never an element the script created; it is Torn's, restyled by a
  selector too broad to tell the two apart. Now excluded by name.
- **The assist count is visible on the roster and the board, not just the
  attack overlay.** Both surfaces rendered the icon *instead of* the label —
  and `label` is where "Smoke ×3" lived, so the number survived only in a
  tooltip, on exactly the two surfaces someone scans to see who still needs
  help. The icon says WHICH, the count says HOW MANY, and both now render.
  Still nothing at one, where "×1" is noise.

### Changed
- The War Room's **Flags** column uses `InfoTooltip` instead of a native
  `title`, which mobile browsers show on neither tap nor long press — a flag's
  meaning was unreachable on a phone, which is where the board is most often
  read mid-war.

- The roster badge's count is given the icon's own height and centred inside
  it, rather than left to flex alignment alone: a digit's visual centre sits
  above its box centre, so 9px text beside a 14px glyph reads as sitting low
  even when the two boxes are correctly aligned.

Userscript **v1.45.1**.

## [3.64.0] - 2026-09-05

### Fixed
- **The assist count updates live again instead of only on a page reload
  (#603).** The userscript's assist index is keyed by target and judged recency
  on `created_at` — which does not change when #591 raises the count with
  `SET wanted = wanted + 1`. The row came back down the delta carrying the new
  number, compared equal, and was discarded, so **every increment and every
  decrement was dropped by the very client that asked for it**. Rows now win
  the badge slot when they are an update to the request already on screen,
  matched on row id, with recency still deciding between different requesters.
- The optimistic entry made that permanent rather than transient: it stamped a
  client clock reading, strictly later than the server's `created_at`, so every
  later server row for our own request lost the comparison for the life of the
  page. That is why a refresh was the only thing that ever showed the truth.
- `requestAssist` and `decrementAssist` now paint the count the **server**
  returned rather than ignoring it, so the pip moves on the press instead of on
  the next poll. `POST /api/war-room/assist` returns `wanted` on both branches
  now, not just on the increment.

The dashboard was never affected — `useWarRoomSocket` merges by row id — so the
faction-page badge, the attack overlay and the board now agree by construction.

### Added
- **Right-click an assist button to take one off**, the desktop shortcut for
  the hold. ⚠️ A long press on a touchscreen also synthesises `contextmenu`, so
  both routes share one guard: two decrements for one press would be worse than
  none.
- **`InfoTooltip`** — a tooltip that works on a touchscreen (#604). Global
  Admin's scraper-job descriptions were behind a native `title`, which mobile
  browsers show on neither tap nor long press, so the text was unreachable on a
  phone while the dotted underline advertised that it was there. It matches the
  War Room's stat-breakdown panel, but opens on tap as well as hover and is
  positioned in fixed viewport coordinates — the jobs table lives inside an
  `overflow-x-auto` wrapper that clips an absolutely-positioned child.

Userscript **v1.44.0**.

## [3.63.0] - 2026-09-05

### Fixed
- **A second press on an assist button now raises the count instead of
  cancelling the request (#600).** The server has incremented on a repeat of
  the same target and kind since #591, but the overlay never reached it: a
  press on your own active kind routed to the #523 toggle-off, written before
  counting existed and never revisited when counting was added. So the one
  gesture that should raise the count was the one that destroyed the request,
  and the counter was unreachable from the surface built for it.

### Added
- **Hold an assist button to take one back.** Half a second, and the last one
  clears the request — "decrement to zero" and "cancel" are the same act, so
  there is no separate rule for cancelling. Holding a kind you have not
  requested does nothing. The hold fires while the button is still held rather
  than on release, because half a second with no sign of registering is exactly
  what you cannot afford to guess at mid-fight; the button shrinks under the
  finger to show it landed.
- **`POST /api/war-room/assist/decrement`.** A POST rather than a DELETE
  variant on purpose — Torn PDA's HTTP bridge exposes only `PDA_httpGet` and
  `PDA_httpPost`, so a DELETE cannot be issued from a phone at all, and this
  gesture's home is the attack page. Scoped to the caller's own request with no
  admin branch: a hold is fat-fingerable, and quietly shaving a count off
  someone else's request is a bad thing to be able to do by accident.

Userscript **v1.43.0**.

## [3.62.0] - 2026-09-05

### Changed
- **A new matchup resets push-surge alerting to off (#598).** `surge_alerts_enabled`
  (#208) and `surge_revive_alerts_enabled` (#359) were set once by a leader and
  carried forward across every subsequent war, indefinitely — the one part of
  the room that was not already a clean slate at auto-setup, where state and
  dibs are tombstoned, the chain is reset and notes are reseeded. Alerting tuned
  for one war is wrong for the next, and a termed war is the clear case: surge
  alerts push to **every** subscriber on hospital and revive churn that is
  entirely expected, so the room cries wolf all week and people mute it — which
  then costs them the alert in the war where it mattered. Off is the safe
  default because the failure is asymmetric.
- The thresholds, windows and cooldowns behind those switches are deliberately
  **not** reset. They are tuning a leader worked out for their own faction and
  stay true across matchups; wiping them would mean re-deriving the numbers
  every week just to turn alerting back on.

## [3.61.1] - 2026-09-05

### Fixed
- **The userscript's Settings panel now scrolls with the button that opened
  it (#590).** It was positioned `fixed` at the launcher's viewport
  coordinates, so it opened in the right place and then stayed welded to the
  screen as the page scrolled out from under it. On mobile, where that panel is
  most of the script's UI, it ended up hovering over the roster you were
  scrolling to read. It is now positioned in **page** coordinates, anchored to
  the launcher, and the same fix covers the chain popover.
- The panel copies its anchor's positioning rather than assuming: the fallback
  launcher strip we inject when Torn's own `#top-page-links-list` is missing
  *is* pinned to the viewport, and a popover that scrolled away from a button
  that does not move would be the same bug in reverse.
- Placement now measures where the box actually landed and corrects by the
  error. Absolute coordinates resolve against the nearest positioned ancestor,
  and Torn is free to make `<body>` positioned on any deploy — doing the
  arithmetic blind would silently offset the panel the day they do.
- **Warleads can see the pre-war stacks snapshot on RW History (#595).** The
  section was behind a leadership-only check in the war detail modal, while
  `GET /api/wars/:id/stacks-snapshot` had allowed warleads since #480 — so the
  people who run the roll call were the ones who could not read it back. The UI
  gate now mirrors the route. Visitors are still out; the route is read-only to
  them by way of `requireNotVisitor()`, and showing them the section would only
  buy them a 403.

Userscript **v1.42.1**.

## [3.61.0] - 2026-09-05

### Added
- **Assist requests carry a count, decremented by what actually happens in the
  fight (#591).** Pressing smoke / tear / help again on the same target raises
  it — "I need three smokes" is a real thing to say, and stacked grenades are a
  real use case. A different kind or a different target still replaces, since
  one person is in one fight asking for one thing.
- **`POST /api/war-room/assist/observed`**, which the userscript feeds from
  Torn's attack-page fight log. A button press means "I intend to", which is
  not the same as going — an observed action is the only signal that cannot
  lie. Three gates decide whether an event counts, and all three live on the
  server: the actor name must resolve to someone on the war roster; that member
  must be in **our** faction (anyone can join a Torn fight, and an enemy join
  carries the identical event class to a member helping); and the event must
  not already have been counted. A `join` answers a `help` request — the log
  and the request are naming the same thing twice.
- Deduplication is a ledger keyed on `(target_id, actor_id, kind,
  event_second)`. Every member with the userscript open sees the **same** log,
  so one join is reported once per observer; without this the counter would
  drain as fast as people were watching. Torn gives no stable fight id, so the
  key is the event itself, rounded to the second — two observers' clocks will
  not agree to the millisecond, and rounding is what makes their reports
  collide instead of both counting.
- **The count is visible where it is decided.** The war-roster badge reads
  `Smoke ×3`, and the attack-page overlay carries a pip on the button you press
  to raise it — that is the surface where you decide whether to ask for one
  more, so it has to say how many you have already asked for. A count of one
  shows nothing: `×1` is noise on the overwhelming majority of requests. An
  absent or unusable count floors at **one, never zero** — a row from before
  the column existed would otherwise render `×0`, which reads as "nobody is
  asking", the opposite of what a live row means.
- The userscript reports qualifying fight-log events every poll, with no local
  record of what it has already sent. The server's ledger is the only thing
  that can answer "has this been counted" correctly, because several members
  watch the same fight — re-sending is free, missing one is not.
- A requester cannot answer their own call for **help**: they are already in
  the fight, and their own join would cancel the request the moment they made
  it. Enforced server-side on member ids rather than in the script on scraped
  names. Grenades are deliberately not excluded this way — a smoke you throw
  yourself after asking for three is genuinely one of the three.

### Fixed
- **Assist requests no longer expire mid-fight (#591).** The window was a
  hardcoded 120 seconds, chosen on the reasoning recorded in
  `warRoomAssistsExpiry.ts` that "Torn fights are seconds, not minutes". A Torn
  fight runs to **five minutes** — and a fight log captured while investigating
  this shows a real one already 132 seconds old, twelve seconds past the point
  where the request had silently vanished. The hand went down while the fight
  was still going, which is the one moment it must not. The default is now
  300s.
- **A target who jails, travels or flies out ends the fight too.** Only
  `Hospital` counted as a fight ending, so an assist against a target who
  became unattackable any other way sat out the full window. The test is now
  "stopped being attackable", which covers `Jail`, `Traveling`, `Abroad` and
  anything else Torn adds. An unknown state is still treated as attackable on
  purpose: dropping live requests whenever the roster momentarily lacks a
  status would cost more than a stale marker does.

### Added
- **`assist_expiry_seconds`**, a per-faction setting alongside the dibs
  auto-drop window, editable in War Room settings and clamped to 0–600s (0
  disables auto-expiry). Deliberately a **separate** knob from
  `dibs_expiry_seconds`: that one measures how long a claim survives after a
  target surfaces, so pushing it to 300 to cover a fight would keep claims
  blocking other claimers for five minutes. The window is read inside the
  insert transaction, so a settings change mid-flight cannot arm a deadline
  from one value and sweep it against another.

## [3.60.0] - 2026-09-05

### Fixed
- **The War Room userscript no longer bleeds its roster styling onto every
  other faction tab (#523 follow-up).** Its page gate was
  `pathname === '/factions.php'`, which is every tab on a hash-routed SPA, so
  `injectStyles()`' overrides applied on Armory, Crimes and Upgrades too —
  where `.white-grad { display:flex; width:100% }` inflates Torn's own section
  header into an empty full-width bar carrying the tab name. The gate now
  reads the hash route (`#/war/rank`, sub-routes allowed) and never the
  `type=N` query, which is a per-faction layout id that would work for one
  faction and silently fail for the next. Two halves make it real: a teardown
  when the SPA routes away, and `scopeCss()` prefixing every rule with
  `html.tnl-war-active` — the prefix being the load-bearing part, since a
  `pushState` that changes no hash fires neither `hashchange` nor `popstate`
  and the teardown would simply never run. The launcher and its status light
  deliberately stay on every faction tab; only the roster work is gated.
- **The userscript works on Torn PDA.** The dashboard API is cross-origin from
  torn.com and serves no CORS headers, so a privileged transport is the only
  way the script can reach its own backend — and PDA ships
  `PDA_httpGet`/`PDA_httpPost`, not the GM API. `gmRequest()` now falls back to
  those. `GM_setValue` was also called unguarded in four places and threw
  `ReferenceError` there, so all storage goes through `gmGet`/`gmSet` with a
  `localStorage` fallback. The launcher gained a fallback anchor: it required
  `#top-page-links-list`, a desktop-layout element, and returned null without
  it — making "no anchor" indistinguishable from "the script never ran", on the
  platform hardest to debug.
- **Every glyph in the userscript survives a non-UTF-8 client.**
  `files.monchoon.me` sends a bare `Content-Type: application/javascript`, and
  PDA's webview decodes that as Latin-1 — U+283F arrived as `â ¿` and every
  other symbol was mangled with it. All non-ASCII inside string literals is now
  `\uXXXX` escapes, which decode identically under any charset. Comments keep
  their real characters; they never render.
- **The attack-page assist panel can be moved.** It was pinned top-right over
  Torn's own attack controls with no way to shift it. Now draggable by a
  handle (pointer events, so touch works), position remembered and clamped to
  the *visual* viewport — not `innerHeight`, which on mobile parks it behind
  the keyboard. Click the handle to collapse; coarse-pointer sizing gives
  thumb-sized targets.

### Changed
- **The loadout shield is graded by age rather than a stale/fresh flag.** One
  boolean made a 61-minute-old observation and a week-old one look identical,
  which is the wrong shape for gear: within a war, what someone wore two hours
  ago is almost certainly still true, while yesterday's is a hint. Three bands
  now — green under 2h, amber 2–24h, grey beyond — with `isLoadoutStale()` kept
  as the third band of `loadoutFreshness()` rather than a second threshold, so
  the two can never disagree. An observation with no readable timestamp reads
  stale, and the tooltip names the band so colour is never the only signal.

### Added
- A fight-log parser in the userscript, groundwork for the assist counters
  (#591). Torn's attack page log shows other players' actions, which is what
  makes an assist request verifiable by observation rather than by someone
  remembering to press "I'm coming". The `attacking-events-*` classes are the
  only stable hooks on those rows; everything around them is a CSS-module hash
  Torn rotates each deploy.

## [3.59.0] - 2026-09-03

### Fixed
- **An unconfigured faction is no longer silently paid flat-weighted, and a
  payout mode picked on the Payout Management page now holds (#587).**
  Reported by a Leadership/OC-Manager/Warlead member who saw **Flat Weighted**
  lit whatever the faction setting said. `GET /api/oc-config` returned
  `payout_mode: null` for a faction that had never saved one, and each reader
  invented its own meaning for `null`: Payout Management failed the
  `PAYOUT_MODES.includes(null)` test and fell through to its `flat-weighted`
  seed, while `FactionConfigContext` read the same `null` as optimistically
  tiered. A faction could therefore see the tier machinery on screen and be
  paid by ticket weighting it had never configured. The absent case is now
  resolved once, server-side, and the default is **equal** — the only mode
  that is correct with nothing configured, where tiered needs a tier table and
  flat-weighted needs a ticket policy. A stored value that is not one of the
  three modes falls back the same way instead of reaching the client as
  something every consumer rejects. Reading the setting was never role-gated
  (`requireAuth` only); that is now pinned by a test using a token with no
  role assignments at all, since the report was first read as an admin-only
  permissions problem.
- **Saved payout weeks record the mode that produced them (#587).**
  `savePayoutWeek()` rebuilds the week record field by field and had simply
  omitted `payout_mode`, so the column added in
  `db/migrations/0005-payout-mode.sql` was NULL in every tenant even though
  the caller passed a mode and the server accepted the column. Reopening a
  saved week then had nothing to restore and fell back to a hardcoded
  `'tiered'`, which silently retagged every equal and flat-weighted faction's
  history; it now falls back to the faction's actual setting.
- **The faction default no longer lands on top of a mode the user just picked
  (#587).** `/api/oc-config` resolves after first paint, and opening a
  historical week also writes the selector, so either could overwrite a
  deliberate choice. A hand-picked mode is now sticky for the rest of the
  session.

### Changed
- `PAYOUT_MODES` and the default now live in one module per side —
  `server/src/payoutModes.ts` and `frontend/src/utils/payoutCalculations.js` —
  rather than being duplicated between `admin.ts`'s write validation and each
  reader's fallback.

## [3.58.1] - 2026-08-28

### Fixed
- **Blast from the Past and Counter Offer's endings that have no diagram
  terminal are now confirmed and priced at $0, instead of permanently
  reading as an incomplete lower bound (#473).** Both crimes' probability
  engine reports more good endings than their diagrams draw terminals for
  (`goodEnding35/45/310/410` on Blast from the Past; `goodEnding5/6` plus a
  stray `unknown` field on Counter Offer) — confirmed live against
  tornprobability directly, and now raised with their maintainer. The
  mirror's reward tracking is keyed strictly by diagram node id, so no
  amount of better mapping will ever price these from that source. What
  the investigation also found: the crimes' 4 REAL diagram terminals were
  already mapped and priced correctly the whole time (`assignEndings`'s
  Hungarian assignment handles a ragged API-vs-diagram count fine on its
  own) — the "unpriced" experience was specifically these starved extras
  dragging `expectedValue()`'s completeness flag down. `oc_scenario_endings`
  gains a `starved` column (migration 0053) — distinct from `resolved`,
  which stays accurate ("no node was found") — set from
  `assignEndings`'s `unmatched.endings` (no more fragile regex-parsing of
  combined problem strings for the good-ending path). `endingValue()`
  (frontend) treats a starved ending as a confirmed $0 rather than missing;
  `pricingQuality()` stops counting it as "unmapped" (which would ask for a
  better probe that can never arrive); `payoutSpread()` excludes it
  (it's not a designed outcome a router role decides between). MonChoon:
  "let's softly mark those endings as 0s for the moment" — reversible the
  moment an upstream diagram fix gives either extra a real terminal.

## [3.58.0] - 2026-08-28

### Added
- **OC Simulator endings now price their observed item drops, not just
  money (#441 follow-up, part of #473).** tornprobability's mirror feed
  carries a per-node `items` array (name, occurrence rate, average
  quantity) that `probabilityClient.ts` was silently discarding — only
  `money`/`respect` were read. Crimes that pay in items instead of cash
  (Window of Opportunity's antiquities, and everything `paysInItems()`
  already flagged: Best of the Lot, Crane Reaction, Gaslight the Way,
  Stage Fright) showed as unpriced/"$0" despite the source data existing
  all along. Item drops are now captured (`oc_scenario_node_stats.items`,
  migration 0052) and priced at CURRENT market rates when the scenarios
  endpoint is read (`server/src/oc/itemPricing.ts`), using the same
  `GREATEST(market_price, sell_price)` convention #448 already established
  for the crime-level item average — an illiquid item's `market_price` is
  often 0 because it rarely trades, and pricing on market alone would value
  exactly the rare, expensive drops at nothing. An item observed dropping
  but absent from our catalogue is reported as unmatched and priced at 0
  rather than silently guessed. The frontend's `endingValue()` now sums
  money + item value per ending, so `payoutsFromEndings()`,
  `pricingQuality()`, `payoutSpread()` and `paysInItems()` all read the
  combined figure — an ending with real items and $0 cash is priced, not
  unpriced, and a crime whose items are now priced stops being flagged by
  `paysInItems()`.

## [3.57.0] - 2026-08-28

### Changed
- **OC payout tickets/money now come from the occupancy poller (#389) instead
  of the legacy crime_slots calculation, for any window it fully watched.**
  MonChoon, after the position_id fix above resolved the last two
  discrepancies found while manually verifying #389 against the whole
  roster: "I think it makes sense to just switch over completely." Reasoning:
  `crime_slots` and `crime_participation_v2` are both snapshot-keyed — a seat
  change or a leave-and-rejoin overwrites `joined_at` and the earlier time is
  gone, which is structural, not a bug to patch. The occupancy poller was
  purpose-built to survive exactly that. `calculatePayouts` now checks
  `occupancyCoverage.covered` (true only when there is no gap anywhere in the
  window, including at its edges) and, when true, sets `ticketTimeSpent` and
  the displayed `timeSpent` from `observedSeconds` rather than the
  completed/banked interval union; it also folds in any member the poller saw
  that the half-hourly `crimes-sync` snapshot missed entirely. Any coverage
  gap — including a faction whose scraper container wasn't running, per
  MonChoon's stated concern — falls all the way back to the legacy
  calculation, unchanged. The old figures stay available as `legacyTimeSpent`
  / `legacyTicketTimeSpent` for comparison, and the result carries a
  `timeSource: 'occupancy' | 'legacy'` flag; `OccupancyPanel` and the payout
  table (`PayoutManagement.jsx`) both now say which one drove a given
  payout instead of always reading as diagnostic-only. Five new
  `payoutCalculations.test.js` cases cover the coverage gate, the
  occupancy-only-member case, and the legacy fallback.

## [3.56.4] - 2026-08-28

### Fixed
- **Occupancy poller (#389) was reading the wrong field for a crime slot's
  seat id, silently defeating its own position-swap detection.** Chasing
  down two remaining "observed time exceeds counted time" outliers
  (Rokiyam, GoobersKitten) after the #389/3.56.3 fix landed traced back to
  `crimeOccupancy.ts`'s `observationsFrom` reading only the top-level
  `slot.position_id`, which Torn's v2 payload doesn't populate — the real
  seat id is nested at `slot.position_info.id` (`crimesSync.ts` has always
  read it correctly via `pi.id ?? slot.position_id`). With `position_id`
  coming back null on every poll, a member who changed seats mid-crime
  (without leaving) got merged into one continuous `crime_occupancy` stint
  instead of two, which is what made "observed" read as *more* accurate
  than "counted" for exactly the members who happened to swap seats.
  `crime_slots` and `crime_participation_v2` are both snapshot-keyed and
  structurally can't retain the earlier seat's time through a swap; the
  occupancy poller was already designed to survive that (it keys stints by
  `(crime_id, member_id, position_id)` specifically so a seat change opens
  a new stint) — it just wasn't seeing real seat ids to key on. Fixed the
  field read to match `crimesSync.ts`'s extraction; two new regression
  tests cover the real Torn payload shape and the resulting stint split.

## [3.56.3] - 2026-08-27

### Fixed
- **OC payout "counted" time spent was inflated for members who left a
  still-open crime — sometimes by days, found via the #389 investigation
  MonChoon requested.** Cross-referencing counted vs. observed time for the
  whole roster (not just a handful of flagged names) showed most members
  matching to the hour once compared correctly — but a small cluster shared
  suspiciously identical, large gaps. `crimeParticipation.ts` closed a
  departed member's segment using `crime.executed_at ?? crime.expired_at`
  unconditionally, even when the crime was still Recruiting/Planning.
  `expired_at` is every crime's *future* deadline, stamped from creation —
  not evidence anything had happened — so a member who left an unresolved
  crime got `left_at` set to a date that hadn't occurred yet. Payout math
  clips `[joined_at, left_at]` to the window, so this credited banked time
  running past the window's own end. Fixed: an unresolved crime now closes
  at "now" like the code's own comment always said it should. Backfilled
  143 already-corrupted rows across 4 of 5 tenants (`updated_at` already
  held the correct timestamp — only `left_at` had the wrong value).
  New regression test: the existing coverage never caught this because its
  fixture crime had no `expired_at` at all, unlike every real crime.

## [3.56.2] - 2026-08-27

### Fixed
- **OC Payout Management's occupancy panel showed "Not watched" for weeks the
  poller genuinely covered (#389) — in every path, not just one.**
  `OccupancyPanel` reads `crimesData.occupancy_polls`, and two independent
  bugs dropped it before it got there:
  - Reopening a **saved** week rebuilt `crimesData` from
    `/api/payouts/weeks/:id/crimes`, which returns `{ crimes, slots }` only,
    silently overwriting the occupancy data an earlier fetch in the same flow
    had already loaded. Fixed by carrying it through, now via a small pure
    `buildHistoricalWeekCrimesData` helper so the wiring is unit-tested
    instead of only checkable by hand.
  - **Calculating a fresh week** — the actual "Run Payout" flow — went
    through `loadCrimesForPayout`, which reshapes the server's response into
    its own return shape and never extracted `occupancy`/`occupancy_polls`
    at all, in either of its two return branches. This is the more
    fundamental of the two: it means the panel had never worked for a live
    calculation, only ever for a reopened week — and that path was *also*
    broken by the bug above. Fixed by carrying both fields through in both
    branches, covered by new unit tests.

## [3.56.1] - 2026-08-27

### Fixed
- **Migration 0047 crashed on every production deploy attempt, leaving the
  server stuck on 3.54.0 for a day.** `inventory_items_with_prices` (and the
  9 per-category views built on it) all `SELECT loaned_to`, so Postgres
  refused the type-change outright — "cannot alter type of a column used by
  a view or rule" — and `set -euo pipefail` correctly aborted the whole
  deploy script before it could write `deploy/.last-deployed`, so cron kept
  retrying every 5 minutes, each time re-running the pre-deploy backup step
  and dying before ever reaching the build-cache prune at the bottom of the
  script. Two knock-on costs from the same crash loop: the backups volume
  grew to 17.6GB (a fresh, never-pruned archive set per faction on every
  retry) and Docker's build cache grew to 13.67GB, un-reclaimed. Fixed by
  CASCADE-dropping the view chain around the `ALTER`, then recreating it
  verbatim from `db/template.sql`. Covered by a new regression test that
  reconstructs the pre-migration schema by hand and applies 0047 against it
  — `db/test/template.test.mjs` alone couldn't have caught this, since it
  applies the current template (already `jsonb`), never migrates an existing
  one.
- **`deploy/update.sh` now prunes Docker images/build cache on every exit,
  not just a clean run.** The prune used to be two plain steps near the
  bottom of the script, reached only on the happy path — which is exactly
  what let this same incident's crash loop run unpruned for a full day.
  Moved into a `cleanup()` function installed via `trap cleanup EXIT` right
  after the early `--if-changed` exit, so a crash anywhere later in the
  script — a failed migration, a failed build, a failed readiness check —
  still reclaims build cache on its way out.

## [3.56.0] - 2026-08-26

### Added
- **Pre-war stacks snapshot, cross-referenced against roll call (#480).** A
  new immutable `war_stacks_snapshot` row per member per war, captured
  automatically within the minute before war start (`war_room_member_stats_v2`
  is overwritten in place every sweep — this is the only place a member's
  energy right before the war survives past the next tick). Records energy,
  whether the member OD'd at any point since the war was matched, and no
  reading at all as an explicit "unknown" — never a silent zero. Shown in a
  collapsible section of the RW History war detail (energy, OD flag, and
  their roll-call response side by side), with a CSV export. Lead-only,
  matching the memberstats data it comes from.
- **War Room now auto-enables at matched+30min, not never (#480).** #345
  removed T-1h auto-enable because the OLD ticker had a second gate that made
  "enabled" lie about whether the board was actually polling — that problem
  no longer exists (`enabled` has been the sole gate since #345), so
  reintroducing auto-enable is on clean footing. The 30-minute buffer gives
  Torn's API room to settle on a fresh matchup before the room starts polling
  continuously; per-war, fires at most once, so a leader who manually stops
  the room afterward is never fought on a later tick. Running the room from
  matchup to war start is also what makes the OD flag above possible —
  `overdose_until` only accumulates while it's on. `member_stats_poll_interval_sec`
  (off, 0, by default) is filled in to 300s at the same moment if a leader
  hasn't already configured it, since auto-enabling the room alone doesn't
  capture anything without the sweep also running.

### Fixed
- **A silent, repo-wide landmine: `new Date()` on a timestamptz value read
  through the app's own DB pool returns `Invalid Date`/`NaN`, in every server
  timezone.** `server/src/db.ts` deliberately returns timestamptz as a raw
  string (`2026-08-26T20:26:47.768038-05`) rather than a parsed JS `Date`, to
  match legacy PostgREST payload shapes — and Postgres's default text offset
  has no colon (`-05`, `+00`), which fails strict ISO-8601 parsing outright.
  Building #480's auto-enable timer hit this directly: a JS-side "has 30
  minutes passed" comparison silently always evaluated false. Fixed by moving
  the comparison into the query itself rather than parsing the string in JS.
  Nothing else is audited yet — flagging the pattern for anyone doing
  timestamp arithmetic elsewhere in server/.

## [3.55.0] - 2026-08-26

### Added
- **Data Export: RW payouts, war contributions, ranked wars, crime
  participation, and member battle stats.** `war_payouts`,
  `war_payout_members`, `war_member_contributions`, `ranked_wars`, and
  `crime_participation_v2` join the leadership export list; `member_battle_stats`
  is admin-only, matching the sensitivity of the roster/CPR exports already
  there.
- **A saved RW payout now carries its members' final effort % as its own
  column** (`war_payout_members.effort_share`), computed server-side as
  `payout_amount / total_payout` — well-defined across every payout mode,
  unlike the participation/contribution shares that only exist for the
  formula modes. Backfilled for existing saved payouts. Shown in the RW
  Payouts history sheet and on a member's own Dashboard payout list.

### Fixed
- **Faction armory loaned-item tracking.** The #542 move to API v2 fixed the
  scraper's category pagination, but `inventory_items.loaned_to` was still
  stored as a comma-joined string of borrower names — which discarded each
  borrower's own loaned amount and couldn't be matched back against a member
  id. The Leadership "Loaned Items" popup showed "Unknown" for everyone with
  a 1-item count, and a member's own "items on loan" panel matched nobody at
  all. `loaned_to` is now structured JSON (`{member_id, member_name,
  amount}[]`) end to end.

### Removed
- **`member_cpr_data`**, the legacy pre-CPR-rewrite scrape table, superseded
  by `member_cpr_v2` for some time and unreferenced anywhere in the app.

## [3.54.1] - 2026-08-23

### Changed
- **Removed the War Room Flags column's 🎯 loadout flag.** The shield icon
  next to the member's name (added in 3.54.0) showed the same observation
  in the same place a lead is already looking — the two were redundant
  rather than complementary. The shield stays; `memberFlags()` no longer
  takes a `loadout` argument.

## [3.54.0] - 2026-08-23

### Added
- **A loadout shield icon next to each member's name in the War Room
  (#528 Part 2 follow-up).** Hovering shows the latest observed loadout —
  weapons and armour, who saw it, and its age — in the same CSS-only
  group-hover tooltip style `BattleStatsCell` already uses, so it reads as
  the same visual language as the Stats column rather than a new one.
  Placed before the notes pencil. Renders nothing for the (usual) case of a
  member nobody has fought yet; dims once the observation passes the
  existing 1h staleness threshold. The Flags column's own 🎯 loadout flag is
  unchanged — this is the same fact placed where a lead is already looking
  when reading names, not a replacement for the scan-the-flags view.

## [3.53.3] - 2026-08-23

### Fixed
- **Loadout capture (#528 Part 2) was reading the attacker's own gear, not
  the target's.** Torn ships the SAME ids — `#modelLayersContainer` and
  every `#weapon_*` — on both the attacker's and the defender's panel, and
  the attacker's panel is always first in document order, so an unscoped
  `document.querySelector('#modelLayersContainer')` silently grabbed the
  wrong side every time. Caught live in production: three real captures,
  every one MonChoon's own weapons and armour. Now anchors on
  `defender___<hash>`, the one class fragment Torn puts only on the
  opponent's weapon wrappers (confirmed present pre-fight and mid-fight),
  and scopes every subsequent DOM read inside that ancestor instead of the
  whole document.
- **The userscript now sends a loadout capture at most once per attack**,
  not once per content change. A loadout cannot change once a fight is under
  way, so re-sending as Torn progressively revealed more of the DOM was
  producing multiple near-duplicate rows for a single fight. A failed POST
  does not latch, so a transient error still retries on the next tick.

### Changed
- **Assist requests use real icons now, not emoji (#523).** Smoke, tear gas
  and help were 🚬/💨/🆘 — replaced with Lucide's `CloudFog`, `Droplet` and
  `LifeBuoy`, matching the icon set the rest of the dashboard already uses.
  `assistBadgeState()`/`badgeState()` now hand back a `label` (readable text)
  and an `icon` (a Lucide name), rather than an emoji doing double duty as
  both — the dashboard renders the real `lucide-react` component; the
  userscript, which has no build step and cannot import one, inlines the
  exact same Lucide paths as raw SVG instead. Same three surfaces as before:
  the attack-page overlay buttons and the Dibs-badge morph on both the
  faction page and the War Room.

## [3.53.1] - 2026-08-22

### Fixed
- **War Room: Farm mode no longer interleaves abroad targets into the
  timer-sorted list (#561).** A released hospital timer means "no longer
  hospitalized," not "attackable soon" — an abroad target still needs real
  travel time back to Torn, so a soon-to-release hospitalized-abroad member
  used to sort right next to a domestic target that really was about to be
  hittable. Farm mode now splits travelling/abroad/hospitalized-abroad
  targets (the same predicate already used for the Status filter chips and
  the ✈ row flag) into their own "Abroad" section below the main list, sorted
  by battle stats instead of timer. Desktop and mobile both share the new
  `splitFarmAbroad`/`isAbroadTarget` in `warRoomFarmSort.js`. Every other
  sort column is unchanged.

## [3.53.0] - 2026-08-22

### Added
- **Passive enemy loadout capture from the attack page (#528 Part 2).** Once
  Torn reveals a defender's gear (weapons/armor stay hidden until the fight
  actually starts — Torn does NOT expose them pre-fight), the userscript
  captures it by NAME (`aria-label`/`<area title>`, never image `src` — a
  gear-hiding third-party script can strip `<img src>` but has no reason to
  touch either of those) and posts it silently in the background, deduped by
  content signature per fight so it never re-sends on every poll tick. Adds
  no visible control to the attack page — read-only, nothing wrapped, moved,
  covered or intercepted.
  - New append-only table `war_room_loadout_observations_v2` — deliberately
    NOT `war_room_state_v2`, which is the live per-member delta overwritten
    every tick; a loadout observation is a provenanced, point-in-time fact
    about one player and every one of them is kept.
  - `POST /api/war-room/loadout` validates shape and bounds size (schema-
    checked slot names, ≤100-char item names, ≤4KB payload) and rate-limits
    30 captures/5min per member — a legitimate capture happens once per
    fight, so this only ever catches a modified client trying to fill the
    table.
  - The War Room's Flags column shows a 🎯 flag with the latest observation
    per target on hover (per-slot names, who saw it, and its age), dimmed
    once past 1h since a stale loadout shown confidently is worse than none.
  - Retention: a daily hard-prune deletes observations past 30 days,
    unconditional (not behind the scraper job table's admin opt-in) — this is
    intel about individual players gathered by us, not data Torn hands out,
    so the retention promise holds from the moment the feature is live.

## [3.52.3] - 2026-08-22

### Fixed
- **Userscript: sorting by Score buried the actual top score at the bottom
  of the list (#547).** Torn comma-formats any score of 1,000 or more
  (`"1,009.26"`), and `Number()` treats a comma as invalid input rather than
  a thousands separator, so `scoreSortValue()` read every four-digit-plus
  score as `NaN` — indistinguishable from a genuinely missing score, which
  always sorts last regardless of direction. Caught live on staging: a
  member with the highest score in the faction (1,009.26) sorted dead last
  instead of first. Now strips the comma before parsing.

## [3.52.2] - 2026-08-22

### Added
- **Userscript: a debug-only host override for staging QA.** There was no way
  to point a login at a `*_dev` host — `tenants.json` is production-only by
  design (deploy/update.sh explicitly excludes staging from it), so testing
  #523's backend-touching assist requests against `dev.monchoon.me` meant the
  userscript kept resolving the session to production instead, where the
  route correctly doesn't exist yet. `GM_setValue('tnl-dibs-debug-host',
  'dev.monchoon.me')` (Tampermonkey's own Storage panel — never in code, and
  never surfaced in the settings UI) now wins over `tenants.json` and skips
  fetching it entirely, so a fresh login lands on the given host instead. A
  real member's key never has this set.

## [3.52.1] - 2026-08-22

### Fixed
- **Userscript: the #523 assist overlay never rendered on the real attack
  page.** `attackPageMatch()` checked `pathname === '/loader.php'` — Torn
  retired that path for attacks (this file's own `attackUrl()` already
  builds a `page.php` link, and already had a test saying so), but the
  page-surface matcher was never updated to match. `isAttackPage()` was
  therefore always false and `boot()` skipped `renderAssistOverlay()`
  entirely — confirmed live: the `@match` correctly injected the script on
  `page.php?sid=attack…`, but nothing painted. Now checks `/page.php`.

## [3.52.0] - 2026-08-22

### Added
- **Assist requests: raise a hand from the attack page (#523).** A new
  `war_room_assists_v2` table + `assist` delta/snapshot channel + POST/DELETE
  `/api/war-room/assist` routes carry live, attacker-set "raise a hand"
  markers — 🚬 smoke / 💨 tear / 🆘 help — against `(requester, target)`,
  cleared by the requester, a short timeout, or the target going down
  (reuses the `warRoomDibsExpiry.ts` sweep pattern, see
  `warRoomAssistsExpiry.ts`). The userscript gains a second `@match` for
  `page.php?sid=attack*` — one script, two gated surfaces — with a small,
  strictly-additive overlay offering the three one-click requests on the
  attack page. On the faction page and in the War Room, an active assist
  request morphs the existing Dibs badge itself (icon + who/how-long-ago in
  the tooltip, click-through to the fight) rather than adding a second
  indicator, conserving the row's already-tight width; dibs underneath is
  unaffected. Held off `dev`'s default auto-merge (`hold-merge`) pending
  live verification on torn.com's attack page — the first script surface
  ever placed there.

## [3.51.0] - 2026-08-22

### Added
- **Userscript: a name is already a link to the profile (#547).** Torn wraps
  the whole honor-bar name — and the plain-text twin our activity tint
  reveals in its place — in its own `<a href="/profiles.php?...">` already,
  so no click handling needed writing: a plain click opens the profile in
  this same window exactly as any other Torn link does, and middle-click
  already opens a new tab on its own, since that is a real anchor and the
  browser's own behaviour needs no help. Colour is untouched.
- **Userscript: the two war tables sort independently, on every sortable
  column — including Torn's own Name, Level and Score, not only our BS and
  Status.** With the script off, Torn's Name/Lv/Score headers sort *both*
  tables from a single click — one shared setting driving two visual lists,
  which a userscript cannot scope from outside. The only way to make these
  three columns behave per-table is to take them over entirely: clicking one
  now reads the value straight off that row (name, level, score are all
  plain text already on the page) and reorders only that list, the same
  `bindSort()`/flex-`order` mechanism already proven on Status — which is
  also what keeps Torn's own handler from ever seeing the click.
- **Userscript: a Feedback button, posting through the same endpoint the
  dashboard's own Feedback modal uses.** Bug or suggestion, title and
  description, same 200/5000-character limits and same GitHub-issue pipeline
  server-side — no new API surface, just a client for what already exists.

### Changed
- **Userscript: the battle-stat total is a normal link again.** #539 made it
  always open in a new tab, on every kind of click; a plain left click now
  opens the attack page in this same tab instead, matching every other link
  on the row. Middle-click and ctrl/cmd-click still open a new tab — that is
  the browser's own behaviour on a real `<a href>` and never depended on
  `target`.

### Fixed
- **Userscript: the plain-text name is actually clickable now, not just
  visible (#547).** Torn's plain `.honor-text` span is `position: absolute`
  — a normal backdrop layer sitting invisibly under the honor-bar image and
  its per-character SVG twin — and an absolutely positioned element is
  blockified by the CSS spec regardless of any `display: inline` we set, so
  it never counted toward the size of the `<a>` wrapping it. Once the
  activity tint hid that `<img>`, the anchor had nothing left sizing it and
  collapsed to zero: the coloured text still painted (absolute positioning
  escapes a zero-size ancestor) but there was no box left to hover or click.
  `position: static` on the span and its wrappers pulls it back into normal
  flow, so the link now actually sizes around the text sitting on it.
- **Userscript: the Atk column links again outside an active war.** Torn
  renders that cell as a plain, unstyled span with no `href` at all whenever
  the row doesn't currently qualify for its own quick-attack link — true
  with the userscript fully disabled too, so this was never something our
  script broke. Since the destination is the same URL the BS link already
  builds, the script now gives Atk a real working link of its own (same-tab
  click, native middle/ctrl-click for a new tab) whenever Torn didn't
  provide one, rather than just relabelling dead text. Left untouched on a
  teammate row, and on any row where Torn's own link already works.

## [3.50.2] - 2026-08-22

### Fixed
- **Server test suite no longer intermittently fails on cold Postgres
  boots.** Every test file under `server/` boots its own embedded Postgres —
  the same as `db/`, which already carries generous timeouts
  (`testTimeout: 120s`, `hookTimeout: 180s`) for exactly that reason.
  `server/` never had its own vitest config and ran on the 10-second stock
  default instead. Both flakes this surfaced this week — a teardown-race
  `pool is closed`, and a `bootstrap.test.ts` hook that timed out at exactly
  10000ms — passed clean on an immediate re-run, confirming cold-boot
  timing rather than a real failure.

## [3.50.1] - 2026-08-22

### Fixed
- **The #543 migration no longer truncates `faction_attacks` on every
  deploy.** As first written, its `TRUNCATE` had no guard — `db/migrate.mjs`
  keeps no ledger and replays every file in `db/migrations/` on every
  deploy, and every other migration is safe to replay only because it does
  `IF NOT EXISTS`/`ON CONFLICT` work. This one would have wiped the table
  again on the very next deploy, and the one after that, forever. Caught
  before it ever ran against a real tenant database. The migration now only
  adds the 13 columns; the one-time backfill is a manual operator action
  (see the ops runbook / #543's PR for the exact commands).

## [3.50.0] - 2026-08-22

### Added
- **`faction_attacks` captures every field Torn's v2 endpoint returns
  (#543).** 13 new columns — `code` (the attack-log hash), both sides'
  `level`, `respect_loss`, `is_interrupted` / `is_stealthed` / `is_raid` /
  `is_territory_war`, `territory_war_id`, `finishing_hit_effects` (jsonb —
  what actually finished the fight, loadout-relevant for #528), and the
  three modifiers we were dropping (`retaliation`, `group`, `overseas`).
  None of this costs an extra API call — Torn was already sending all of it
  on every row this endpoint returns. Existing rows are left as-is, with
  the 13 new columns null; a one-time backfill (truncate, then let the sync
  re-walk Torn's full available window) is a manual operator action, run by
  hand once after this deploys — not baked into the migration, since
  `db/migrate.mjs` has no ledger and replays every file on every deploy.

## [3.49.0] - 2026-08-21

### Changed
- **Faction inventory sync moved off API v1 onto v2 `faction/inventory`
  (#542).** v1 is what's actually deprecated here — Torn disabled the
  per-category v1 selections on 2026-08-20. v2 needs one call per category
  (nine now, not eight — `consumables`, `boosters` and `loot` are newly
  collected) and paginates at 100 rows, and returns one row per
  stack-and-borrower rather than one row per item type, which the sync now
  aggregates back into the totals `inventory_items` expects. `loaned_to`
  comes out richer than before: v1 only ever named one borrower, v2 names
  every one. The cron job and the manual "Sync" button shared this mapping
  by a comment, not by code, before now — they call one function.

### Fixed
- **`faction_attacks.chain` is stored as Torn sends it, null included
  (#544).** Torn is moving "no chain applies" from `0` to `null` — already
  live for attacks where the attacker isn't the calling faction, and for
  every row from 2027-01-01. `0` is also a genuine chain position, so
  coercing null to `0` would make the two indistinguishable going forward.
  The one place we read this column for meaning (bonus-hit detection in
  payout calculations) is already null-safe. Existing rows are untouched —
  a stored `0` cannot be told apart from a genuine one after the fact, so
  nothing is backfilled.

## [3.48.0] - 2026-08-21

### Added
- **Userscript: a persistent chain widget on the faction page (#524).** A badge
  beside the launcher shows the live hit count and a 1Hz countdown to drop; it
  turns red and pulses inside the same 60-second warning window the board uses,
  with one toast fired per timeout window entered (not on every tick). Clicking
  it opens the bonus-hit ladder and the save-claim button, which posts to the
  same `chain-save` endpoint the board uses and paints optimistically like dibs.
  Toggleable in Settings, on by default.
- **Userscript: a toast when a target you hold dibs on leaves hospital (#526).**
  Detected as a transition between two consecutive polls — never on the first
  poll, and never for a target that drops off the roster entirely, since neither
  case can be positively confirmed as a discharge. Torn's own rendered Status
  cell is authoritative over the poll on disagreement, since the roster snapshot
  can be up to 3 seconds stale. Toggleable in Settings, on by default.

### Changed
- **Userscript: the fair-fight highlight threshold is a setting, not a fixed
  2.50.** A number input in Settings, alongside the existing on/off toggle.
- **Userscript: the dominant stat is marked in the battle-stat breakdown tooltip
  (#541).** A leading marker on that stat's row — the label field still pads to
  the same width either way, so every other row is byte-identical to before.

## [3.47.1] - 2026-08-21

### Fixed
- **Userscript: middle-clicking a battle-stat total opens a new tab, instead of
  starting autoscroll.** The total was a `<span>` with a click handler that called
  `preventDefault()` and `window.open()` — which works for a plain left click and
  silently breaks every other way of opening a link. Middle-click fell through to
  the browser's autoscroll (the scroll-wheel cursor), and ctrl/cmd-click, "open
  link in new tab" and the status-bar URL preview did nothing at all. It is now a
  real `<a href target="_blank" rel="noopener noreferrer">`, so opening the attack
  page is the anchor's own default action and every one of those gestures works
  without us implementing any of them. The click handler is kept only to stop the
  event reaching Torn's row handler.

## [3.47.0] - 2026-08-21

### Fixed
- **Backups: a deploy no longer costs a second full set of archives (#510).**
  Every deploy dumped all six databases twice — `update.sh` takes a pre-deploy
  archive, then the restarted sidecar dumped the lot again on start — turning a
  correct 6-a-day into a measured 65, 70 and 95 on deploy days. The sidecar's
  start-up run now stands down for any database already archived within
  `BACKUP_FRESH_HOURS` (default 20). The pre-deploy backup and the scheduled
  daily run are both untouched: the first is the rollback path and the second is
  the actual daily backup, and neither may be skipped.
- **Backups: the offsite prune now collects B2's hidden versions (#510).**
  Deleting a file on B2 leaves a hidden version that goes on being billed until
  something collects it, and nothing did — 3 GiB of the 9.34 GiB stored was
  deleted data. The remote prune is now followed by an `rclone cleanup`.

### Added
- **Fallen members are excluded from every roster, count and scrape.** Torn
  preserves the account of a player who has died (status `Fallen`, "Resting in
  Peace") and keeps them on the faction roster indefinitely — which is also how
  a faction comes to hold more than 100 members. A new `members.is_fallen`,
  set by the roster sync, is paired with `is_current` across the members page,
  the battle-stat leaderboard, OC rosters and member counts, the calendar, and
  the profile / stats / CPR / battle-stat scrapers (which also stops spending
  Torn calls on an account that can never change). The War Room drops them for
  both factions at the one place its rosters are built, so roll-call turnout
  and activity counts no longer include them.

  ⚠️ `is_current` is deliberately left true and the faction-stint history
  untouched: they have not left the faction, and flipping it would rewrite
  their history as a departure. Nothing is deleted — a direct lookup still
  resolves, so old links and past payout rows keep working.

- **Userscript: live status column (#515).** The Torn Status cell now carries a
  1 Hz hospital countdown (`1h23m` / `45m12s`), an abbreviated travel leg with an
  inferred ETA (`>CN ~54m`, `CN>`), and `In CN` for a member already abroad — all
  computed from data the delta poll already carried. An abroad hospital stay is
  marked with the country (`SWI:12m00s`), because it is a different proposition
  from a local one. Torn's own status stays authoritative on any disagreement.
- **Userscript: roster intelligence (#525).** Member names are tinted by activity
  (green online / amber idle / grey offline), an Okay member's Status cell shows
  their last action and a revive glyph, and the tooltip carries revive audience,
  wall and early-discharge flags plus — for leads, on our own members only —
  energy and drug/medical/booster cooldowns.
- **Userscript: sortable battle-stat column.** Clicking the `BS` header orders the
  whole table by battle stats (descending, then ascending, then off); Torn's own
  Status header sorts by how soon each member is attackable. Rows are permuted
  with flexbox `order` rather than moved, so the sort survives Torn re-rendering
  the list.
- **Userscript: a Warline-style online/idle count on the "Members" header**, on
  both factions' tables. Same look as the standalone Warline script (green
  pill, no offline count in the label), but counted from the **roster** we
  already hold in `rt.state` rather than scraped off the rendered rows — a DOM
  count only ever sees what Torn has painted, so it silently undercounts
  anything paginated, virtualised or collapsed. Which side is which comes from
  the roster too, never from left/right. The tooltip carries the full
  breakdown including offline. Toggleable in Settings, on by default.

### Changed

- **Userscript: the panel shows which version is running.** Soft grey beside the
  "Torn War Room" title, `v1.32.0`, in the same gray-400 the dashboard footer
  uses. Nothing renders when there is no version to read, rather than the
  "vundefined" an unguarded read would put on screen.
- **Userscript: the panel opens from a "Torn War Room" link in Torn's own page
  title**, beside Faction Warfare / Forum / Leave Faction, instead of a floating
  dot in the bottom-left corner. The amber/green connectivity light rides along
  as the link's icon, so one element is both the way in and the health readout,
  and the panel opens anchored under it rather than across the page. The link is
  re-checked each render pass, since Torn re-renders the page title on
  navigation and would otherwise drop it.
- **Userscript: the Attack column is renamed "Atk" and narrowed to 30px**, header
  included — the data cells already did this per row; the header now matches.
- **Userscript: the Level header is renamed "Lv" and Members "Name"**, on both
  factions' tables. "Level" was the widest label on a column that only ever
  holds a 2-3 digit number; "Name" says what the column holds in half the
  width, and the width it gives back is where the online/idle badge sits.
- **Userscript: the BS header reads centered**, rather than right-aligned like
  the numbers underneath it.
- **Userscript: the battle-stat column moves to sit between Level and Score**,
  split out from the Dibs badge, which stays where it was — immediately before
  Attack. BS is a read-first, decision-relevant number; Dibs is a click, and
  belongs next to the other click. Each is now its own cell (48px / 46px)
  instead of two halves sharing one 100px box.
- **Userscript: the battle-stat badge's border sits a little further from the
  number** (2px/5px padding, up from 1px/3px), so it reads as a box around the
  text rather than a line hugging it. The cell's own outer padding was trimmed
  to make room (4px → 2px a side) so the wider badge padding doesn't cost the
  column any net width.


- **Userscript: comments cut back to the ones that earn their place.** Issue
  numbers, section banners and doc comments restating the function name are
  gone. What stays: Torn's own formulas and published constants, the DOM
  quirks we work around, the references to the scripts and extensions we
  interoperate with (Warline, Wall Battlestats, TornTools), and the handful of
  warnings marking a trap someone has already fallen into. No behaviour change
  — every line of code is byte-identical.
- **Userscript: TornTools' war-list filters work again.** TornTools is a browser
  extension many players run; its Ranked War Filter (activity / status / level)
  hides rows by putting `.tt-hidden` on the `<li>`. Our flex-layout rule targets
  that same element and is *more specific* — `ul.members-list > li` (0,1,2)
  against their `.tt-hidden` (0,1,0) — so at equal `!important` ours won and
  `display: flex` silently un-hid every row they had filtered out. With the
  script on, their filter appeared to do nothing. Both halves of our row
  selector now carry `:not(.tt-hidden)`, so a filtered row is never matched and
  theirs stays the only display rule in play.

  ⚠️ The online/idle badge still counts the **whole roster**, not the filtered
  view — that is deliberate (#531): it answers "how many of that faction are
  online", which a filter does not change. TornTools shows its own
  "Showing N of M" for the filtered count.
- **Userscript: nothing is hidden on a narrow screen any more** — not the
  battle-stat column, not Score, not the online/idle badge. The rule hid `BS`
  under 1000px, inherited from the float layout where a row that did not fit
  wrapped, so something had to go. Under flex nothing does: every data column
  is fixed-width and the name column is `flex: 1 1 auto` with `min-width: 0`,
  so a narrow screen is absorbed by ellipsising the name. The badge keeps its
  numbers and drops only its words — `3 online / 8 idle` becomes `3 / 8`, with
  green and amber carrying what the words said (the same tones the names are
  tinted with), and the fixed columns give back a few px each.
- **Userscript: rows wrapped onto a second line, and the header disagreed with
  the rows about the column order** — BS sat before Score in the header but
  after it in every row, from the same markup. One cause for both: Torn lays
  its cells out with floats (they carry a `left` class), the cells this script
  injects are not floated, and non-floated content does not sit in DOM order
  relative to floats — it flows around them. A float row therefore ignored
  where our BS cell actually was, and overflow wrapped to a new line instead
  of overflowing. Sorting appeared to fix it only because the sort's `order`
  permutation forced the row list into flex as a side effect — which is also
  why the header, which sorting never touches, stayed wrong. The header, the
  list and each row are now all flex: one layout model, DOM order honoured
  everywhere, nothing needing a sort click to render.
- **Userscript: the online/idle badge no longer drops to a second line** in the
  name header — its cell keeps the label, the sort arrow and the badge on one
  line rather than stacking them.
- **Userscript: removed the -46px name-column reclaim.** It existed to close a
  hole the float layout could not reabsorb when the status dot and faction tag
  were hidden; under flex the name column is `flex: 1 1 auto` and takes that
  space by itself, and a negative margin would now drag the next column into
  an overlap instead.
- **Userscript: the battle-stat badge didn't wrap its own text, and clipped at
  the top.** Its green fair-fight border lived on the flex slot, which was
  stretched to the full row height (`align-self: stretch`) — so the border
  drew a box the height of the whole row around one line of 11px text, and any
  mismatch between that forced height and Torn's actual row height clipped it.
  Moved the border onto the text span itself, sized to its own content with a
  little padding, so it can't be taller than what it wraps.
- **Userscript: missing dividers between Level/Score and Score/Status.** Same
  root cause as the Attack divider below — the box-sizing reset's `border: 0
  !important` wiped out hairlines Torn's own cells carried. Score and Status
  now draw their own `border-left` in the same rule as the reset.
- **Userscript: the Attack column's left divider had gone missing.** The
  box-sizing fix for resized columns reset `.attack`'s `border` to `0
  !important` for width-accounting reasons; that shorthand silently wiped out
  the *separate*, non-`!important` `border-left` rule that drew the divider,
  regardless of which was declared first — an `!important` shorthand always
  wins over a plain longhand. Folded the hairline into the same box-sizing
  rule, after the reset, so it can't be clobbered by it again.
- **Userscript: a blank gap between Level and Score, only when name tinting is
  on.** Torn's war-list markup confirmed the actual cause: our forced `width`
  on Level/Score/Status/Attack only sets the *content* width, and Torn's own
  padding on those cells (content-box by default) sat on top of it, invisibly
  widening the box past what we declared. The narrower the forced width, the
  more that leftover padding stood out as blank space. Every column this
  script resizes now sets `box-sizing: border-box` with an explicit small
  padding, so the declared px value is the true rendered width — no
  unaccounted-for Torn padding left to reopen a gap. (Supersedes the 46px
  reclaim-margin estimate from the previous release, which addressed a
  different, smaller contributor to the same symptom.)
- **Userscript: our faction table sits beside the enemy's on a fresh page load**,
  not only after toggling the tint setting off and back on. Root cause: the
  runtime measurement that sized the width reclaimed from the hidden status dot
  and faction tag deadlocked with itself — the moment the tinting class was
  added it hid those icons via `display:none`, so any later measurement of them
  read zero forever, and the correction never got a real value. Toggling the
  setting worked only because it briefly un-hid the icons long enough to
  measure them once. Replaced with a hardcoded, generously-sized constant that
  has no such cycle to deadlock on.
- **Userscript: tinted names use a plain, readable font.** Torn's honor-text
  span carries whatever styling the badge component intends, which reads badly
  once shown as a name; it now gets an explicit system-UI sans-serif stack.
- **Userscript: the score column is narrower** (44px), since its content is a
  handful of digits.
- **Userscript: tinted names are actually visible.** Torn ships the war-list name
  three ways — an honor-bar `<img>`, a per-character SVG twin, and a plain
  `<span class="honor-text">`. Showing the plain one was not enough: Torn paints
  honor text with a gradient clipped to the glyphs, which sets
  `-webkit-text-fill-color: transparent`, and that wins over `color`. The name is
  now given a flat colour through both properties with the background cleared.
- **Userscript: the faction tag goes with the status dot**, and the member column
  is pulled back by their measured combined width, so removing them actually
  gives the row space instead of leaving a gap.
- **Userscript: the dibs control and stat total are centred on the row.** The
  previous attempt assumed the rows were flex containers; they are floats, so it
  was a no-op. The column now takes Torn's measured row height.
- **Userscript: names come back when tinting is off.** The honor-bar image was
  being hidden on every row regardless of the setting, and the check for a text
  replacement only asked whether the element existed — not whether it carried any
  text — so rows were left blank. The swap is now part of the tint setting and
  needs non-empty text to fire.
- **Userscript: sort headers toggle between two states**, not three. Leave a sort
  by choosing another column.
- **Userscript: names render as text, so activity tinting is visible.** Torn draws
  the name as a decorative honor-bar image with a text twin alongside; the gradient
  had nothing to land on. The image is now hidden and the text shown — but only on
  rows where the text twin was actually found, so a row can never end up nameless.
  Torn's own online dot is hidden while we tint, which also buys back its width.
- **Userscript: the battle-stat total is capped at five characters.** Three
  significant digits — `1.23B`, `12.3B`, `123B` — so it stops spilling out of the
  column. The tooltip still shows the full dashboard figure.
- **Userscript: the dibs control and the stat total sit on the row's centre line.**
- **Userscript: clicking a battle-stat total opens the fight again.** Torn retired
  `loader.php` for attacks — it now answers with a JSON error — so the link goes to
  `page.php?sid=attack&user2ID=…`.
- **Userscript: the stat tooltip paints above the table.** As an `::after` it was
  trapped inside `.tnl-col`'s stacking context and could never rise above the rows
  below it. It is now a single fixed-position element on `<body>`, anchored
  below-right of the cursor, flipping rather than spilling off screen, in grey.
- **Userscript: activity tinting works.** Torn paints war-list names with a
  gradient clipped to the glyphs (`background-clip: text; color: transparent`), so
  setting `color` on the anchor changed nothing visible. The gradient is now
  replaced on `.honor-text` instead, as CAT does.
- **Userscript: the page is fast again.** `scan()` only ever added anchors and Torn
  replaces rows constantly, so the node index accumulated dead anchors for the life
  of the tab — each still walked by `render()`, the 1 Hz tick and `applySort()`. The
  index now prunes as it walks, row lookups are cached per anchor, and `applySort()`
  returns immediately when no sort is applied.
- **Userscript: turning off battle stats removes the whole column**, header
  included, and the TNL column shrinks to the dibs control alone.
- **Userscript: the stylesheet no longer breaks the script.** A backtick inside a
  CSS comment sat within `injectStyles()`'s template literal, terminated it early,
  and the remainder parsed as JavaScript — `ReferenceError: button is not defined`,
  with nothing on the page. `node --check` does not catch this. `injectStyles()` is
  now covered by a stub-DOM test that asserts the rendered CSS carries no backtick
  and no un-interpolated `${`.


- **Userscript: comments moved out of the file.** 889 comment lines in 2526 became
  ~120; the provenance, constraints and traps now live in
  `docs/userscript-references.md`.
- **Userscript: column separators.** Vertical hairlines between the dibs and
  battle-stat halves and against Torn's Attack column, matching Torn's own table.
- **Userscript: Attack is relabelled `Atk` and its column narrowed**, buying ~30px
  a row. The dibs control keeps its previous flat-pill look but at a compact size
  with the holder's name truncated, and the column drops to 100px.
- **Userscript: the battle-stat tooltip is stacked like the War Room's** — FF, one
  line per stat, Total, then age and source — and clicking the total opens the
  attack page, as Wall Battlestats does.
- **Userscript: the dibs control is a compact chip, not a full-width pill.** The
  column drops from 132px to 104px and the button from a fixed 78px block to
  `auto / min 28px / max 40px`, both measured off CAT's `.call-button` rather
  than guessed. The label is now `DIBS` / `YOURS` / the holder's name truncated,
  with colour saying whose claim it is and the tooltip — now set on every state
  — saying who exactly. Torn's score column is narrowed to 50px to match.
- **Userscript: the stat breakdown marks the dominant stat (#513).** Matches the
  reference script's intent within the limits of a plain-text tooltip.

### Fixed

- **Userscript: Torn's own column sorts work again after sorting by BS.** We
  reorder rows with the flex `order` property, which overrides DOM order
  outright. Torn sorts by moving the nodes themselves — so once our sort was
  active, its header arrow moved and not a single row did. Sorting by Status
  appeared to break the spell only by accident: status values tie constantly and
  `sortEntries` breaks ties on DOM position, so Torn's reordering leaked through.
  Clicking one of Torn's own sortable headers now drops our sort and clears the
  `order` values before its handler runs.

## [3.46.0] - 2026-08-19

### Added
- **Data Export: raw CSV out of the dashboard, by table and TCT date range** (#517).
  A new Leadership tab lets you pick a table, pick a start and end day (and
  optionally a time), and download the rows as raw CSV. Every date and time on
  the screen and in the file is TCT.
  - **The tables are a hand-curated allowlist, not the schema.** Anything absent
    from it is not exportable and the endpoint 404s, so a new table holding
    something sensitive is not published the day it is created. `member_secrets`
    is not on the list and must never be — it holds API keys. Each table carries
    its own role floor: Torn returns and OC payouts at leadership, anything
    personal (roster, CPR, stints) at admin. Visitors get nothing.
  - **⚠️ Each table declares its own time column AND that column's type**, which
    is the whole reason the registry exists. `created_at` means opposite things
    in two of our tables: in `crimes` it is a bigint holding *Torn's*
    crime-creation time, in `faction_attacks` it is a timestamptz holding *when
    we inserted the row*. A generic exporter filtering on "created_at" would
    filter on the event in one and on our scrape time in the other — and both
    exports would look entirely correct.
  - Nothing stored is altered or dropped: readable columns are *added* beside
    the raw ones. An epoch integer keeps its value and gains a `<col>_tct`
    column next to it; a bare member id gains a `<col>_name` resolved against
    the roster. Attacks and revives are deliberately *not* joined — they already
    store the name as-of-the-event, and joining would rewrite history and blank
    every opponent.
  - Exports **stream from a server-side cursor**, so a 444k-row attacks export
    never sits in the API's heap. ⚠️ The known cost: once the first byte is sent
    the response is already a 200, so a failure part way through cannot become
    an error — the browser would save a short file that opens perfectly. Every
    export therefore ends with a `# complete: <n> rows` marker; the UI checks
    for it, strips it from the saved file, and says plainly when it is missing.
  - **⚠️ CSV injection is guarded.** Torn display names are user-controlled, and
    a field starting `=`, `+`, `-` or `@` is *executed* as a formula when Excel
    opens the file — and an exported roster is exactly the file someone
    double-clicks. Such fields are prefixed with an apostrophe, except plain
    negative numbers, so payout adjustments still sum.

## [3.45.0] - 2026-08-19

### Changed
- **Dibs is one control now, on both surfaces (#509).** Clicking your own claim
  releases it; the separate **Release** link is gone from the War Room. Three
  states, one button: grey `Dibs` for a free target, blue `✓ Yours` for your
  own, amber with the holder's name for someone else's.
  - **Admins keep the override**, moved onto the badge itself rather than a
    second link beside it — and it now works on the Torn userscript too, which
    never had it. This was never a new capability: the DELETE handler has
    always released any claim for an admin and filtered to `claimed_by = you`
    for everyone else. As before, nobody is notified.
  - The userscript reads `is_admin` out of its own session token to decide
    whether to offer the click. ⚠️ That is a UI affordance and nothing more —
    the token is signed and the script cannot verify it, so a member could
    hand themselves the flag and gain nothing, because the server still filters
    the release to their own claims.
  - Both surfaces derive the control from one function, `dibsButtonState`. The
    userscript mirrors it verbatim rather than importing (one file, no build
    step); the pair disagreeing about whether a click releases a claim is
    exactly the sort of thing that would only surface mid-war.

### Changed
- **⚠️ War Room: 0 now means OFF for dibs auto-drop and both chain pollers.**
  It previously meant "as fast as allowed" — the exact opposite. A lead who set
  the chain poller to 0 got the most aggressive cadence in the table, and a
  dibs auto-drop of 0 would have released every claim five seconds after it was
  taken. Both silent, both mid-war. The three fields join the existing
  off-or-floored group: exactly 0, or [floor, 600]. A *positive* value under
  the floor is still raised to the floor, because wanting polling faster than
  we allow is not the same as not wanting it.
  - The field also appeared to revert on screen, which is what made it look
    like a UI bug: the client used `Math.max(floor, Number(x) || 30)`, and **0
    is falsy**, so a deliberate 0 came back as the default before it was ever
    sent. All three inputs now share one `clampCadence` helper that can express
    "off". No helper text — 0 reads as off on its own.
  - Both consumers honour it: `chainPollDue` returns false at 0 (checked
    *before* the never-fetched shortcut, or a disabled poller would still fire
    once per boot), and `sweepDibsExpiry` returns without so much as a query.

### Fixed
- **⚠️ The userscript's read loop forked in two after the first tab switch.**
  `tick()` awaits its request, so the visibility listener — and `pokePoll()`
  after a claim — could start a second self-scheduling chain while one was
  already in flight. From then on every poll happened twice, forever, doubling
  the load on the tenant for no extra freshness. Visible in the console as
  paired requests all the way down. One read at a time now, with a pending flag
  so a request made mid-flight is honoured once rather than dropped.
- **The BS column now has a header and sits where it was asked to.** It was
  landing wherever it could find an anchor — and with no header at all — so it
  read as a stray number rather than a column. It is now inserted immediately
  left of the Attack column, with a Torn-style `BS` header, both located by
  structure rather than by Torn's hashed class names.
- **A dib held by someone else now names them** and is far easier to read: a
  larger control, and three colours that separate at a glance — blue for yours
  and actionable, amber for taken, grey for free. "Claimed" alone tells you not
  to hit, which is half the job; the name is what settles a collision in one
  message in faction chat instead of three.

### Added
- **Battle stats and Fair Fight on the Torn war page.** A `BS` column sits
  where Wall Battlestats puts its own, so the two read as one table and
  dropping that script leaves no hole. The figure is the total; the colour
  fires only when a single stat carries a third of the build (a wall, a speed
  build) rather than on every row, where it would mean nothing; a green border
  marks FF ≥ 2.5. The tooltip carries FF, the four components and the spy date.
  - **No new requests and no TornStats key.** `war_room_state_v2` already
    carries `bsp_total` and the components, and the script was already polling
    those rows. Our own row is in the same payload, which is what makes FF
    computable client-side with nothing to look up.
  - ⚠️ The FF maths is duplicated from `frontend/src/utils/fairFight.js` — a
    userscript has one file and no build step, so it cannot import. Tests pin
    the copy to the original: if the two drift, a member with the dashboard and
    Torn side by side sees two different FF for one target and cannot tell
    which is right.
- **The dibs control now sits beside the Attack link**, which is the order the
  decision is actually made in: read the stats, take the dib, hit. It falls
  back to the name cell if Torn renames the attack cell — in the wrong place
  beats absent.

### Fixed
- **⚠️ A full war-room snapshot shipped the faction's entire war history.**
  Neither `war_room_state_v2` nor `war_room_dibs_v2` is ever pruned, and the
  snapshot carried tombstones — so first paint meant **2,648 dib rows to
  describe zero live claims**, and 672 roster rows to describe 194 live
  members. It cost 2.3s against the 300ms the deltas that followed took. A
  tombstone cancels a row the client already holds, which makes it essential in
  a delta and meaningless in a snapshot: a client with no prior state has
  nothing to cancel. Snapshots now omit them; deltas still carry them, with a
  mirror test so that cannot be "optimised" away later. Affects the dashboard's
  first paint as much as the userscript's.
- **⚠️ The userscript offered dibs on members who had left the war.**
  `enemyIds` ignored `deleted_at`, and 478 of forge's 672 roster rows were
  tombstones. The claim would have succeeded — the server has no opinion about
  whether a target is still in the faction. Departures now also retract an
  enemy already known, which a growing-only set could never do.
- **⚠️ A dibs badge took seconds to show your own claim.** It looked like
  network latency and was not: the POST completed in under 300ms and the
  dashboard showed the claim instantly, but neither `claim()` nor `release()`
  wrote to the local index, so the `render()` straight after a click repainted
  from unchanged state and the badge snapped back to "+ Dibs" until a poll
  happened to carry the row. The file header had promised "paint optimistically,
  let the server's answer always overwrite" since the first commit; only the
  second half was implemented. A successful write now paints immediately,
  mirrors the single-dibs rule so you never briefly hold two, and pokes the
  read loop for confirmation instead of waiting out the interval.
- **The dibs badge was unclickable on Torn's war table.** Statically
  positioned, so the Level cell painted over it and took the pointer. It now
  makes its own stacking context, and a long enemy name no longer pushes it
  across two more columns.
- **A hidden tab went 30s between reads**, which read in the console as the
  script having stopped. Now 10s, and returning to the tab reads immediately
  rather than waiting out whatever was scheduled — the gap was always paid on
  the way back, as stale badges at the moment someone alt-tabs in to claim.

### Fixed
- **⚠️ The dibs userscript stopped working after exactly one day, then 401'd
  everything.** A session token *lives* 30 days but only *acts* for 24 hours —
  `verifySessionToken` rejects any token whose `iat` is older than
  `SESSION_FRESH_SECONDS`, which is how a member removed from the faction loses
  access within a day (#119). The SPA has always exchanged stale tokens silently
  via `POST /api/auth/refresh`; the userscript never did. So it worked
  beautifully for a day and then failed completely, while the `expires_at` it
  had stored insisted — a month into the future — that the session was fine.
  Nothing in that picture says "log in again".
  - The script now refreshes on a 401 and retries the call once. Exactly once:
    `/api/auth/refresh` is rate limited to 10/min and the read loop runs every
    three seconds, so a refresh that "succeeds" into a token the server still
    rejects must surface the 401 rather than ask again. A 401 or 403 *from the
    refresh itself* clears the session and asks for a key, instead of holding a
    dead token behind a panel that still claims to be signed in.
- **⚠️ The userscript's WebSocket is gone, and must not come back.** Torn's CSP
  names its allowed origins and we are not among them —
  `connect-src blob: 'self' wss://*.torn.com wss://*.torncity.com …` — so Chrome
  refused the connection before a packet left the browser. The fallback added
  earlier worked, but the attempt itself cost ten seconds on every page load
  and, worse, **leaked the session token**: the browser's own CSP violation
  message prints the entire blocked URL, and the token travelled in the query
  string. Every page load wrote a live 30-day JWT into the console. Our logging
  redacts; Chrome's does not and cannot be asked to. Reads go straight to
  polling now.
  - A failing read backs off (1s to 30s) instead of retrying every 3s, which
    matters when a tenant is mid-deploy and every member is polling at once.

## [3.44.0] - 2026-08-17

### Fixed
- **⚠️ The dibs userscript's WebSocket never worked on torn.com at all — the
  read path now falls back to polling.** The debug log settled it: the script
  logged a connection error on every load while nginx logged **zero** handshakes
  in the same window, from anyone. The connection was being refused inside the
  browser, before a packet left it.
  - The original design note was half right. Sockets *are* exempt from CORS —
    but CORS was never the binding constraint. A page's CSP `connect-src`
    governs WebSockets too, and a socket opened by page script gets none of the
    exemption `GM.xmlHttpRequest` enjoys, because the extension makes that
    request rather than the page. Every 101 in the access log that looked like
    the userscript was a dashboard tab.
  - The socket is still attempted, and still preferred where it works. If it
    fails to *open* — a close before any open, or ten seconds of silence — the
    script switches to polling `/api/war-room/delta` over the privileged
    transport, with the same `since` watermark semantics the endpoint was
    designed around. 3s while the tab is visible, 30s while hidden.
  - The socket `error` line is now debug-only. It fired on every page load for
    as long as the transport was blocked and told nobody anything actionable;
    the fallback announces itself once instead.
- **⚠️ The userscript offered dibs on factions nobody was fighting.**
  `war_room_state_v2` is not pruned when a war ends — forge was holding rosters
  for six factions on 2026-08-17, four of them months old — and the script
  treated *every* row that was not ours as an enemy. Enemies are now scoped to
  the opponent named by the config channel, falling back to the old behaviour
  only while that channel has yet to arrive. A change of opponent now also
  clears the cached roster and claims rather than accumulating both wars.

### Added
- **The dibs userscript has a debug log**, off by default, toggled by a
  `Debug log` checkbox in the expanded panel (a checkbox rather than a console
  command: the script is sandboxed, so `TNLDibs` is not reachable from the
  page's console). It traces every request, the socket's whole lifecycle with
  close codes and how long the connection lived, each frame's row counts, and
  how many badges got painted out of how many players found on the page — the
  three-way split that tells you *why* nothing appeared. Every URL goes through
  a redactor first: the trace can never contain a session token or an API key,
  because pasting a console screenshot into a chat is a normal thing to do.

### Fixed
- **⚠️ Every war-room WebSocket died and reconnected on a five-minute cycle.**
  Not the userscript's fault and not new — the dashboard had been doing it all
  along. nginx gives an idle upstream `proxy_read_timeout 300s`, the hub only
  writes when the ticker broadcasts, and the ticker is war-gated: with no war on
  it never fires, so every socket sat silent until nginx tore the tunnel down.
  Confirmed in the access log on 2026-08-17 — successive `101`s exactly 5m02s
  and 5m03s apart, per client. The hub now pings every 30s (browsers answer at
  the protocol level, so no client change was needed) and terminates any peer
  that misses two ticks, which also stops the hub broadcasting into sockets
  whose owner closed the laptop.
  - This was the "socket error" reported against the #487 userscript. It was
    real, it was just neither new nor specific to the script.
- **⚠️ The dibs userscript (#487) never connected, and could not have shown a
  badge if it had.** Two independent faults behind one symptom:
  - `boot()` awaited `/api/bootstrap` purely to confirm a faction id the session
    already carried, and only then opened the socket. With the socket hostage to
    an HTTP round-trip, a request that never settled meant no `connect()`, no
    throw and no status change — the panel sat on `idle` ("not connected")
    indefinitely with nothing in the console. The faction id now comes from the
    session and **nothing is awaited before `connect()`**.
  - The `snapshot` frame nests each channel as `{ rows: [...] }` while a `delta`
    puts the array at the top level (`fullDelta()` in `warRoom.ts`). The script
    passed the snapshot's wrapper object into `indexDibs`, where `for...of`
    threw *"rows is not iterable"* **inside the message listener** — invisible:
    socket open, panel reading live, not one badge on the page. A `frameRows()`
    helper now normalises both shapes.
  - Also: `connecting` is now a distinct status from `idle`, so a handshake in
    progress no longer reads as a dead connection, and socket errors and close
    codes are logged instead of being swallowed.
- **The dibs panel no longer parks itself on top of the war page.** Once a
  session exists it collapses to a 14px status dot in the corner — click for the
  full panel, `Hide` to send it back. Signing in collapses it automatically. It
  can never collapse while a key is still needed, which would be a script that
  silently does nothing and offers no way to fix it.
- **`deploy/update.sh` now warns when the userscript changes without a
  `@version` bump.** Tampermonkey gates auto-update on that field alone, so
  shipping changed code under an unchanged version leaves every install running
  the old file with no error and no prompt — which has now happened twice.
- **⚠️ A hand-run `deploy/update.sh` hung forever at the pre-deploy backup.**
  Not a slow upload — a **stopped process**. `timeout` runs its child in a new
  process group (that is how it kills the whole tree), which makes that group a
  *background* group for the controlling terminal; `docker compose run` still
  opens stdin even with `-T`, a background process reading the terminal gets
  **SIGTTIN**, and SIGTTIN stops it permanently — it cannot even act on the
  SIGTERM the timeout later sends. Diagnosed live on 2026-08-16: `pgrp=254751`
  against `tpgid=254564`, signal 21 pending, state `T`, with the backup itself
  already finished in 45 seconds. Fixed by detaching the step's stdin from the
  terminal.
  - This only ever bit **interactive** runs. Under cron there is no controlling
    terminal, so no SIGTTIN — which is why auto-deploys were fine while every
    hand-run appeared to wedge, and why it looked like a Backblaze problem.
  - It is also the real cause of the 2026-08-15 production wedge, previously
    recorded as "an interrupted run". The `.last-deployed` marker added then
    still earns its place; it recovers the state, while this removes the cause.
- **⚠️ The deploy died silently one line into publishing the userscript.** It
  read as a hang: the script was written, `tenants.json` was not, and the log
  simply stopped after `==> publish userscript` with no error. Cause was
  `PUBLIC_DOMAIN="$(grep -s '^PUBLIC_DOMAIN=' deploy/.env | cut -d= -f2-)"` —
  the key is not in `.env`, so grep exited 1, `pipefail` propagated it, and
  `set -e` killed the script mid-assignment with `-s` having suppressed the only
  output there was. `deploy/dev-deploy.sh` already carried an `env_value` helper
  with this exact warning attached; `update.sh` had been getting away with the
  raw pipeline only because every key it read happened to exist. All three
  readers now go through the sed-based helper, which cannot fail this way.
  - Two further landmines in the same block, found while fixing it: `curl -f`
    exiting non-zero on an HTTP error would have killed the deploy instead of
    skipping one tenant, and `grep -c` returning 1 on no matches would have
    killed it at the final line precisely when *every* tenant had failed — the
    case that most needs its warning to survive.
- **⚠️ The dibs userscript could not log anyone in.** It asked Torn's v1
  `user/?selections=basic`, which returns `player_id`, `name`, `level`, `gender`
  and `status` — and **no faction**. Every attempt therefore failed with *"Torn
  reports no faction for that key"*, blaming the key rather than the request.
  It now calls `/v2/key/info`, which is what the server's own `verifyTornKey`
  uses, so the script and the dashboard agree about a key by construction;
  `faction_id` is a flat property on `info.user` there. The same call carries
  the access level, so a Public key is now named as the problem instead of
  failing later as a vague login error. Eight tests cover the exchange —
  there were none before, which is why this shipped.

## [3.43.0] - 2026-08-16

### Added
- **War Room dibs userscript (#487).** Claim and release targets from the Torn
  faction war page itself, without leaving the game. Badges show the current
  holder live over the WebSocket; the control claims, releases, or names whoever
  already has it. Published to `files.monchoon.me/scripts/` on every deploy, so
  members auto-update.
  - ⚠️ **It resolves no races itself, deliberately.** The server already does —
    a row lock, a partial unique index and a 409 naming the owner, proven by
    #385's concurrency harness. Anything the script decided locally could only
    be a stale mirror of state another member is mutating, and its failure mode
    is telling you a target is yours when the server gave it to someone else.
  - ⚠️ **Only the session token is stored, never the API key.** The key is held
    in memory long enough to ask Torn which faction it belongs to and to log in,
    then dropped.
  - ⚠️ **The script can never be a member's first key enrolment.** Login is sent
    with the new `require_enrolled` flag: a member who has not already enrolled
    on the dashboard is turned away and pointed there. Enrolment adds a key to
    the shared rotating pool, and the dashboard is where the disclosure
    explaining that is shown — the script has no such screen.
  - Reads go over the WebSocket and writes through `GM.xmlHttpRequest`, both of
    which are exempt from CORS, so no CORS policy was added to the API.
  - Enemy-only: the war page lists both factions, and the socket's `faction_id`
    is what separates them rather than a guess about the DOM.
- **`require_enrolled` on `POST /api/auth/login` (#487).** Opt-in and only ever
  tightening; the SPA omits it and keeps enrolling on first login. Checked per
  member rather than per key fingerprint — the consent is the person's, not the
  individual key's.
- **`deploy/update.sh` publishes the userscript and a generated `tenants.json`**
  (#487). The faction-id → host map is built by asking each live tenant which
  faction it serves, so adding a faction to the box publishes it on the next
  deploy with nobody remembering to. A tenant that cannot name its faction is
  omitted rather than guessed — a wrong entry would send an API key to another
  faction's dashboard.

## [3.42.0] - 2026-08-16

### Added
- **API rate limiting (#485).** There was none: every client until now has been
  the SPA, driven by a handful of people per tenant. The dibs userscript (#487)
  changes that — it runs on a page members leave open for a whole war, and a
  retry bug in a client shipped to phones is discovered *after* everyone has it.
  A generous global cap (600/min) plus a much tighter one on `/api/auth/*`
  (10/min), which is unauthenticated by nature, calls Torn, and is the first
  endpoint an attacker reaches. Refusals return **429 with `Retry-After`** so a
  client can back off by a known amount instead of retrying blindly.
  - ⚠️ **Keyed on the logged-in member, not the IP.** In production every
    request arrives from the same nginx container, so an IP-only key would put
    a whole faction in one bucket and let one busy member 429 everyone else
    mid-war. Authenticated traffic keys on the JWT-verified user id, which
    cannot be forged and needs no `X-Forwarded-For` plumbing to be correct.
  - ⚠️ **Health checks and the war-room WebSocket are exempt.** `update.sh`
    polls `/api/health/ready` up to 20 times in 40s per tenant to decide
    whether a deploy worked, and Docker's HEALTHCHECK hits `/api/health` on its
    own schedule — limiting either would turn ordinary deploys into false FAILs
    and mark healthy containers unhealthy. The socket is exempt because the war
    room reconnects on every network blip, and a member whose train goes
    through a tunnel must not come back to a locked-out roster.
  - The auth budget is a separate store from the general one, so a burst of
    ordinary reads can never lock anyone out of logging in.

### Fixed
- **⚠️ An interrupted deploy wedged the box silently, and `--if-changed` could
  never recover it.** Both `deploy/update.sh` and `deploy/dev-deploy.sh` advance
  the checkout *before* the backup, the migrations and the build, so a run cut
  short anywhere in that gap (a closed SSH session is the usual way) left HEAD
  already equal to origin with none of the work done. The cron guard compared
  HEAD to origin, concluded "nothing to do", and from then on exited without
  writing so much as a log line — production sat five hours behind `main` on
  2026-08-15 with no error anywhere to find. Both scripts now record the commit
  of the last **successful** deploy in a gitignored `deploy/.last-deployed`
  (`-dev` for staging) and compare against that, so an interrupted run is simply
  retried on the next tick. A readiness failure deliberately leaves the marker
  stale: a deploy that retries loudly every five minutes beats one that marks
  itself done and goes quiet.

## [3.41.0] - 2026-08-15

### Added
- **War Room mobile — Fair Fight on every card (#477).** The personal FF score
  now sits immediately left of the battle stats on each mobile member card, with
  the same red-to-green gradient and the same dotted underline marking a number
  that rests on an assumed even stat split. The badge is omitted entirely when we
  hold no battle stats for the viewer, since FF is personal and a dash on every
  card would say nothing about any target.
- **War Room mobile — the "3x FF" filter and an FF sort (#481).** Both mirror
  the desktop controls; the filter is offered only when we hold battle stats for
  the viewer, since without them it would silently empty the board.

### Fixed
- **⚠️ The surge warning never reached anyone using the mobile War Room
  (#481).** The banner renders in the desktop view, and the mobile overlay is a
  full-screen sheet drawn on top of it — so the warning was rendering the whole
  time, underneath a cover. The sound and flash always fired; what a mobile user
  lost was which surge it was, and the leader's one-tap rally call. Both now
  render inside the overlay, above everything else on the screen.
- **⚠️ Green targets could be filtered off the mobile board (#481).** The mobile
  stats filter carried its own copy of the min/max logic without the #366 farm
  exemption, so the enemies who could be hit *this second* disappeared from the
  phone in exactly the situation the exemption exists for. It now shares
  `passesStatsFilter` with the desktop.

### Changed
- **In farm mode the "3x FF" filter never hides a green attack button (#481)**,
  on either surface — someone online and out of hospital is the enemy standing
  up, and a filter must not hide what a lead has to react to. It takes the same
  condition as the stats filter deliberately, so the board never depends on
  which of the two you reached for.
- The desktop FF cell, the FF sort and the "3x FF" filter now read a target's
  stats through one shared `targetBattleStats` helper instead of three
  hand-written copies of the same field mapping, which is also what lets the
  mobile card's camelCase rows produce an identical number. `isGreenTarget` and
  `passesStatsFilter` likewise now read both row shapes.

## [3.40.1] - 2026-08-15

### Fixed
- **The OC Simulator overstated how much of a crime it could not price, by
  about five times** (#471). ⚠️ Clinical Precision reported *"78.72% of the
  probability"* unpriced when the true figure is **16.15%**.
  - `expectedValue` has an explicit branch counting bad endings as fully
    covered mass paying zero — but it was being handed only the *good* endings,
    which made that branch dead code. The shortfall was then a share of the
    good mass, displayed as a share of **all** the probability.
  - ⚠️ **E(x) itself was never wrong.** Bad endings contribute zero either way,
    so the money was right and only the warning around it was inflated — which
    is the more insidious failure, because it pushed people away from crimes
    that were fine.

## [3.40.0] - 2026-08-15

### Changed
- **OC Simulator: the ending map is now derived by simulating the flowchart,
  not by inferring from it** (#471). Ending mapping goes from **21/31 to 29/31**.
  - ⚠️ **The diagram is not a hint about the probability model — it IS the
    model.** Walking it forward reproduces the service's own numbers to five
    decimal places, so the map falls out of arithmetic rather than heuristics.
    Three measured attempts at better heuristics gained nothing and one
    regressed; this replaces them.
  - Endings are assigned **all at once** by Hungarian matching on their
    probability vector across the whole probe sweep, not one at a time. The old
    greedy pass is what produced "no unclaimed ending at depth N": an early
    ending took a node a later one had no alternative for.
  - This is what separates endings that are **identical at the baseline** —
    `_B3S_` and `_C3S_` are both 0.00990 at all-99 and 128x apart once a role is
    dropped.
  - **Multi-role checkpoints AVERAGE.** Both MonChoon and I assumed a product;
    measured against the service's own `successChance`, a product was the worst
    of five candidate rules and the average the best, landing on *exactly* zero
    for seven scenarios. Confirmed by MonChoon, including for three roles.
  - **A complete map and a trustworthy one are now separate facts.**
    `ending_map_confident` is stored alongside a numeric residual: ten scenarios
    reproduce `successChance` exactly while the split between endings does not
    fit, so their per-ending money is flagged rather than quietly trusted.
  - A **spare terminal no longer fails a crime**. Snow Blind's diagram draws a
    good ending the API never reports; every ending that needed pricing still
    got a node.

### Fixed
- **Two crimes stay unmapped, and now say why precisely** (#471). Blast from the
  Past and Counter Offer report more endings than their flowchart draws
  (including keys like `goodEnding35`), so no assignment can be complete. Their
  `successChance` simulates exactly, which is what proves the mismatch is in the
  source data rather than in our model.

## [3.39.0] - 2026-08-15

### Fixed
- **OC Simulator: 21 of 31 crimes now have their endings mapped, up from 18**
  (#390) — and the *cause* of the remaining failures changed completely.
  - ⚠️ **The probe design was the bug, not the scoring.** Each role was dropped
    to **CPR 1** to see which endings that made likelier. That SATURATES: a role
    gating several checkpoints then fails all of them, so the endings needing
    exactly *one* of its failures collapse instead of appearing. Pet Project's
    `goodEnding2` is flat on Picklock at CPR 1 and rises **25x** at CPR 50 — the
    evidence was there the whole time and the probe could not see it.
  - Each role is now probed at **two levels (50, then 1)**, and the strongest
    reading wins: a rise at any level settles it, because saturation can hide a
    rise but never invent one.
  - Measured against all 31 live scenarios: **18/31 → 21/31, no regressions**,
    and the "no role evidence" failure — which accounted for seven crimes — is
    gone entirely. What remains is seven ties and three crimes where the source
    contradicts itself.
  - A **fall now excludes** a candidate: if dropping a role makes an ending
    rarer, that ending is not the one reached by that role failing. One-way, so
    it removes wrong candidates without inventing predictions.

## [3.38.2] - 2026-08-15

### Fixed
- **Calendar date numbers sat mid-cell with event bars printed over them**
  (#395). ⚠️ A `<button>` centres its content vertically when it is taller than
  that content, so the `min-h-[6rem]` cell floated the date into the middle —
  straight into the band layer, which is anchored to the top of the row. The
  cell is now an explicitly top-aligned column, and the date carries its own
  stacking context so a mis-measured lane can never cover it again.

## [3.38.1] - 2026-08-15

### Fixed
- **An ongoing ranked war no longer spans the calendar forever** (#395). A war
  with no recorded end was treated as ending at the maximum representable date,
  so its band ran to the right edge of every week and reappeared in every
  future month. ⚠️ A running war has not *finished*, but it also has not
  happened *tomorrow* — the band now stops on today, and the war drops out of
  months that have not arrived.

## [3.38.0] - 2026-08-14

### Added
- **Per-member Torn event start windows** (#459), on Members → Calendar. During
  an event everyone gets 48 hours opening at their own chosen hour, so where
  each member's window sits is real coordination information — shown as a
  per-member list plus a count per hour, so the faction's coverage reads at a
  glance.
  - ⚠️ **Opt-in, and off until each member switches it on.** Reading
    `/user/calendar` is not among the uses members agreed to when they enrolled
    their key, and silently widening what an existing key does is exactly what
    a consent record exists to prevent. The grant is recorded separately from
    `consent_at`.
  - ⚠️ **Deliberately not a `consent_version` bump.** That gates the whole key
    pool, so a bump would stop every scraper until each member logged in again
    — a heavy price for an optional feature.
  - ⚠️ **Withdrawal deletes.** Turning it off clears the grant *and* removes the
    stored time; the daily job also sweeps rows whose consent vanished by
    another route (key removed, member left), so stored data never outlives its
    permission.
  - Members who declined are **absent from the list**, never present with a
    dash — a row reading "did not share" publishes a decision that is nobody
    else's business.
  - The enrolment disclosure names the scope as opt-in and lists the extra call.
- **`member-event-windows` scraper job**, daily at 04:35, one call per
  **opted-in** member. ⚠️ It uses each member's **own** key, never a pooled one:
  `/user/calendar` answers for the caller, so a rotating key would report one
  person's hour under every member's name — plausible-looking data that is
  entirely wrong. Torn's string is stored verbatim and parsed only at read time,
  so a format change cannot be silently wrong for everyone at once.

## [3.37.0] - 2026-08-14

### Added
- **Steadfast on the calendar** (#395), so people can plan training — a
  training book is five days of commitment, and the rotation decides whether
  they are worth reading now.
  - **Which stat is boosted comes from TNL's rotation**: Strength/Speed swap on
    the **1st**, Defense/Dexterity on the **16th**, offset by half a month. It
    is pure calendar arithmetic, so it predicts **forward indefinitely** — page
    to any future month and the schedule is there.
  - **How much comes from the live faction tree.** A new `faction-upgrades`
    scraper reads `GET /faction/upgrades` daily and the calendar derives the
    percentages from what is actually unlocked. ⚠️ Nothing is hard-coded to
    15/20: the day the tertiary tree is bought, the numbers move on their own.
  - ⚠️ **Off by default, per faction.** The rotation is TNL's policy and this
    stack serves several factions; another faction's schedule looks exactly
    like their own. Enable with the `steadfast_rotation` setting.
  - With no scrape yet, bands name the boosted stats and **decline to claim a
    percentage** rather than defaulting to a plausible-looking 15/10.
- **`faction-upgrades` scraper job**, daily at 02:10. One row **per day** — a
  single current-state row would repaint history with today's numbers, and the
  calendar's whole premise is that a date shows what was true then. The raw API
  response is stored alongside the parse, so a wording change costs a
  re-derivation rather than a lost month.

### Changed
- **Multi-day events are one continuous band, not a pill repeated in every
  cell** (#395). ⚠️ The old rendering *miscounted*: a five-day war read as five
  things, and each cell's "+N more" counted the same war again — so a genuinely
  busy day could hide a one-off behind four repeats of one war. Bands stack
  into lanes, and a band clipped by the week boundary loses its rounded end
  instead of pretending the event stops there.

## [3.36.1] - 2026-08-14

### Changed
- **Calendar: payouts are a single marker on payday, and they link through**
  (#395, on MonChoon's review of the first cut).
  - **OC Payout** no longer spans the week it covers — one flag on the day the
    money moves. The date is derived as `week_end + 1`, not "the next Monday":
    both rules agree on a Mon–Sun week and only one of them survives a faction
    running a week that is not.
  - Clicking it opens **that week's payout modal** — the same one you get from
    the row in Payout History — via `/oc/payouts?week=<id>`.
  - Ranked wars gain an **RW Payout** marker on the war's last day, linking to
    the war payout modal. ⚠️ Only where a payout actually exists: a flag on
    every finished war would be a dead link until leadership pays it out, and
    one dead link teaches people to distrust the ones that work.
- **Adding calendar entries is leadership/admin only.** The controls keyed off
  `effectiveIsLeadership`, which deliberately includes **visitors** so they can
  read leadership surfaces — so a visitor saw an *Add event* button the server
  was always going to refuse. Editing now excludes visitors explicitly.

### Removed
- **Expiring OCs from the calendar** (#395). Not useful there — the OC pages
  already carry it.
- The explanatory paragraph under the calendar grid.

## [3.36.0] - 2026-08-13

### Added
- **Faction calendar** (#395), as a new **Members → Calendar** tab plus an
  **Upcoming** card on the dashboard.
  - **Useful before anyone types anything.** Five of the seven sources are
    derived from tables we already fill: ranked wars, competitions, OC payout
    weeks, and OCs about to expire (#392 was a lapsed OC quietly costing people
    payout time — a date on a calendar is the cheap prevention).
  - **Torn's own events** (folded in from #424) are entered by hand, because
    there is no API for them: the entire v2 spec offers `/user/calendar` (the
    caller's preferred start hour) and `/user/competition` (a competition
    *already running*). Neither can say an event is coming. Entries can be
    marked **repeating yearly**, so "Christmas Town, every December" survives a
    year of nobody maintaining the list.
  - **Birthdays, both kinds.** Torn account anniversaries are derived from the
    profile blob we already snapshot daily — no new scraping, no new consent
    surface. Real birthdays are opt-in and self-service: **day and month only**
    by default, with the year a separate optional field, and *Remove* deletes
    the row rather than hiding it.
  - Everything renders in **TCT**, the grid included. A faction spans
    timezones, and Torn only ever speaks TCT.
  - **Aggregated entries carry no edit controls.** A war shown here is a view
    onto `ranked_wars`; a delete button on it would either do nothing or delete
    the war. Only typed-in rows are editable, by leadership.
  - The dashboard card renders **nothing at all** when the next seven days are
    empty — an empty card every day trains people to stop looking at it.

### Fixed
- **A ranked war with no recorded end no longer disappears from the calendar**
  (#395). `COALESCE(end_at, start_at)` collapsed an *in-progress* war to a
  point in time, so any window starting after the war began excluded it — the
  one war anyone is actually looking for. A null end now means *still running*
  on both sides of the wire, and the frontend clip had the identical bug.

## [3.35.0] - 2026-08-13

### Added
- **Per-role sensitivity in the OC Simulator** (#441). A *What matters?* button
  measures, for every role, how much it moves **success** and how much it moves
  **payout** — and labels each role accordingly:
  - **Gate** — drives success. Failing it ends the crime.
  - **Router** — drives payout. Barely changes whether you succeed, but decides
    which ending you reach, worth ~$159M a step on Break the Bank.
  - **Barely matters** — measured, and genuinely small. Put your weakest member
    here.
  - ⚠️ **Kept as two numbers, never one score.** MonChoon: *"Sometimes they
    affect the payouts more than success, so its important to see these
    distinction."* A combined "impact" figure averages a router's huge payout
    effect together with its negligible success effect and makes it look
    unimportant — which is exactly the role that would then be under-trained.
  - ⚠️ **"Barely matters" and "not measured" are different labels.** Both would
    otherwise invite putting your weakest member there; only one justifies it.
  - ⚠️ A value delta is **refused** when the probe shifts probability onto
    endings we cannot price. Otherwise a role that moves mass somewhere
    invisible looks like it destroys value.
  - Measured **on demand**, not per slider tick — it costs one extra request per
    role, and a six-role crime would otherwise fire seven requests per
    adjustment at a small third-party server. Probes step downward near the
    ceiling so they stay inside 0–100.

## [3.34.1] - 2026-08-13

### Fixed
- ⚠️ **Illiquid item drops were valued at zero** (#448). Item rewards priced on
  `market_price` alone, but some items rarely trade and carry `market_price = 0`
  while `sell_price` holds their real worth — a Priceless Painting is the
  obvious case. That valued exactly the rarest, most expensive drops at nothing.
  Now uses `GREATEST(market_price, sell_price)`, matching what
  `enrichItemBreakdown` has done in the payout path for a long time.
- An item in **neither** price list contributes zero and is **counted**, rather
  than falling back to the `unit_value` stored on the row when the crime ran. A
  stale number presented as a current one is what this feature exists to avoid.
  Affected crimes are marked `under` in the ranking table: their value is an
  understatement, not an estimate.

### Changed
- **`items-sync` now runs every 6 hours** instead of once daily at 04:15. The
  simulator prices item rewards at current market, so re-running a simulation
  should pick up price movement. The whole catalogue is one API call, so four a
  day costs nothing worth counting.

## [3.34.0] - 2026-08-13

### Added
- **Item rewards are valued** (#448). Crimes that pay in items rather than cash
  — Best of the Lot, Crane Reaction, Gaslight the Way and others report $0 on
  every ending — now carry a value derived from our own completed runs, priced
  at today's market. Without it, #444 would rank those crimes last on a number
  measuring half their reward.
  - ⚠️ **Averaged over every successful run, not just the ones that dropped
    items.** Three drops worth $30M across ten runs is $3M a run, not $10M.
  - ⚠️ **Current market price**, deliberately unlike Payout Management, which
    keeps the stored snapshot because a saved week is a record of what happened.
    This is a forecast, so it uses what the items are worth now.
  - ⚠️ **Per crime, never per ending.** The feed prices endings; our history
    records items per crime without saying which ending dropped them.
    Attributing item value to an ending would be inventing a join.
  - A crime we have never completed reports **null**, not zero — "no history" is
    not "drops nothing". A crime run once that dropped nothing reports 0 with a
    run count of 1, which is a real if thin measurement, and the two are kept
    distinguishable.
- **Crime ranking** (#444). A sortable table of every mirrored crime with
  success, scope cost, value per run, **value per scope**, spawns per week and
  income per week.
  - ⚠️ **Ranked on value per SCOPE, not E(x).** Scope is what runs out, so the
    crime turning each point of it into the most value wins even when a pricier
    crime pays more per run.
  - ⚠️ Crimes below their difficulty's **break-even success** are struck through
    and counted in a banner. They drain scope every run whatever they pay, and
    money alone would rank them highly.
  - ⚠️ **The CPR assumption is stated on the table**, not buried: every figure
    assumes one flat CPR across all roles, which is a crew we may not have. So
    is the fact that value-per-run is an approximation — it weights the mean
    priced ending by success rather than using the full ending mix, which is
    what the per-crime cards show.
  - Spawn rates are measured from our own history, with thin samples marked
    `?`. ⚠️ They record past *decisions* as much as capacity: a crime avoided
    because someone judged it not worth it reads as rare, and ranking on that
    would keep it rare. Said plainly under the table.
  - Unknowns sink to the bottom in **both** sort directions (the #351 rule)
    rather than ranking as zero.
  - Success chances are cached server-side per (crime, CPR) — the mirror is
    static between nightly runs, so re-asking the same CPR costs nothing
    upstream.

## [3.33.0] - 2026-08-13

### Added
- **Compare several crimes at once in the OC Simulator** (#445). A picker modal
  lists every mirrored crime grouped by difficulty (Elaborate → Introductory)
  with its scope cost; ticking crimes **enumerates them in selection order**,
  and that order is the order they appear on the page. The selection persists.
  - Each selected crime renders its own card — roles and sliders, success
    chance, endings, scope verdict and E(x) — with #442's live headcount under
    every slider.
  - The header totals what spawning one of each would cost in scope, which is
    the budget question a set of crimes actually raises.
  - ⚠️ **Sliders are per crime and never shared**, even between roles with the
    same name. MonChoon, 2026-08-13: *"each role in every crime is unique (even
    if they are both called Muscle #1)"* — they have different weights,
    different checkpoints and different per-member CPR. Linking them by name
    would silently model something untrue. Each card owns its own state, which
    also means moving one slider recalculates only that crime rather than
    firing six requests at a small third-party server.
  - ⚠️ Crimes are grouped using the OC Planner's **name-authoritative** resolver
    rather than re-deriving from difficulty. Difficulty 8 spans both Advanced
    and Elaborate — Break the Bank is difficulty 8 and configured Advanced — so
    re-deriving would file it differently here than the Planner shows, and
    change its scope cost from 4 to 5 on the way.
  - A persisted selection can outlive a crime being renamed upstream. Missing
    crimes are named rather than silently dropped, and never rendered as an
    empty card.
  - The scope total is withheld entirely if any selected crime has an unknown
    category, rather than shown quietly short — it is a number someone budgets
    against.

## [3.32.0] - 2026-08-13

### Added
- **Role headcount from the real roster** (#442). Each slider in the OC
  Simulator now says how many current members clear that CPR for that role,
  updating as you move it, with the best available CPR shown when nobody does.
  - ⚠️ **"Can fill", never "available".** A member with the CPR may already be
    in another crime — members cannot be in two OCs at once — so every figure is
    an upper bound and the wording says so. Wiring in the occupancy data (#389)
    is the follow-up.
  - ⚠️ Three states that all look like "0" are kept apart: **nobody clears the
    bar** (a training problem), **no readings for this role** (a data problem),
    and **the role could not be joined to a Torn position** (a matching
    problem). Collapsing them would send someone hunting a problem that does not
    exist.
  - Leavers are excluded — a former member's CPR is not capacity we have.
- **Scope economy modelled** (`utils/ocScope.js`), and the simulator now says
  whether a crew can afford to keep running a crime.
  - Scope is spent to spawn and returned **only on success**, so each difficulty
    has a **break-even success chance**: 50% Introductory, 66.7% Simple, 75%
    Intermediate, 80% Advanced, **83.3% Elaborate**. ⚠️ Below that line a crime
    drains the faction's ability to spawn anything, however much money it pays —
    and E(x) alone will never say so. **This is the answer to "what minimum CPR
    should we set".**
  - `scopeReward` added to `config.js` alongside the existing `scopeCost`, plus
    the 100 cap. Scope above the cap is discarded, so a full bank is waste
    rather than a healthy surplus.

### Fixed
- ⚠️ Corrected a misreading: "scope" is Torn's crime-spawning resource, not
  respect. The #445 ticket carried that wrong assumption and has been amended.

### Changed
- Role↔position matching (`server/src/oc/roleMatch.ts`) requires the **name and
  the position id to agree**, and reports a conflict rather than picking a side.
  The same string mismatch has now appeared three times ("Thief 1" upstream,
  "Thief1" in weights, "Thief #1" in Torn), and an off-by-one in position
  numbering would attach every CPR reading to the wrong role, invisibly.

## [3.31.0] - 2026-08-13

### Added
- **E(x) is computed, not hand-entered** (#440). The SSE feed that serves each
  crime's flowchart also emits an `event: stats` frame carrying observed money
  and respect **per diagram node** — the same node ids the #390 ending map
  resolves to. We were already receiving that frame on the same connection and
  discarding it. The nightly mirror now stores it in `oc_scenario_node_stats`
  and the simulator prices every mapped ending from it, at **no extra
  requests**. The 167-cell hand-entry table is no longer the source of payouts.
  - ⚠️ **This independently confirms the #390 mapping.** Joined through the
    derived map, Break the Bank's endings form a monotonic ladder —
    $375.8M → $216.8M, respect 450 → 270 in steps of exactly 45. Under
    declaration order, the shortcut #390 rejected, respect would read
    450, 405, **315, 360**, 270. Confirmation from money, a signal completely
    unrelated to the failure-depth and role evidence that derived the mapping.
    A test asserts the ladder, so a mapping regression fails loudly.
  - **Respect now shown alongside money** — expected respect per run, and per
    ending.
  - **Payout spread** per crime (best vs worst ending, ~$159M on Break the
    Bank). This is what a role that steers *which* ending you reach is worth,
    and the groundwork for #441.
  - ⚠️ **Observation counts travel with the figures.** `n` ranges from 1 to
    6,419 across the real feed; an average from a single run would otherwise
    render identically to one from six thousand. Endings priced from few runs
    are marked, and the three distinct weaknesses — ending unmapped, mapped but
    unpriced, priced but thin — are reported separately, because each has a
    different fix.
  - A run that returns no stats frame **leaves existing prices alone** rather
    than deleting them. Wiping a priced crime because one nightly run arrived
    early would turn a real E(x) into a lower bound of zero, silently.

### Changed
- `expectedValue()`'s lower-bound contract is unchanged and now describes
  unmapped or unobserved endings rather than un-typed ones — the same honesty
  for a different reason.
  
## [3.30.2] - 2026-08-13

### Fixed
- **Two scraper jobs had no description in Global Admin** (#390, #389).
  `crime-occupancy` and `oc-scenarios-mirror` were both registered without a
  `SCRAPER_JOB_INFO` entry, so hovering their names showed the "details are not
  available" fallback instead of what they do. Both now describe their purpose,
  cadence and API footprint like every other job.
  - Guarded both ways: the test now reads the job names straight out of
    `server/src/scraper/registerJobs.ts` and fails if a registered job has no
    summary, or if a summary describes a job that no longer exists. The gap was
    silent — the row renders perfectly, just uselessly — and would have
    recurred on the next job added.

## [3.30.1] - 2026-08-13

### Fixed
- **Opponent history panel spun forever** (#398). "Loading history…" never
  resolved, against a healthy and fully indexed endpoint. The fetch effect
  depended on the state it writes (`state.loading` / `state.data`), so
  `setState({loading:true})` re-triggered the effect, React ran the previous
  cleanup, and that set `cancelled = true` on the request already in flight —
  which then discarded its own response. The in-flight opponent is now tracked
  in a ref, and the effect depends only on `[open, opponentId]`.
  - A 15s timeout now surfaces an error instead of spinning, and a failed
    attempt clears the ref so reopening retries rather than being permanently
    stuck for the session.
  - Guarded by a source-shape test, in the spirit of the #140 `new Date`
    scanner — verified to fail against the original code.
  - No index or precompute needed: `idx_wmc_war_id`,
    `war_room_roll_call_v2_war_idx` and the `(war_id, member_id)` unique already
    cover every join this query makes.

## [3.30.0] - 2026-08-13

### Added
- **OC Simulator** (#390). New tab under OC, gated to OC managers, leadership
  and admin (the OC Planner's gate). Pick a crime, set each role's CPR, and the
  success chance, per-ending probabilities and E(x) update as you move a slider.
  - **Nightly mirror job** (`oc-scenarios-mirror`, 03:50): copies the 31
    scenarios, their roles and weights, their flowcharts and the derived
    ending→node mapping into `oc_scenarios` / `oc_scenario_roles` /
    `oc_scenario_endings`. The browser never talks to the upstream service — an
    outage degrades to stale numbers instead of a dead page.
  - Server proxies `CalculateSuccess`, validating the scenario is one we
    mirrored and the CPR vector is the length that crime actually takes. A
    wrong-length vector gets perfectly ordinary numbers upstream, for a crime
    nobody is running.
  - **E(x) is presented as a lower bound** until every good ending is priced,
    and left blank rather than shown as `$0` when nothing is priced — a zero
    reads as "this crime pays nothing". The payout table is still hand-entered
    (0 of 167 filled).
  - Model completeness (27 complete, 4 in progress) is shown on the page. It
    exists only on the upstream HTML page; the API omits it, and an in-progress
    model answers with numbers that look exactly as authoritative as a finished
    one.

### Fixed
- **The upstream API zero-pads its ending slots** (#390). Found by running all
  31 scenarios: Plucking the Lotus Petal returns `goodEnding1..10` with 5–10
  exactly 0 against 4 real endings; Ace in the Hole returns 10 against 7. Taken
  at face value this looked like the API and the diagram disagreeing about the
  crime's shape, and refused seven scenarios outright. Only a *trailing* run of
  zeros is trimmed — an interior zero is a real ending that happens to be
  unreachable at those CPRs, and renumbering around it would shift every later
  ending onto the wrong node.
- **The diagram feed hung on every fetch** (#390). It is an SSE stream the
  server holds open after sending the diagram, so `res.text()` waited for an end
  that never came and aborted on the timeout every time — discarding a diagram
  we had already received. Now read incrementally and closed as soon as a
  complete frame arrives (288 ms against the live service).
- **A truncated SSE frame decoded as a valid prefix** (#390). Base64 does not
  fail on a partial payload; half a diagram still starts with `flowchart LR` and
  would have been stored as a complete one with most of its nodes missing. Only
  frames terminated by a blank line are accepted.
- ⚠️ The service is **HTTPS on port 3000**, not HTTP. Plain HTTP gets an empty
  reply, which reads exactly like the service being down.

### Changed
- `validateScenarioTree` now separates `ok` (no problem of any kind) from
  `mappable` (no problem that invalidates the ending mapping) (#390). Mob
  Mentality — the only defective diagram of the 31 — has one narrative node that
  stops without reaching an ending. It is off every path to a terminal, so it
  cannot affect the mapping, and refusing the whole crime over it would cost a
  real capability for no safety. The problem is still reported, in words.

## [3.29.0] - 2026-08-13

### Added
- **Opponent history panel on the War Room** (#398). The endpoint from 3.28.0 now
  has a UI, in the notes / roll-call area rather than the roster table — this is
  pre-war planning reading and must not compete for space during a chain. Shows
  previous matchups (dates, scores, result, our top scorers, roll-call turnout and
  the note we wrote), capped at 5 with a "show all" expander, plus a diff of their
  current roster against their roster in the most recent previous war.
  - ⚠️ Labelled **war roster**, never "faction". Torn's ranked-war report held
    77–100 rows per war in the real data, so anyone who joined mid-war or left
    before the report was cut is simply absent from it. The caveat is always
    visible, not a tooltip, because it changes what the numbers mean.
  - A faction we have never fought produces no diff at all, rather than "everyone
    on their roster is new" — technically true, useless, and alarming.
  - Level movement since the last war shown for members present in both; null
    rather than 0 when either level is unknown.
  - Fetched on first open, not on mount: history changes once a war and has no
    business adding a request to a page already polling at a 2 Hz floor.
- **Observed occupancy on the payout page** (#389 part 2, UI). What the poller
  actually watched, next to what the existing calculation inferred — an `Observed`
  column and a collapsible panel with coverage, poller accuracy and the largest
  per-member disagreements.
  - ⚠️ Diagnostic only. Payouts are still calculated from the existing figures,
    per MonChoon: *"I will observe the data for a few weeks until I can verify its
    working and then we can push it."* Nothing here moves money.
  - The `Observed` column is **hidden entirely** for a window the poller never
    covered, and an unobserved member renders as an em dash. A column of `0h`
    would read as "nobody was in a crime" when it means "we were not looking" —
    the #330 confusion, which cost a fortnight the last time it was made.
  - Coverage escalates on either a single gap ≥ 15 min or >1% of the window
    missing, deliberately *not* on the underlying `covered` flag: that goes false
    on one late tick, which would make a 4-minute hiccup and a 4-hour outage
    produce the same warning, and a warning that fires on both is ignored on both.
  - Poller accuracy reports "no evidence" when no joins were witnessed, rather
    than passing a claim nothing has tested.

## [3.28.0] - 2026-08-13

### Added
- **History against the current opponent** (#398).
  `GET /api/war-room/history/:factionId` returns every completed ranked war against
  one faction, newest first, each with our contributions, the roll call, and the
  public note we wrote at the time. That last one is the part with no other home:
  scores are public and contributions are Torn's, but what we said about them last
  time was only findable by scrolling the archive war by war.
  - Excludes the war currently in progress — "previous matchups" including the one
    being fought reads as history the lead has not lived through yet.
  - Empty arrays rather than nulls for a war with no notes or roll call, which is
    the common case for a first-time-noted opponent and would otherwise throw in
    the panel.
  - Leads/visitors only, matching the notes archive.

## [3.27.0] - 2026-08-13

### Added
- **OC ending mapping derived, not assumed** (#390). `server/src/oc/endingMap.ts`
  resolves `goodEndingN` to a diagram node id from two independent signals that
  must agree: the fewest checkpoint failures a path to that ending needs, and
  which roles' CPR drops actually raise it in a probe sweep.
  - ⚠️ **Position matching is wrong, not merely unproven.** For Break the Bank
    the derived mapping swaps positions 3 and 4 against declaration order, so
    `goodEnding3` and `goodEnding4` would have carried each other's payouts.
  - Returns `ok: false` with reasons rather than a partial map — a half-derived
    mapping's resolved endings look exactly as trustworthy as its guesses.
  - Refuses on: no baseline probe, a diagram/API disagreement about how many
    endings exist, no role evidence, or a tie between two candidate endings.
- **OC scenario flowchart parsing** (#390), the substrate for the OC Simulator.
  `server/src/oc/scenarioTree.ts` parses the mermaid diagram tornprobability.com
  serves per scenario, enumerates every path from the prelude to each ending, and
  counts the checkpoints a path passed or failed.
  - Pass/fail is read from the edge **label** the diagram states (`-- "Pass" -->`),
    not inferred from the child node's id suffix. The two agree today, but one is
    a statement and the other is a convention.
  - `allPassTerminal()` returns **null** rather than choosing when a scenario has
    no unique every-checkpoint-passed ending. An ambiguous anchor must read as
    "cannot map"; picking arbitrarily is how a plausible-but-wrong mapping ships.
  - `validateScenarioTree()` checks the invariants the source must satisfy —
    every checkpoint has both a Pass and a Fail edge, every branch reaches an
    ending, nothing is unreachable from the prelude. It is the mirror job's gate:
    a scenario that fails is refused rather than mapped, since a partial tree
    still produces confident numbers. Break the Bank passes clean at 18
    checkpoints, 10 endings, 137 nodes.
  - Tested against the real Break the Bank diagram as a fixture, not a
    hand-written sample.

## [3.26.0] - 2026-08-13

### Added
- **Fair Fight maths** (#422): `battleStatsScore` and `fairFight` in
  `utils/fairFight.js`, using the formula MonChoon confirmed —
  `BS = √str + √spd + √def + √dex`, `FF = min(3, 1 + 8/3 × def_BS/att_BS)`.
  Pinned to the stated cases: 5b vs 100m gives **1.38**, an even fight and
  punching up both cap at **3.00**. Any missing stat component yields `null`,
  never a guess — FF decides who gets attacked, and BS score is a sum of square
  roots, so it cannot be recovered from a stat total.
  `GET /api/members/me/battle-stats` returns the **caller's own** row to any
  authenticated member — the only extra read FF needs. The target side is the
  enemy roster the war room already shows everyone, so no other member's stats
  enter the calculation.
  - Only a total (BSP gives one number, not four)? An even split is assumed, per
    MonChoon. ⚠️ That **overstates lopsided builds by 30%+**, because an even
    split maximises the sum of roots for a given total — on the defender side it
    makes a target look more rewarding than it is. `scoreIsEstimated()` marks
    which scores were assumed.
  - `ffGradientPosition` runs red at 1.00 → green at 3.00, and `isMaxFF` backs
    the "3x FF" roster filter with a tolerance rather than exact equality.

  The enemy-roster column is wired: order is now
  `Name · Activity · Status · Timer · Flags · Stats · FF · Dibs · Action`, Name
  narrowed and truncating, FF sortable (nulls sink both ways per #351) with a
  red→green gradient, and a **3x FF** filter button showing only targets at the
  cap. An estimated FF carries a dotted underline, since a number built on a
  bare total should not look as solid as one built on a real spy.

### Changed
- War Notes: roll-call results collapse to a tally — `Roll Call 41 Yes · 22 No
  (33 missing)` — expanding to the full table on click, matching the Past Wars
  control below it. The table is a row per respondent and was pushing the
  archive off screen on a full faction.

## [3.25.0] - 2026-08-12

### Added
- **Observed occupancy reaches the payout, as diagnostics** (#389 part 2). Every
  payout now carries what the poller actually saw for the same window, alongside
  the inferred figures it does not yet replace:
  - `member.observedSeconds` — the union of that member's observed stints,
    clipped to the window, to compare against the inferred Time Spent.
  - `occupancyCoverage` — whether the poller watched the window, and where it did
    not. A window with no polls reads as **unwatched**, never as "nobody moved".
  - `occupancyDrift` — how far our first sighting sits from Torn's `joined_at`,
    which is the signal for whether the poller is keeping up. Judged on p95, not
    max, so one stint straddling a restart cannot condemn a healthy poller.
  - `GET /api/payouts/crime-data` returns `occupancy` and `occupancy_polls`.

  None of it is wired into the money. Switching the moment coverage looked
  complete would take that decision away from the operator, and after four passes
  where this calculation was confidently wrong, "the numbers changed and nobody
  chose that" is the outcome most worth designing against.

### Changed
- `mergeIntervalSeconds` moved to `utils/intervals.js` and is re-exported from
  `payoutCalculations` — occupancyTime needs it, and importing it back out of
  payoutCalculations would have been a circular import that resolves only by
  hoisting luck.

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

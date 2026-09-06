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

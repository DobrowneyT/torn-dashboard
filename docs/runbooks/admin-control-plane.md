# Runbook — the admin control plane (#609)

The fleet's operations container. It is **not** part of the tenant stack: it
sits behind `profiles: ["admin"]` in `deploy/docker-compose.yml`, so a plain
`docker compose up` does not start it and `update.sh` does not sweep it along.
A bad push here is fleet-wide, so deploying it is a deliberate act.

Two listeners from one process:

| surface | address | what lives there |
|---|---|---|
| public | `:8090` behind nginx (`admin.monchoon.me`) | the status page, read APIs, provisioning (slice 6) |
| local | `127.0.0.1:8091` on the **host**, over an SSH tunnel | destructive operations, and anything that makes the container reach outward |

⚠️ The local surface's boundary is the **host-side port publication**, not the
process's bind address. Docker forwards a published port to the container's
network interface, never to its loopback — binding `127.0.0.1` *inside* the
container makes the published port reach nothing at all (`curl` returns `000`,
not an HTTP status). The listener binds `0.0.0.0`; `127.0.0.1:8091:8091` in
compose is what keeps it off the internet.

---

## 1. Credentials

Generated, never hand-written. The container **refuses to start** if any of the
four is missing — an admin surface that comes up with no gate is worse than one
that does not come up.

```bash
cd /home/ubuntu/torn/torn-dashboard
npx tsx db/admin-password.mts
```

It prints four lines ready to paste into `deploy/.env`:

```
ADMIN_USERNAME=...
ADMIN_PASSWORD_HASH=scrypt.131072.8.1.<salt>.<hash>
ADMIN_TOTP_SECRET=...
ADMIN_SESSION_SECRET=...
```

and a TOTP URI to scan into an authenticator app.

⚠️ **A literal `$` in any `.env` value must be doubled (`$$`).** Compose
interpolates inside `.env` *values*, silently. This is what truncated
`ADMIN_PASSWORD_HASH` mid-string and crash-looped the container on its first
deploy — hence the dot-separated hash format, which contains no `$` at all.
SMTP passwords are the likely victim now.

⚠️ `ADMIN_SESSION_SECRET` must **not** equal `JWT_SECRET`. Sharing it would make
every tenant session token a valid fleet credential; the container cross-checks
this at boot and refuses to start.

## 2. Deploy

⚠️ **Always pass BOTH compose files.** Every `api-<slug>` service lives in
`docker-compose.override.yml`, and compose auto-loads an override only when no
`-f` is given at all — so a bare `-f deploy/docker-compose.yml` cannot see the
tenants. Two consequences, one annoying and one destructive:

- `docker compose -f deploy/docker-compose.yml restart api-tnl` fails with
  `no such service: api-tnl`
- ⚠️ that same invocation reports all five running tenant containers as
  **orphans**, so adding `--remove-orphans` to it would **delete every tenant
  API container on the box**

`deploy/update.sh` builds the invocation correctly; export the same thing before
running anything by hand:

```bash
cd /home/ubuntu/torn/torn-dashboard
export COMPOSE_FILES="-f deploy/docker-compose.yml -f deploy/docker-compose.override.yml --project-directory deploy"
```

```bash
cd /home/ubuntu/torn/torn-dashboard
./deploy/update.sh                       # tenants, from main — does its own fetch/reset
docker compose --profile admin $COMPOSE_FILES up -d --build admin
docker compose $COMPOSE_FILES logs --tail=40 admin
```

⚠️ Do **not** `git pull` before `update.sh`. It fetches and resets on its own,
and a manual pull leaves the branches divergent.

Expect on a healthy boot:

```
[admin] v3.74.0 public :8090 (read + provisioning), local 0.0.0.0:8091 (...)
[admin] monitor armed — discord configured, digest to you@example.com at 8:00 UTC
```

## 3. Logging in from the shell

⚠️ **Read this before writing your own `curl`.** Interactive bash performs
history expansion on `!` *inside double quotes*, which aborts the command
before `curl` runs — you get `-bash: !@: event not found`, an empty token, and
a bare `LOGIN FAILED` with nothing whatsoever wrong with the application. A
password containing `!`, `$`, `"` or a backtick will hit this. The sequence
below avoids it entirely: history expansion is off, the password never appears
on a command line, and the JSON body is built by `node` rather than by string
interpolation.

```bash
cd /home/ubuntu/torn/torn-dashboard
set +H                                   # stop bash expanding `!`
read -rsp 'Admin password: ' ADMINPW; echo
```

Then this block, which is re-runnable — the TOTP code refreshes each time:

```bash
CODE=$(docker exec tnl-dashboard-admin-1 npx tsx -e \
  "import('./src/adminPlane/totp.js').then(t=>console.log(t.totpCode('$(grep -oP '^ADMIN_TOTP_SECRET=\K.*' deploy/.env)', Math.floor(Date.now()/1000/30))))")

BODY=$(node -e 'console.log(JSON.stringify({username:process.argv[1],password:process.argv[2],code:process.argv[3]}))' \
  "$(grep -oP '^ADMIN_USERNAME=\K.*' deploy/.env)" "$ADMINPW" "$CODE")

TOKEN=$(curl -s -X POST http://127.0.0.1:8091/api/admin/login \
  -H 'content-type: application/json' --data-raw "$BODY" | grep -oP '"token":"\K[^"]+')

echo "code $CODE → ${TOKEN:+LOGIN OK}${TOKEN:-LOGIN FAILED}"
```

From a workstation, tunnel first — `ssh -L 8091:127.0.0.1:8091 ubuntu@<vps>` —
and the same commands work against `http://127.0.0.1:8091`.

## 4. Verifying a deploy

```bash
curl -s http://127.0.0.1:8091/api/admin/me      -H "authorization: Bearer $TOKEN"; echo
curl -s http://127.0.0.1:8091/api/admin/status  -H "authorization: Bearer $TOKEN" | head -c 600; echo
curl -s http://127.0.0.1:8091/api/admin/alerts  -H "authorization: Bearer $TOKEN"; echo
curl -s http://127.0.0.1:8091/api/admin/digest  -H "authorization: Bearer $TOKEN" | head -c 800; echo
```

The negative checks matter as much as the positive ones — they are the security
boundary, and they must fail:

```bash
# password with no TOTP code → 401
NOCODE=$(node -e 'console.log(JSON.stringify({username:process.argv[1],password:process.argv[2]}))' \
  "$(grep -oP '^ADMIN_USERNAME=\K.*' deploy/.env)" "$ADMINPW")
curl -s -o /dev/null -w '%{http_code} (want 401)\n' -X POST http://127.0.0.1:8091/api/admin/login \
  -H 'content-type: application/json' --data-raw "$NOCODE"

# a destructive/outbound route does not EXIST on the public surface → 404
docker compose $COMPOSE_FILES exec admin \
  node -e "fetch('http://127.0.0.1:8090/api/admin/local/ping').then(r=>console.log(r.status,'(want 404)'))"
```

## 5. Alerting (slice 4)

All optional. Unset means the status page is the only place alerts appear —
degraded, visible, and safe. Add to `deploy/.env`, then recreate the container.

```
ADMIN_DISCORD_WEBHOOK_URL=      # urgent only; point at an ADMIN-ONLY channel
ADMIN_SMTP_URL=                 # e.g. smtps://user:app-password@smtp.gmail.com:465
ADMIN_DIGEST_TO=
ADMIN_DIGEST_FROM=
ADMIN_DIGEST_HOUR_UTC=8
ADMIN_ALERT_INTERVAL_MS=60000
ADMIN_PUBLIC_URL=https://admin.monchoon.me
```

A **webhook, not a bot**: no token, no gateway connection, and it cannot read
anything, so the worst case for a leaked URL is someone posting in a private
channel. `torn-discord-bot` is untouched.

**What goes where.** Urgent → Discord: a tenant down or degraded, no dump newer
than 48h, no dump at all, an unreadable backup directory, disk over 90%, item
prices stale. Everything else → the daily digest: a single missed nightly dump,
disk over 80%, a faction with no backup on record.

**Proving SMTP works** without waiting until 08:00 UTC — on the local surface
only, because a POST that makes the container send mail on demand is an
amplifier in anyone else's hands:

```bash
curl -s -X POST http://127.0.0.1:8091/api/admin/local/digest/send \
  -H "authorization: Bearer $TOKEN"; echo
# → {"result":"sent","subject":"[fleet] all clear · 5/5 tenants up"}
```

`"result":"not_configured"` means `ADMIN_SMTP_URL` or `ADMIN_DIGEST_TO` is
missing. `"result":"failed: ..."` carries the SMTP error verbatim.

⚠️ **Expect roughly two minutes of silence before an incident is announced**,
and roughly two after it clears. That is the flap suppression doing its job: an
alert must be seen on two consecutive cycles before anything is sent, and be
absent for two before it is called resolved. If you kill a tenant to test this,
wait it out rather than concluding the webhook is broken.

⚠️ **The first digest is tomorrow's.** On a control plane that has never sent
one, the scheduler seeds its clock rather than firing immediately — otherwise a
container started at 23:00 would mail a digest covering nothing, seconds after a
deploy. Use the local `digest/send` route above to see one now.

## 6. Fleet feature-flag defaults (slice 5)

A fleet default applies to every faction that has not set the same flag for
itself. Reading is on the public surface; **writing is tunnel-only**, because a
flag reaches every tenant within a minute and the dangerous value is a valid one
— `* * * * * *` on a scraper cadence would have five factions calling Torn every
second on their own pooled keys, which is a fleet-wide rate-limit ban from one
typo with no undo that gives the keys back.

```bash
# What the fleet currently sets (public surface, read-only)
curl -s http://127.0.0.1:8091/api/admin/flags -H "authorization: Bearer $TOKEN"; echo

# Set one — tunnel-only
curl -s -X PUT http://127.0.0.1:8091/api/admin/local/flags/scraper.schedule.items-sync \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data-raw '{"value":"0 0 */12 * * *","description":"item catalogue, twice daily"}'; echo

# Unset it. ⚠️ DELETE, never a write of null — the row's EXISTENCE is the
# "set" signal, so a stored null would be a flag that is set and empty at once.
curl -s -X DELETE http://127.0.0.1:8091/api/admin/local/flags/scraper.schedule.items-sync \
  -H "authorization: Bearer $TOKEN"; echo
```

**Scraper cadence** is the first consumer. Its key is
`scraper.schedule.<job_name>`, and a job's schedule resolves through three
layers, most specific first:

1. the faction's own `scraper_jobs.cron_schedule` (Global Admin → Scrapers)
2. `fleet_flags['scraper.schedule.<job>']` — what you set above
3. the code default in `JOB_TABLE`

Global Admin shows the effective cadence and a badge saying which layer supplied
it. Clearing the field there and saving returns that faction to the default.

⚠️ **A faction that has its own value will not pick up a fleet default.** After
the upgrade to v3.75.0 most jobs follow the default automatically — a row whose
schedule exactly matched the built-in was adopted, since only the old seeding
could have written it — but anything an operator ever edited stays theirs until
they clear it. That is deliberate: silently retiming every faction's scrapers on
a deploy is a fleet-wide Torn rate-limit event.

⚠️ **Cadence changes arm on the tenant API's next restart.** The scheduler
creates its cron tasks at startup. A flag write is picked up within a minute by
anything that reads flags live, but the running cron tasks are not rebuilt.

⚠️ **An invalid expression is ignored, not fatal.** It falls back to the code
default and is reported on the Global Admin page and in the API logs. Check
there if a cadence you set does not appear to have taken.

## 7. Provisioning a faction (slice 6)

From `admin.monchoon.me` → **Provision a faction**: slug, display name, Torn
faction id, and optionally the leader's and operator's Torn user ids. No SSH.

⚠️ **The admin container does not provision anything.** It validates the form and
writes a row to `provision_requests`; a host-side agent outside every container
claims the row and runs one known command with those arguments. That is why no
container mounts the Docker socket: a fully compromised admin container can ask
for a faction to be created and nothing else.

### Installing the agent (once)

```bash
sudo cp deploy/systemd/tnl-provision-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tnl-provision-agent
systemctl status tnl-provision-agent --no-pager
```

It runs as `ubuntu`, must be in the `docker` group, and reads its Postgres
credential from `deploy/.env` (`DB_PASSWORD_GLOBAL_RW`, written by
`db/new-global.mjs`) or from `GLOBAL_DATABASE_URL_RW`.

Handle one request by hand, without the timer:

```bash
node deploy/host-agent.mjs --once
journalctl -u tnl-provision-agent -f      # or watch the service
```

### What it does, in order

1. **Re-validates** the row against the same rules as the API. ⚠️ Deliberately
   duplicated: "the API validated it" stops being true the day anything else
   writes to that table, and this is the process holding superuser and Docker.
2. `node db/new-faction.mjs --slug … --name … --faction-id …` — database, schema,
   seed, `faction_config`, first role grants, the scoped `app_<slug>` credential,
   the compose override and the nginx vhost.
3. `docker compose -f docker-compose.yml -f docker-compose.override.yml up -d --build api-<slug> nginx` —
   the only step that needs Docker, and the only reason the agent exists.

Output streams into the request row and is shown on the page. ⚠️ It is redacted
on the way in (`KEY=`/`SECRET=`/`PASSWORD=` lines and connection-string
passwords), because that log is served over the admin API.

### After it says done

The stack is running but the **host** nginx and TLS are not touched — this is
deliberate, the agent has no business editing a certificate. Point
`<slug>.monchoon.me` at the box and extend the cert yourself:

```bash
sudo vi /etc/nginx/sites-available/tnl-dashboard     # add <slug>.monchoon.me to server_name
sudo certbot --nginx --expand -d monchoon.me -d <slug>.monchoon.me   # plus the existing ones
sudo nginx -t && sudo systemctl reload nginx
```

See `deploy/LAUNCH.md` § 4.3.

### When it fails

The page shows **which step** failed and the captured log, and offers **Retry**.
⚠️ A failed run is not rolled back, and that is on purpose: if `new-faction.mjs`
succeeded and only the container failed to come up, the database, role and deploy
artifacts are correct — undoing them would throw away the expensive, correct work
and leave the retry nothing to adopt. `new-faction.mjs` is idempotent, so a retry
walks the same path.

⚠️ Only a **failed** request can be retried. Re-queueing a running one would hand
the same slug to a second agent run while the first is still inside
`new-faction.mjs`.

| the form says | what it means |
|---|---|
| "Slug must be 2–21 characters…" | the slug goes into `CREATE DATABASE faction_<slug>`; the cap is because Postgres truncates identifiers at 63 bytes **silently** |
| `"…_dev" is reserved` | staging databases are `faction_<slug>_dev`, and the fleet monitor excludes them — a faction slugged that way would be invisible to monitoring |
| a 409 conflict | the database, or a live/completed request, or that Torn faction id already exists |

## 8. The fleet item catalogue (slice 7)

`/v2/torn/items` is public, so one key serves every faction — one of exactly two
of twenty scraper jobs the #608 audit found movable. Set your own key:

```
ADMIN_TORN_API_KEY=
```

⚠️ **Unset is a supported state, not a failure.** With no key the control plane
publishes nothing, `items_synced_at` stays NULL, and every tenant syncs from its
own key pool exactly as before. The boot line says which:

```
[admin] item catalogue sync disabled — set ADMIN_TORN_API_KEY to publish prices for the fleet.
```

Force a refresh without waiting for the two-hour cycle (tunnel-only, because it
makes the container reach out to Torn on demand):

```bash
curl -s -X POST http://127.0.0.1:8091/api/admin/local/items/sync \
  -H "authorization: Bearer $TOKEN"; echo
# → {"rows":1834,"syncedAt":"2026-09-06T12:00:00.000Z"}
```

A `502` carries the reason verbatim — a bad key and a Torn outage read
differently, and the previous prices are left intact either way.

### ⚠️ What protects you from the single key

Centralising trades five-fold redundancy for one key, and **the failure is
silent**: prices quietly stop updating and every faction keeps valuing payouts
off a stale table. That is the decay that ran unnoticed for months in July
(#123/#124). Three things stand in the way, and they only work together:

1. **Tenants fall back to their own pools.** A tenant adopts the fleet copy only
   while `items_synced_at` is under 6 hours old. Past that it claims a pooled key
   and syncs itself, exactly as before. The control plane is a fast path, never
   a dependency.
2. **A refresh is due every 2 hours, well inside that 6-hour window.** Two
   consecutive failed refreshes cost nothing; the third is when tenants start
   feeding themselves again. ⚠️ If these two numbers were equal the copy would
   look stale at the end of every cycle and the feature would save nothing while
   appearing to work — a test asserts the relationship.
3. **A truncated response is refused.** Fewer than 100 items is a partial read,
   not a small catalogue. The sync fails, the previous timestamp stands, and
   tenants keep using their own pools.

The status page shows `items_synced_at`, and the alerting from slice 4 fires
`items-stale` once prices exist and go stale — ⚠️ never while the value is NULL,
because that means "not in service", not "infinitely old".

### If both sources die for a week

Item prices are then **withheld**, not used. The OC Simulator shows a banner
saying so and reports every item reward as unpriced rather than valuing it at a
week-old price — the same house rule as `item_value_unmatched` (#441) and
unpriced endings (#473): absent beats confidently wrong. Every other number on
the page is unaffected. The fix is to get either source working again; the next
successful sync clears it.

## 9. Keeping Docker disk under control

This box runs production, staging **and** the CI runner on one Docker daemon, so
every PR leaves build layers behind. Measured on 2026-09-06: 4.0 GB of build
cache and 4.7 GB of unreferenced images, against 22 GB free — a slow leak whose
first symptom is a deploy failing to build.

`deploy/docker-prune.sh` handles it. Install it as a nightly cron:

```bash
crontab -e
# 17 4 * * *  /home/ubuntu/torn/torn-dashboard/deploy/docker-prune.sh >> /home/ubuntu/torn/docker-prune.log 2>&1
```

Run it by hand any time — it prints `docker system df` before and after.

⚠️ **Never add `--volumes`, and never run `docker volume prune`.** Every
faction's database and the backup archive live in named volumes, and Docker
calls a volume "unused" whenever no container is currently attached — true of
any stack that is stopped, mid-deploy or mid-restore. One prune at the wrong
moment is every tenant's data, and the backups with it.

⚠️ **Never add `-a` to the image prune.** That removes every image not attached
to a *running* container, base images included. Nothing breaks, but the next
compose build re-pulls and re-builds from scratch — the CI job that takes four
minutes takes fifteen, on every PR, until the cache warms again. A permanent
runner's whole value is that cache.

## 10. When something looks wrong

| symptom | first thing to check |
|---|---|
| container `Restarting (1)` | `logs admin` — it refuses to start on a missing or plaintext credential, and says which |
| `curl` returns `000` | you are hitting a port nothing publishes; the local surface is `127.0.0.1:8091` on the **host** |
| `LOGIN FAILED` with a code that matches your phone | history expansion — see §3; `set +H` and rebuild the body with `node` |
| `Authentication required` on every call | `$TOKEN` is empty because the login above failed silently |
| no Discord message during an outage | fewer than two cycles have passed, or `ADMIN_DISCORD_WEBHOOK_URL` is unset — check the boot line in §2 |
| status page loads but the incidents card says unavailable | the incident store is in Postgres, so this is what a database outage looks like; the fleet table is fetched separately and still works |
| a fleet flag has no effect on one faction | that faction has its own override — Global Admin shows the source badge; clear it there |
| a fleet cadence flag has no effect anywhere | cron tasks are built at startup; restart the tenant APIs. If it still does nothing, the expression was rejected — check the API logs |
| a provisioning request sits at `pending` | the host agent is not running: `systemctl status tnl-provision-agent` |
| the agent logs "No global database credential" | `deploy/.env` has no `DB_PASSWORD_GLOBAL_RW` — run `node db/new-global.mjs --adopt` |
| the agent starts but `docker compose` fails with a permission error | the service user is not in the `docker` group |
| `no such service: api-<slug>` from a hand-run compose command | the override file was not passed — see § 2, and never add `--remove-orphans` to that invocation |
| a request is stuck at `running` | one run may take 15 minutes before it is killed and marked failed; after that, Retry |
| a deploy or CI run fails with "no space left on device" | `df -h /` then run `deploy/docker-prune.sh`; if the cron is not installed yet, see § 9 |
| the OC Simulator says "item prices unavailable" | both the fleet catalogue and that faction's key pool have failed to refresh for a week — check `items-sync` in that tenant's Global Admin, and the admin boot line for `ADMIN_TORN_API_KEY` |
| `items_synced_at` stays NULL | no `ADMIN_TORN_API_KEY`, so the fleet publishes nothing; tenants are syncing from their own pools, which is fine |
| items-sync runs report `source: pool` when you expected `fleet` | the fleet copy is over 6h old, or the tenant cannot reach `global` — both fall back on purpose |

## Related

- `docs/security-model.md` — the fleet's trust boundaries
- `deploy/LAUNCH.md` — first-time stack setup
- `db/new-global.mjs` — provisioning the shared `global` database
- Issue #609 (this build), #608 (the audit that scoped it)

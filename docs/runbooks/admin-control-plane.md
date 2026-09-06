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

```bash
cd /home/ubuntu/torn/torn-dashboard
./deploy/update.sh                       # tenants, from main — does its own fetch/reset
docker compose --profile admin -f deploy/docker-compose.yml up -d --build admin
docker compose -f deploy/docker-compose.yml logs --tail=40 admin
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
docker compose -f deploy/docker-compose.yml exec admin \
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

## 7. When something looks wrong

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

## Related

- `docs/security-model.md` — the fleet's trust boundaries
- `deploy/LAUNCH.md` — first-time stack setup
- `db/new-global.mjs` — provisioning the shared `global` database
- Issue #609 (this build), #608 (the audit that scoped it)

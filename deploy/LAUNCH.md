# Launching the stack on a Hetzner VPS (staging)

A step-by-step, validated-as-we-go runbook for standing up the multi-faction
self-hosted stack on a Hetzner VPS for testing. Built collaboratively: each step
is run, confirmed, then written down here with the real output. Target for this
first pass is a **staging** deployment (a shared VPS, a test domain) — not the
production cutover.

> **Status:** Phases 0–5 validated on `Duby` — the stack is **live on HTTPS**
> for all three tenants, with real Forge data restored (2026-07-15). Phase 6
> (operating: deploys + the dev loop) is tooled and documented; the stress test
> and monitoring/off-site backups are tracked as issues #116 / #117.

## Context

- **Host:** `Duby` — a Hetzner **CPX21** (3 vCPU / 4 GB / 80 GB, x86, us-east,
  `5.161.91.183`), Ubuntu 24.04.3 LTS, **shared with a friend** who runs their
  own services. Prime directive: **do not disrupt their workloads.** We don't
  touch their firewall, their updates, or reboot the box.
- **Domain (test):** `monchoon.me` (Namecheap, Advanced DNS). The apex `@`
  already points at **GitHub Pages** and must stay that way; we only *add*
  faction subdomains: `forge.` / `tnl.` / `mayhem.monchoon.me`.
- **What we deploy:** `deploy/docker-compose.yml` — shared Postgres + nginx, one
  `api-<slug>` process per faction (from `docker-compose.override.yml`), plus the
  optional `backup` sidecar. See `deploy/README.md` for the module model.

## Prerequisites (confirm before Phase 1)

- [ ] Friend has **agreed** we can install/run Docker containers, use disk/RAM,
      and add reverse-proxy routes + subdomains.
- [ ] You have **SSH access** to the VPS (and know whether you have `sudo`).
- [ ] `monchoon.me` is yours and you can **edit its DNS records** (Namecheap →
      Advanced DNS).
- [ ] A Torn API key or two to seed the pool for the staging faction.
- [ ] Faction ID + leader's Torn user ID for each tenant. Used here:
      forge `10739` (leader 2250591), tnl `6731` (leader 2605556),
      mayhem `525` (leader 14297). MonChoon (`2250591`) is admin on all three.

---

## Phase 0 — Reconnaissance (look before you touch)

Goal: learn the box's OS, resources, whether Docker is usable, and — critically —
**what already occupies the ports we care about**, so we design coexistence
before installing anything. None of these commands change the system.

SSH in, then run each block and paste the output back.

### 0.1 — OS, kernel, resources

```bash
uname -a
cat /etc/os-release | head -4
echo "--- cpu/mem/disk ---"
nproc
free -h
df -h /
```

### 0.2 — Your access level

```bash
id                       # groups — is 'docker' one of them?
sudo -n true 2>&1 && echo "sudo: passwordless" || echo "sudo: needs password / none"
```

### 0.3 — Is Docker present and usable?

```bash
docker version 2>&1 | head -8
docker compose version 2>&1 | head -2
docker ps 2>&1 | head            # do we get a permission error, or a container list?
```

### 0.4 — What already listens on the ports we want (coexistence check)

```bash
# Needs sudo to see process names; without it you still see the ports.
sudo ss -tlnp 2>/dev/null | grep -E ':(80|443|5432|8088|8080)\b' || ss -tln | grep -E ':(80|443|5432|8088|8080)\b'
echo "--- any reverse proxy on the box? ---"
command -v nginx caddy traefik 2>&1
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null
```

### 0.5 — Outbound to Torn (the API tickers need this)

```bash
curl -sS -o /dev/null -w 'api.torn.com -> %{http_code}\n' https://api.torn.com
```

### Findings (validated 2026-07-13)

| Check | Result |
|---|---|
| OS / kernel | Ubuntu 24.04.3 LTS, 6.8.0-124 x86_64 |
| CPU / RAM / disk | 3 vCPU · 3.7 Gi (647 Mi used, 3.1 Gi avail) · 75 G (12% used) |
| **Swap** | **none (0 B)** — must fix, see Phase 1 |
| Access | user `monchoon`, in `sudo` group, **password required** (no passwordless sudo) |
| **Docker** | **not installed** — must install, see Phase 1 |
| Outbound to Torn | `api.torn.com -> 301` ✅ (301 is Torn's redirect; HTTPS egress works) |
| **Port 80** | **taken** — host `nginx` (systemd, `/usr/sbin/nginx`), IPv4+IPv6 |
| **Port 443** | **free** — nothing serves HTTPS on this box today |
| Ports 5432 / 8080 / 8088 | free — no host Postgres to collide with |
| Also running | `mug-bot.service` (our own sibling project!), `pm2-root` (Node apps behind that nginx) |
| Pending OS updates | 47 updates + "restart required" — **coordinate with the friend; not ours to reboot** |

### Decision: the host nginx is the public front door

We do **not** contest port 80. The existing systemd nginx fronts everything; our
Docker stack listens only on loopback behind it.

```
Internet :80/:443
      │
   host nginx (systemd — already serving the friend's apps)
      │   + new server blocks: forge/tnl/mayhem.monchoon.me
      │   + TLS terminated here (certbot)
      ▼
 127.0.0.1:8088   ← our Docker nginx (HTTP_BIND=127.0.0.1, not internet-facing)
      │   routes by Host header (server_name <slug>.*)
      ▼
 api-forge / api-tnl / api-mayhem containers
```

Why: zero disruption to the friend's vhosts; certbot's HTTP-01 challenge needs
port 80, which host nginx already owns, so TLS needs no DNS-01 plumbing or
registrar API token; and binding our stack to loopback means it is unreachable
from the internet except through the front door. Port 443 being empty means we
*add* HTTPS rather than migrate it — small blast radius.

`deploy/docker-compose.yml` gained an `HTTP_BIND` var for exactly this
(`0.0.0.0` default for local dev, `127.0.0.1` on the VPS).

**Verdict: the box is sufficient.** The stack needs ~1.5–2 GB, landing us near
2–2.5 GB of 3.7 GB alongside the friend's ~650 MB. 3 vCPU comfortably covers 4
tickers (mostly IO-wait) + WebSocket fan-out.

**The one real risk is the missing swap.** The nginx image *builds the SPA*
(Vite/npm), which can transiently want 1–2 GB — on a 4 GB box beside someone
else's services that's a plausible OOM-kill. Phase 1 adds a 4 G swapfile.

---

## Phase 1 — Host provisioning (Docker + swap)

Codified in **`deploy/provision-host.sh`** — idempotent, safe to re-run. It
installs Docker Engine + the compose v2 plugin (official Docker repo, *not*
snap/`docker.io`), adds you to the `docker` group, and creates a 4 G swapfile
with `vm.swappiness=10`.

It deliberately does **not** touch the firewall, install a reverse proxy, apply
system updates, or reboot — this box is shared, so those stay human-coordinated.

```bash
# on Duby, from a checkout of the repo (see 1.2)
./deploy/provision-host.sh          # or: SWAP_GB=2 ./deploy/provision-host.sh
```

After it runs, **log out and back in** (group membership only applies to new
logins), then confirm:

```bash
docker run --rm hello-world      # no sudo → the group took effect
free -h                          # swap now shows 4.0Gi
```

### 1.2 — Get the code onto the box

```bash
sudo apt-get install -y git
git clone git@github.com:DobrowneyT/torn-forge-oc-system.git   # or https://
cd torn-forge-oc-system
git checkout docs/hetzner-launch   # carries HTTP_BIND + this runbook (merges to dev later)
```

## Phase 2 — DNS

### DNS (done first — propagation takes time)

Namecheap → `monchoon.me` → **Advanced DNS** → Host Records → ADD NEW RECORD.
**Leave the existing `@` A records (GitHub Pages) and `www` CNAME untouched.**

| Type | Host | Value | TTL |
|---|---|---|---|
| A Record | `forge` | `5.161.91.183` | 5 min |
| A Record | `tnl` | `5.161.91.183` | 5 min |
| A Record | `mayhem` | `5.161.91.183` | 5 min |

Low TTL while testing makes mistakes cheap. New hostnames have nothing cached,
so they resolve in minutes (the 48-hour figure applies to *nameserver* changes,
not new records). Optionally add `A * → 5.161.91.183` so future factions need no
DNS edit — explicit records still win, so `@`/`www` are unaffected.

Verify:

```bash
dig +short forge.monchoon.me tnl.monchoon.me mayhem.monchoon.me   # → 5.161.91.183 ×3
```

### 2.1 — Existing host nginx (validated 2026-07-13)

nginx 1.24.0, `sites-enabled/`:

- `default` — `listen 80 default_server`, `server_name _`, root `/var/www/html`
- `torn-armory` — `listen 80`, `server_name 5.161.91.183`, `proxy_pass http://localhost:3000`

**No conflict.** nginx matches `server_name` against the Host header first;
`default_server` only catches hostnames no block claims. Our
`forge/tnl/mayhem.monchoon.me` blocks win by name, and raw-IP requests keep
going to torn-armory. We add a file and touch neither of theirs.

## Phase 3 — Bring up the stack + provision the factions

Repo lives at `~/torn/torn-forge-oc-system` on Duby.

### 3.1 — Secrets and `.env`

Generate the three secrets, **store them in a password manager**, then hand-fill
`.env`. Nothing auto-generates them into a file you never read.

```bash
openssl rand -hex 24    # → POSTGRES_PASSWORD
openssl rand -hex 32    # → JWT_SECRET
openssl rand -hex 32    # → KEY_ENCRYPTION_KEY   (must be exactly 64 hex chars)
```

**Use hex, not a passphrase.** `POSTGRES_PASSWORD` is interpolated into a
`DATABASE_URL` (`postgres://user:pass@postgres:5432/db`) *and* through docker
compose variable substitution — `@ : / # ?` break the URL and `$` breaks compose.
Hex sidesteps all of it.

**Back up `KEY_ENCRYPTION_KEY` like it's irreplaceable, because it is.** It
encrypts every member's Torn API key at rest; lose it and the whole key pool is
undecryptable (every member has to re-enrol). Losing `JWT_SECRET` only forces a
re-login; losing `POSTGRES_PASSWORD` is resettable.

```bash
cd ~/torn/torn-forge-oc-system/deploy
cp .env.example .env
nano .env          # fill in the values below
chmod 600 .env
```

```env
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<YOUR_POSTGRES_PASSWORD>
JWT_SECRET=<YOUR_JWT_SECRET>
HTTP_PORT=8088
HTTP_BIND=127.0.0.1
POSTGRES_HOST_PORT=5432
KEY_ENCRYPTION_KEY=<YOUR_KEY_ENCRYPTION_KEY>
TORNSTATS_API_KEY=
BSP_API_KEY=
```

`HTTP_BIND=127.0.0.1` is load-bearing: the stack binds to loopback, reachable
only through the host nginx, never straight off the internet.

Verify before booting — a wrong-length key **silently disarms** the scrapers and
ticker rather than erroring (we've been bitten by this):

```bash
awk -F= '/^KEY_ENCRYPTION_KEY=/{print length($2)" chars (must be 64)"}' .env
awk -F= '/^HTTP_BIND=/{print "bind: "$2" (must be 127.0.0.1)"}' .env
```

`.env` is gitignored — never commit it. `db/new-faction.mjs` will later *append*
an auto-generated `DB_PASSWORD_<SLUG>` per faction, so back up the whole file.

### 3.2 — Boot the shared services

```bash
cd ~/torn/torn-forge-oc-system/deploy
docker compose up -d --build postgres nginx
docker compose ps
```

### 3.3 — Provision each faction (this IS the runbook from deploy/README.md)

`db/new-faction.mjs` runs on the **host** (it writes `deploy/.env`, the compose
override, and the nginx vhost), which is why Phase 1 installs Node.

```bash
cd ~/torn/torn-forge-oc-system
npm ci --omit=dev --workspace @tnl/db     # pg + dotenv for the CLI

node db/new-faction.mjs --slug forge  --name "TNL Forge"  --faction-id 10739 \
  --leader-id 2250591 --admin-id 2250591
node db/new-faction.mjs --slug tnl    --name "The Next Level" --faction-id 6731 \
  --leader-id 2605556 --admin-id 2250591
node db/new-faction.mjs --slug mayhem --name "<Mayhem's name>" --faction-id <ID> \
  --leader-id <leader Torn ID> --admin-id 2250591
```

Each run creates the DB from `db/template.sql`, seeds it, provisions the scoped
role `app_<slug>`, appends `DB_PASSWORD_<SLUG>` to `deploy/.env`, writes the
`api-<slug>` block into `docker-compose.override.yml`, and emits
`deploy/nginx/factions/<slug>.conf`. `--admin-id 2250591` keeps MonChoon a global
admin on every tenant.

### 3.4 — Bring up the faction APIs + rebuild nginx (bakes in the new vhosts)

```bash
cd ~/torn/torn-forge-oc-system/deploy
docker compose up -d --build api-forge api-tnl api-mayhem nginx
docker compose ps
```

### 3.5 — Prove it locally, BEFORE exposing it

```bash
curl -s -H 'Host: forge.monchoon.me'  http://127.0.0.1:8088/api/health
curl -s -H 'Host: tnl.monchoon.me'    http://127.0.0.1:8088/api/health
curl -s -H 'Host: mayhem.monchoon.me' http://127.0.0.1:8088/api/health
# each → {"status":"ok","faction":"<slug>"}
curl -s -H 'Host: forge.monchoon.me'  http://127.0.0.1:8088/api/health/ready
# → {"status":"ok",...,"db":"up","scheduler":"armed","ticker":"armed"}
curl -s -H 'Host: forge.monchoon.me'  http://127.0.0.1:8088/ | head -c 200   # the SPA
```

Only once these pass do we point the world at it (Phase 4).

**Validated 2026-07-13** — all three tenants built, booted `(healthy)`, and
answered:

```
{"status":"ok","faction":"forge"}
{"status":"ok","faction":"tnl"}
{"status":"ok","faction":"mayhem"}
{"status":"ok","faction":"forge","db":"up","scheduler":"armed","ticker":"armed"}
<!DOCTYPE html> …the SPA…
```

Note the ordering that made this work: **provision every faction before the
final `nginx` build.** The faction vhosts (`deploy/nginx/factions/<slug>.conf`)
are baked into the nginx image at build time, so a faction added *after* the
last nginx build won't route until nginx is rebuilt.

## Phase 4 — Expose it (host nginx front door + TLS)

The stack answers on `127.0.0.1:8088`. Now we let the world reach it.

### 4.0 — Is inbound 443 actually open?

Port 443 has never been used on this box, so it may be closed at the host
firewall **or** at the Hetzner Cloud Firewall (a separate layer, in the Hetzner
console → the server → *Firewalls*). certbot's HTTP-01 challenge only needs
port 80, so a cert will issue fine even if 443 is blocked — and then HTTPS just
won't load. Check both before blaming nginx:

```bash
sudo ufw status            # 'inactive' is fine; if active, 443/tcp must be allowed
```
Plus Hetzner console → Firewalls: if a firewall is attached, it needs an inbound
rule for **TCP 443** (and 80).

### 4.1 — The front-door vhost

One block for all three hostnames, proxying to the Docker nginx on loopback.
Two things are load-bearing:

1. **`proxy_set_header Host $host`** — the tenant is selected *downstream* by
   Host header (`server_name <slug>.*`). Drop it and every request lands on the
   default tenant.
2. **WebSocket upgrade headers** — the war room is a WebSocket app; without
   these the live ticker silently fails to connect.

The `map` variable is deliberately named `$tnl_connection_upgrade` rather than
the conventional `$connection_upgrade`: the friend's config may already define
that name, and a duplicate `map` is a fatal config error.

```nginx
# /etc/nginx/sites-available/tnl-dashboard
map $http_upgrade $tnl_connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name forge.monchoon.me tnl.monchoon.me mayhem.monchoon.me;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:8088;
        proxy_http_version 1.1;

        # The tenant is selected downstream by Host — it must survive the hop.
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # War room = WebSockets.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $tnl_connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/tnl-dashboard /etc/nginx/sites-enabled/
sudo nginx -t                     # MUST pass — this config also serves the friend's apps
sudo systemctl reload nginx       # reload, not restart: no dropped connections
```

Verify over plain HTTP from your laptop before adding TLS:

```bash
curl -s http://forge.monchoon.me/api/health;  echo   # {"status":"ok","faction":"forge"}
curl -s http://tnl.monchoon.me/api/health;    echo
curl -s http://mayhem.monchoon.me/api/health; echo
```

### 4.2 — TLS (certbot, HTTP-01)

Port 443 was empty, so we're *adding* HTTPS rather than migrating it — small
blast radius. certbot only edits the block whose `server_name` matches the `-d`
names, leaving the friend's vhosts alone.

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d forge.monchoon.me -d tnl.monchoon.me -d mayhem.monchoon.me
```

It will ask for an email, ToS agreement, and whether to redirect HTTP→HTTPS —
**choose redirect**. Then confirm renewal works:

```bash
sudo certbot renew --dry-run      # renewal is automatic via certbot.timer
curl -s https://forge.monchoon.me/api/health; echo
```

Browse **https://forge.monchoon.me** — log in with a Torn API key.

**Validated 2026-07-13 — the stack is LIVE.**

- `ufw` already allowed 22/80/443 (plus 3001 for mug-bot); no firewall change needed.
- `nginx -t` passed against the friend's existing config; reload was clean.
- Cert issued for all three names, deployed into `sites-enabled/tnl-dashboard`,
  expiring 2026-10-11; `certbot renew --dry-run` succeeded (auto-renew armed via
  `certbot.timer`).
- All three answer over HTTPS, and **the war room runs with no browser errors** —
  the WebSocket upgrade survives both proxy hops (host nginx → Docker nginx →
  API), which was the one thing most likely to break.

```
https://forge.monchoon.me/api/health  → {"status":"ok","faction":"forge"}
https://tnl.monchoon.me/api/health    → {"status":"ok","faction":"tnl"}
https://mayhem.monchoon.me/api/health → {"status":"ok","faction":"mayhem"}
```

## Phase 5 — Seed real Forge data

The other two tenants start empty and fill from live scraping + member logins.
**Forge** already has real history (359k attacks, 207 members, 158 ranked wars),
so we seed it by restoring a dump of the existing `faction_forge`.

### 5.1 — Dump the source (on the machine that holds the real Forge DB)

`--exclude-table-data=member_secrets` is essential: those rows are Torn keys
encrypted with that machine's `KEY_ENCRYPTION_KEY`, which is **different** on
Duby — they'd restore as undecryptable garbage. The table schema stays; members
re-enrol simply by logging in, and no key material ever leaves the source box.

```bash
docker exec tnl-dashboard-postgres-1 pg_dump -U postgres --no-owner --no-privileges \
  --exclude-table-data=public.member_secrets faction_forge \
  | gzip > deploy/backups/forge-seed-$(date -u +%Y%m%dT%H%M%SZ).sql.gz
```

### 5.2 — Copy it to Duby

```bash
# on Duby: make sure the (gitignored) dir exists
mkdir -p ~/torn/torn-forge-oc-system/deploy/backups
# from the source machine:
scp deploy/backups/forge-seed-<TS>.sql.gz \
    monchoon@5.161.91.183:~/torn/torn-forge-oc-system/deploy/backups/
```

### 5.3 — Restore into the live faction_forge

`--create` drops and recreates the DB, so **stop `api-forge` first** or the drop
blocks on its open connections. `--role app_forge` re-applies the scoped grants
(dumps carry none — #115) and the restore **fails loudly if the app role still
can't read**. The role's password in `deploy/.env` is left untouched.

```bash
cd ~/torn/torn-forge-oc-system/deploy
docker compose stop api-forge

docker compose run --rm -v "$(pwd)/backups:/seed" backup \
  node db/restore.mjs --create --db faction_forge --role app_forge \
    --archive /seed/forge-seed-<TS>.sql.gz
# expect: "…app_forge can read: true"

docker compose up -d api-forge
```

### 5.4 — Confirm

```bash
curl -s -H 'Host: forge.monchoon.me' http://127.0.0.1:8088/api/health/ready; echo
# → db:up, and the SPA now shows real members/attacks/wars once you log in
```

> **member_secrets / key pools:** all three tenants start with **empty pools**
> (forge's were excluded; tnl/mayhem never had any). A faction's war-room ticker
> can't fetch until at least one member logs in (which enrols their key), and
> each *warring* faction wants **2–3 keys** to stay under Torn's 100/min per-key
> limit. Line up a couple of members per faction before a real war.

**Validated 2026-07-15** — restored on Duby: 57 public tables,
`faction_config = forge/10739`, **`app_forge can read: true`** (the #115 grants
re-apply), readiness `db:up, scheduler:armed, ticker:armed`.

> **Gotcha that bit the first attempt:** the server checkout was still on a
> deleted feature branch, so `git pull` fetched but merged nothing ("no such
> ref") and the sidecar was built from the STALE tree — the restore then died
> on `Unknown option '--role'`. If you see that pull warning, `git checkout
> dev && git pull origin dev` first, and pass `--build` to `docker compose run`
> so the sidecar picks up the fresh tree.

## Phase 6 — Operating: deploying updates + the local dev loop

The steady-state workflow once the launch phases are done.

```
laptop: feature branch → local compose stack (real data via pull-live-db.sh)
   → PR → CI green → merge to the deploy branch (staging: dev; production: main)
      → Duby: update.sh (cron-run every 5 min with --if-changed)
         → pull, migrate every faction DB, rebuild, restart, verify readiness
```

### 6.1 — Deploying to the server: `deploy/update.sh`

One idempotent script does the whole server-side deploy:

1. `git fetch` + **fast-forward-only** pull of *the branch the checkout is on*
   (staging tracks `dev` today; at cutover you `git checkout main` once and it
   tracks `main` — no config to edit). Refuses to invent merge commits.
2. **Pre-deploy safety dump** of every faction DB through the backup sidecar
   (skippable with `SKIP_BACKUP=1`; failure warns, never blocks).
3. `node db/migrate.mjs` against **every** `faction_*` database (idempotent).
4. `docker compose up -d --build` — compose rebuilds images and recreates only
   the containers that actually changed (the SPA rides the nginx image).
5. **Readiness probe per tenant** (`Host: <slug>.localhost` matches the
   `<slug>.*` vhosts on any domain); non-zero exit if any tenant is down.

A `flock` guard means overlapping runs are impossible, and operator state
(`deploy/.env`, the compose override, `nginx/factions/*.conf`) is gitignored so
a pull can never clobber it.

```bash
cd ~/torn/torn-forge-oc-system && ./deploy/update.sh     # manual deploy
```

### 6.2 — Auto-deploy on merge

**Decision: a 5-minute poller on the server, not a GitHub-Actions SSH push.**
An Actions deploy needs an SSH private key to the box stored in GitHub secrets
— CI shell access to a *shared* server. Polling gives the same "merge and walk
away" outcome with zero inbound access and zero secrets held by CI; worst case
a merge takes 5 minutes to land. (Switching to Actions later is trivial if
ever wanted.)

```bash
crontab -e     # on Duby, add:
*/5 * * * * cd $HOME/torn/torn-forge-oc-system && ./deploy/update.sh --if-changed >> $HOME/torn/deploy.log 2>&1
```

`--if-changed` exits silently when origin hasn't moved, so the log only grows
on real deploys. Watch a deploy land with `tail -f ~/torn/deploy.log`.

### 6.3 — Local development with real data

Develop on feature branches against a local compose stack (one tenant is
plenty), then PR into the deploy branch:

```bash
# local stack, forge only:
cd deploy && docker compose up -d --build postgres api-forge nginx
# hack, test at http://forge.localhost:8088 (or localhost:8088), run suites…
```

To make the local DB mirror the live one:

```bash
./deploy/pull-live-db.sh forge               # dump on server → stream over ssh → restore locally
./deploy/pull-live-db.sh tnl --pull-only     # just fetch the archive, restore later
```

The dump streams over SSH (no server temp files), **always excludes
`member_secrets` data** — those are members' Torn keys encrypted with the
*server's* `KEY_ENCRYPTION_KEY`: undecryptable locally, and live key material
has no business on a dev machine — and the restore re-applies the scoped
grants (#115) so the local API boots against it immediately.

### 6.4 — Validation summary (folded in from the old Phase 6)

Everything the validation phase called for got proven during Phases 3–5:
health + readiness per tenant (3.5, 4.2, 5.4), the war room live in a browser
over both proxy hops (4.2), and a real backup → restore → bootable-DB drill
(Phase 5 — which also *caught* #115). Remaining proof points are tracked as
issues: load behaviour under #116, off-site backups + alerting under #117.

## Phase 7 — Stress test (4 tickers + ~400 WS clients) — **issue #116**

## Phase 8 — Monitoring (UptimeRobot) + off-site backups (B2) — **issue #117**

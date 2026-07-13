# Launching the stack on a Hetzner VPS (staging)

A step-by-step, validated-as-we-go runbook for standing up the multi-faction
self-hosted stack on a Hetzner VPS for testing. Built collaboratively: each step
is run, confirmed, then written down here with the real output. Target for this
first pass is a **staging** deployment (a shared VPS, a test domain) — not the
production cutover.

> **Status:** in progress. Phase 0 (recon) is the only validated section so far.
> Later phases are outlines until we run them.

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
- [ ] `monchoon.tech` is yours and you can **edit its DNS records** (or a
      delegated subdomain like `*.torn.monchoon.tech`).
- [ ] A Torn API key or two to seed the pool for the staging faction.

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
git clone https://github.com/DobrowneyT/torn-forge-oc-system.git
cd torn-forge-oc-system
git checkout dev                 # the migration lives on dev until cutover
```

## Phase 2 — Networking & TLS (reverse proxy, cert, DNS)  _[pending 0.4]_

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

### 2.1 — Recon the existing host nginx first (read-only)

We're adding server blocks to a config that already serves someone else's apps.
Look before writing:

```bash
nginx -v
ls -l /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null
sudo nginx -T 2>/dev/null | grep -E 'server_name|listen|root|proxy_pass|default_server'
```

What matters: whether any block is a `default_server` (it will catch our
hostnames until ours exist), and which ports/names are already claimed.

### 2.2 — Front-door vhost (after the stack is up in Phase 3)

One server block per faction, all proxying to the Docker nginx on loopback and
**preserving the Host header** (that's what selects the tenant downstream).
Written to `/etc/nginx/sites-available/tnl-dashboard` and symlinked into
`sites-enabled/`. WebSocket upgrade headers are required — the war room is a
WebSocket app.

```nginx
# /etc/nginx/sites-available/tnl-dashboard
server {
    listen 80;
    listen [::]:80;
    server_name forge.monchoon.me tnl.monchoon.me mayhem.monchoon.me;

    location / {
        proxy_pass http://127.0.0.1:8088;
        proxy_http_version 1.1;

        # The tenant is selected downstream by Host — it must survive the hop.
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # War room is a WebSocket app.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/tnl-dashboard /etc/nginx/sites-enabled/
sudo nginx -t          # MUST pass — this config also serves the friend's apps
sudo systemctl reload nginx
```

### 2.3 — TLS (certbot, HTTP-01)

Port 443 is currently empty, so we're *adding* HTTPS, not migrating it. certbot
edits only the vhosts named with `-d` and leaves the friend's blocks alone.

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d forge.monchoon.me -d tnl.monchoon.me -d mayhem.monchoon.me
```

Requires the DNS records to already resolve to this box. Renewal is automatic
(`certbot.timer`); confirm with `sudo certbot renew --dry-run`.

## Phase 3 — Bring up the stack + provision the staging faction  _[pending]_

## Phase 4 — Seed / restore data  _[pending]_

## Phase 5 — Validation (health, readiness, war room, backups)  _[pending]_

## Phase 6 — Stress test (4 tickers + ~400 WS clients)  _[pending]_

## Phase 7 — Monitoring (UptimeRobot) + off-site backups (B2)  _[pending]_

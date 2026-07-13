# Launching the stack on a Hetzner VPS (staging)

A step-by-step, validated-as-we-go runbook for standing up the multi-faction
self-hosted stack on a Hetzner VPS for testing. Built collaboratively: each step
is run, confirmed, then written down here with the real output. Target for this
first pass is a **staging** deployment (a shared VPS, a test domain) — not the
production cutover.

> **Status:** in progress. Phase 0 (recon) is the only validated section so far.
> Later phases are outlines until we run them.

## Context

- **Host:** a Hetzner VPS **shared with a friend** who already runs their own
  services on it. Prime directive: **do not disrupt their workloads.** We
  coexist (our own ports / behind their existing reverse proxy), we don't
  commandeer ports 80/443 or their Postgres.
- **Domain (test):** `monchoon.tech` (to be confirmed). One apex → unlimited
  subdomains; each faction is `<slug>.monchoon.tech`.
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

### What we're deciding from this

- **Ports 80/443:** if the friend runs a reverse proxy (nginx/Caddy/Traefik)
  there, we route our subdomains **through it** to our nginx on a high port
  (clean, shares their TLS). If 80/443 are free, we can take them ourselves.
- **Postgres:** ours runs in a container on an internal network and only needs
  a *host* port for admin/`new-faction.mjs`; if 5432 is taken we use another
  (`POSTGRES_HOST_PORT`).
- **Docker access:** decides whether we prefix commands with `sudo` and whether
  we need the friend to add you to the `docker` group.
- **Resources:** confirms headroom for our ~1.5–2 GB stack alongside theirs.

_(Paste the Phase 0 output and we'll record the decisions here, then move to
Phase 1.)_

---

## Phase 1 — Base setup (Docker, repo, .env)  _[pending Phase 0]_

## Phase 2 — Networking & TLS (reverse proxy, wildcard cert, DNS)  _[pending]_

## Phase 3 — Bring up the stack + provision the staging faction  _[pending]_

## Phase 4 — Seed / restore data  _[pending]_

## Phase 5 — Validation (health, readiness, war room, backups)  _[pending]_

## Phase 6 — Stress test (4 tickers + ~400 WS clients)  _[pending]_

## Phase 7 — Monitoring (UptimeRobot) + off-site backups (B2)  _[pending]_

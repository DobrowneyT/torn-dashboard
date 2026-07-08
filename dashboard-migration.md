# Dashboard Migration Plan — Multi-Faction "Franchise" Architecture

**Status:** Draft v1 — 2026-07-07
**Author:** Audit + interview conducted with Claude Code
**Scope:** Website code only (`src/`, `supabase/`, GitHub workflow CI). The Discord bot, mug-bot, and analysis scripts at the repo root are out of scope.

---

## 0. Executive summary

TNL-Forge's dashboard today is a single-tenant system: a React SPA on GitHub Pages, a Supabase project (Postgres + RLS + two Edge Functions + Realtime-capable infra), and GitHub Actions cron scrapers that commit scraped data back into the git repo. It works, but faction identity is hardcoded in at least **six independent places**, the usage profile (1.3M+ edge invocations/month) is dominated by an **unconditional 1-second cron tick**, and nothing about it can be duplicated for a second faction without hand-editing code, policies, secrets, and workflows.

The agreed target (locked in during the design interview):

| Decision | Choice |
|---|---|
| Tenancy | **Self-hosted Postgres, one database per faction** |
| Packaging | **Docker Compose everything** — portability by construction |
| Topology | Shared Postgres + shared nginx; **one API/ticker process per faction** |
| API layer | **Custom Node/TypeScript REST API** (replaces Supabase Edge Functions *and* PostgREST reads) |
| War room transport | **WebSockets** (server tick pushes deltas); tick runs **only during active wars** |
| Scrapers | **Full rewrite into the Node API** as scheduled in-process jobs (GitHub Actions retired) |
| Faction config | **DB-backed config + admin UI**; faction leaders self-serve their own roles/tiers/branding |
| Frontend | **One shared bundle** + `/api/bootstrap` runtime config (per-faction name, favicon, imagery in fixed slots) |
| Domains | One apex domain + subdomain per faction (vanity domains possible later as extra vhosts) |
| Hosting | Provider-agnostic (that's the point of Docker); **Oracle Cloud free tier as first experiment**, Hetzner ~€5/mo as the boring fallback |
| Source control & CI | **GitHub stays** as the repo of record; Actions keeps running **test/lint/build CI on every PR**. Only the *data-scraping* and *Pages-deploy* workflows retire. Deployment workflows return later, once hosting/topology is settled (see §3.4) |
| Release safety | A permanent **staging faction** (a Forge duplicate with scrubbed-or-real data) receives every release first; only verified releases roll to the four production factions (see §6.1) |
| Budget | **≤ $20 CAD/month all-in** — achievable (see §4.1) |
| Sequencing | Phased milestones, locally runnable at every phase; verify Forge end-to-end → add faction #2 in staging → big-bang go-live; Supabase stays live until final cutover |
| Requirement | Must sustain **≥3 simultaneous war rooms** at 1–2 Hz |

The visitor (read-only demo) role was built first on the current Supabase stack (shipped separately from this plan) and must be carried over as a first-class role in the new API.

---

## 1. Current-state architecture (as audited)

```
                      ┌────────────────────────────────────────────┐
                      │              GitHub (repo)                  │
                      │  • source code                              │
                      │  • data/ folder  ←── scrapers COMMIT data  │
                      │  • gh-pages branch (built site)             │
                      └──────┬───────────────────────┬─────────────┘
                             │ deploy-pages.yml      │ daily-scrapers.yml (01:00 UTC)
                             ▼                       │ scrape-cpr / crimes / wars /
                      GitHub Pages                   │ faction-attacks (Python)
                  (static SPA, HashRouter,           │   env: VITE_SUPABASE_URL,
                   base=/torn-forge-oc-system/)      │   SERVICE_ROLE key, APP_KEY_SECRET,
                             │                       │   VITE_FACTION_ID (default 10739)
                             │                       ▼
        Torn key login       │            ┌──────────────────────────┐
        (user's own Limited  │            │   Supabase (us-east-2)   │
         key, localStorage)  │            │  Postgres 17 + RLS       │
                             ▼            │  36 public tables        │
                      ┌──────────────┐    │  pg_cron + pg_net +      │
                      │  Browser SPA │───▶│  Vault (live-DB only,    │
                      └──────┬───────┘    │  NOT in repo migrations) │
                             │            └──────┬───────────────────┘
              reads: supabase-js → PostgREST     │ 1s tick: private.war_room_cron_tick()
              (RLS via 4h JWT minted by          │ 3min: cron_war_lifecycle
               war-room-fetch)                   ▼
              writes: fetch → Edge Functions ┌───────────────────────┐
                                             │ Edge Functions (Deno) │
                                             │ • admin-db (1.8k LOC) │
                                             │ • war-room-fetch      │
                                             │   (1.6k LOC)          │
                                             └───────────────────────┘
```

### 1.1 The three data paths

1. **Reads** — `supabase-js` → PostgREST, ~40 `.from(...)` call-sites across ~15 view/util files. Every SELECT policy requires an `authenticated` JWT whose `faction_id` claim matches (or is non-null). The JWT is minted by `war-room-fetch` (`mint_session_token`, 4 h TTL, HS256 with the project JWT secret) after verifying the user's Torn key. Managed by `src/utils/sessionToken.js`.
2. **Writes** — everything goes through the `admin-db` Edge Function (service-role client, RLS bypassed) with the user's Torn key in `x-torn-api-key`. Server-side auth = `verifyTornUser()` (faction membership or ID-list bypass) + per-action ID-list checks. Generic CRUD actions (`upsert/insert/update/delete/clear_table`) are leadership-gated.
3. **War room** — pg_cron fires `private.war_room_cron_tick()` **every second**, which `pg_net`-POSTs `cron_poll_war_room` to `war-room-fetch`; that fetches Torn (rotating consented key pool from `member_secrets`), diffs, and writes state tables. Clients poll four delta channels at 1 Hz via `useWarRoomPoll`. A 3-minute `cron_war_lifecycle` job auto-creates/enables/disables war sessions.

### 1.2 Usage decomposition (last billing period: 1,309,655 invocations, 32.9 GB egress)

- **The 1 s tick fires unconditionally, 24/7** — the enabled/war-active check happens *inside* the edge function, after the invocation is already billed. Steady state that is ~2.59 M invocations/month by itself; the observed 1.31 M is consistent with the tick being active for roughly half the period plus client polling during wars.
- Client war-room polling: 1 Hz per open client while enabled (batched delta poll), plus BSP/chain fetches.
- Side finding: the project database is **3.2 GB, of which ~2.75 GB is `net._http_response`** (pg_net's response log of every 1 s tick) and 293 MB is `cron.job_run_details`. Real application data is ~150 MB, dominated by `faction_attacks` (104 MB / 413 K rows). See Phase 0 quick wins.
- Egress (33 GB) is mostly war-room poll responses + heavy reads (War Overview pulls large attack datasets; its JS chunk alone is 4.9 MB pre-gzip — worth code-splitting regardless of migration).

**Implication for 4 factions:** on Supabase this quadruples into paid territory forever; on a self-hosted box the same workload is trivial — 4 ticks/second of a few Torn API calls + small DB writes, and per-message/per-invocation billing disappears entirely. This is what makes self-hosting the budget-correct answer, not just a preference.

### 1.3 Coupling inventory — everything that hardcodes "Forge"

| # | Location | What's hardcoded | Migration treatment |
|---|---|---|---|
| 1 | `src/config.js` | faction id/name/tag; **role ID lists** (admins, leadership, warlead, ocmanager, visitor); tier requirements; CPR requirements; payout tickets; crime item ids; OC scenario tables | → per-faction DB config (`faction_config`, `role_assignments`, `tier_requirements`, …) served by `/api/bootstrap`; OC scenario data is game-global → shared seed data |
| 2 | `supabase/functions/admin-db/index.ts` | `LEADERSHIP_IDS`, `FACTION_ID = '10739'` | → API reads roles from the faction DB; faction resolved from vhost |
| 3 | `supabase/functions/war-room-fetch/index.ts` | `LEADERSHIP_IDS`, `WARLEAD_IDS`, `ADMIN_IDS`, `VISITOR_IDS`, `OUR_FACTION_ID` | same as #2 |
| 4 | Live-DB RLS policies | literal `'10739'` inside ~20 SELECT policy expressions | RLS retired as the auth boundary — the API layer + per-faction DB *is* the boundary |
| 5 | JWT claims | `faction_id: '10739'` baked into every minted token | API signs its own JWTs; faction implied by which DB the API instance talks to |
| 6 | Python scrapers | `VITE_FACTION_ID` env (good!) but defaults to `10739`; CPR scraper also pushes to a hardcoded Google Sheet/Gist | scrapers rewritten in TS; per-faction config from DB; Sheets/Gist exports become optional per-faction settings or are dropped |
| 7 | `.github/workflows/*` | secrets, schedules, and the **repo-as-data-store** pattern (scrapers commit JSON to `data/`) | scraper + Pages workflows retired; state lives in Postgres; scheduling in-process (node-cron). `tests.yml` **stays** and grows — GitHub remains the repo + PR-CI home (§3.4) |
| 8 | `vite.config.js` | `base: '/torn-forge-oc-system/'` (GitHub Pages path) | `base: '/'` behind nginx; HashRouter already host-agnostic |
| 9 | Build-time env | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` baked into the bundle | one bundle, zero baked env; everything from `/api/bootstrap` |
| 10 | Live DB, not in repo | `member_secrets` + key-pool RPCs, pg_cron jobs, Vault secrets, `private.war_room_cron_tick()` | **schema-drift risk**: the DB template must be generated from a `pg_dump --schema-only` of the live DB, not from `supabase/migrations/` (which is incomplete by design) |
| 11 | Key pool semantics | one consented pool per faction (`member_secrets`) | preserved naturally: one pool table per faction DB |

### 1.4 Security posture notes that affect the migration

- Pending from before: leaked legacy `service_role` + Torn keys are fixed in code but still need rotation; the migration removes the service-role concept entirely (the API holds one Postgres credential per faction DB, never shipped to clients).
- The war-room dibs/chain-claim actions intentionally skip user verification (documented trust trade-off). In the new API these ride the authenticated WebSocket, closing that hole for free.
- The visitor role (read-only demo) must be re-implemented as API middleware: full read surface, dibs allowed, all other mutations rejected server-side.

---

## 2. Target architecture

```
                    yourdomain.com DNS
      forge.tnl.dev   mayhem.tnl.dev   …one A record per faction (same IP)
            │               │
            ▼               ▼
┌─────────────────────────────────────────────────────────────────┐
│ VPS (Docker Compose)                                            │
│                                                                 │
│  ┌───────────┐   static bundle (one build, all vhosts)          │
│  │   nginx   │──► /usr/share/nginx/html  (+ Let's Encrypt       │
│  │ (vhosts + │        wildcard cert, HTTP→HTTPS, WS upgrade)    │
│  │ TLS + WS) │                                                  │
│  └─────┬─────┘  Host header routes /api + /ws to the right API  │
│        │                                                        │
│  ┌─────▼──────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐  │
│  │ api-forge  │  │ api-mayhem │  │ api-fac3   │  │ api-fac4  │  │
│  │ Node/TS    │  │            │  │            │  │           │  │
│  │ • REST     │  │  same      │  │  same      │  │  same     │  │
│  │ • WS hub   │  │  image,    │  │  image,    │  │  image,   │  │
│  │ • ticker   │  │  different │  │  different │  │  different│  │
│  │ • scrapers │  │  env       │  │  env       │  │  env      │  │
│  │ • scheduler│  │            │  │            │  │           │  │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬─────┘  │
│        │               │               │               │        │
│  ┌─────▼───────────────▼───────────────▼───────────────▼─────┐  │
│  │ Postgres 17 (one container)                               │  │
│  │   db: forge   db: mayhem   db: fac3   db: fac4            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────┐  nightly pg_dump per DB → compressed →           │
│  │ backups  │  object storage (Backblaze B2) + 14-day retention │
│  └──────────┘                                                   │
└─────────────────────────────────────────────────────────────────┘
```

**Why this shape (recap of interview trade-offs):**
- *One API process per faction* = the isolation you wanted (a crash/hot loop in one faction's ticker can't stall another's war room) without 4× nginx/Postgres. Same Docker image, four `env`-differing services in one compose file.
- *DB-per-faction* keeps every single-tenant assumption in queries and schema. No `faction_id` re-keying, no cross-tenant leak class. `CREATE DATABASE mayhem TEMPLATE faction_template` + seed = new tenant.
- *Compose everywhere* is the portability requirement made real: local dev, staging, Oracle, Hetzner — identical stack, moved with `git pull` + DB restore + DNS.

### 2.1 The API service (per faction)

Single TypeScript service (suggested: **Fastify** + `ws` + `node-postgres` + `node-cron`; all boring, well-maintained choices) with four internal modules:

1. **REST API** (`/api/...`)
   - `POST /api/auth/login` — body: Torn key. Verifies via `key/info` (same logic as today's `verifyTornUser`, including the 10-min/24-h cache), resolves roles from the DB, returns an API-signed JWT (4 h, same claim shape: `torn_user_id`, `is_leadership`, `is_admin`, `is_warlead`, `is_ocmanager`, `is_visitor`). Visitor keys are **never** stored.
   - `GET /api/bootstrap` — faction name, tag, branding asset URLs, current user's roles, feature flags. Replaces every baked `VITE_` var.
   - Read endpoints replacing the ~40 supabase-js call-sites (see §3.1 for the porting strategy).
   - Write endpoints replacing `admin-db`'s ~20 actions, with per-role middleware (`requireLeadership`, `requireNotVisitor`, …).
2. **WebSocket hub** (`/ws`) — authenticated by the same JWT. Rooms: `war-room` (state/dibs/chain deltas pushed by the ticker), later extensible. Dibs claims/releases arrive as WS messages, serialized through the same DB unique constraints as today.
3. **Ticker** — `setInterval`-driven loop, **started only when** `war_room_config.enabled = true` *and* a managed war is in its active window (the lifecycle job flips it, as today, but in-process). Each tick: rotate key pool → fetch enemy members / our members / chain on their cadences → diff → write → broadcast deltas to the WS room. 1 Hz × 4 factions is negligible load; the key pools are per-faction so Torn rate limits don't interact.
4. **Scheduler** — node-cron table driving the rewritten scrapers (§3.2) + lifecycle checks + nightly maintenance (vacuum stats, prune soft-deleted war-room rows).

### 2.2 Per-faction database

- **Template** generated once from the live Supabase DB (`pg_dump --schema-only`, then stripped of Supabase-specific schemas: `auth`, `storage`, `vault`, `net`, `cron`, `graphql`, RLS policies, and `SECURITY DEFINER` helpers that exist only to read JWT claims).
- New tables: `faction_config` (name, tag, torn faction id, branding, feature flags), `role_assignments` (torn_user_id, role, added_by, added_at), `tier_requirements_config`, `cpr_requirements_config` — i.e. everything in today's `src/config.js` that is faction policy rather than game data.
- Game-global reference data (items, OC scenario catalog) ships as seed SQL in the template.
- RLS is dropped. The API is the sole DB client; each API instance gets one Postgres role scoped to its own database (`GRANT CONNECT` only on its DB) — so even a compromised faction-3 API credential cannot read faction 1's data.

### 2.3 Frontend

- One Vite build, `base: '/'`, served identically on every vhost.
- On boot: `GET /api/bootstrap` → faction name in header/title, favicon swapped via `<link rel=icon>` injection, hero/branding images from `/branding/*` (per-faction static dir mounted into nginx) — fixed sizes/positions so each faction just supplies assets.
- Data layer: replace `src/utils/supabase.js` + `adminApi.js` + `warRoomApiV2.js` with a single `src/api/client.js` (fetch wrapper with JWT header + error normalization) and `src/api/ws.js` (reconnecting WebSocket with poll fallback). Views keep their shapes — the porting is mechanical per view (§3.1).
- Login UX unchanged (Torn key paste, same disclosure — minus the "joins the pool" language for visitors).

### 2.4 Admin UI (new, Phase 5)

Faction-leader self-serve settings page:
- Role management (add/remove Torn IDs per role — replaces editing `config.js` + redeploying).
- Tier/CPR requirement editing.
- Branding (name shown, favicon upload, hero image upload).
- War-room defaults (poll cadences, revive services).
Global-admin (you) additionally gets: cross-faction switcher, scraper run status/history, manual scraper triggers, key-pool health.

---

## 3. Gap analysis — what actually has to change

### 3.1 Frontend read path (~40 call-sites, ~15 files)

Strategy: **one REST endpoint per view's data need**, not a generic query API (that would re-invent PostgREST badly). E.g. `GET /api/crimes?status=…&range=…`, `GET /api/members/overview`, `GET /api/wars/:id/contributions`. Port one view at a time; each view is independently verifiable against the local compose stack. The heavy hitters:

| View | Today | New endpoint(s) |
|---|---|---|
| Dashboard/Members/CrimesView | `.from('crimes'/'members'/'crime_slots')` | `/api/crimes`, `/api/members` |
| MemberOverview | 5+ tables + saved views/thresholds | `/api/members/overview`, `/api/overview-views` CRUD |
| Payout flows (OC + RW) | payout tables + `admin-db` saves | `/api/oc-payouts`, `/api/war-payouts` (GET+POST) |
| War History/Overview | `ranked_wars`, `war_member_contributions`, `faction_attacks` (large!) | `/api/wars`, `/api/wars/:id/report`, paginated attacks |
| War Room v2 | 4-channel delta poll + actions | WS push + `/ws` messages; REST fallback endpoints |
| Tier/Inventory/DataMgmt | mixed reads + `admin-db` writes | corresponding CRUD endpoints |

### 3.2 Scrapers (full TS rewrite — your call, sized honestly)

Shared core first (this is also what the ticker needs, so it pays for itself): Torn API client with rate limiting (~100 req/min budget, mirrors `scripts/utils/torn_api.py`), key-pool claim/rotate (ports the `member_secrets` RPC logic), upsert helpers, structured run-logging to a `scraper_runs` table (feeds the admin UI).

Then per scraper, in dependency order: items → crimes/CPR → members/member-stats → wars/attacks → revives. The Python originals stay in the repo as executable reference specs until each port is verified against a copy of real data. Google Sheets/Gist side-exports: decide per scraper — recommend dropping unless actively used, else make them per-faction opt-in config.

### 3.3 What gets retired

- GitHub Pages deploy + `gh-pages` dependency; `deploy-pages.yml`.
- All *scraper* workflows + the `data/` commit-back pattern (repo returns to being just code).
- Both Edge Functions; pg_cron/pg_net/Vault usage; PostgREST/RLS as the security model; the Supabase project itself (after cutover).
- `sessionToken.js` complexity shrinks (mint = login; refresh = re-login or silent refresh endpoint).

### 3.4 What stays on GitHub — and what comes back later

GitHub's role changes from "hosting + scheduler + data store" to what it's actually good at:

**Stays throughout (from day one):**
- The repo remains the single source of truth for all code (frontend, server, DB template, compose files, runbooks).
- `tests.yml` survives and grows: every PR runs vitest (frontend) + the new server test suites (unit + the endpoint-authorization matrix from §7) + a compose build check. Nothing merges to `main` red.
- Normal PR-based development flow; the phased migration happens on ordinary feature branches.

**Deferred until hosting/topology is settled (post-Phase 6):**
- Deployment workflows. During the migration, deploys are deliberately manual (`git pull && docker compose up -d --build` on the server) — cheap, transparent, and they don't bake a half-decided topology into CI. Once the provider and layout are stable, add a `deploy.yml` that ships to **staging first** (§6.1), e.g. via SSH action or a small webhook listener on the server, and promotes to production factions on manual approval (GitHub *environments* with required reviewers map to this exactly).

**Never returns:**
- Actions as a cron scheduler or the repo as a data store.

---

## 4. Hosting evaluation

**Derived requirements:** always-on Node ×4 + Postgres + nginx (fits in ~1.5–2 GB RAM total; 2 vCPU comfortable); WebSocket support (any VPS; not GH Pages/most shared hosts); outbound HTTPS to Torn (London-hosted — EU placement gives the ticker 10–20 ms RTTs, nice but not required at 1 Hz); Docker; ~10 GB disk (app data is ~150 MB real; headroom for attacks growth ×4 + backups staging).

| Option | $/mo (CAD) | Fit | Notes |
|---|---|---|---|
| **Oracle Cloud Always Free** (A1 ARM, up to 4 vCPU/24 GB) | **$0** | ✅ Docker, huge headroom | The experiment you want to run. Caveats: capacity lotteries for A1 shapes, idle-reclaim policy on Always Free (mitigate: real workload ≈ never idle; take backups seriously), ARM images (multi-arch builds — trivial with modern Docker). **Verdict: great first host *because* the stack is portable; do not treat as unkillable.** |
| **Hetzner CX22/CPX11** (2 vCPU/4 GB, EU) | ~$7.50 | ✅ | The boring fallback. Best latency to Torn. Add Hetzner backups (+20%) or rely on B2 dumps. |
| DigitalOcean/Vultr (2 GB) | ~$16–18 | ✅ | Same model, NA-friendly billing, ~2× Hetzner price. |
| Opalstack | ~$14 | ⚠️ | No Docker, no root — **incompatible with the chosen packaging**. Would force the bare-metal deployment path (per-host setup scripts, shared-host RAM quotas around the 4 API processes + ticker). Only reconsider if you abandon Compose. |
| Keep Supabase (for contrast) | ~$34+ (Pro) + per-project compute | ❌ | Over budget for one org before adding factions. |

**Recommendation:** build against Compose locally (Phase 1 onward needs no server at all), trial Oracle free in Phase 4–5, keep Hetzner as the 30-minute escape hatch. The migration plan is identical either way — that's the point.

### 4.1 Cost model vs. the $20 CAD ceiling

| Item | CAD/mo |
|---|---|
| Server — Oracle free *(or Hetzner)* | $0 *(or ~$7.50)* |
| Domain (one apex, subdomains free) | ~$1.25 ($15/yr) |
| Backblaze B2 backups (~10 GB + egress) | ~$0.10–1 |
| TLS (Let's Encrypt wildcard via DNS-01) | $0 |
| Uptime monitoring (UptimeRobot free tier) | $0 |
| **Total** | **~$1.50** *(Oracle)* / **~$9** *(Hetzner)* |

Comfortably under budget on either host, with room for a vanity domain or two if a faction wants one later.

---

## 5. Phased roadmap

Every phase leaves a working system: the current Supabase stack stays live and untouched until Phase 7. Every phase is runnable locally via `docker compose up` (Postgres included) — no VPS needed until Phase 6. Estimates assume focused hobby-time weeks; treat as relative sizes.

### Phase 0 — Quick wins on the current stack *(hours, do immediately)*
- [ ] Gate the 1 s tick in SQL: `private.war_room_cron_tick()` early-returns unless `war_room_config_v2.enabled` (and optionally a war window) — kills ~2.6 M invocations/mo of idle billing on Supabase **today**.
- [ ] Prune `net._http_response` (2.75 GB) + `cron.job_run_details` (293 MB); confirm pg_net's TTL job is running so it never regrows.
- [ ] Finish the pending key rotation + admin-db redeploy (pre-existing security item).
- [ ] Commit + deploy the visitor feature (built separately; see repo diff).

### Phase 1 — Repo restructure + Compose skeleton *(1–2 weeks)*
- Monorepo layout: `frontend/` (moved SPA), `server/` (new TS service), `db/` (template SQL + seeds + faction-init script), `deploy/` (compose files, nginx templates, runbooks).
- Update `tests.yml` for the new layout (frontend vitest + a `server/` test job + compose build check) — CI stays green on every PR through the whole migration.
- `docker-compose.yml`: postgres + nginx + one API stub + built frontend; `docker-compose.dev.yml` for hot-reload local dev.
- Generate the DB template from the live Supabase DB (`pg_dump --schema-only` + strip pass) — resolves the schema-drift risk (§1.3 #10). Write `scripts/new-faction.sh` (create DB from template, seed config row, emit nginx vhost + compose service block).
- **Acceptance:** `docker compose up` serves the existing SPA locally against an empty faction DB; `new-faction.sh demo` creates a second working DB.

### Phase 2 — API core: auth + reads + writes *(3–5 weeks, the long pole)*
- Auth module (login, JWT, role middleware, visitor semantics, Torn-verify cache).
- `/api/bootstrap` + frontend api-client; port read call-sites view-by-view (checklist of ~15 views; each independently testable against a restored copy of Forge production data).
- Port `admin-db`'s actions to typed endpoints; delete the generic arbitrary-table CRUD in favor of purpose-built endpoints (closes a standing security wart).
- **Acceptance:** with a restored Forge snapshot, every page renders and every leadership flow (payout saves, tier mgmt, overview views) works locally with Supabase fully out of the loop. Visitor role behaves identically.

### Phase 3 — Scrapers in TS *(2–4 weeks)*
- Shared Torn client + key pool + run-logging; port scrapers in dependency order; scheduler wiring; `scraper_runs` admin visibility.
- **Acceptance:** a full simulated nightly run on the local stack produces row-level parity (spot-checked diffs) with the Python scrapers on the same input window.

### Phase 4 — War room over WebSockets *(2–3 weeks)*
- Ticker (war-gated) + WS hub + dibs/chain/roll-call/notes messages; `useWarRoomPoll` → `useWarRoomSocket` (keep the delta-merging logic, swap the transport; retain a REST poll fallback for flaky connections).
- **Acceptance:** two browsers + a simulated war on local compose show sub-second dib propagation; kill/restart the API mid-war and clients reconnect cleanly. Load-check: 4 tickers + 30 fake clients (trivial, but prove it).

### Phase 5 — Config admin UI + branding + multi-faction polish *(1–2 weeks)*
- Settings pages (roles, tiers, branding upload), global-admin views, `/api/bootstrap` branding, favicon/name/imagery slots.
- **Acceptance:** create faction #2 locally via runbook alone (no code edits); its leader (you, role-playing) renames it, uploads branding, sets roles — all self-serve.

### Phase 6 — Staging on the real server *(1–2 weeks calendar, mostly soak time)*
- Provision Oracle (or Hetzner), DNS + wildcard cert, deploy compose, restore a fresh Forge snapshot as the **staging faction** (this tenant is permanent — it becomes the pre-release environment described in §6.1), run scrapers on schedule for ≥1 week in parallel with production; compare outputs nightly.
- Add faction #2 with real config; verify multi-faction isolation (their leaders can preview here — the visitor feature's successor).
- **Acceptance:** a full ranked war handled on staging (war room live for observers) with zero manual intervention; backup/restore drill executed once (restore a dump to a scratch DB and boot the stack against it).

### Phase 7 — Cutover *(a weekend)*
- Freeze writes on Supabase (announce, disable scrapers/cron) → final `pg_dump` → restore → flip DNS → smoke-test every flow → decommission GitHub Pages/Actions; pause, then delete the Supabase project after a 30-day safety window (final dump archived to B2).
- Rollback plan: DNS back to GitHub Pages + re-enable Supabase cron (both remain intact until the safety window closes).

---

## 6. New-faction onboarding runbook (post-migration target: ~30 min)

1. `./scripts/new-faction.sh mayhem 12345` — creates DB from template, seeds `faction_config` (torn faction id 12345), creates the scoped Postgres role, appends the compose service + nginx vhost blocks.
2. Add DNS record `mayhem.yourdomain.com` → server IP (wildcard cert already covers it).
3. `docker compose up -d api-mayhem && docker compose exec nginx nginx -s reload`.
4. Add the faction leader's Torn ID to `role_assignments` (`leadership`) via global-admin UI.
5. Leader logs in with their Limited key → self-serves roles, tiers, branding.
6. Scrapers backfill on their next scheduled runs (or trigger manually from the admin UI).

### 6.1 Ongoing release flow — the staging faction

The staging tenant built in Phase 6 doesn't get torn down after cutover; it becomes the **fifth, permanent faction**: `staging.yourdomain.com`, instantiated by the same runbook above, configured as a duplicate of Forge (periodic `pg_dump` refresh from the Forge DB, optionally with member API keys scrubbed from `member_secrets` so its scrapers/ticker run on a single test key or stay disabled).

Release cadence once live:

```
feature branch ──PR──► GitHub CI (vitest + server tests + compose build)
        │ merge to main
        ▼
   deploy to STAGING faction only          ← manual at first; deploy.yml later
        │ verify: affected flows + a war-room smoke if touched
        ▼
   promote to all 4 production factions    ← one command / one approval click
```

Because every faction runs the **same image and same bundle**, "promote" is just re-deploying the already-verified artifact with four env targets — there is no per-faction build to drift. This also answers "how do I try risky schema changes": run the migration against the staging DB first; the per-faction DB model means production factions are untouched until promotion.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Oracle free-tier reclaim / capacity loss | Portability by construction: nightly B2 dumps + compose = rebuilt on Hetzner in <1 h. Practice the restore drill in Phase 6. |
| Single server = shared blast radius for 4 factions | Per-faction API processes (crash isolation), Docker restart policies, uptime alerts, tested backups. Accept: a host outage takes all 4 down — communicate this to the family. |
| API replaces RLS as the *only* auth boundary | Per-faction DB credentials (defense in depth), role middleware unit tests, and an endpoint-authorization test suite (every route × every role) as a Phase 2 acceptance gate. |
| Scraper rewrite regressions | Python originals kept as reference; parity diffs in Phase 3; parallel-run in Phase 6. |
| The long pole (Phase 2) stalls | Views port independently — pausing mid-phase leaves main branch shippable; Supabase remains production throughout. |
| Torn API limits with 4 factions | Pools are per-faction (per-member keys), so budgets don't interact; the shared TS client enforces per-pool rate limits centrally. |
| JWT/secret management on the box | `.env` files outside git + docker secrets; document rotation; no service-role-style master key exists anymore. |

## 8. Out of scope / open items

- Discord bot + mug-bot integrations (separate audit if/when they should join the compose stack — the server can host them easily).
- Vanity domains per faction: supported later as additional vhosts + certs; faction pays, you add a block.
- CPR Google Sheets export: confirm whether still used before porting or dropping.
- GitHub's ongoing role, deploy automation timing, and the staging-first release flow: settled — see §3.4 and §6.1.

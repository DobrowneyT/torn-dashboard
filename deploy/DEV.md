# Staging / dev instance

A second, private copy of the dashboard running on the same VPS as production,
serving a **full copy of a real tenant's database**, reachable at
**https://dev.monchoon.me** and logged into exactly like production (or through
an SSH tunnel). It exists so a change can be exercised against real data — the
key pool included — before it is promoted to `main` and reaches live factions.

Introduced by **#292**. Production is untouched by everything on this page.

---

## The one-paragraph version

The live tenant `faction_forge` gets cloned to `faction_forge_dev`. A second git
worktree, its own compose project (`tnl-dashboard-dev`), and its own nginx bound
to `127.0.0.1:8090` run the dashboard against that copy. You reach it at
https://dev.monchoon.me — the host nginx proxies to that loopback port — or with
`ssh -L 8090:127.0.0.1:8090` if you prefer. The branch the
worktree is on decides what it runs: on `dev` a cron auto-follows every merge;
on anything else the cron stands down and the branch you deployed stays put.

---

## Safety model

**What is isolated.** The dev API only ever opens `faction_<slug>_dev`. Every
write it makes — settings, payouts, competitions, enabling a scraper — lands in
the copy. The live tenant database is never opened by this stack, and the two
migrate loops are mutually exclusive by name: `deploy/update.sh` skips
`%_dev` databases, `deploy/dev-deploy.sh` migrates **only** `%_dev` databases.

**Why the copy holds real secrets, and why that is fine.** The clone includes
`member_secrets` / `faction_secrets`, so the key pool works for real. That is
the point — pool behaviour is exactly what is hard to test otherwise. It is safe
because **the data never leaves the VPS**: the clone is a local `pg_dump | psql`
between two databases in the same cluster, and the only way to reach the running
instance is an SSH tunnel to a port bound to loopback. This is also why there is
no laptop copy — putting decryptable member keys on a laptop was explicitly
rejected during design.

**Reachable, but gated.** `nginx-dev` still binds `127.0.0.1:8090` and nothing
on the public internet routes to that port directly — verify with
`curl --max-time 5 http://<vps-public-ip>:8090/`, which must fail. **Do not
change that bind address.** Since the `dev.monchoon.me` vhost was added
(`deploy/host-nginx/dev.monchoon.me.conf`) the instance is reachable from
anywhere, so three controls carry what the SSH tunnel used to:

| Control | What it stops |
|---|---|
| Loopback bind on `:8090` | Anything reaching the instance except through the host nginx. ⚠️ UFW is **not** active on this box — the bind *is* the firewall. |
| TLS (Certbot, auto-renewing) | Session cookies and any key rendered in a settings page crossing the wire in clear text. |
| The app's own login | Everything else. Same Torn-key auth, same role checks, same session handling as production — reading the cloned tenant's roles. |

⚠️ **Do not put HTTP Basic auth in front of this.** It was tried and reverted on
2026-08-16, and it does not merely fail — it produces an unbreakable sign-in
loop. The SPA sends `Authorization: Bearer <token>` on every API call
(`frontend/src/utils/apiClient.js`), which **replaces** the browser's cached
Basic credentials on exactly those requests. nginx sees a Bearer token where it
wants Basic, answers 401 with a challenge, the browser re-prompts, and the app's
own 401 handler retries. The page itself loads fine throughout, because static
assets *do* carry the Basic header and API calls never can, so it reads as an
app bug. Basic auth and a bearer-token app cannot share the `Authorization`
header. A gate that avoids that header — a signed cookie checked by nginx, mTLS,
an IP allowlist — would work; Basic auth cannot.

**What this means for the risk.** Staging now sits at the same exposure as
production, which is also public and also holds real member secrets. The one
genuine difference is that staging runs *unreleased* code, so its auth has had
the least exposure of any code we run — a session bug on a feature branch is
reachable here before it is anywhere else. Keep that in mind when a branch
touches auth, sessions or roles.

Staging is also `noindex, nofollow, noarchive` and serves a blanket
`robots.txt` — a search result for a copy of a live faction's data is an
invitation to go looking.

### ⚠ Blast radius — what IS live

Three things reach the outside world. Read this before you go clicking.

| Path | What happens | Default |
|---|---|---|
| **Torn API** | Login and any scraper you enable make real calls with the copied key pool, spending real key quota. Responses are written **only to the copy**. | Scrapers **off** in every fresh clone |
| **Web Push** | If VAPID keys are set, a dev notification is delivered to **real members' real browsers**. They cannot tell it came from staging. | **Off** — `DEV_VAPID_*` unset |
| **In-app feedback** | If a GitHub token is set, submitting feedback opens a **real issue** in the real repo. | **Off** — `DEV_FEEDBACK_*` unset |
| **Chain Watch bot endpoint** (#782) | Serves this copy's sign-up data to the Discord bot when `DEV_CHAIN_WATCH_TOKEN` is set. Unset leaves the route **unregistered**, not merely unauthenticated. Give it a value of its own rather than the live tenant's token, so a staging token cannot open production. | **Off** unless you set it |
| **Revive requests** (#308) | Clicking revive POSTs to the **real** service (UHC/WTF/Nuke) and summons **real revivers** to a real player. There is no test mode and no toggle — the service is whatever URL the copied config holds. | **On** — always live |

**Revive is the one live path with no off switch.** Testing it end-to-end necessarily
reaches a third-party service and real people, so keep it to a single request on
yourself, and don't leave a war-room tab clicking it. To exercise the plumbing
without summoning anyone, point the tenant's revive service URL at a throwaway
endpoint (any URL that accepts a POST) in the **copy's** Manage Services — the
copy's config is disposable, and the change never reaches the live tenant.

Push and feedback stay off unless you opt in for a single deploy:

```bash
DEV_FEEDBACK_GITHUB_REPO=DobrowneyT/scratch \
DEV_FEEDBACK_GITHUB_TOKEN=ghp_… \
  ./deploy/dev-deploy.sh dev
```

Point feedback at a throwaway repo rather than the real one. For push, prefer
testing with your own subscription only.

---

## One-time setup (operator, on the VPS)

Production lives in `~/torn/torn-dashboard` on `main`. The staging worktree is a
sibling directory so neither checkout can move the other.

```bash
cd ~/torn/torn-dashboard

# FETCH FIRST. deploy/update.sh only ever runs `git fetch origin main`, so this
# box has likely NEVER fetched dev — its local `dev` ref is frozen at whenever
# the repo was cloned, often dozens of commits stale. `-B dev origin/dev` forces
# the worktree onto the real remote branch instead of that stale local ref.
git fetch origin
git worktree add -B dev ~/torn/dashboard-dev origin/dev

# deploy/.env is gitignored and lives only in the production checkout.
# Symlink (don't copy) so a credential rotation propagates to staging.
ln -s ~/torn/torn-dashboard/deploy/.env ~/torn/dashboard-dev/deploy/.env

# A worktree gets its own working tree but NOT the production checkout's
# node_modules. db/clone-tenant-dev.mjs needs dotenv + pg, so install before
# running it. (dev-deploy.sh does this too — this is for the clone that
# precedes the first deploy.)
cd ~/torn/dashboard-dev && npm ci --omit=dev --workspace @tnl/db

# Auto-follow `dev`. Silent unless the branch is `dev` AND origin moved.
crontab -e
*/5 * * * * cd $HOME/torn/dashboard-dev && ./deploy/dev-deploy.sh --if-changed >> $HOME/torn/dev-deploy.log 2>&1
```

The staging cron and the production cron take **different flocks**
(`tnl-dashboard-dev-deploy.lock` vs `tnl-dashboard-update.lock`), so they may run
at the same time without interfering.

---

## Daily use

### 1. Clone (or refresh) the tenant data

```bash
cd ~/torn/dashboard-dev
node db/clone-tenant-dev.mjs --tenant forge
```

Drops and recreates `faction_forge_dev` from live, turns **every scraper off**,
re-applies the tenant's scoped grants, and runs migrations. Re-run it whenever
you want fresh data — each run is a full refresh, and anything you changed in
the copy is discarded.

Only one tenant is on the staging ground at a time. To switch tenants, clone the
other one and redeploy with `DEV_SLUG` set to it.

### 2. Deploy a branch

```bash
DEV_SLUG=forge ./deploy/dev-deploy.sh dev        # first run — pins the tenant
./deploy/dev-deploy.sh feat/301-whatever         # any PUSHED branch (WIP commits fine)
./deploy/dev-deploy.sh                           # rebuild what's checked out
```

`DEV_SLUG` is sticky: it is persisted to `deploy/.env.dev` (generated,
gitignored) and reused on later runs, including by the cron.

### 3. Reach it

Browse **https://dev.monchoon.me**, or tunnel in if you would rather not:

```bash
ssh -L 8090:127.0.0.1:8090 <user>@<vps>   # then http://localhost:8090
```

Either way, log in with your own real Torn key. That login is one real API call;
everything after it reads the copy.

---

## The branch model

The checked-out branch **is** the mode switch — there is no pin file to forget.

| Worktree is on | The 5-minute cron does |
|---|---|
| `dev` | Fetches, and rebuilds if `origin/dev` moved — hands-off staging of everything merged to `dev` |
| any other branch | **Nothing.** Exits silently, leaving your manually deployed branch alone |

So: `./deploy/dev-deploy.sh feat/whatever` takes staging off auto-follow for as
long as you need it, and `./deploy/dev-deploy.sh dev` puts it back.

`dev-deploy.sh` does a `git reset --hard` on the worktree. The staging ground is
disposable and branch swaps must always succeed — never keep work there that
exists nowhere else.

---

## Verifying the isolation

Worth doing once after setup, and any time the deploy scripts change.

```bash
# The dev API is connected to the copy, not the live database.
docker compose -f deploy/docker-compose.dev.yml --project-directory deploy \
  exec api-dev printenv DATABASE_URL          # …/faction_forge_dev

# Production's migrate loop does not list the copies.
docker compose -f deploy/docker-compose.yml --project-directory deploy \
  exec -T postgres psql -U postgres -tAc \
  "SELECT datname FROM pg_database
     WHERE datname LIKE 'faction\_%' AND datname NOT LIKE '%\_dev'"

# The RAW port is not reachable off-box (run from your laptop — expect a failure).
# Only the gated vhost may reach the instance.
curl --max-time 5 http://<vps-public-ip>:8090/     # must fail
curl -o /dev/null -w '%{http_code}\n' https://dev.monchoon.me/   # 200 (the SPA)
curl -o /dev/null -w '%{http_code}\n' https://dev.monchoon.me/api/members/me/battle-stats
                                                       # 401 JSON — app auth, no browser prompt

# The two stacks own different containers.
docker compose -p tnl-dashboard ps
docker compose -p tnl-dashboard-dev ps
```

To prove a scraper write stayed in the copy: note a row count in the live
database, enable that job in staging, let it run, and re-check the live count.

---

## Troubleshooting

**`Cannot find module .../db/clone-tenant-dev.mjs`, or `./deploy/dev-deploy.sh: No such file
or directory`** — the worktree is on a **stale `dev`** (see the fetch note in Setup). Confirm
with `git log --oneline -1`, then:

```bash
cd ~/torn/dashboard-dev
git fetch origin
git reset --hard origin/dev
```

A giveaway is legacy directories that #135 deleted (`supabase/`, `data/`, `export/`,
`scripts/`, `requirements.txt`) still being present.

**`Cannot find package 'dotenv'`** — the worktree has no `node_modules` yet. A git
worktree does not share the production checkout's. Run
`npm ci --omit=dev --workspace @tnl/db` in the worktree, then retry the clone.

**`spawnSync dropdb ENOENT`** (or `pg_dump` / `psql` ENOENT) — you are on a build
that expected Postgres client binaries on the host. There are none: Postgres runs
in a container. Update the worktree (`git fetch origin && git reset --hard origin/dev`);
the clone now runs `pg_dump | psql` inside the postgres container and does the
drop/create through the `pg` driver.

**`Copy … failed` / `service "postgres" is not running`** — the clone dumps from
inside the production stack's postgres container, so that stack has to be up.
Check with `docker compose -p tnl-dashboard ps`.

**`DEV_SLUG is not set`** — first run only. `DEV_SLUG=forge ./deploy/dev-deploy.sh dev`.

**`faction_<slug>_dev does not exist`** — clone it first (step 1).

**`deploy/.env not found in this worktree`** — the symlink from setup is missing.

**`network tnl-dashboard_default not found`** — the production stack is down.
Staging attaches to prod's network to reach Postgres; bring production up first.

**Readiness FAIL** —
`docker compose -f deploy/docker-compose.dev.yml --project-directory deploy logs api-dev`.
A stale `deploy/.env.dev` is regenerated on every deploy, so re-running is a
valid first move.

**Tunnel connects but the page is blank** — the SPA is baked into the
`nginx-dev` image at build time; `./deploy/dev-deploy.sh` rebuilds it. A plain
`docker compose up` without `--build` will serve a stale bundle.


## Testing the Discord bot against the copy (#782, #785)

The bot polls a dashboard; pointing it at this instance lets the whole Chain
Watch feature be exercised without the endpoint existing on a live tenant.

```bash
DEV_CHAIN_WATCH_TOKEN=$(openssl rand -hex 32) ./deploy/dev-deploy.sh dev
grep DEV_CHAIN_WATCH_TOKEN deploy/.env.dev        # the value to give the bot
```

⚠️ **`.env.dev` is regenerated on every deploy**, so a token passed once does not
survive the next one. Either pass it on every `dev-deploy.sh`, or export it in
the cron's environment — otherwise the board goes stale after the next auto-deploy
and the cause is invisible.

Then in the bot's `.env`, point the tenant at this instance:

```
CHAIN_WATCH_TOKEN_FORGE=<the value above>
```

```
/chain tenant add slug:forge base_url:https://dev.monchoon.me board_channel:#chain-test
```

⚠️ **The scrapers are disabled in a fresh clone.** Travel state and the chain
projection come from `activity-sample` and `chain-sample`; until you enable them
in Global Admin the board renders with no travel and "not enough chain yet",
which reads as broken rather than as switched off.


## Pushing board updates to the bot (#785 follow-up)

The bot redraws its board on its own interval (default 5 minutes). That is right
for the chain counter and travel state, and far too slow for a sign-up — somebody
claims a slot and stares at an unchanged board. The dashboard can nudge the bot
instead, and the board redraws within seconds.

⚠️ **A unix socket, not a port.** A container cannot reach the host's
`127.0.0.1` — its traffic arrives via the bridge gateway — and the obvious fix
for that, binding `0.0.0.0`, would put a control channel for a process holding a
Discord token and five tenant bearers on the public internet. A bind-mounted
socket has no port, needs no firewall rule, and carries no credential.

```bash
mkdir -p /run/chain-notify          # the bot listens here
DEV_CHAIN_NOTIFY_DIR=/run/chain-notify \
DEV_CHAIN_WATCH_TOKEN=<as before> ./deploy/dev-deploy.sh dev
```

In the bot's `.env`:

```
CHAIN_NOTIFY_SOCKET=/run/chain-notify/notify.sock
```

⚠️ **The DIRECTORY is mounted, not the socket file.** The bot deletes and
recreates the file on each start; a bind mount of the file itself would leave the
container holding the old inode, and the push would silently stop working after
the first bot restart.

⚠️ **Entirely optional, and never load-bearing.** Unset, or the bot not
listening, means the board updates on its poll interval exactly as before. A
dropped nudge costs one poll of staleness, nothing more.

Debounce is `/chain set board_debounce_seconds` (default 5). Leadership filling a
rota assigns eight slots in twenty seconds; coalescing turns that into one
redraw instead of eight Discord edits and a flickering board.

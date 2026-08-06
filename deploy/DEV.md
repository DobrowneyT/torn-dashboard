# Staging / dev instance

A second, private copy of the dashboard running on the same VPS as production,
serving a **full copy of a real tenant's database** and reachable only through
an SSH tunnel. It exists so a change can be exercised against real data — the
key pool included — before it is promoted to `main` and reaches live factions.

Introduced by **#292**. Production is untouched by everything on this page.

---

## The one-paragraph version

The live tenant `faction_forge` gets cloned to `faction_forge_dev`. A second git
worktree, its own compose project (`tnl-dashboard-dev`), and its own nginx bound
to `127.0.0.1:8090` run the dashboard against that copy. You reach it with
`ssh -L 8090:127.0.0.1:8090` and browse `http://localhost:8090`. The branch the
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

**Not public.** `nginx-dev` binds `127.0.0.1:8090`. Nothing on the public
internet can route to it, and the host reverse proxy has no vhost for it. Do not
change that bind address.

### ⚠ Blast radius — what IS live

Three things reach the outside world. Read this before you go clicking.

| Path | What happens | Default |
|---|---|---|
| **Torn API** | Login and any scraper you enable make real calls with the copied key pool, spending real key quota. Responses are written **only to the copy**. | Scrapers **off** in every fresh clone |
| **Web Push** | If VAPID keys are set, a dev notification is delivered to **real members' real browsers**. They cannot tell it came from staging. | **Off** — `DEV_VAPID_*` unset |
| **In-app feedback** | If a GitHub token is set, submitting feedback opens a **real issue** in the real repo. | **Off** — `DEV_FEEDBACK_*` unset |
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
git worktree add ~/torn/dashboard-dev dev

# deploy/.env is gitignored and lives only in the production checkout.
# Symlink (don't copy) so a credential rotation propagates to staging.
ln -s ~/torn/torn-dashboard/deploy/.env ~/torn/dashboard-dev/deploy/.env

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

### 3. Tunnel in

```bash
ssh -L 8090:127.0.0.1:8090 <user>@<vps>
```

Then open **http://localhost:8090** and log in with your own real Torn key. That
login is one real API call; everything after it reads the copy.

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

# Staging is not reachable off-box (run from your laptop — expect a timeout).
curl --max-time 5 http://<vps-public-ip>:8090/     # must fail

# The two stacks own different containers.
docker compose -p tnl-dashboard ps
docker compose -p tnl-dashboard-dev ps
```

To prove a scraper write stayed in the copy: note a row count in the live
database, enable that job in staging, let it run, and re-check the live count.

---

## Troubleshooting

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

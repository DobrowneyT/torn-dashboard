# Chain Watch → Discord: operator runbook

How the Discord bot (`DobrowneyT/torn-discord-bot`) is given access to a tenant's
Chain Watch data. Endpoint: `GET /api/internal/chain-watch` (#782, part of #775).

## The token

Each tenant has its **own** Chain Watch token, derived from the fleet secret:

```
token(slug) = HMAC-SHA256(FLEET_METRICS_SECRET, "chain-watch:" + slug)
```

⚠️ **This is not `FLEET_METRICS_TOKEN`, and reusing that one instead is a
mistake worth catching in review.** Both come from the same secret, but the bot
is a different trust domain: it runs off this box, holds a Discord token, and is
joined to servers full of people. `/api/internal/fleet-metrics` reports key-pool
depth, which `docs/security-model.md` and #609 both treat as reconnaissance
handed over. Scoping the HMAC costs one string and keeps a bot compromise to
sign-up times and rosters.

⚠️ **The endpoint is reachable from the internet.** The generated tenant vhost
proxies `location /api/` wholesale, so `/api/internal/*` is *not* protected by
living on the compose network. The token is the only thing in front of it.

## Provisioning a tenant

```bash
node db/chain-watch-token.mjs                # print every faction's line
node db/chain-watch-token.mjs forge          # print just one
node db/chain-watch-token.mjs --write        # write them into the override
docker compose up -d --no-deps api-forge     # restart what changed
```

`--write` edits `deploy/docker-compose.override.yml` in place, adding
`CHAIN_WATCH_TOKEN` to each `api-<slug>` service and leaving
`FLEET_METRICS_TOKEN` and everything else byte-for-byte alone. A slug with no
matching service is a **failure** and nothing is written — a partially applied
pass is the worst state, because the tenants that did get a token look fine
while the rest 401 forever.

⚠️ **Absent token = unregistered route**, not an open one. A tenant you have not
provisioned exposes nothing.

## Instant redraws in production

Without this a board updates on the bot's poll interval — up to five minutes
after somebody signs up. Staging has pushed instantly since #785; production
never did, because its per-faction services live in
`deploy/docker-compose.override.yml`, which is generated on the box and is not
in the repo.

```bash
node db/chain-notify-wire.mjs                # show what would change
node db/chain-notify-wire.mjs --write forge  # apply it (writes a backup)
```

Then, in `deploy/.env`:

```
CHAIN_NOTIFY_DIR=/home/ubuntu/torn/run/chain-notify
```

...and restart the services it named. That directory is where the **bot**
creates its socket, and the bot has to be able to write there.

⚠️ **One variable.** `CHAIN_NOTIFY_SOCKET` is derived from `CHAIN_NOTIFY_DIR`
with compose's `:+`, so it cannot be set without something being mounted at it.
A socket address pointing at nothing fails on every sign-up, silently, inside a
fire-and-forget POST that swallows its own errors.

⚠️ **The directory is mounted, never the socket file.** The bot creates and
deletes the socket; bind-mounting the file leaves the container holding the old
inode — a push that silently stops working after a bot restart.

⚠️ **Optional on both ends.** No `CHAIN_NOTIFY_DIR`, or a bot that is not
listening, means the board updates on its poll interval as it always has.
Factions created by `db/new-faction.mjs` are born wired, so nothing has to be
remembered later.

## Which dashboard a faction actually reads

A slug is a **label on the bot side**. It picks which `CHAIN_WATCH_TOKEN_<SLUG>`
is sent; the host in `base_url` is what decides whose data comes back. A tenant
called `forge` pointed at `https://dev.monchoon.me` reads **staging**, and
nothing about the board says so.

`/chain tenant list` prints each faction's URL. Check it when numbers look
wrong before looking anywhere else.

To run staging and production side by side, give them different slugs — `forge`
→ `https://forge.monchoon.me` and `dev` → `https://dev.monchoon.me` — and set
`CHAIN_WATCH_TOKEN_FORGE` and `CHAIN_WATCH_TOKEN_DEV` from the matching box.
⚠️ The two tokens are **not interchangeable**: each is derived from its own
stack's `FLEET_METRICS_SECRET`.

## What the bot needs in Discord

Per channel or thread it posts in:

| Permission | Why |
| --- | --- |
| View Channel | Without it the bot cannot see the channel at all — Discord answers `50001 Missing Access` |
| Send Messages | Posting the board and pings in a normal channel |
| Send Messages in Threads | The same, in a **thread**. A different bit; a role can hold one without the other |
| Embed Links | The board is an embed. Without this it posts nothing |
| Read Message History | Finding its own board to edit, and tidying up |
| Manage Threads | Un-archiving a quiet thread before writing |

⚠️ **For a thread, set these on the parent channel.** Threads inherit, and
there is usually nothing to fix on the thread itself.

⚠️ **A slash command still reaches the bot in a channel it cannot see** — only
the *user* needs Use Application Commands. `/chain channel` therefore checks
`app_permissions` and refuses rather than accepting a channel it could never
write to.

## Giving it to the bot

Out of band — the bot's own environment, one entry per faction it serves.

⚠️ **Never through a Discord slash command.** Command arguments are visible to
the client and land in logs; a tenant bearer pasted into a channel is a leaked
credential for that faction. `/chain tenant add` deliberately takes no token
(#783).

## Rotating

Rotating `FLEET_METRICS_SECRET` changes **every** token — fleet metrics and
chain watch, all tenants — at once. Re-run both writers and restart every `api-*`
service, then update the bot. A partial rotation leaves some tenants 401ing,
which the bot reports as a stale board rather than an outage.

## Checking it works

```bash
TOKEN=$(node db/chain-watch-token.mjs forge | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" https://forge.monchoon.me/api/internal/chain-watch | jq '{event: .event.title, hours: (.hours|length), horizon: .gap_horizon_hours}'
```

Expected when no event is running:

```json
{ "event": null, "hours": 0, "horizon": 6 }
```

⚠️ **That is a 200, not a 404.** "Nothing is running" is the correct answer most
of the year; an error status would look like an outage and put the bot into a
retry loop over a right answer.

## What the samplers have to be doing

The payload's travel state comes from `member_activity_samples` and its chain
figure from `chain_samples` — both written by scraper jobs.

⚠️ **The clone script disables every scraper**, so a freshly refreshed staging
tenant serves an event with no travel state and an unmeasured projection, which
reads as "nobody is flying and we cannot say" rather than as "the samplers are
off". Before a test chain, enable `chain-sample` and `activity-sample` in Global
Admin; turn them back to a dormant cadence afterwards, since they cost roughly
650 calls/day/tenant with no event running.

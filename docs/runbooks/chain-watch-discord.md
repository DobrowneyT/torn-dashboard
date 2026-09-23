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

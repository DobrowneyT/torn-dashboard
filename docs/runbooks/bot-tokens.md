# The Discord bot's tenant tokens: operator runbook

Choonbot holds **three** credentials per faction, and the control plane holds a
fourth for itself. This is where they come from, and what each one lets its
holder do.

## The four tokens

All four are HMACs of the one fleet secret, `FLEET_METRICS_SECRET` in
`deploy/.env`, scoped apart by a prefix:

| Env var on `api-<slug>` | Scope string | Endpoint | Holder | Reads | Writes |
| --- | --- | --- | --- | --- | --- |
| `FLEET_METRICS_TOKEN` | `<slug>` (bare) | `/api/internal/fleet-metrics` | admin container | key-pool depth, scraper health | — |
| `CHAIN_WATCH_TOKEN` | `chain-watch:<slug>` | `/api/internal/chain-watch` | the bot | sign-up times, rosters | — |
| `WAR_OVERVIEW_TOKEN` | `war-overview:<slug>` | `/api/internal/war-overview` | the bot | a war's full attack + revive history | — |
| `MEMBER_THREADS_TOKEN` | `member-threads:<slug>` | `/api/internal/member-threads/*` | the bot | the member-report outbox + thread registry | ⚠️ **yes** |

```
token(slug) = HMAC-SHA256(FLEET_METRICS_SECRET, "<scope>:" + slug)
```

⚠️ **The scope prefix is the whole security argument.** Each is derivable only
from the fleet secret, which lives on the admin container alone, and a leak from
any single tenant yields that one faction and that one feature. Reusing one
scope for two features would mean a leak of the cheapest credential surrenders
the most expensive data — #609 is explicit that reconnaissance handed over by
accident is still handed over.

⚠️ **`MEMBER_THREADS_TOKEN` is the only one that grants writes.** Its holder
marks outbox rows posted and records thread ids against a permanent per-member
performance log that the faction's leadership reads. Treat it as the most
sensitive of the three, not the newest.

⚠️ **Every one of these endpoints is reachable from the internet.** The
generated tenant vhost proxies `location /api/` wholesale, so `/api/internal/*`
is *not* protected by living on the compose network. The token is the only thing
in front of it.

⚠️ **Absent token = unregistered route**, not an open one. A tenant you have not
provisioned exposes nothing, and a bot pointed at it gets a 404 rather than
data.

## Getting one

```bash
node db/member-threads-token.mjs                # print every faction's line
node db/member-threads-token.mjs forge          # print just one
node db/member-threads-token.mjs --write        # write them into the override
docker compose up -d --no-deps api-forge        # restart what changed
```

`db/chain-watch-token.mjs`, `db/war-overview-token.mjs` and
`db/fleet-metrics-token.mjs` take the same three forms. `--write` edits
`deploy/docker-compose.override.yml` in place, adding only its own variable and
leaving every other line byte-for-byte alone.

⚠️ **A slug with no matching `api-<slug>` service is a failure and nothing is
written.** A partially applied pass is the worst state: the tenants that did get
a token look fine while the rest 401 forever.

## The bot does not need you to paste it

```bash
curl -s -H "Authorization: Bearer $REGISTRY_TOKEN" \
  'http://127.0.0.1:<admin-port>/api/internal/tenants?tokens=1' | jq '.tenants'
```

`GET /api/internal/tenants?tokens=1` on the admin plane returns every faction's
slug, `base_url` and all three bot tokens, **derived on demand** from the fleet
secret. Nothing is stored and nothing has to be kept in step, so a faction
provisioned after the bot last restarted appears the moment its database does.

That endpoint has its own scope (`fleet-tenants`) and is opt-in: the default
answer carries no credentials, because a consumer that only wants to know which
factions exist should not be handed the means to read them.

⚠️ **Never hand a token over through a Discord slash command.** Command
arguments are visible client-side and land in logs; a tenant bearer pasted into
a channel is a leaked credential for that faction. `/chain tenant add`
deliberately takes no token (#783).

## Rotating

Rotating `FLEET_METRICS_SECRET` changes **all four tokens for every tenant** at
once. Re-run each writer, restart every `api-*` service, then let the bot
re-read the registry. A partial rotation leaves some tenants 401ing, which the
bot reports as stale data rather than an outage — and #645 proved that "not
measured" reads as healthy to a human.

## Checking one works

```bash
TOKEN=$(node db/member-threads-token.mjs forge | cut -d= -f2)
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  https://forge.monchoon.me/api/internal/member-threads/claim | jq '{pending: (.pending|length), threads: (.threads|length)}'
```

⚠️ **`claim` is not a read.** It takes the pending rows for ten minutes, so a
curl against production hides them from the bot until the claim goes stale. Use
a tenant you are willing to delay, or expect the next poll to be empty.

## See also

- [`chain-watch-discord.md`](chain-watch-discord.md) — the Discord permissions
  the bot needs, instant redraws, and which dashboard a slug actually reads.
- [`admin-control-plane.md`](admin-control-plane.md) — where the fleet secret
  lives and what else it backs.

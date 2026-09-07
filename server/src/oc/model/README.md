# The OC scenario model

Committed game data (#606). **Do not edit these files by hand** — regenerate
them with the build script and review the diff.

Every file here describes a Torn organised crime: its roles and weights, its
endings, and where known what each ending pays. `<slug>.json` is the scenario;
`<slug>.mmd` is its flowchart, kept separate because it is ~28 KB of mermaid per
crime (1.1 MB against 404 KB for everything else) and inlining it would make
every refresh a one-line diff nobody can review.

## Why this is a file and not a table

Scenario structure is **Torn game data, identical for every faction**, and it
changes only when Torn ships an update — a few times a year. It used to be
mirrored on a schedule into per-tenant tables, which was the wrong shape twice
over: it spent API budget on a constant, and it let two tenants disagree about a
fact that cannot differ between them.

⚠️ And it did worse than that. The mirror only ran where somebody had enabled
the `oc-scenarios-mirror` job, so on 2026-09-06 **three of five live tenants
held zero scenarios** and their OC Simulator was silently empty — an empty table
looks exactly like a crime with no data. A file shipped in the image cannot be
present on some tenants and absent on others.

## Refreshing

Two inputs, from two sources that are **not interchangeable**:

| source | supplies |
|---|---|
| tornprobability | the graph, ending probabilities, `successChance`, role weights |
| Crimes Hub | per-ending money, respect, item counts, chain rewards |

⚠️ Crimes Hub carries **no success probabilities at all** — the percentages it
shows are item-drop odds — so it cannot replace the first. tornprobability
carries no payouts, so it cannot replace the second. Each file records which
source gave what, in its `sources` block.

⚠️ **Permission.** The Crimes Hub author was asked and approved use of their
models (recorded on #606). That permission covers use; it does not excuse
blurring provenance, which is why the `sources` field exists.

### 1. Export the mirrored model

From a tenant whose `oc-scenarios-mirror` has run (`tnl` or `forge`):

```sql
SELECT json_agg(x ORDER BY x.name) FROM (
  SELECT s.name, s.parameter_count, s.is_complete, s.observed_paths, s.diagram, s.diagram_valid,
         s.diagram_problems, s.role_fidelity_error, s.role_fidelity_roles,
         (SELECT json_agg(json_build_object('position_id', r.position_id,
                 'role_name', r.role_name, 'weight', r.weight) ORDER BY r.position_id)
            FROM oc_scenario_roles r WHERE r.scenario_name = s.name) AS roles,
         (SELECT json_agg(json_build_object('ending_key', e.ending_key,
                 'node_id', e.node_id, 'kind', e.kind, 'resolved', e.resolved,
                 'problem', e.problem, 'starved', e.starved) ORDER BY e.ending_key)
            FROM oc_scenario_endings e WHERE e.scenario_name = s.name) AS endings,
         (SELECT json_agg(json_build_object('node_id', n.node_id, 'n', n.n,
                 'money_min', n.money_min, 'money_max', n.money_max, 'money_avg', n.money_avg,
                 'respect_min', n.respect_min, 'respect_max', n.respect_max,
                 'respect_avg', n.respect_avg, 'items', n.items) ORDER BY n.node_id)
            FROM oc_scenario_node_stats n WHERE n.scenario_name = s.name) AS node_stats
    FROM oc_scenarios s
) x
```

⚠️ `node_stats` is not optional. These are tornprobability's GLOBAL aggregates
(the mirror wrote them straight from the upstream feed), and they are what the
Simulator renders as per-node payouts, E(x) and success figures. An export
without them produces a model that looks complete and shows no money.

⚠️ This step disappears once the mirror tables are dropped; the export becomes
the previous contents of this directory.

### 2. Capture the Crimes Hub facts

One page per scenario at `https://crimeshub-2b4b0.firebaseapp.com/oc/<slug>`.

⚠️ **The pages are client-rendered** — a plain HTTP fetch returns an empty
shell. A real browser render is required, and roughly a third still come back
unrendered on the first attempt and need retrying.

⚠️ **Our FETCH TOOLING rate-limits at 20 requests an hour per domain**,
counting failed attempts and its own `robots.txt` reads. A full refresh spans
two windows, so be patient rather than clever.

⚠️ This cap is **ours, not Crimes Hub's** — an earlier version of this file said
"the origin rate-limits", and that was wrong. The origin served 200s to `curl`
throughout a period when every fetch was being refused. Blaming the wrong party
matters here: it turns a tooling limit into an apparent request to back off from
a site that never asked us to. (The refusal was a pagefetch bug — a
`rate_limited` verdict cached under the robots.txt TTL, so one exhausted hour
became a 24-hour lockout with the quota reading empty; fixed in pagefetch#21.)

⚠️ **Slugs need Unicode normalisation.** `Guardian Ángels` carries U+00C1; a
naive `[^a-z0-9]` strip yields `guardianngels`, which 404s — that scenario would
silently arrive with no rewards. `scenarioSlug()` in `../modelLoader.ts` is the
one to use.

⚠️ Some crimes redirect to a `/v2` path (`aceinthehole`, `breakthebank`,
`honeytrap`). That is normal.

⚠️ **Five scenarios have no page on Crimes Hub**, verified against its live
index on 2026-09-07 — earlier notes said three, and two different lists of three
were in circulation, neither correct:

| scenario | slots | level | our endings | unresolved |
|---|---|---|---|---|
| Hostile Takeover | 6 | 9 | 14 | 7 |
| First Aid and Abet | 3 | 1 | 13 | 7 |
| Lock Stock | 5 | 8 | 11 | 5 |
| Pet Project | 3 | 1 | 11 | 5 |
| Best Of The Lot | 3 | 2 | 11 | 3 |

All five ARE listed on the index with slot count and level; they are the only
ones with no detail link, so they read as registered-but-unmapped rather than
withheld. **26 of 31 are linked**, and we now have all 26.

That matters beyond coverage — Hostile Takeover and First Aid and Abet hold the
two worst ending-resolution rates in the fleet, so the role labels that would
resolve them are exactly what is unavailable.

⚠️ **A slug can be irregular, and a miss is SILENT.** Crimes Hub serves
"Plucking the Lotus Petal" at `/oc/lotuspetal`, not at our
`pluckingthelotuspetal`. A wrong slug returns a 200 carrying a "NOT FOUND"
body, so nothing throws — the scenario simply arrives unpriced, which looks
identical to a scenario that has no data. Check any newly-unpriced scenario
against the index before concluding the data is absent.

### 3. Build

```bash
npm run oc:model:build -- --export <tenant-export.json> \
  --crimeshub ../src/oc/crimeshub-facts.json
```

Then read the diff. That is the entire point of committing this.

⚠️ **Pass the COMMITTED `server/src/oc/crimeshub-facts.json`, and add to it —
never build from a file containing only the scenarios you just captured.** The
build regenerates every scenario from scratch and knows only what the facts file
holds, so a partial facts file silently blanks the payouts of every scenario
missing from it. Caught on 2026-09-07 by building to a throwaway `--out` first:
a six-scenario facts file produced a model that **gained 30 endings and lost
213**. Build to a temp directory and diff before overwriting this one.

⚠️ That facts file is committed precisely because it was not, once. The
original capture existed only as a transient input, so the committed model could
not be rebuilt without re-scraping all 26 pages — and any rebuild attempted
without it would have destroyed the data it could not recover. The 20 scenarios
in it now marked `recovered from the committed model` were reconstructed out of
the model files themselves to close that gap.

## ⚠️ The parser refuses to guess, and must keep refusing

Crimes Hub's reward display has **at least seven shapes**:

| shape | example |
|---|---|
| cash | `Good End #1 / $117,161,350 / 294` |
| items | `Good End #1 / 1841 / x3` |
| pooled | `Good End #1 / 170 / "One from each pool" / x1 ×12` |
| ranged | `Good End #1 / 121 / x14-15  x1  x2` |
| probabilistic | `Good End #5 / 74 / "One of" / x4 (43%)  x6 (57%)` |
| chain | `Good End #4 / Ace in the Hole` — the payout IS the next crime |
| bad | `Bad End #1` |

Each was found by a scenario breaking the parser written for the previous ones.
An early positional version recorded Crane Reaction's **good** endings as
`money: 0`, which asserts *"this ending pays nothing"* when the truth is *"it
pays in items we have not priced here"*.

A fabricated figure in a committed file is strictly worse than an absent one, so
anything unrecognised is left `null` and the build reports it. The dataset may
be **incomplete; it may never be wrong** — the same rule as
`item_value_unmatched` (#441), unpriced endings (#473) and null-not-zero (#351).

Two of Crimes Hub's own annotations are preserved rather than stripped: a
trailing `?` on an ending it is unsure of, and `UNKNOWN` terminals.

## What the build will tell you

```
wrote 31 scenarios
  endings with rewards:  183
  no Crimes Hub data:    114
  unparsed (left null):    8

⚠️  32 Crimes Hub ending(s) have NO counterpart in our model and were dropped.
```

⚠️ That last line is not noise. Our upstream reports only good endings for some
crimes while Crimes Hub draws the bad ones, so those terminals are lost. Placing
them needs the graph structure. Do not "fix" it by inventing node ids.

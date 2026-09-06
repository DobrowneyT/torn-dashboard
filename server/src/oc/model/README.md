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
  SELECT s.name, s.parameter_count, s.is_complete, s.diagram, s.diagram_valid,
         s.diagram_problems, s.role_fidelity_error, s.role_fidelity_roles,
         (SELECT json_agg(json_build_object('position_id', r.position_id,
                 'role_name', r.role_name, 'weight', r.weight) ORDER BY r.position_id)
            FROM oc_scenario_roles r WHERE r.scenario_name = s.name) AS roles,
         (SELECT json_agg(json_build_object('ending_key', e.ending_key,
                 'node_id', e.node_id, 'kind', e.kind, 'resolved', e.resolved,
                 'problem', e.problem, 'starved', e.starved) ORDER BY e.ending_key)
            FROM oc_scenario_endings e WHERE e.scenario_name = s.name) AS endings
    FROM oc_scenarios s
) x
```

⚠️ This step disappears once the mirror tables are dropped; the export becomes
the previous contents of this directory.

### 2. Capture the Crimes Hub facts

One page per scenario at `https://crimeshub-2b4b0.firebaseapp.com/oc/<slug>`.

⚠️ **The pages are client-rendered** — a plain HTTP fetch returns an empty
shell. A real browser render is required, and roughly a third still come back
unrendered on the first attempt and need retrying.

⚠️ **The origin rate-limits at 20 requests an hour**, counting *failed*
attempts and its own `robots.txt` reads. A full refresh of 31 scenarios spans
two windows, and retrying into a limit you have already hit only pushes it
further out. Be patient rather than clever.

⚠️ **Slugs need Unicode normalisation.** `Guardian Ángels` carries U+00C1; a
naive `[^a-z0-9]` strip yields `guardianngels`, which 404s — that scenario would
silently arrive with no rewards. `scenarioSlug()` in `../modelLoader.ts` is the
one to use.

⚠️ Some crimes redirect to a `/v2` path (`aceinthehole`, `breakthebank`,
`honeytrap`). That is normal.

⚠️ **Three scenarios are not on Crimes Hub at all**: First Aid and Abet,
Hostile Takeover, and Lock Stock. That matters beyond coverage — Hostile
Takeover has 7 of 14 endings unresolved and First Aid and Abet 7 of 13, the two
worst in the fleet, so the labels that would resolve them are unavailable from
this source.

### 3. Build

```bash
npm run oc:model:build -- --export <tenant-export.json> --crimeshub <facts.json>
```

Then read the diff. That is the entire point of committing this.

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

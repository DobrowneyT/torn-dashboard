# OC minimum-CPR thresholds: the algorithm, and what we decided about it

Working record for **#688**. The source document is reproduced verbatim first;
everything after it is our analysis, the decisions taken, and the mistakes made
along the way.

⚠️ **The mistakes are recorded on purpose.** Two of them were made twice in one
sitting, by both of us, and one of them shipped a plausible-looking formula that
was 21% wrong in a direction that biased the whole hierarchy. If this file only
held conclusions we would re-derive the same errors.

---

## Part 1 — the source document, verbatim

From MonChoon, `CPR-Algorithm.pdf`, September 2026. Reproduced exactly, including
the author's own hedges.

> The basic 'algorithm' is thus:
>
> 1. Set the CPR to the largest number such that the number of people in the
>    faction able to do the role is at least equal to the number of roles in the
>    crime. Example below (BftP), we have 6 or more people able to do each role,
>    meaning we could put out a team at least this strong.
>
> 2. Divide the E(X) figure by [n(n+1)/2] + [(n-1)*0.5] to give the return per
>    person per day (assuming a 12 hour waiting period for each joiner, bar the
>    first) where n is the number of roles in the crime
>
> 3. This sets the upper limit of the potential income for each crime. The crime
>    above it in the hierarchy must have a minimum CPR level such that the per
>    person per day return is around this level, or there will be no point in
>    doing it. It could probably be slighlty lower because easier CPRs at higher
>    levels mean more flexibility in practice. This is where there a bit of
>    nuance that I can't make an explicit rule on without playing around with it,
>    which is clearly unhelpful for the purposes of an algorithm. Like maximum of
>    the crime below x 90% or something.
>
> 4. Try to optimise the CPR so that it meets the criteria above but using the
>    lowest possible numbers. If we can drop a role to a full carry, like Thief 1
>    / Picklock 2 then prioritise doing that and make the other roles a couple
>    points higher if needs be. I did this with some Monte Carlo simulations to
>    get a rough estimate of which roles are more or less important, but you can
>    also use the numbers given by those APIs. It's not rocket science, ideally
>    we want no minimum on the carry roles (set it to the lowest actual member of
>    the faction like Andrew so its not literally zero in the simulator, but in
>    the official guidance just put zero), 65-75 if it's 25-30% importance, 60-70
>    if its 15-25%, 55-65 if its 10-15%, and then iterate from there.
>
> 5. Would probably need some sort of check in terms of the scope and the
>    spawning more generally. Like simulate spawning a certain number of each
>    level of crime per day and make sure we have enough people to fill the
>    roles. If the numbers don't work out, go back a step and redo the CPRs.
>    Spawns are generally equal between lvl and crimes. So Advanced is 25% for
>    each of the 4 crimes, because it's 50/50 lvl 7 or 8, then 50/50 for each of
>    the crimes. Elaborate is different, it's 2:2:1 and the 1 is the crime we
>    simply cannot do, if we spawn it we need to leave it unfilled. So guaranteed
>    to lose 20% of our scope on those levels at least. We would also need to
>    take the scope figure quoted in the site currently and increase it a bit,
>    because it assumes each crime is undertaken with the exact minimum CPR
>    levels. Maybe we could assume half way between the minimum CPR and the
>    'maximal' CPRs from step 1?

---

## Part 2 — the objective

**Maximise `$ per faction member per day`.** Not per participant.

```
                          Σ over concurrently-running crimes of E(X)
$/faction-member/day  =  ───────────────────────────────────────────
                            roster size × personDays(n, g)
```

⚠️ This is the single most consequential decision in the whole design, and it
was not in the source document. A member sitting idle because the bar is too
high to crew a second crime contributes nothing — under a per-*participant*
metric they would simply vanish from the denominator rather than counting as the
cost they are.

It gives the problem a genuine **interior optimum**, which is why the answer was
never obvious:

| | E(X) per crime | `k` concurrent crews | idle members |
|---|---|---|---|
| raise CPR | ↑ | ↓ | ↑ |
| lower CPR | ↓ | ↑ | ↓ |

Maximal CPR is one endpoint (best crew, fewest crimes, most people idle). The
floor is the other (everyone busy, poor returns). Neither wins.

---

## Part 3 — the game mechanics we rely on

Confirmed by MonChoon, 2026-09-11.

- **A crime completes `24h × n` after the first member joins.** Each member adds
  24h in their role, and the roles run back to back.
- **Lock-in is `24h × slots remaining at join time`.** The first joiner into a
  six-role crime is held 6 days; the last is held 1.
- **A member cannot be in two organised crimes at once.** This is the constraint
  that makes crew counting a matching problem rather than arithmetic.

---

## Part 4 — step by step

### Step 1 — the maximal CPR vector · DECIDED · built (#691)

**Kept exactly as written. No safety margin.**

⚠️ **It is a CEILING, not an answer.** The document says so itself ("This sets
the upper limit of the potential income"), and step 4 descends from it.
Publishing it directly would ask the whole faction to train to a bar that lets
us run exactly one crime.

**The rule is provably sufficient, not a heuristic.** By Hall's marriage
theorem: if every one of `n` roles has ≥`n` candidates, then for any subset `S`
of roles `|N(S)| ≥ n ≥ |S|`, so a crew of *distinct* members always exists.

That matters because `frontend/src/utils/ocRosterFit.js` has carried this
warning since #442:

> ⚠️ Deliberately does NOT check that the eligible sets are disjoint. One member
> can be the only person clearing the bar for three roles, and this would call
> that crime crewable.

That failure **cannot occur** under step 1's rule. The document independently
landed on the exact condition that closes a known gap in our code.

⚠️ **The guarantee evaporates for `k > 1`.** Two concurrent crews need ≥`k` per
role *and* ≥`k·n` across the **union** of the eligible sets — and per-role counts
cannot see the union. Hence step 1 being a ceiling, and hence `ocCrewMatching.js`.

**Fragility is accepted.** On Blast from the Past one CPR point costs six of
seven eligible members on three of six roles, so step 1 parks every role on a
cliff edge by construction. Fine, because nothing is published from it — the
fragility stays at the top of a search that moves downward into comfortable
territory. The implementation reports the cliff so step 4 knows what it is
holding.

### Step 2 — per-person-per-day · DECIDED · built (#690)

**The document's formula is correct as written.**

```
personDays(n, g) = n(n+1)/2  +  (n-1)·g
                   └ lock-in ┘   └ slack ┘
```

- `n(n+1)/2` — lock-in under a perfect fill, from the 24h-per-remaining-slot
  mechanic: locks of `n, n-1, … 1` days.
- `(n-1)·g` — the human factor. Each joiner after the first arrives `g` early
  and idles, because nobody joins the instant the previous role's 24h expires.

⚠️ **`g` is faction behaviour, not a game rule.** It is the only free parameter
in the figure, defaults to 12h, is clamped to `[0, 24h]`, and every threshold
the algorithm produces inherits it. It moves the answer by **~22%** across that
range — which is why #687 exists to measure our real value from observed
occupancy.

### Step 3 — the hierarchy floor · DECIDED: DELETED

**Removed from the algorithm. Not implemented.**

The document asks for a hand-set rule stopping a higher tier from being
pointless — *"Like maximum of the crime below x 90% or something"* — and the
author flags it as unresolved in the same breath: *"a bit of nuance that I can't
make an explicit rule on without playing around with it, which is clearly
unhelpful for the purposes of an algorithm."*

**It dissolves under the objective in Part 2.** Once we maximise
`$/faction-member/day` across the **whole spawn mix**, a tier that does not beat
the one below simply will not be chosen — the constraint falls out of the
optimisation rather than needing to be imposed on it. Picking a number for it
would add a tunable that can only make the answer worse than the optimiser's.

⚠️ **What we lose, stated honestly:** step 3 was also expressing something the
optimiser does not capture — the author's note that a higher tier *"could
probably be slightly lower because easier CPRs at higher levels mean more
flexibility in practice"*. Flexibility has real value that a point estimate of
throughput misses. If the optimiser starts recommending we abandon a tier and
that feels wrong in practice, **this is the first place to look**, and the fix
is to model flexibility explicitly rather than to reinstate a 90% fudge.

Decision by MonChoon, 2026-09-11: delete it, document it.

### Step 4 — threshold search · DECIDED · built (#692)

Descend from step 1's ceiling, scoring each candidate vector against the
objective, and output the minimum CPR per role that we publish.

**The importance bands are mechanical**, because role weights are static
per-crime values from tornprobability summing to 100 — not local derivatives, so
they do not shift as thresholds move. The Monte Carlo folklore in the document
is not needed; we have the real numbers.

| role weight | starting band |
|---|---|
| >30% | **70–75** *(interim — see below)* |
| 25–30% | 65–75 |
| 15–25% | 60–70 |
| 10–15% | 55–65 |
| carry role | floor |

⚠️ **The document's bands stop at 30%, and Muscle on BftP is 34.6%** — the top
role in the worked example falls off the end of the table. 70–75 is an interim
value pending empirical work.

⚠️ **The bands are a starting shape, not a constraint.** The search should be
free to leave them and report when it does.

**Prioritise dropping a role to a full carry.** The document is explicit that
turning one role into a carry (Picklock 2 on BftP is 2.9% impact) and paying for
it a couple of points elsewhere is usually the better trade. A search that only
moves all roles together will miss this.

#### ⚠️ Scope is reported, not enforced — and that was a correction

`ocScope.js` supplies a per-category break-even success chance
(`scopeCost / scopeReward`), below which a crime steadily destroys the resource
that lets us spawn anything:

| category | break-even |
|---|---|
| Introductory | 50.0% |
| Simple | 66.7% |
| Intermediate | 75.0% |
| Advanced | 80.0% |
| Elaborate | 83.3% |

The first build of slice 4 treated that as a **hard floor** and disqualified any
vector below it, before scoring, so that money could not argue its way past.

**That was wrong, because scope is a PORTFOLIO question, not a per-crime one.**
MonChoon, 2026-09-12:

> I am okay to have the higher paying crimes scope negative in the hopes that
> some lower ones balance it out (since we cant control spawning) and if things
> get to a point where we need to fill up scope a bit, we can always spawn some
> lower level crimes, so im not worried about that, whatsoever.

Scope is fungible across the whole spawn mix and cheaply replenished by running
easier crimes. Refusing a lucrative crime because *that one crime* is
scope-negative optimises a sub-problem nobody has — and **we do not control what
spawns**, so a per-crime veto buys nothing anyway.

So every candidate now carries `netScope` and `aboveBreakEven`, and none is
refused for it. **Solvency across the mix belongs to step 5**, which simulates
the spawn distribution and can actually see the portfolio.

⚠️ What to watch: scope is capped at 100 and regenerates +1/day. If the chosen
mix bleeds scope faster than the easy crimes replenish it, the constraint
reappears at portfolio level — which is exactly where step 5 should catch it.

#### Warm start — and the correction that goes with it

Seed the search from the **currently published vector**, falling back to step 1's
ceiling when there is none. Roster composition moves slowly, so last run's answer
is nearly always near this run's.

⚠️ **The incumbent is a SEED, not a tiebreak.** An earlier draft of this
requirement proposed keeping the incumbent unless a challenger beat it by a
margin, for stability. **That was wrong and is withdrawn.** It conflated:

| | |
|---|---|
| **Feasibility** | A hard constraint. If fewer than `n` members can fill a role at the incumbent bar, that bar is *impossible* and must fall. No margin applies. |
| **Optimality among feasible vectors** | Where near-ties live. |

A margin applied to the first **publishes a target nobody can hit** — strictly
worse than churn, because someone training toward an unreachable number wastes
weeks. The member base changes in both directions: people leave, and lower-CPR
members join.

MonChoon, 2026-09-11: *"If we get lower quality members with lower CPRs we may
not have 6 people at a role at level 86 anymore, so we would go down. The point
is that whatever the incumbent value is, is likely not far from the true value,
so its a good place to start."*

So: always produce the correct answer for current data, and **report movement
and why** — *"Engineer 86 → 85: only 5 members now clear 86"* is actionable.
That is reporting, not damping.

### Step 5 — spawn and scope feasibility · SPECIFIED · not built (#693)

- **Advanced**: even — 25% each of 4 crimes (50/50 level 7 or 8, then 50/50).
- **Elaborate**: **2:2:1**, and the "1" is a crime we cannot do. ~20% of
  Elaborate scope is lost by construction. *(Open: which crime, and whether that
  is permanent — see below.)*

⚠️ **The existing scope figure is optimistic and must be corrected.** It assumes
every crime runs at the exact minimum CPR, which is not what happens — crews form
from whoever is available, usually above the minimum. The document suggests
assuming halfway between the minimum and step 1's maximal; that is a reasonable
default and should be a tunable, not baked in, because it is a guess about
behaviour in the same family as `g`.

### Step 6 — the published guidance table · SPECIFIED · not built (#694)

⚠️ **Carry roles publish as `0`. Confirmed deliberate** (MonChoon, 2026-09-12:
*"I think carry roles should publish 0, even though the simulator effectively
uses the lowest real number."*).

The simulator wants the lowest real member's CPR so it does not model a literal
zero, but the guidance says **zero** — because "you do not need this role
trained" is the true instruction, and any number at all invites people to train
toward it. The two surfaces disagree **by design**, and anyone reconciling them
later should not "fix" it.

**Recompute, do not freeze.** Roster churn invalidates these, and step 1's
output sits on a cliff by construction. Regenerating from live readings is the
whole point — a hand-maintained document is exactly what drifts today.

---

## Part 5 — mistakes made, and how they were caught

⚠️ Kept so they are not repeated.

### The cumulative slack term — 21% wrong, and biased

I argued the slack term should be `g·n(n-1)/2` rather than `(n-1)·g`, reasoning
that an early joiner sits through every subsequent gap.

**Wrong.** The gaps do not delay the crime — it completes at `24h × n` whatever
happens. Joiners arrive *early* and idle, rather than the crime finishing *late*.
Each non-first joiner is held exactly `g` longer than ideal, **once**.

| n | correct | cumulative (wrong) | overstatement |
|---|---|---|---|
| 3 | 7.0 | 7.5 | 7% |
| 4 | 11.5 | 13.0 | 13% |
| 6 | **23.5** | 28.5 | **21%** |

⚠️ The error **grows with `n`**, so it does not cancel — it systematically
favours bigger crimes in exactly the tier-against-tier comparison the algorithm
rests on.

**How it is now caught:** the test in `ocPersonDays.test.js` walks the join
schedule by hand and is deliberately *not* the closed form under test.

### The Engineer off-by-one — both of us, twice

The worked example in the source document, and a later screenshot, both set
Engineer at **86** while asserting "6 or more people able to do each role". At 86
only **5** clear it. The answer is 85.

⚠️ The first version of the screenshot also carried *"This role's name and slot
disagree between sources"* on Picklock 1 — a warning removed in v3.98.0 — so
**step 1 had been applied with one of six roles unmeasured**. The assumption
happened to hold (7 clear 87), but it was an assumption.

**How it is now caught:** the real forge table is the test fixture in
`ocMaximalCpr.test.js`, with a dedicated test for Engineer. Requiring `n-1`
instead of `n` fails seven assertions.

### Reading a per-role headcount as a crew count

Every role on BftP has 7–9 eligible members, which reads as "seven crews". If the
same nine strong members clear every bar, it is **one**.

⚠️ **Wrong by 5×, always in the optimistic direction** — the direction that
publishes thresholds the roster cannot sustain.

**How it is now caught:** `ocCrewMatching.test.js` pins both — the *same*
maximal vector seats seven crews against independent per-role pools and one
against an overlapping roster.

### Mistaking the verification table for hardcoding

The PR for #691 leaned so heavily on the forge verification table that it read as
though 85/86/87 were constants. They are a test fixture; the solver sorts each
role's readings and takes the `n`-th highest, re-derived live every run.

⚠️ **Step 1 does not search and needs no warm start** — warm starting belongs to
step 4, which does.

---

## Part 6 — verifying the model

⚠️ **forge cannot verify this and tnl can.** MonChoon, 2026-09-12:

> I dont think we can start evaluating which elaborate crimes we can or cant do
> yet, because we dont have ANY CPR data from our members to know what their
> levels are for certain roles. However, we should be able to use this same
> simulator on `tnl.monchoon.me` so that we can verify it as a model.

Every module in slices 1–4 is therefore **pure and injectable**: readings,
positions, roster size, category and the probability lookup are all parameters,
and no module reads tenant config or assumes a faction. The same code runs
against either tenant's data and the answers can be compared by hand.

What to check first, against a tenant that has the readings:

1. **`E(X)` monotonicity in CPR** — the one unproved assumption in step 4's
   candidate generation. If a higher bar ever scores *lower*, "highest vector
   per `k`" is a heuristic rather than an optimum, and the write-up must say so.
2. **The candidate set is small in practice.** It is a handful on synthetic
   rosters; real readings are lumpier and could yield more distinct crew counts.
   Each one costs a tornprobability call.
3. **Whether a chosen vector is actually crewable on the day** — `k` is what the
   roster supports from a standing start, and does not know who is already
   committed to a crime in flight.

## Part 7 — still open

1. **The >30% importance band.** 70–75 is interim, pending empirical work.
2. **`g`.** Assumed 12h until #687 measures it per tenant.
3. **`E(X)` monotonicity in CPR** — assumed by step 4's candidate generation,
   not proved. Ending payouts are not ordered, so a higher bar could shift mass
   onto a good ending that pays less, especially where the reward is items.
   Verify against a tenant with real readings.

### Closed

- ~~**Which Elaborate crime can we not do?**~~ **Dissolved, 2026-09-12.** It is
  an OUTPUT now, not an input: a role with fewer readings than the crime has
  roles returns `null` from step 1 and names itself in `limitingRoles`, and a
  vector yielding `k = 0` is not fieldable. ⚠️ The reason matters and is kept
  distinct — "nobody is good enough" versus "we have never observed anyone in
  this role" (#351). forge is currently the second case on those roles, which is
  a measurement gap and not a verdict.
- ~~**Carry roles: `0` or the lowest real member?**~~ **Both, deliberately** —
  `0` in guidance, lowest real member in the simulator. See step 6.
- ~~**Step 3's hierarchy rule**~~ — deleted, see step 3.

## Slices

| # | slice | issue | state |
|---|---|---|---|
| 1 | crew-matching engine | #689 | built |
| 2 | $/person/day | #690 | built |
| 3 | maximal-CPR solver | #691 | built |
| 4 | threshold search | #692 | built |
| 5 | spawn and scope feasibility | #693 | specified |
| 6 | published guidance table | #694 | specified |

Related: #687 (measure `g`), #443 (team builder — shares slice 1), #602 (is
Elaborate worth it — this answers it).

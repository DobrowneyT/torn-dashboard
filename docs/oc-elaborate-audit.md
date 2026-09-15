# Is unlocking Elaborate worth it for Forge?

Decision record for **#602**. Measured on the tenant databases 2026-09-13/14.

**Short answer: yes — but crewing was never the gate, and the thing that is has
nothing to do with Elaborate.** Forge can crew the Elaborate roots at close to
tnl's quality. What it cannot currently afford is the **scope**, because its
Advanced success rates are 8–13 points below tnl's. Fix that first and Elaborate
pays for itself; unlock without fixing it and you run the bank down.

⚠️ Mistakes made reaching this answer are recorded at the bottom. Two of them
were mine and were caught by MonChoon, and one of them had been sitting in the
issue for months.

---

## 1. The chicken-and-egg, and how it actually broke

Deciding whether to unlock needs an expected value → a success chance → the
crew's CPRs for Elaborate roles → which exist only once you are running the crime.

The original plan was a classifier matching Forge's members against tnl's. That
needed **member data to cross a tenant boundary**, which is the one thing this
architecture prevents, and it is why the issue sat in triage.

**It is not needed.** CPR is deterministic given the member, so fitting
`target = slope × source + intercept` on a faction that runs **both** crimes and
applying it to Forge's own readings gives estimates at the rounding floor. What
crosses the boundary is a **coefficient table**, not member rows.

See `oc-cpr-mechanics.md` for why a slope rather than an offset: Crime Experience
multiplies the other factors.

## 2. The fitted map

`frontend/src/data/cpr-transfer.json`, 20 Elaborate roles. Donor chosen **per
role** by held-out MAE — 200 shuffles, 50/50 split.

| | held-out MAE |
|---|---|
| 18 roles, tnl donor, n = 73–87 | **0.28 – 1.36** |
| ⚠️ 2 Driver roles, capacityx donor, n = 7–8 | 0.54 – 1.64, **flagged `low_confidence`** |

CPR is **integer-valued** — 7,464 readings, zero fractions — so 0.3–0.6 is the
rounding floor and no modelling improvement is available. Measured and rejected:
unweighted ensembles across 26 sources (**worse**, 1.44 vs 0.97), inverse-variance
weighting (no change), fitted lines in aggregate (no change).

⚠️ **The two Driver roles are the weak point and always will be.** Driver runs on
**Racing**, the only stat no other role uses, so no non-Driver source can predict
it. tnl runs no crime containing a Driver, so it cannot donate one at any sample
size; capacityx can, with **seven members**. Where a well-sampled donor exists the
selection is made on measured error; where it does not, the **stat family** breaks
the tie, because a holdout over n=7 fits on 3–4 points and cannot separate
candidates. `Ace in the Hole / Driver` therefore routes through
`Bidding War / Driver` (slope 2.01) even though a DEX/Forgery source scored better
on those seven points.

## 3. Can Forge crew it?

Estimated crews at a uniform bar:

| Crime | roles | 50 | 55 | 60 | 65 | 70 | 75 |
|---|---|---|---|---|---|---|---|
| **Stacking the Deck** | 4 | 19 | 18 | 15 | **13** | 0 | 0 |
| **Lock Stock** | 5 | 15 | 14 | 12 | **10** | **8** | 4 |
| Ace in the Hole | 5 | 13 | 11 | **2** | 0 | 0 | 0 |
| Hostile Takeover | 6 | 11 | 9 | 7 | **4** | 0 | 0 |

**Yes, on the roots** — the crimes you actually choose to spawn. The children are
thinner, but they spawn automatically, so thin is survivable.

Forge's estimated **medians** run ~10 points under tnl's actuals, while the
**maxima** are within 1–4 points. Forge has tnl's top end and a longer low tail —
and for fielding one or two crews only the top end matters.

⚠️ 29–30 of Forge's members fall outside the Driver coefficients' fitted range and
7–13 are dropped entirely for mapping below zero. Driver estimates are sound at the
top of the roster and junk at the bottom. It matters less than it sounds: Driver is
the 3%-weight carry seat.

## 4. What it is worth

180 days, items priced `GREATEST(market_price, sell_price)`, chains billed at the
root's person-days plus the child's weighted by how often the child runs.

| | $/person-day |
|---|---|
| tnl, Lock Stock → Hostile Takeover | **$12,235,821** |
| tnl, Break the Bank (best Advanced) | $11,644,322 |
| tnl, Stacking the Deck → Ace in the Hole | **$11,374,822** |
| tnl Advanced, whole category | $7,630,000 |
| Forge Advanced, whole category | $6,694,467 |

⚠️ **Elaborate does not beat the best Advanced crime.** Lock Stock's chain edges
Break the Bank by 5%. It beats the Advanced **category**, because you cannot choose
which crime spawns and the average carries Window of Opportunity and Blast from the
Past with it. Any summary quoting "1.6× Advanced" without that sentence is
misleading.

## 5. ⚠️ The real finding: it is an OCCUPANCY play

| | person-days /180d | busy | % roster |
|---|---|---|---|
| tnl, all crimes | 14,290 | 79.4 | **97%** |
| tnl, Advanced only | 10,758 | 59.8 | **73%** |
| Forge, all crimes | 12,499 | 69.4 | **73%** |

**tnl stripped of Elaborate sits at exactly Forge's occupancy.** Advanced alone
appears to saturate a roster near 73%; Elaborate is a second independent stream of
crimes that uses the rest.

Decomposing tnl's 2.06× advantage in $/member/week: **rate 1.55× × occupancy 1.32×**.

And it carries weak members better, though not the way one would guess from the
weight tables — those are the same in both tiers:

| | seats | CPR < 60 | |
|---|---|---|---|
| Advanced | 2,998 | 73 | 2.4% |
| Elaborate | 1,003 | 48 | **4.8%** |

Concentrated almost entirely in `Ace in the Hole / Driver` (41.8% weak) and
`Stacking the Deck / Driver` (33.3%). **Deeper carry seats, not more of them.**

⚠️ **No cannibalisation.** Of 136 members in difficulty-7+ crimes, **103 work both
tiers** at 35.5 seats each; the 30 Advanced-only members average 11.2. There is no
displaced elite — the Advanced-only group are the light participants.

## 6. ⚠️ The gate is scope, and it is Forge's Advanced success rate

Net scope per 180 days:

| | Advanced | Elaborate | regen | **net** |
|---|---|---|---|---|
| **tnl** (runs both) | **+274** | −160 | +180 | **+293** |
| Forge today, Advanced only | **−16** | 0 | +180 | +164 |
| Forge + low tiers | −16 | 0 | +180 | +284 |
| Forge + Elaborate at tnl's volume (117) | −16 | **−208** | +180 | **−44** |
| Forge + Elaborate at 58 chains | −16 | −103 | +180 | +61 |
| Forge + Elaborate at 40 chains | −16 | −71 | +180 | +93 |

**tnl's Advanced generates +274 scope. Forge's generates −16.** The whole
difference is success rate — tnl runs Blast from the Past at 89.7% and Window of
Opportunity at 97.0% against Forge's 79.0% and 86.7%.

⚠️ **tnl pays for Elaborate out of an Advanced surplus Forge does not have.** So
the three things Forge wants — drop the cheap crimes, unlock Elaborate, run it at
volume — are **mutually exclusive at current success rates**. Any two work; all
three go negative. This is the community expectation made concrete: *"you're
somewhat expected to do lower OCs to farm scope in times of need."*

## 7. Recommendation

1. **Raise Advanced success before unlocking.** Ten points on Blast from the Past
   and Window of Opportunity is worth roughly **+150 scope per 180 days** — enough
   to fund Elaborate *and* drop the cheap crimes. It also lifts the $6.69M/person-day
   rate directly. It is a bigger lever than Elaborate and than the low-tier cull.
2. **If unlocking now, cap at 40–60 chains per 180 days** and keep the low tiers as
   scope farms until Advanced catches up.
3. **Expect a ramp.** tnl's Elaborate CPRs (60–68) sit *below* their Advanced
   (71–78); these roles start low and climb. The figures above are the steady state.

## 8. What was wrong on the way here

- ⚠️ **"Forge is about 3 CPR points behind tnl, so it can crew Elaborate."** The 3
  points were measured on **Advanced** roles and applied to Elaborate — an untested
  cross-crime extrapolation presented as a measurement. Caught by MonChoon.
- ⚠️ **"CPR looks crime-level rather than role-level."** An artifact of same stat
  family on an evenly-developed roster. Caught by MonChoon. See `oc-cpr-mechanics.md`.
- ⚠️ **The issue claimed a three-link chain "returns up to 18 scope for a single
  spend of 5"**, making Elaborate a scope machine. Backwards — scope is repaid only
  at the terminal link, so chains are scope-**negative**. This had been in the issue
  since it was filed.
- ⚠️ **Window of Opportunity was reported at $1.06M/person-day.** `coalesce` does not
  replace zero, so 77 Priceless Paintings at $70M each were valued at nothing. Real
  figure $4.63M. Caught by MonChoon asking how items were priced.
- ⚠️ **"Break the Bank shows no measurable gain from CPR."** Coarse bucketing hid the
  gradient; equal-count buckets give 69.4% at 62–67 against 78.8% at 67–71.
- ⚠️ **A donor chosen on held-out MAE from n=7** picked a DEX/Forgery role to predict
  a Racing one. Fixed by requiring n≥25 for a trusted donor and letting the stat
  family break ties below that.

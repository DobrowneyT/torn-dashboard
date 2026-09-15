# What actually determines CPR

How Torn computes Checkpoint Pass Rate, as far as the community has established it,
cross-checked against what our own tenant databases measure.

This is the **mechanics** record. `oc-cpr-algorithm.md` is the decision record for the
minimum-CPR algorithm we publish (#688) and assumes what is written here.

⚠️ **Provenance is marked throughout.** Torn does not publish the formula. Nearly
everything below is community reverse-engineering, and the parts we have checked
ourselves are marked as such. Treat an unmarked claim as *plausible and widely
repeated*, not as fact.

## Sources

| | |
|---|---|
| **[OCs 2.0] Anatomy of an Organized Crime** — Emforus, 19/12/24, last reply 17/08/26 | `torn.com/forums.php?p=threads&f=61&t=16438960` |
| **The Newbie's OC 2.0 Guide** — Aidaaa, 29/07/26 | `torn.com/forums.php?p=threads&f=61&t=16587624` |
| Aidaaa's collated guide | `aidapaul.github.io/torn-happy-jumps/oc-guide.html` |
| Our own tenant databases | measured 2026-09-13/14, five factions |

---

## The headline: CPR is per ROLE, not per crime

> *"CPR is determined by the role you joined and its stat requirements."* — Emforus

⚠️ **We got this wrong once and it is worth recording why**, because the mistake is
easy to repeat from our own data.

Measuring the spread of one member's CPR across the roles *within* a crime, on tnl:

```
Break the Bank         1.82     Ace in the Hole     10.67
Window of Opportunity  1.48     Stacking the Deck    8.21
```

That looks like "CPR is a property of the crime". It is not. Break the Bank's roles are
Muscle, Robber and Thief — **all battlestat roles**, so they move together. Ace in the
Hole contains **Driver**, which runs on Racing, a skill nothing else in the game uses.

The apparent per-crime behaviour was **same stat family**, plus a donor faction whose
members have uniformly developed stats. A faction with unbalanced members would not
show it.

## What raises each role

Collated by Aidaaa from community testing; the per-role attributions are
**community-established, not admin-confirmed**.

| Role | Driven by |
|---|---|
| Muscle, Enforcer | STR + DEF, plus END. *(Disposal tested and ruled out.)* |
| Thief, Robber | DEX + SPD, plus Shoplifting / Burglary |
| Picklock | DEX, plus Forgery *(confirmed by players training it from scratch)* |
| Sniper | DEX + SPD |
| Hacker, Techie | **Cracking** |
| Engineer, Bomber | **Forgery** |
| Hustler, Negotiator, Imitator | **Hustling + Scamming** |
| **Driver, Hijacker** | **Racing** — *"needs real CE behind it too"* |
| Assassin | **Hunting** |
| Reviver | Reviving. Highest-weight role found anywhere: 46% of Manifest Cruelty |
| Interrogator, Saboteur, Decoy | ⚠️ **Unknown.** Too recent for anyone to have isolated a driver |

## Crime Experience gates everything, and multiplies

> *"CE still has bearing in 2.0, namely, it acts as a **multiplier** to the other
> factors that determine CPR. If your baseline CPR is low … you may find your CPR
> lower than your peers, even if your CE is far higher than theirs."* — Emforus

⚠️ **This is why cross-crime CPR relationships are not offsets.** If CE scales the
other factors, mapping a member's CPR from one crime to another is affine with a
**slope**, not a constant shift. We measured slopes of 0.93–1.04 between adjacent
difficulties and **~2.0** across a large difficulty gap (Bidding War d6 Driver →
Ace in the Hole d9 Driver, n=7, R² 0.98).

## Ceilings, of which there are at least two

1. **CPR itself is capped at 100 and integer-valued.** 7,464 readings across two
   tenant databases contained **zero** fractional values — measured, ours.
2. **Battlestats stop mattering around 1B**; past that, further CPR needs crime skills
   and CE. *Community belief, not confirmed.*
3. Workstats are theorised to stop mattering around **300k**. *Speculation, flagged as
   such in the source.*
4. Crime-skill effects continue **past CS100**: *"grinding any of these crimes will
   further increase your CPR."*

⚠️ Ceiling 1 is why a weak member gains far more than a strong one when moving to an
easier crime. Measured on forge, same crime pair, by CPR band:

```
                       LOW (~37)   MID (~57)   HIGH (~70)
Pet Project (d1)          +53.8       +39.3       +27.4
Market Forces (d3)        +46.8       +35.7       +25.2
Dish It Out  (d6)         +25.0       +27.9       +19.3
```

**A single offset per crime pair is therefore wrong across large difficulty gaps.** It
is safe only where both crimes sit well below the ceiling — which, for
Advanced (d7–8) → Elaborate (d8–9), it does.

## Checkpoints, and why weight beats CPR

Every OC is a graph of checkpoints, each tied to one or more roles.

| Kind | Failing it |
|---|---|
| **Mainline** | Drops to a lower branch, not an instant loss |
| **Recovery** | Returns you to the mainline as if you had passed |
| **Lenient** | A mainline check with two stacked recovery chances. Common early |
| **Critical** | Forces a worse branch, **~20–30% less reward** |
| **Determinant** | Can end the OC outright, usually only after an earlier fail |

> *"letting you put weaker members in lenient roles and stronger members in critical
> roles"* — Emforus

⚠️ That is the **carry-role strategy**, arrived at independently in #692/#694 before we
had read any of this. It is the same idea: a low-weight role tolerates a low CPR, so
publishing a bar for it is wasted training.

One account reports an OC surviving **four** separate checkpoint failures. It is
*consecutive* failures that sink a run, not any single one.

## Chains

> *"These OCs start appearing at level 5, and the generated OC will always be one level
> higher than the preceding one. To receive a reward, **all** OCs within the chain must
> be successfully completed, as **only the final OC in the chain will provide
> rewards**."*

✅ Confirms the model in `ocChains.js` exactly, including the correction made in
#712/#715 — scope is paid once at the root and repaid only at the terminal link. An
earlier draft of #602 claimed a three-link chain "returns up to 18 scope for a single
spend of 5"; that was backwards, and this is the independent confirmation.

## Scope

> *"Scope regenerates passively, 1/day … obtained by successfully clearing OCs at a rate
> of 1 + OC tier … cap of 100, once you reach 100 any additional scope obtained will be
> lost."*

✅ Matches `config.ocCategories` — cost = tier, reward = tier + 1.

⚠️ **And a warning that bears on any Advanced-only plan:**

> *"you're expected to run at a deficit if your faction's constantly running high-level
> OCs … Reaching the required success rate for level 8+ OCs becomes significantly harder
> for most factions, so you're **somewhat expected to do lower OCs to farm scope** in
> times of need, then return to high level OCs once you've recovered."*

Our own measurement put forge's sustainable floor at ~75% average Advanced success,
funded by regeneration alone. The community expectation is that factions cycle back to
cheap crimes deliberately. **Watch the balance rather than trusting the floor.**

---

## Predicting an unobserved role's CPR

For #602 — estimating a faction's Elaborate CPRs before it has unlocked Elaborate.

**Method.** Fit `target = slope × source + intercept` on a donor faction whose members
carry readings for **both** roles, then apply to the subject faction's own readings.

**Out-of-sample error**, held-out halves of tnl, 200 shuffles per role:

| | MAE | p90 | worst |
|---|---|---|---|
| Same stat family, adjacent difficulty | **0.3–0.6** | ~1.0 | ~2 |
| Cross-family | 0.9–1.7 | ~2 | ~4 |
| ⚠️ **Driver, from any non-Racing role** | **2.4–2.9** | **6.4** | 9.7 |
| Driver, from Bidding War Driver (capacityx, n=7) | **0.77** | — | 1.8 |

⚠️ **CPR is integer-valued, so an MAE of 0.3–0.6 is at the rounding floor.** There is no
modelling headroom left for same-family pairs. Measured and rejected: unweighted
ensembles across 26 sources (**worse**, 1.44 vs 0.97), inverse-variance weighting
(no change), fitted lines instead of flat offsets (no change in aggregate — but see
below).

### What actually helps

1. **A same-stat-family donor at an adjacent difficulty.** In 6 of 8 targets a
   residual-minimising search already picked exactly that, unprompted.
2. **A fitted line, not a flat offset**, wherever the difficulty gap is large. The slope
   is the CE multiplier showing through.
3. ⚠️ **For Driver, a donor faction that runs a Racing role.** Racing is the only stat no
   other role uses, so no amount of modelling recovers it — this is the one genuine
   data-collection gap. tnl cannot help: it runs no crime containing a Driver.

### ⚠️ What does NOT work: hardcoding "always match the stat family"

`Hostile Takeover / Engineer` (forgery) predicts **better** from `Break the Bank /
Thief #1` (d8, wrong family) at MAE 0.91 than from `Blast from the Past / Engineer`
(d7, right family) at 1.37. With CE as a multiplier, **difficulty proximity can outweigh
stat family**. Select the donor on measured residual and use the family table to
predict *where selection will fail*, not to override it.

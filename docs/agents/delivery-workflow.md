# Delivery Workflow

The per-change conventions the [`delivery`](../../.claude/agents/delivery.md) agent
follows in **implement mode**, and the checklist any contributor (human or agent)
should use when landing a change on `dev`. This is the canonical reference; the agent
definition summarizes it.

> **Every change — feature *and* bug fix, no exceptions — branches off `dev`,
> PRs into `dev`, and reaches production only via a separate, approved
> `dev → main` merge.** Never branch off `main`, never PR into `main`, never
> force-push `main`.
>
> Why it is unconditional: `deploy/update.sh` deploys **whatever branch the
> server checkout is on**, and the production checkout is on **`main`
> permanently**. Anything that lands on `main` is live for every tenant within
> ~5 minutes. See [Where a merge actually goes](#where-a-merge-actually-goes).

## The loop, per issue

1. **Branch off `dev`.** Name it `feat/<issue>-<slug>` or `fix/<issue>-<slug>`
   (e.g. `feat/159-dibs-claim-timeout`). Always branch from an up-to-date `dev`.

2. **TDD where a seam exists** (`/tdd`). Write the failing test first, then the
   minimal code to pass it. Test at the **highest existing seam**:
   - Server: black-box HTTP / ticker tests against real templated Postgres
     (`server/test/*.test.ts`). Prefer extending an existing test file.
   - Frontend: pure, util-level tests (`frontend/src/**/__tests__/*.test.js`).
     Extract decision logic into a util and test that, rather than rendering.
   Some changes (docs, config, pure UI) have no meaningful seam — say so and skip.

3. **Schema changes touch both files.** A new column/table gets an idempotent
   `db/migrations/000N-*.sql` (`ADD COLUMN IF NOT EXISTS`, etc.) **and** the same
   change in `db/template.sql`. `deploy/update.sh` runs `db/migrate.mjs` per faction
   DB on deploy. Never write a blanket migration that would wrongly change every
   tenant (e.g. pinning a per-faction setting) — document those as one-time writes.

4. **CHANGELOG line.** Add a terse bullet under `## [Unreleased]` in `CHANGELOG.md`,
   referencing the issue: `- Collaborative war notes (#160)`. Group under
   `### Added` / `### Changed` / `### Fixed`. Keep a Changelog, lite.

5. **Version bump.** The repo-root **`VERSION`** file is the single source of truth;
   keep **all four** `package.json` files in sync with it — root, `frontend/`,
   `server/` and `db/`. Do not do it by hand:

   ```bash
   echo 3.147.0 > VERSION && node scripts/check-version-sync.mjs --fix
   ```

   ⚠️ This step used to say "the root `package.json`", but all four have been
   kept in sync in practice since the workspace split, and CI now **fails** when
   they disagree (`scripts/check-version-sync.mjs`, run by the Changelog Gate
   and by `npm test`). `VERSION` feeds the footer and `/api/health`; the package
   files feed npm and the Docker builds — a mismatch means the dashboard reports
   a version that was never built. It has happened twice: **3.142.1** shipped
   with all four package files a version behind, and PR #804 was caught by hand
   during a rebase.

   Level follows the change:

   | Change type | Bump | Example |
   |---|---|---|
   | `feat` (new capability) | **minor** | 3.0.0 → 3.1.0 |
   | `fix` (bug fix, no new API) | **patch** | 3.1.0 → 3.1.1 |
   | breaking (removes/renames a contract, migration users must act on) | **major** | 3.1.1 → 4.0.0 |

   A human may **override** the level (state it in the issue). When you cut a release,
   promote `## [Unreleased]` to a dated `## [X.Y.Z]` heading whose version equals
   `VERSION`; the footer (`VITE_APP_VERSION`, read from `VERSION` at build) and
   `/api/health` (read at runtime) surface it automatically.

   > Batching note: while the `delivery` agent workflow is still being proven, a run
   > of related staging-only features may accumulate lines under `[Unreleased]` and
   > take a single version bump when a release is cut, rather than one bump per PR.
   > Once the CI gate (#165) lands, per-PR bumps become the enforced norm.

6. **Verify honestly.** Run the affected suites
   (`npm run test:run --workspaces --if-present`) and, for frontend/JSX or container
   changes, `npm run build -w frontend`. If something fails or was skipped, say so.

7. **Open the PR to `dev`** with `Closes #<issue>` in the body — for the link,
   **not** for the close. GitHub only honours that keyword when a PR merges into
   the **default branch** (`main`), so on a `dev` PR it cross-references the
   issue and nothing more. The issue stays open until promotion (step 9), which
   is the honest state: the fix is on staging, not in front of anyone.

   **Enable auto-merge once required checks pass** — this is the default:

   ```
   gh pr merge <pr> --auto --merge
   ```

   **Opt out** — do NOT auto-merge — when any of these hold:
   - the issue carries the **`hold-merge`** label, or
   - the issue text asks to hold / test on staging first, or
   - the change wants a human to eyeball it before it can be promoted.

   Merging to `dev` reaches **no live tenant**, which is what makes auto-merge
   the safe default. It does update the staging instance (#292) within ~5
   minutes when that instance is in auto-follow mode, so the opt-out still
   matters when someone is mid-test on the staging ground.

8. **After merge**, delete the merged branch. **Leave the issue open** — it is
   closed by the promotion that puts the fix in front of users, not by the merge
   that puts it on staging. Comment on it if the outcome differs from what the
   issue asked for (a re-scope, a part that turned out impossible), so the
   closing comment in step 9 is not the first anyone hears of it.

9. **Promotion to production is a separate act.** `dev` accumulates until a human
   decides to ship: cut the release (promote `[Unreleased]` to a dated heading
   matching `VERSION`), then open and merge a `dev → main` PR. **The delivery
   agent never does this on its own** — delivering an issue ends at `dev`.

   **The promotion PR body MUST carry a `Closes #<issue>` line for every issue in
   the batch.** This is the one PR that merges into the default branch, so it is
   the only place the keyword actually fires — and it fires at the right moment,
   because that is when the fix becomes real for the people who reported it.

   ```markdown
   Promote dev → main: v3.15.0 → v3.18.0

   Closes #356
   Closes #357
   Closes #358
   Closes #376
   Closes #382
   ```

   Without these lines, delivered issues silently accumulate as open. That is
   exactly what happened up to v3.18.0: #358, #376 and #382 were all live in
   production while still sitting open, because every `Closes #` had been written
   on a `dev` PR where it could never take effect. Nothing warns you — the PR
   renders the reference, the merge succeeds, and the issue just stays open.

   Get the list from the commit range rather than from memory:

   ```bash
   git log --oneline origin/main..origin/dev | grep -oE '#[0-9]+' | sort -u
   ```

   Read that as a starting point, not an answer. Run against the real v3.18.0
   promotion it returns thirteen numbers:

   ```
   #356 #357 #358 #371 #374 #375 #376 #378 #379 #381 #382 #383 #384
   ```

   Only **five** of those are issues the batch resolved (#356, #357, #358, #376,
   #382). Seven are the PRs themselves (#374, #375, #378, #379, #381, #383,
   #384) — squash-merge appends the PR number to every subject line — and #371
   is an earlier issue mentioned for context, already closed.

   So check each number is an issue this batch actually resolves before listing
   it. Closing the wrong issue is worse than leaving one open: a wrongly-closed
   issue looks handled, and nobody goes back to check.

## Where a merge actually goes

| Merge | Deploys to | Who approves |
|---|---|---|
| feature branch → `dev` | nothing live; the staging instance if it is auto-following (#292) | auto-merge on green |
| `dev` → `main` | **production — every tenant, within ~5 minutes** | a human, deliberately |

`deploy/update.sh` on the VPS runs `--if-changed` every 5 minutes and deploys
**the branch its checkout is on**. That checkout is on `main` and **stays on
`main` in perpetuity** — it is the deploy model, not a migration leftover.
Staging is a *separate git worktree* with its own script, compose project, lock
file and `faction_*_dev` databases (`deploy/dev-deploy.sh`, see
`deploy/DEV.md`); the two cannot deploy over each other.

## Required checks

The PR's required status checks are the repo's CI: **Node tests** (vitest —
frontend/server/db), **Python tests** (pytest), and the **Compose build + boot
check**. Auto-merge waits for all of them to pass.

## The changelog gate (#165)

`.github/workflows/changelog-gate.yml` checks that a PR changing source under
`frontend/`, `server/`, or `db/` also updates `CHANGELOG.md` (and `VERSION`, once
`REQUIRE_VERSION` is turned on). It's rolling out in two phases:

- **Phase 1 (current): warn-only.** `WARN_ONLY: 'true'` — the job annotates the PR
  and writes a job summary but **never fails** it, so we can confirm it doesn't
  misfire before it can block anyone.
- **Phase 2: enforce.** Flip `WARN_ONLY` to `'false'` (and `REQUIRE_VERSION` to
  `'true'` when per-PR bumps become the norm — see the batching note above), then add
  **"Changelog + version check"** as a required status check in branch protection so
  it blocks merge.

**Escape hatch** for a legitimate no-bump PR (test-only, pure refactor, tooling): add
the **`no-changelog`** label, or put `[skip changelog]` in the PR body. The gate does
not fire on docs-only / non-source PRs at all.

## The `hold-merge` label

`hold-merge` is the documented opt-out from auto-merge-on-green. Apply it to an issue
(or PR) that a human should read before it even lands on `dev` — risky infrastructure,
deploy tooling, anything whose review matters more than its speed. Absent the label
(and absent an explicit hold in the issue), the default is auto-merge once CI is green.

It is not the control that keeps a change off production — the `dev → main` gate
already does that, unconditionally, for every change.

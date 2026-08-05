# Delivery Workflow

The per-change conventions the [`delivery`](../../.claude/agents/delivery.md) agent
follows in **implement mode**, and the checklist any contributor (human or agent)
should use when landing a change on `dev`. This is the canonical reference; the agent
definition summarizes it.

> Applies to feature work, which branches off and merges into **`dev`**.
> `main` is **live production** (the self-hosted stack); an approved **`dev → main`**
> merge is what promotes to production.

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
   keep the root `package.json` `version` in sync with it. Level follows the change:

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

7. **Open the PR to `dev`** with `Closes #<issue>` in the body. **Enable auto-merge
   once required checks pass** — this is the default:

   ```
   gh pr merge <pr> --auto --merge
   ```

   **Opt out** — do NOT auto-merge — when any of these hold:
   - the issue carries the **`hold-merge`** label, or
   - the issue text asks to hold / test on staging first, or
   - the change wants a human to eyeball staging before it's live.

   Auto-merge ⇒ **auto-deploy to staging** within ~5 minutes via the `dev` cron.
   That blast radius is why the opt-out exists.

8. **After merge**, close the issue manually (a PR to `dev` does not auto-close it),
   and delete the merged branch.

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
(or PR) whose change must be verified on staging, or released deliberately, before it
reaches the live path. Absent the label (and absent an explicit hold in the issue),
the default is auto-merge once CI is green.

# torn-forge-oc-system

TNL faction management dashboard for Torn (React SPA + Supabase, migrating to a self-hosted multi-faction stack — see `dashboard-migration.md` for the roadmap of record). Two sibling projects that used to live here have been extracted to their own repos — the Discord bot (`DobrowneyT/torn-discord-bot`) and mug-bot (`DobrowneyT/torn-mug-bot`); this repo is now just the dashboard.

## Branch policy

`main` is the live production site (GitHub Pages deploys from it) and must stay intact throughout the multi-faction migration. All work on the migration issues (#59–#76, parent PRD #58) branches from and merges into **`dev`** — never commit migration work directly to `main`. `main` only receives urgent fixes for the live site.

## Agent skills

### Issue tracker

Issues and PRDs live in this repo's GitHub Issues (`gh` CLI); external PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 to their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), all created on the repo. See `docs/agents/triage-labels.md`.

### Domain docs

Single context (Dashboard): `CONTEXT-MAP.md` at the root points at the Dashboard glossary (root `CONTEXT.md`). See `docs/agents/domain.md`. (The Discord bot and mug-bot are now separate repos.)

### Delivery agent

The `delivery` agent (`.claude/agents/delivery.md`) authors issues (`/to-prd` → `/to-issues`) and implements ready-for-agent issues end-to-end. The per-change conventions it follows — branch off `dev`, TDD, CHANGELOG line, `VERSION`+`package.json` bump, PR with `Closes #`, auto-merge-on-green with the `hold-merge` opt-out — are the canonical checklist in `docs/agents/delivery-workflow.md`.

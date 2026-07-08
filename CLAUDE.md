# torn-forge-oc-system

TNL faction management dashboard for Torn (React SPA + Supabase, migrating to a self-hosted multi-faction stack — see `dashboard-migration.md` for the roadmap of record). The repo also hosts two sibling projects: the Discord bot (`discord/`) and mug-bot (`mug-bot/`) — see `CONTEXT-MAP.md`.

## Branch policy

`main` is the live production site (GitHub Pages deploys from it) and must stay intact throughout the multi-faction migration. All work on the migration issues (#59–#76, parent PRD #58) branches from and merges into **`dev`** — never commit migration work directly to `main`. `main` only receives urgent fixes for the live site.

## Agent skills

### Issue tracker

Issues and PRDs live in this repo's GitHub Issues (`gh` CLI); external PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 to their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), all created on the repo. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: `CONTEXT-MAP.md` at the root points at the Dashboard (root `CONTEXT.md`), Discord bot, and mug-bot contexts. See `docs/agents/domain.md`.

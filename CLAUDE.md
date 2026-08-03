# torn-forge-oc-system

TNL faction management dashboard for Torn — a self-hosted multi-faction stack (React SPA + Node/Fastify + Postgres, deployed via Docker Compose on a VPS). The legacy single-tenant Supabase + GitHub Pages app was retired at the production cutover (#195); `dashboard-migration.md` remains the roadmap of record for the migration's history and the remaining cleanup (#132 repo rename, #135 legacy-superset deletion). Two sibling projects that used to live here have been extracted to their own repos — the Discord bot (`DobrowneyT/torn-discord-bot`) and mug-bot (`DobrowneyT/torn-mug-bot`); this repo is now just the dashboard.

## Branch policy

`main` is **live production** — the self-hosted stack serving all tenants. `dev` is the **permanent staging ground**. Features branch off `dev`, merge into `dev` (each PR green on CI), and an approved **`dev → main`** merge is what promotes to production. Never force-push `main`.

## Agent skills

### Issue tracker

Issues and PRDs live in this repo's GitHub Issues (`gh` CLI); external PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 to their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), all created on the repo. See `docs/agents/triage-labels.md`.

### Domain docs

Single context (Dashboard): `CONTEXT-MAP.md` at the root points at the Dashboard glossary (root `CONTEXT.md`). See `docs/agents/domain.md`. (The Discord bot and mug-bot are now separate repos.)

### Delivery agent

The `delivery` agent (`.claude/agents/delivery.md`) authors issues (`/to-prd` → `/to-issues`) and implements ready-for-agent issues end-to-end. The per-change conventions it follows — branch off `dev`, TDD, CHANGELOG line, `VERSION`+`package.json` bump, PR with `Closes #`, auto-merge-on-green with the `hold-merge` opt-out — are the canonical checklist in `docs/agents/delivery-workflow.md`.

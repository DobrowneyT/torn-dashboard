# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. For the Discord bot and mug-bot contexts, also check their own `docs/adr/` directories for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This is a **multi-context repo**: three co-existing projects share it. The dashboard is the primary context and owns the repo root; the Discord bot and mug-bot are self-contained contexts in their own directories.

```
/
├── CONTEXT-MAP.md            ← points at the three contexts
├── CONTEXT.md                ← Dashboard context (src/, supabase/, scripts/, docs/)
├── docs/adr/                 ← dashboard + system-wide decisions
├── discord/
│   ├── CONTEXT.md            ← Discord bot context
│   └── docs/adr/
└── mug-bot/
    ├── CONTEXT.md            ← Mug-bot context
    └── docs/adr/
```

Note: after the planned multi-faction re-architecture (`dashboard-migration.md`), the dashboard context will span the new `frontend/`, `server/`, `db/`, and `deploy/` directories — it remains one context unless its vocabularies diverge.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_

# Context Map

This repository is a single context: the **Dashboard**. It has (or will lazily grow) its own `CONTEXT.md` glossary and `docs/adr/` decisions.

| Context | Scope | Glossary | ADRs |
|---|---|---|---|
| **Dashboard** | The TNL faction management website: `src/`, `frontend/`, `server/`, `db/`, `deploy/`, `supabase/`, `scripts/`, `docs/`, CI workflows | [CONTEXT.md](CONTEXT.md) | [docs/adr/](docs/adr/) |

The `CONTEXT.md` file and ADR directory are created lazily by `/domain-modeling` when terms or decisions actually get resolved — absence is expected, not an error.

Two sibling projects were extracted to their own repositories (each with its own context docs): the **Discord bot** → `DobrowneyT/torn-discord-bot`, and **mug-bot** → `DobrowneyT/torn-mug-bot`.

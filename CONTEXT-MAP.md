# Context Map

Three co-existing projects share this repository. Each has (or will lazily grow) its own `CONTEXT.md` glossary and `docs/adr/` decisions.

| Context | Scope | Glossary | ADRs |
|---|---|---|---|
| **Dashboard** (primary) | The TNL faction management website: `src/`, `supabase/`, `scripts/`, `docs/`, CI workflows | [CONTEXT.md](CONTEXT.md) | [docs/adr/](docs/adr/) |
| **Discord bot** | `discord/` | [discord/CONTEXT.md](discord/CONTEXT.md) | discord/docs/adr/ |
| **Mug-bot** | `mug-bot/` (userscripts + analysis tooling) | [mug-bot/CONTEXT.md](mug-bot/CONTEXT.md) | mug-bot/docs/adr/ |

The per-context `CONTEXT.md` files and ADR directories are created lazily by `/domain-modeling` when terms or decisions actually get resolved — absence is expected, not an error.

System-wide decisions that cross contexts live in the root `docs/adr/`.

# Claude Context

See @AGENTS.md for full documentation.

## Quick Reference

- **Stack**: Bun + Turborepo + TypeScript + Biome
- **Binary**: `warden` (apps/cli, `bun run --cwd apps/cli install:global`)
- **Docs**: apps/docs (Fumadocs), `bun run --cwd apps/docs dev` → :3210

## Commands

```bash
bun run dev       # Dev server(s)
bun run typecheck # Type check
bun run build     # Production build
bun run check     # Biome lint + format
bun run test      # Tests
```

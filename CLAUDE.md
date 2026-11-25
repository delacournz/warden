# Claude Context

See @AGENTS.md for full documentation.

## Quick Reference

- **Stack**: Bun + Turborepo + TypeScript + Biome
- **Binary**: `warden` (apps/cli, `bun run --cwd apps/cli install:global`)
- **Docs**: apps/docs (Fumadocs), `bun run --cwd apps/docs dev` → :3210

## Commands

```bash
bun run dev       # Dev server(s)
bun run dev:web   # Docs site only (:3210)
bun run typecheck # Type check
bun run build     # Production build
bun run check     # Biome lint + format
bun run test      # Tests
bun run cli:link   # ~/.local/bin/warden → this checkout's source (shim)
bun run cli:unlink # put back whatever warden was before cli:link
bun run cli:link:viewer # build apps/viewer (debug; -- --release), then link with WARDEN_VIEWER_PATH set in the shim; -- --login <api-url> [--account <name>] logs in after
```

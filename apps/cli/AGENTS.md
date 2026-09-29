# @warden/cli

The `warden` binary. `src/cli.ts` dispatches to `src/commands/<name>.ts` (registered in `commands/registry.ts`).

## Patterns
- Each command exports `<name>Command: Command` with `run(ctx: CommandContext) → exit code`.
- All I/O through `CommandContext` (`out`/`err`/`store()`/`exec`/`now`/`env`) — tests use `testing.ts` `testContext()` + `fakeExec()`.
- Parse flags with `node:util` `parseArgs`; every command supports `--json` via `output.ts` `emit()`.
- Devices come from `providers.ts` `providerFor(platform, ctx)`.

## Build
- `bun run build` → `dist/warden` (bun --compile)
- `bun run install:global` → `~/.local/bin/warden`

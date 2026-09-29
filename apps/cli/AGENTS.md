# @warden/cli

The `warden` binary. `src/cli.ts` dispatches to `src/commands/<name>.ts` (registered in `commands/registry.ts`).

## Patterns
- Each command exports `<name>Command: Command` with `run(ctx: CommandContext) → exit code`.
- All I/O through `CommandContext` (`out`/`err`/`store()`/`exec`/`now`/`env`) — tests use `testing.ts` `testContext()` + `fakeExec()`.
- Parse flags with `node:util` `parseArgs`; every command supports `--json` via `output.ts` `emit()`.
- Devices come from `providers.ts` `providerFor(platform, ctx, owner)`; claim flags + owner resolution in `claim-flags.ts`; lease selection (`<id…>|--udid|--mine|--session`) in `lease-select.ts`.
- `hooks/`: Claude Code hook handlers (`claude-pretool.ts`: PreToolUse/SessionEnd), settings merge, argent rule patch, text diff. Hook failures never block a tool (exit 0).
- `assets/`: text assets embedded in the binary (`warden-skill.md` via `import … with { type: "text" }`).
- `warden install` never touches `~/.claude` without showing a diff + confirm (`--yes` / `--dry-run`); tests use a temp `HOME`.

## Build
- `bun run build` → `dist/warden` (bun --compile)
- `bun run install:global` → `~/.local/bin/warden`

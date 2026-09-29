# @warden/cli

The `warden` binary. `src/cli.ts` dispatches to `src/commands/<name>.ts` (registered in `commands/registry.ts`).

## Patterns
- Each command exports `<name>Command: Command` with `run(ctx: CommandContext) → exit code`.
- All I/O through `CommandContext` (`out`/`err`/`store()`/`exec`/`now`/`env`) — tests use `testing.ts` `testContext()` + `fakeExec()`.
- Parse flags with `node:util` `parseArgs`; every command supports `--json` via `output.ts` `emit()`.
- Devices come from `providers.ts` `providerFor(platform, ctx, owner)`; claim flags + owner resolution in `claim-flags.ts`; lease selection (`<id…>|--udid|--mine|--session`) in `lease-select.ts`.
- `hooks/`: agent hook handlers (`claude-pretool.ts`: PreToolUse/SessionEnd, shared by Claude Code and Codex: same stdin JSON + exit-2 blocking), hook-config merge (`claude-settings.ts` `mergeWardenHooks`; `codex-hooks.ts` for `$CODEX_HOME/hooks.json`), agent detection (`agents.ts`), argent rule patch, text diff. Hook failures never block a tool (exit 0).
- `assets/assets.d.ts`: `*.md` text-import typing. The skill lives at repo-root `skills/warden/SKILL.md`, embedded via `src/skill.ts`.
- `warden install` targets detected agents (or `--claude` / `--codex`) and never touches `~/.claude` / `~/.codex` without showing a diff + confirm (`--yes` / `--dry-run`); tests use a temp `HOME` (detection reads `ctx.env.PATH`, never the process PATH).
- `update/`: build info (`dev`/`local`/`release`, embedded via `--define __WARDEN_BUILD__=<json>`), semver, GitHub release lookup/download (gh), source build, atomic binary install with self-check.

## Build
- `bun run build` → `dist/warden` (channel `local`, records this checkout; `scripts/build.ts`)
- `bun run build:release` → `dist/warden-{darwin,linux}-{arm64,x64}` + `checksums.txt` (CI, on `v*` tags)
- `bun run install:global` = `bun src/cli.ts update` → `~/.local/bin/warden`
- Never compile without `scripts/build.ts` / `compileArgs` — a binary without build info can't update itself.

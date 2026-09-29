# @warden/cli

The `warden` binary. `src/cli.ts` dispatches to `src/commands/<name>.ts` (registered in `commands/registry.ts`).

## Patterns
- CLI framework: **commander** via `@commander-js/extra-typings` (typed args + opts, no `any`). Each command is `defineCommand({ name, summary, aliases?, register })` in `src/commands/<name>.ts` (registered in `commands/registry.ts`). `register(cmd, ctx, done)` adds `.argument()`s, `.option()`s and nested `cmd.command(...)` subcommands; every `.action()` calls a plain function `(ctx, args…, opts) → Promise<number>` and reports it with `done(code)`. `xCommand.run(ctx)` parses `ctx.argv` (what tests call); `runProgram` builds a fresh program per run.
- Usage errors (unknown option, missing/excess args) are commander's: printed in red to `ctx.err`, exit 1; `--help` → exit 0. Validate values (durations, ints, platforms) in the action and print `color.red("warden <cmd>: …")` + return 1.
- Shared option sets are typed helpers: `withClaimOptions(cmd)` (claim + run), `withSelectOptions(cmd)` (release + heartbeat). Every command keeps `--json` (stdout = one JSON document, nothing else on stdout).
- UI lives on `ctx.ui` (`ui.ts`): `color` (chalk instance — respects NO_COLOR/FORCE_COLOR/TTY; never import chalk's default instance), `spinner(text)` (ora on stderr; `withSpinner(ctx, text, work)` routes the work's `ctx.err` lines above the spinner), `confirm` / `select` (@clack/prompts; `undefined` = cancelled → `ui.cancelled("Aborted.")`, exit 1). Only prompt when `ui.interactive` and no `--yes`; otherwise fail with a message naming the flag. Exception: `warden install` treats a cancelled/declined prompt as "skip that step" and carries on. `warden hook` output is machine-read: no colour, spinners or prompts there.
- All I/O through `CommandContext` (`out`/`err`/`store()`/`exec`/`now`/`env`/`ui`) — tests use `testing.ts` `testContext()` (+ `scriptedUi({ interactive, confirm, select })`, whose `events` log spinners/prompts) and `fakeExec()`.
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

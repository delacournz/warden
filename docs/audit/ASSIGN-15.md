# Assignment 15 · `cli-startup-size` (sonnet, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/15-cli-startup-size.md` and `docs/audit/raw/15-cli-startup-size.jsonl`.

## Improvement goal

Lower the compiled CLI's cold-start time, RSS and binary size (K3: 116 MB binary, 57 MB RSS vs ≤ 50 MB target), find import-graph leaks on hot commands (K4), and check the build/packaging scripts that produce the npm packages and the helper assets.

## Owned files

- `apps/cli/src/{cli,command,context,ui,output,spinner-context,bounded,providers,project-context,running-apps,golden-deps,skill,skill-cli,device-state,install-flags,lease-select,testing,simctl.testing}.ts` and tests (`startup.test.ts`, `help.test.ts`, `cli.test.ts`, `command.test.ts`, `output.test.ts`, …)
- `apps/cli/src/commands/{registry,version,heartbeat,hook,release,check,ls,devices,port}.ts` and tests
- `apps/cli/src/npm/*.ts` (`manifests`, `declarations`, `e2e-bundle`, `e2e-bundle-main`, `e2e-stage`, `helper`, `helper-stage`, `helper-asset`, `config-entry`, `shim`, `shim-main`, `platforms`) and tests (`e2e-bundle.test.ts` pins the dex base64)
- `apps/cli/scripts/{build,npm-packages,helper-asset}.ts`, `apps/cli/src/update/source-build.ts` (`compileArgs`) and `source-build.test.ts`
- `packages/e2e/native/scripts/{deps,build}.ts` and tests (the idb library-package download and `--from-source` path from commit bd8a238)
- Read-only context: `apps/cli/AGENTS.md` (cold start paragraph, Build section); `docs/plans/wdn-perf.md` PERF-4.1, PERF-4.2 and the Follow-ups row for starter.

Not yours: `update/*` (except `source-build.ts`), `hooks/*`, `commands/{install,update,doctor,doctor-helper}.ts` (not audited; agent 20 may read them).

## Starting hotspots

- `startup.test.ts`: what it asserts for `version`/`heartbeat`/`claim`/`gc`/`release`/`ui <sub>`/`batch`, and which hot commands have no allowlist (K4: `run`/`dev`). You may run it (`WARDEN_HOME=... bun test apps/cli/src/startup.test.ts`) to list the modules each command loads; report the heaviest modules per command.
- Static imports on the dispatch path: `cli.ts` → `command.ts` → `registry.ts` → `context.ts` (`terminalUi` lazy?) → `output.ts`; zod, commander, chalk, ora, clack load points.
- Binary size: `compileArgs` (`--minify --bytecode --sourcemap=linked`), what pulls `typescript` into the bundle (`graph-worker`, `declarations.ts`?) and whether it can be a separate entry; the `uiad-dex.generated.ts` base64 (~33 KB) inlined into both the e2e bundle and the CLI binary; `skill.ts` embedding `skills/warden/**` markdown.
- `e2e-bundle.ts` / `e2e-stage.ts`: `Bun.build` externals (`bun:test`, `zod`), chunking, what the published `@delacour/warden-e2e` loads at import (relevant to per-spec-process start).
- `manifests.ts` / `platforms.ts` / `shim-main.ts`: the node shim's startup path (spawn of the platform binary; signal forwarding; exit code propagation).
- `native/scripts/deps.ts`: tarball download + sha256, `--from-source` shallow clone into `~/Library/Caches/warden-idb/src/<tag>`, cache keys; `build.ts`: codesign, `manifest.json`, staging; failure modes on a CI runner.
- `bounded.ts`, `spinner-context.ts`, `output.ts`: any per-line work on hot output paths.

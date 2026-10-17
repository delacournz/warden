# Assignment 12 · `cli-e2e-setup` (opus, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/12-cli-e2e-setup.md` and `docs/audit/raw/12-cli-e2e-setup.jsonl`.

## Improvement goal

Shorten the time from `warden e2e <suite>` start to the first test running, and remove serialisation points in the supervisor (claim → Metro → install → hide → warm → spawn), without weakening teardown.

## Owned files

- `apps/cli/src/commands/e2e.ts` (604), `apps/cli/src/commands/batch.ts` (1856) **except** the functions owned by agent 13 (`summaryJson`/`display` ~383–495, `readRunnerReport` ~541, `startView`…`announceDevices` ~554–587, `watchdog` ~641, the log/screenshot half of `jobRunner` ~677, `report` ~780), `apps/cli/src/commands/batch.testing.ts`
- `apps/cli/src/lease-session.ts` (504), `apps/cli/src/batch/{setup,early-warm,warm-drivers}.ts`, `apps/cli/src/e2e/{bun-runner,jobs,launch,warm-connect}.ts`, `apps/cli/src/metro.ts` (310), `apps/example/warden.config.ts`
- Tests: `e2e.test.ts` (1628) and `batch.test.ts` (1069) are large: grep them for the behaviour you need, do not read them whole; `lease-session.test.ts`, `metro.test.ts`, `early-warm.test.ts`, `warm-drivers.test.ts`, `bun-runner.test.ts`, `jobs.test.ts`, `launch.test.ts`.
- Read-only context: `docs/plans/wdn-perf.md` PERF-4.5, PERF-4.7, PERF-4.8 and the Follow-ups rows for conductor; `apps/cli/AGENTS.md`.

Not yours: `claim-flags.ts` and `sim-windows.ts` (agent 16 owns the headless hide + reboot; cite "see 16" for the fact that it is awaited before `onLeased`), `providers`/`claim.ts` (16), `builds/*` and `config.ts`/`git-facts.ts` (17: cite call counts only), the poller/TUI/verdicts (13).

## Pipeline map (from a prior read; verify every line you use)

P0 dispatch `cli.ts:22` → `runLazyProgram` → `commands/e2e` (statically imports `batch.ts`). P1 select: `findSuite` (git-facts probe + cache-busted `require` of `warden.config.ts`, `builds/config.ts:363`), `changedFiles` = 3 sequential git spawns (`core/affected/git.ts:54-59`, skipped for `--all/--flows/--files`), per-platform graph loop (`affected.ts:151-153`). P2 spec plan: `Bun.which("bun")`, `Bun.resolveSync` preload, `specBundleId` may re-read git + config. P3 run plan: `jobPlan`/`shardFlows` round-robin by sorted id; job timeout = `jobTimeoutMs × biggest shard` (`e2e.ts:555`). P4 pre-claim: `resolveOwner` `Bun.spawnSync` git (`batch.ts:1614`, again `:854`), `maybeAutoGc`. P5 ports: serial `for` (`lease-session.ts:60`). P6 Metro background: `node_modules/.bin/expo start --dev-client --port N`, ready poll `READY_POLL_MS` 150 × `fetch /status` (2 s) + 2 `lsof` when the root header is absent, `readyTimeout` 2 m, prewarm 2 sequential fetches ≤ 5 min each (`metro.ts:260-271`). P7 fingerprint fire-and-forget. P8 claim: legs in parallel (`runLegs` `Promise.all` `:371`), then hide/arrange inside the await before `onLeased` (`claim-flags.ts:186-194`, see 16). P9 early warm (iOS) per device from `onLeased` (`lease-session.ts:346` → `early-warm.ts:38` → `warm-drivers.ts:88`), `WARM_TIMEOUT_MS` 120 s. P10 install per device in parallel per leg (`:230`); `claimAll` joins at `:400`. P11 `buildPools`, `holdLeases` heartbeat 30 s. P12 `startServices` (`batch.ts:1164`) serial: Metro await → `--serve` (poll 500 ms, probe 2 s) → `--record` (10 s start). P13 `preparePools` (`:1405`) → `setupDevices` parallel per device (slim 74 launchctl spawns 8 wide + `sh -c setup`), only after P12. P14 `Promise.all([openOnDevices (no timeout, `:1075`), hideLateWindows (`:1316`)])` at `:1414`, then `settleWarm` barrier `:1418` (`early-warm.ts:59`: one slow device gates every job on every leg). P15 `runGrid` → `runPools` → `runBatch` (`schedule.ts:43`: FIFO per pool, one attempt per worker, retries same worker). P17 teardown (`:1382-1399`): abort warm → `stopServe` 15 s grace → recordings SIGINT 15 s → helpers close → `metro.stop` SIGTERM + `KILL_GRACE_MS` 15 s, all before `batch.json` and the verdict. P19 shutdown-if-pass (`e2e.ts:230-233`: CI `always`, local `idle`). SIGINT: no SIGKILL escalation except the per-job watchdog.

Per-job child: `[bun, test, --preload <preload>, --timeout <t+30000>, ...flows]`, detached, `cwd suite.cwd`; env built at `batch.ts:702-712` + `specEnv` (`bun-runner.ts:89-101`). Per-flow isolation pays bun start + preload + driver connect per flow (150–250 ms claimed).

## Starting hotspots

- Which of P12/P13/P14 could overlap P8–P10 safely (what each actually depends on), and what the critical path to the first job is for: 2 sims cold, 2 sims warm, 1 emulator.
- The warm barrier: per-leg instead of global; warm failure is warn-only but the wait is not.
- Metro: `expo` resolution (`node_modules/.bin/expo` vs `bunx`), 150 ms poll, 2 × 5 min prewarm, `--dev-client` flags; whether `example` (Release) suites skip Metro entirely.
- `e2e.ts`: `shutsDownOnPass` wiring (K10 slim refusal on Android: `platformError`), `--count`, `--devices all`, `--no-warm`, dry-run cost.
- `lease-session.ts`: `claimLegs`, `installLegApp`, `childEnv`, `release()` paths on failure (claim failure releases at `:405`, install failure at `:430`): any lease or helper left behind on a thrown error between them?
- `jobs.ts`/`bun-runner.ts`: shard retry rebuilds argv from failed flows after re-reading `results.jsonl` (K5), per-device vs per-flow mode, `BUN_TIMEOUT_MARGIN_MS` 30 s.
- Teardown: the 15 s graces in series before the report; SIGINT path leaving detached children.
- `apps/example/warden.config.ts`: `slim: true`, `count: 2`, `warmDrivers` default: what the example suite pays per run because of its own config.

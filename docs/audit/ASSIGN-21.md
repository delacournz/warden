# Assignment 21 · `unit-test-suite-speed` (sonnet, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/21-unit-test-suite-speed.md` and `docs/audit/raw/21-unit-test-suite-speed.jsonl`.

## Improvement goal

Make the repo's own `bun test` suites faster and less flaky. This is the one thing that can be measured in this container, and you run **alone**: no other agent is executing tests while you work, so your timings are meaningful (within the noise of a shared cloud container).

## Inputs

- `docs/audit/raw/00-baseline-tests.txt`: the orchestrator's serial baseline (typecheck + `bun run test` per package, pass/fail counts and wall time). Full logs are not committed; re-run what you need.
- Package test scripts: `apps/cli` runs `bun test --timeout 20000`; the others plain `bun test`. 108 test files in `apps/cli`, 92 in `packages/e2e`, 52 in `packages/core`, 36 in `packages/e2e-bench`.
- `AGENTS.md` rule: never run real `simctl`/`adb` in `bun test`; side effects injected; tests use temp `WARDEN_HOME`.

## Method

1. For each package: `cd <pkg> && WARDEN_HOME=<your scratch home> bun test 2>&1 | tee <scratch>/<pkg>.log` once; then find per-file timing. Bun prints `[N.NNms]` per test in its default reporter when a test is slow and a total at the end; if per-file numbers are not visible, run the slowest-looking directories separately (`bun test src/commands`, `bun test src/driver/ios`, …) and time them with `time`.
2. List the 15 slowest test files across the repo with their wall time and why they are slow (child processes, real sleeps, large fixtures, snapshot I/O, repeated `WARDEN_HOME` sqlite creation per test).
3. Grep every `*.test.ts` for real-time waits: `setTimeout(`, `Bun.sleep(`, `sleep(`, `await new Promise(r => setTimeout`, `--timeout`, `jest.useFakeTimers`-like fake clocks; classify each hit as fake-clock (fine) or wall-clock (a candidate), and flag any assertion on elapsed time (flake risk on a loaded CI runner).
4. Child-process tests: `apps/cli/src/startup.test.ts` (runs the CLI in a child per case), `*.race-fixture.ts` users, `helper.integration.test.ts`, `graph-process`/`graph-worker` tests, anything spawning `bun`: count the spawns per run and the serial time.
5. Snapshot tests (`__snapshots__`, `help.test.ts`, `tui.test.ts`, report goldens): churn risk and whether they would be cheaper as targeted assertions.
6. Shared setup: tests that create a sqlite store, a temp dir or a fake driver per test when per-file would do.
7. Anything that failed or was flaky in the baseline: root-cause it (do not fix).

## Output

Findings per the brief's schema, with `category: test-gap | flake-risk | dx` and `platform: host`; `est_saving` in seconds of suite wall time per package. Include a table: package, baseline wall, your wall, slowest 5 files. In `## Gaps`, list tests that can only be meaningful on macOS (Swift, device smoke) and what CI covers.

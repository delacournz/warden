# Assignment 18 · `core-store-affected` (sonnet, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/18-core-store-affected.md` and `docs/audit/raw/18-core-store-affected.jsonl`.

## Improvement goal

Lower lease-path latency and prove concurrency safety in the sqlite store and port leasing; lower the cost of `warden affected` (the flow-selection step at the front of every `warden e2e`), and the `run`/`dev` command start paths.

## Owned files

- `packages/core/src/{store,ports,types,duration,exec}.ts`, `packages/core/src/{store,ports}.race-fixture.ts` and tests (`store.test.ts`, `ports.test.ts`, …)
- `packages/core/src/affected/{affected,affected.schema,cache,flows,git,graph,graph-process,graph-snapshot,graph-worker,select,fixture.testing}.ts` and tests
- `packages/core/src/batch/{schedule,preset,preset.schema,expand}.ts` and tests
- `apps/cli/src/commands/{affected,affected-graph,run,dev}.ts` and tests (`dev.test.ts` 412, `run.test.ts`, `affected.test.ts`)
- Read-only context: `packages/core/AGENTS.md`; `apps/cli/AGENTS.md` paragraphs on git facts and `__affected-graph`; `docs/plans/wdn-perf.md` PERF-4.3, PERF-5.2, PERF-5.3 and the Follow-ups rows for quiet and spawner; the plan's "Already fine, leave alone" line about the store (WAL, busy_timeout, cached statements, short txns): verify it.

Not yours: `claim.ts` (16), `builds/*` (17), `batch.ts` (12/13).

## Starting hotspots

- `store.ts` (400): `PRAGMA journal_mode=WAL`, `synchronous` (PERF-5.3 proposed `NORMAL`: landed?), `busy_timeout`, statement caching, `transaction()` = `BEGIN IMMEDIATE` as the cross-process mutex: how long the longest transaction holds it (claim's reclaim → allocate → lease), what runs inside a txn that could be outside, `MIGRATIONS` cost at open, the `meta` rows used as spawn arbitration (`simd_spawn:<udid>`), `gcWork`.
- `ports.ts` (244): bind probe outside the txn, lease inside; the race fixture; `claimRunPorts` is called in a serial `for` by the CLI (12): can `claimPorts` take a span in one txn?
- `liveness`/`types`: nothing heavy expected; confirm.
- `affected/*`: `changedFiles` = 3 sequential git spawns (`git.ts:54,57,59`), `snapshotKey` 2 parallel git calls + sync hashing of up to 2000 dirty files (`graph-snapshot.ts:72,91-99,128`), the graph worker (`graph-process.ts:101`, `WORKER_TIMEOUT_MS` 120 s; compiled binary → hidden `__affected-graph`), `cache.ts` keyed by HEAD + dirty hash, the per-platform loop computing both platforms before `e2e.ts` rejects the ambiguity (`affected.ts:151-153`), `select.ts` matching cost, `flows.ts` scan.
- `graph.ts` (268): `loadTs` lazy `require("typescript")` (~90 MB) only in the worker; verify no path loads it in the parent.
- `commands/dev.ts` (498): `devScheme` runs `bunx expo config --json` (1–3 s; PERF-4.5 said skip on iOS or run alongside the claim: landed?), eager zod config load (K4), Metro ownership checks.
- `commands/run.ts`: start path and what it loads (K4).
- `batch/schedule.ts`: FIFO per pool, retries on the same worker; `preset.ts`/`expand.ts` placeholder expansion per job.
- Race fixtures: what they prove and what concurrency case has no fixture (two claims racing for the last device, claim vs gc, port probe TOCTOU).

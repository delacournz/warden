# Assignment 14 · `cli-ui-agent` (opus, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/14-cli-ui-agent.md` and `docs/audit/raw/14-cli-ui-agent.jsonl`.

## Improvement goal

Shorten every `warden ui <sub>` call (a fresh process each time: start + lease check + state I/O + helper connect + snapshot), and make the iOS helper lifecycle (spawn arbitration, ready detection, replacement, stop) correct under concurrency and crashes.

## Owned files

- `apps/cli/src/agent-ui/{act,actions,close,controls,device,diff,driver,helper,helper-sweep,helper.race-fixture,open,output,paths,query,run,scroll,snapshot-command,snapshot,state,state.worker.testing,status,stop-helper-after,target,ui-driver,ui-options,video}.ts` and tests (`helper.test.ts` 697, `helper.integration.test.ts`, `ui-actions.test.ts` 672, `ui-query.test.ts`, `ui-snapshot.test.ts`, `ui.test.ts`, `state.test.ts`, `target.test.ts`, …)
- `apps/cli/src/commands/{ui,ui.testing}.ts`, `apps/cli/src/device-lease.ts` and tests
- `apps/cli/src/e2e/warm-connect.ts` (read; owned by 12) and `apps/cli/src/batch/warm-drivers.ts` (read; owned by 12) for how the warm path uses `ensureHelper`
- Read-only context: `apps/cli/AGENTS.md` paragraphs on `agent-ui/` and `helper.ts`; `docs/plans/wdn-e2e.md` § `warden ui`, "ui-bench after D11" (openDriver 570–730 ms → ~8 ms after the AutomationEnabled skip), "Android real-device pass" timings; `docs/plans/wdn-perf.md` PERF-1.5 and K17.

Not yours: flows (11), devtools CLI (10), `bench.ts` (19), the drivers (03, 05). The AutomationEnabled write itself is agent 16's finding; you report where the `ui`/warm paths run it serially.

## What a prior read found (verify every line)

- `ensureHelper` (`helper.ts:487-515`): a first connect with `readyTimeoutMs: 2000` always fails on a cold helper (`:158`) before the spawn path runs; then `simd_spawn:<udid>` meta row in a txn; spawn `warden-simd --udid U --socket $WARDEN_HOME/simd/U.sock --idle-timeout 600 [--resources dir]` (`:373-382`), detached; wait for the stdout `ready` line `SIGNAL_WAIT_MS` 1500 (`:42`), else poll the socket every `POLL_MS` 100 up to `SPAWN_WAIT_MS` 5000 (`:29,32`); client handshake `DEFAULT_READY_TIMEOUT_MS` 15 s.
- On the `ui` and warm paths the AutomationEnabled probe/write runs serially after helper start (`helper.ts:523-527`, `warm-connect.ts:20-27`), in `openDriver` it runs in parallel.
- `state.json` keeps the lease owner + helper binary mtime; a resident helper whose owner or binary differs is replaced; `stopHelper` = `shutdown`, ≤ 2 s, SIGTERM; `sweepDeadHelpers` for gc (dead pids only).

## Starting hotspots

- Per-call cost model for `warden ui snapshot -i` (measured 182–185 ms warm, 544–726 ms cold): process start (cite 15), `resolveUiDevice` + `ensureCallerLease` (sqlite txn + heartbeat), `state.json` read, helper connect, snapshot, `last-snapshot.json` + `state.json` atomic writes, render. Which of these could be skipped or merged.
- Cold-helper path: the 2 s wasted connect; whether `watchStart` can race the ready line against the socket poll; what happens if the spawner dies between the meta row and the spawn (stale row = nobody spawns?); two `warden ui` calls arriving within the same 100 ms.
- Helper replacement rules (owner changed, binary mtime changed): a replacement mid-`warden e2e` run on the same sim?
- `target.ts`: `@eN` refs older than 30 s re-verified; `last-snapshot.json` size and parse cost per call.
- `query.ts` (484): `wait` back-off (100 → 250 ms after 1 s, `wait stable` 100 ms), `find`/`get`/`is` snapshot counts.
- `actions.ts` (438) + `act.ts` + `scroll.ts`: `--settle` (two equal hashes ≥ 250 ms apart, 3 s default) vs the helper's native settle; `fill` read-back; `scroll --until` snapshots per swipe.
- `ui-driver.ts` / `driver.ts`: Android = a fresh adb-backed driver per process, so every call pays shell start + probe + `warden-uiad` start (K17): cost per call and the daemon-mode option (`adb forward localabstract`, lease-scoped socket).
- `video.ts`: `simctl io recordVideo` start/stop handling, orphaned recorders.
- `device-lease.ts`: `ensureCallerLease` and `releaseDevices` + `after` hooks ordering.
- Tests using real sleeps; the race fixture's coverage.

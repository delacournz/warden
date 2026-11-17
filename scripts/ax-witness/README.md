# ax-witness

Question: when the in-sim accessibility service is silent for `warden-simd` (both its readers: the in-sim `axbridge`
guest and the host `ax` translator), does an XCUITest client in a resident `warden-runner` on the SAME simulator still
answer `snapshot`? If it does on a real wedge, the runner is an independent wedge witness (not a reader).

Non-shipping: nothing here is published or bundled.

## Run locally

Needs Xcode 27, `bun install`, `bun run --cwd packages/e2e native:deps` and `bun run --cwd packages/e2e native:build` (builds
`packages/e2e/native/dist/warden-simd`). Use a simulator you own:

```bash
warden claim ios --json --label axw --ttl 30m          # take the udid
bun scripts/ax-witness/ax-witness.ts --udid <udid> --freeze    # emulated silence
bun scripts/ax-witness/ax-witness.ts --udid <udid> --observe --seconds 120   # no interference
warden release <leaseId> --shutdown
```

- It builds the runner for the simulator (`xcodebuild build-for-testing` on `ios-runner/WardenRunner.xcodeproj`,
  `CODE_SIGNING_ALLOWED=NO`, derived data under `~/Library/Caches/warden-ax-witness`; `--skip-build` reuses it),
  starts `warden-simd` over stdio, starts the runner with `test-without-building ... testServe` in the background,
  launches Settings through simd, then loops: one `snapshot` to simd, one to the runner (once it listens on its TCP port
  on `127.0.0.1`), 1 s apart.
- `startup` rounds: the runner takes 2–4 min to come up on a fresh CI sim, so simd is read from the start and the
  runner is skipped until it is ready. It gets `--runner-ready-seconds` (420). If it never gets ready (that ceiling, or
  `xcodebuild` exiting), `--observe` still writes a summary with `runner never ready: <why>`; `--freeze` fails.
- `--freeze`: 6 s baseline, SIGSTOP of the launched app and SpringBoard for `--freeze-seconds` (60), SIGCONT, 10 s
  recovery. This is an EMULATION of a silent AX service, not a real wedge: the processes AX would read are stopped.
- `--observe`: no interference for `--seconds` (120). This is what CI hunts with.
- Other flags: `--app <bundle id>`, `--interval <ms>`, `--min-streak <n>` (3), `--simd <path>`, `--out <dir>`,
  `--derived-data <dir>`, `--runner-ready-seconds <s>` (420).

## Run on CI

`gh workflow run ax-wedge-hunt --ref <branch> -f runner=<label> -f iterations=5 -f seconds=120` (inputs: `runner`
default `xcode-27`, `xcode` developer dir or `.app`, `iterations`, `seconds`). The helper needs Xcode 27: `xcode-27`
(GitHub's macOS 27 image) or `namespace-profile-mac-medium` (Namespace). Every wedge seen so far came from the Namespace
runner; GitHub's `xcode-27` image has not wedged in 78 fresh boots, so hunt on Namespace. Each iteration creates a fresh
simulator, runs `--observe`, deletes it. The artifact `ax-wedge-hunt` holds
`iteration-N/{run.jsonl,summary.json,summary.txt,simd.log,runner.log}` and `hunt.json`; the job summary has one row per
iteration and marks (FLAGGED) the ones where simd was silent for 3 or more reads in a row, or whose runner never got
ready.

## Read the result

`summary.txt` / `summary.json` (`run.jsonl` is one record per read: `source` simd or runner, `outcome` answered /
silent / error, `code`, `latencyMs`, `busy`):

- `no-simd-silence`: simd never missed 3 reads in a row; nothing learned (the usual CI outcome).
- `witness-answers`: simd was silent while the runner answered every time. The runner works as a witness.
- `witness-silent`: both silent. The runner is not independent of the failure.
- `witness-mixed`: some of each; look at each streak.
- `witness-unread`: simd was silent only while the runner was not up. With `runner never ready`, it is the closest a run
  gets to "both silent": XCUITest may not start on a wedged sim. Read `runner.log` for where it stopped.

The run verdict counts only streaks the runner was read during; an `unread` streak (the runner not up yet) beside a
read one does not make the run `witness-mixed`.

A streak lists simd's consecutive silent reads, its duration and the runner's answers during it. `busy` counts runner
refusals (`runner busy: snapshot has held XCUITest ...`): the runner's main-thread op cannot be cancelled, so once one
snapshot hangs, later reads only prove it is still hung, not that the AX service is silent. Only the first read of a
streak is an independent probe.

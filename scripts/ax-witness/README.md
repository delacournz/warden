# ax-witness

Question: when the in-sim accessibility service is silent for `warden-simd` (both its readers: the in-sim `axbridge`
guest and the host `ax` translator), does an XCUITest client in a resident `warden-runner` on the SAME simulator still
answer `snapshot`? If it does on a real wedge, the runner is an independent wedge witness (not a reader).

Non-shipping: nothing here is published or bundled.

## Run locally

Needs Xcode 27, `bun install`, `bun run native:deps` and `bun run --cwd packages/e2e native:build` (builds
`packages/e2e/native/dist/warden-simd`). Use a simulator you own:

```bash
warden claim ios --json --label axw --ttl 30m          # take the udid
bun scripts/ax-witness/ax-witness.ts --udid <udid> --freeze    # emulated silence
bun scripts/ax-witness/ax-witness.ts --udid <udid> --observe --seconds 120   # no interference
warden release <leaseId> --shutdown
```

- It builds the runner for the simulator (`xcodebuild build-for-testing` on `ios-runner/WardenRunner.xcodeproj`,
  `CODE_SIGNING_ALLOWED=NO`, derived data under `~/Library/Caches/warden-ax-witness`; `--skip-build` reuses it),
  starts it with `test-without-building ... testServe` and connects to its TCP port on `127.0.0.1`, starts `warden-simd`
  over stdio, launches Settings through simd, then loops: one `snapshot` to simd, one to the runner, 1 s apart.
- `--freeze`: 6 s baseline, SIGSTOP of the launched app and SpringBoard for `--freeze-seconds` (60), SIGCONT, 10 s
  recovery. This is an EMULATION of a silent AX service, not a real wedge: the processes AX would read are stopped.
- `--observe`: no interference for `--seconds` (120). This is what CI hunts with.
- Other flags: `--app <bundle id>`, `--interval <ms>`, `--min-streak <n>` (3), `--simd <path>`, `--out <dir>`,
  `--derived-data <dir>`.

## Run on CI

`gh workflow run ax-wedge-hunt --ref <branch> -f runner=<label> -f iterations=5 -f seconds=120` (inputs: `runner`
default `macos-26`, `xcode` developer dir or `.app`, `iterations`, `seconds`). The helper needs Xcode 27, so use the
`xcode-27` label or pass `xcode`. Each iteration creates a fresh simulator, runs `--observe`, deletes it. The artifact
`ax-wedge-hunt` holds `iteration-N/{run.jsonl,summary.json,summary.txt,simd.log,runner.log}` and `hunt.json`; the job
summary has one row per iteration and marks (FLAGGED) the ones where simd was silent for 3 or more reads in a row.

## Read the result

`summary.txt` / `summary.json` (`run.jsonl` is one record per read: `source` simd or runner, `outcome` answered /
silent / error, `code`, `latencyMs`, `busy`):

- `no-simd-silence`: simd never missed 3 reads in a row; nothing learned (the usual CI outcome).
- `witness-answers`: simd was silent while the runner answered every time. The runner works as a witness.
- `witness-silent`: both silent. The runner is not independent of the failure.
- `witness-mixed`: some of each; look at each streak.

A streak lists simd's consecutive silent reads, its duration and the runner's answers during it. `busy` counts runner
refusals (`runner busy: snapshot has held XCUITest ...`): the runner's main-thread op cannot be cancelled, so once one
snapshot hangs, later reads only prove it is still hung, not that the AX service is silent. Only the first read of a
streak is an independent probe.

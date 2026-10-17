# Audit 10 · devtools-facet

Scope: `packages/e2e/src/devtools/*`, `apps/cli/src/agent-ui/devtools-{cli,register}.ts`, `apps/cli/src/commands/ui-collect.ts`. All devtools test files pass here (`bun test src/devtools/*.test.ts`, 12 files, 0 failures), so every finding below is a gap the tests do not cover, not a red test. No device was available: every device timing is `estimated` unless a doc is cited.

## Top 5 by impact

1. 10-1 A devtools session that loses its target for about 2 s is dead for the rest of the spec process, and an app relaunch takes 4.5-6.4 s.
2. 10-2 The network drain is destructive and shared, and re-install ignores new config, so concurrent CLI/collector/spec consumers lose entries and `--bodies` can silently be a no-op.
3. 10-3 The `getByTestId` React-tree accelerator runs a full fiber walk plus native measure of every emitted node on every poll miss (about 25 % of the app JS thread while waiting).
4. 10-4 On Android the devtools target filter uses the AVD name, but Metro reports `Build.MODEL`, so a shared Metro gives `device_mismatch` or the wrong device.
5. 10-5 `evaluate`, `tree` and `reloadJs` wait out a reconnect with no deadline, so the 2 s tree budget and `--timeout` do not bound them.

## Findings

### 10-1 Session turns `lost` after about 2 s and is never revived
- Category: flake-risk
- Severity: P1
- Known?: new (adjacent to K18, which measures the boot time)
- Evidence:
  - `packages/e2e/src/devtools/session.ts:17-18@dfcc68b`: backoff 200 ms x 10 attempts. In `reconnect` (`session.ts:186-221@dfcc68b`) each failed attempt is one `/status` + `/json/list` (no target, so it fails fast) plus `sleep(200)`, so the budget is about 2.1 s.
  - At `session.ts:211-214@dfcc68b` the state becomes `{kind:"lost"}`; `current()` (`:224-229@dfcc68b`) then returns the error forever. Nothing leaves `lost`.
  - The owner caches the facet for the whole process: `packages/e2e/src/session.ts:220-231@dfcc68b` keeps `devtoolsOpening` once it succeeded and only resets it when the *open* fails. `peekDevtools()` (`:233@dfcc68b`) keeps returning the dead facet, so failure capture writes stale rings.
  - A terminate + launch (what `app.open` does, `packages/e2e/src/app.ts:67-86@dfcc68b`) removes the page from Metro until the new runtime registers. Measured boot of the Release example is 4.5-6.4 s, median 5.5 s (`docs/plans/wdn-e2e.md:396@dfcc68b`); a dev client with Metro is slower. 2 s < 4.5 s.
  - The doc already records the symptom: "a collector from before an app restart ends as `lost`" (`docs/plans/wdn-e2e.md:294@dfcc68b`). The same applies to the spec facet.
  - `session.test.ts:262-273@dfcc68b` only tests that giving up works; nothing tests "target returns after the budget".
- Impact: estimated. Any spec in a dev-client run that relaunches the app (every test in the bench pattern) kills `device.devtools.*` and the React accelerator after the first relaunch that outlasts 2 s. After that, `getByTestId` on a view hidden from accessibility falls back to "not found" (`react-locator.ts:38-45@dfcc68b` swallows the error) and the test times out (action timeout) instead of using the accelerator. Per affected test: the full action timeout (seconds). iOS and Android. Not measured.
- Proposed fix:
  - Make the reconnect budget time-based (for example 30 s with 200 ms growing to 1 s), since "no target yet" is the normal state during a relaunch.
  - Let `lost` be left: on the next `current()` call, start a fresh `establish()` (single-flight) instead of returning the stored error.
  - In `packages/e2e/src/session.ts`, drop the cached facet when it emitted `lost`, so `devtools()` reopens.
  - Files: `session.ts` here, `packages/e2e/src/session.ts` (owner 8). Additive; the `lost` event stays.
- Effort: M
- Risk: a longer budget delays the `lost` signal for a truly dead Metro (collector exit takes longer); keep the collector's idle exit independent. Verification of timing needs a device; the logic does not.
- How to verify: new `session.test.ts` case: `dropAll()`, `setTargets([])`, advance the injected sleep past 10 attempts, then `setTargets([page 2])` and expect `evaluate` to work. On a device: `app.open()` three times in one spec, then `device.devtools.evaluate("1+1")`.
- Confidence: high on the mechanism, med on how often 2 s is exceeded
- Verified by: traced path from `app.open` to `session.devtools()` to `connectDevtools.reconnect`; read

### 10-2 Network drain is destructive and shared; re-install ignores new config
- Category: correctness
- Severity: P1
- Known?: new
- Evidence:
  - The page wrapper's drain empties the page ring: `network.script.ts:54-58@dfcc68b` (`var out = log; log = []`). Every consumer that polls takes entries away from the others.
  - `attachNetwork` polls every 500 ms for as long as the facet lives (`network.ts:133-140@dfcc68b`) and, with no `sink`, drops what it takes into its own ring.
  - The CLI opens a full facet for `eval`, `tree` and `reload` (`devtools-cli.ts:137-152@dfcc68b`). `reload` waits for up to 5 s plus a reconnect and a `tree` can run 5 s, so the CLI's poll fires and discards entries a running collector (`logs start`) should have recorded. The spec process's own facet does the same to a collector run for the same device.
  - The install is guarded by `if (g.__warden_net_patched) return "already"` (`network.script.ts:12@dfcc68b`). The first installer's config wins for the life of the JS context: `ring`, `includeBodies`, `skipPrefixes`. So `warden ui eval x` (bodies off) and then `warden ui logs start --bodies` records no bodies, with no error.
  - The CLI install also leaves the wrapper behind with nobody draining it: the page keeps recording into its ring up to `ring` entries (2000) after the CLI exits.
  - `fakePage` (`devtools.testing.ts:195-215@dfcc68b`) sets `installed = true` on any install and never models `already`, so no test sees the config pinning.
- Impact: estimated. Lost network entries in the collector files for any CLI call or spec facet that overlaps a collector (silent); `--bodies` ignored after any earlier attach to the same JS context. Both platforms.
- Proposed fix:
  - Version the wrapper: store `g.__warden_net_cfg` and, when the new config differs, update it in place (do not stack a second wrapper).
  - Make the CLI one-shots not install the network wrapper at all (see 10-6).
  - Give each consumer its own cursor in the page ring (an increasing id plus `__warden_net_drain(sinceId)`) so a read does not remove entries, and trim by ring size only.
  - Files: `network.script.ts`, `network.ts`, `devtools.testing.ts`, tests. Additive (page-side protocol is internal).
- Effort: M
- Risk: page-side script change runs in Hermes untranspiled (plain ES2015 rule). Needs a device to confirm the cursor under a real fetch burst.
- How to verify: `network.script.test.ts` plus `network.test.ts` with two attached captures on one fake page: both must see all entries; a second install with `includeBodies:true` must change behaviour.
- Confidence: high
- Verified by: read; traced from `uiReload` to `attachNetwork.poll` to `__warden_net_drain`

### 10-3 React-tree accelerator walks and measures the whole screen on every poll miss
- Category: perf-cpu
- Severity: P1
- Known?: new
- Evidence:
  - Callers: `locator.ts:243,250,334,622@dfcc68b` (owners 6/7) call `reactCandidates` whenever a plain `getByTestId` has no accessibility match: reads (`single()`), `boundingBox`, and every action poll step (`reactStep`). `context.ts:54-56,167-180@dfcc68b`: throttle 450 ms, timeout 2 s.
  - Each call is a complete `TREE_SCRIPT` run (`tree.script.ts:21-447@dfcc68b`): `countFibers` walks every root (up to 20 000 fibers each, `:383-397,407-418`), then `buildChildren` walks again, then `registerHost` records a host for every emitted node (testID, label, screen root, or text; `:224-242`) and `measure` issues one native `measureInWindow` per host (`:436-438`), capped at 8000 (`:29`).
  - `max` only trims the output after measuring (`flatten`, `:349-366`). `locateByTestIdViaReact` (`react-locator.ts:25-60@dfcc68b`) needs only the nodes whose `testID` matches, but the request carries no filter (the only option is `screen`, which `reactMatches` does not pass).
  - Cost on a small screen: `tree` `durationMs` 141-168 ms warm for 12 components (`docs/plans/wdn-e2e.md:291@dfcc68b`).
- Impact: estimated. While a test waits for a testID that accessibility does not expose, the app's JS thread runs about 150 ms of tree work every 450 ms throttle window: 150 / (450 + 150) = 25 % of the JS thread, on the same thread that has to render the thing being waited for, so it also slows the app it waits on. A 4 s wait is about 6 tree runs, about 0.9 s of JS-thread time. Larger screens cost more (the measure count scales with emitted nodes). iOS and Android.
- Proposed fix:
  - Add `testId` (string or regex source) to `TreeScriptConfig`: with it, emit and measure only matching nodes (plus none of their ancestors), so measure calls drop from N to k.
  - Fold `countFibers` into the root pick (take the first root with `current.child`, or count lazily with a cap of about 2000).
  - Plumb `testId` through `TreeOptions` and `locateByTestIdViaReact`; keep the tree call for `warden ui tree`.
  - Files: `tree.script.ts`, `tree.ts`, `devtools.types.ts`, `screen/react-locator.ts` (owner 6/7). Additive.
- Effort: M
- Risk: regex matching inside Hermes must stay ES2015; `all`/`inactive` semantics must be unchanged when `testId` is absent. Needs a device to measure the new cost.
- How to verify: `tree.script.test.ts` with a fixture fiber tree and a `testId` filter (host measure calls counted); on a device, trace `devtools.tree` span `ms` before/after during a `tap(getByTestId(...))` that waits 3 s.
- Confidence: med (JS-thread duty cycle is derived from a small-screen number)
- Verified by: traced path from `Locator.reactStep` to `fetchTree` to `TREE_SCRIPT.measure`

### 10-4 Android devtools target uses the AVD name; Metro reports the device model
- Category: correctness
- Severity: P1
- Known?: new (extends `docs/plans/wdn-e2e.md:458` root cause 6, fixed for iOS only)
- Evidence:
  - `WARDEN_DEVICE_NAME` is the lease device name for every platform (`apps/cli/src/commands/batch.ts:663-665,707@dfcc68b`); on Android that is the AVD name (for example `warden-pixel-10-1`, `packages/core/src/providers/android.test.ts:152`).
  - `selectTarget` filters by exact `t.deviceName === query.deviceName` (`inspector.ts:154-175@dfcc68b`). If nothing matches and Metro serves more than one device, the result is `device_mismatch` (`:165-174`).
  - From my knowledge of RN (not in this repo), Android's inspector `deviceName` is `Build.MODEL` (plus release/API on non-Genymotion), never the AVD name. Two emulators of one profile therefore also carry the same name, so the name cannot tell them apart.
  - The CLI side passes the name for iOS only: `devtools-cli.ts:141@dfcc68b` and `devtools-cli.ts:300@dfcc68b` (`device.platform === "ios" && device.name`). So `warden ui eval|tree|reload|logs start` on Android with two devices on one Metro attach to the newest page of any device (the root cause 6 bug).
  - `inspector.ts:140` says "persist this to re-pin the same device", but nothing outside the session persists `logicalDeviceId` (`grep logicalDeviceId` finds only `ui-collect.ts` plumbing); the pin is in-memory (`session.ts:121,172@dfcc68b`), so every CLI call and every new collector re-selects by name.
- Impact: estimated. On a shared-Metro Android batch (the `warden e2e` default of one Metro per run, `docs/plans/wdn-e2e.md:458`), devtools fails with `device_mismatch` (safe but unusable), or on the CLI hits another emulator's app. Not measured; Android only. Single-emulator runs are unaffected.
- Proposed fix: identify the device by something the host knows and the page can state. Options: (a) after attach, evaluate `globalThis.__warden_device_probe` against a per-device marker the host sets with `adb -s <serial> shell setprop debug.warden.id`/an intent extra and read through a native module; (b) match `ANDROID_ID` via `adb shell settings get secure android_id` if the inspector `logicalDeviceId` is derived from it; (c) as a first step, persist the `logicalDeviceId` after the first successful attach in `state.json` and have the batch runner record it per worker. Files: `inspector.ts`, `devtools-cli.ts`, `packages/e2e/src/session.ts` (owner 8), `batch.ts` (owner 12). Needs a decision, see Questions.
- Effort: M
- Risk: `contract: env` if a new env name is added; needs two emulators on one Metro to verify.
- How to verify: lease two emulators, run `warden batch` with a devtools spec; log `session.target.deviceName` and `logicalDeviceId` per worker.
- Confidence: low-med (relies on RN's Android device name, which I cannot check here)
- Verified by: read; traced path from `batch.ts` env to `selectTarget`

### 10-5 No deadline on waiting out a reconnect; stale page can be re-selected
- Category: flake-risk
- Severity: P2
- Known?: new
- Evidence:
  - `evaluate`, `send`, `evaluateWithBinding` call `current()` (`session.ts:224-229,237-239,312-315,337-340@dfcc68b`), which awaits `state.done` with no timeout; the caller's `timeoutMs` covers only the CDP send afterwards. `reloadJs` also does `await state.done` after the epoch wait (`:299-302`), so its 5 s `reloadWaitMs` bounds only the "reload not observed" case.
  - One reconnect attempt can take up to `list` (3 s per request, `inspector.ts:111`, 2-3 requests) + `openCdp` (10 s default, `cdp.ts:5`) + handshake `Runtime.enable` (default timeout, `session.ts:139`), so the full loop is far above the 2 s `REACT_TIMEOUT_MS` (`context.ts:56@dfcc68b`) and the CLI `--timeout`.
  - `executionContextsCleared` triggers `reconnect` immediately (`session.ts:181-183`). At that moment Metro may still list the old page; `selectTarget` takes the newest listed page (`inspector.ts:169`, `newestFirst`) and nothing checks that the id changed. A socket opened to the dying page can accept the upgrade and never answer `Runtime.enable`. `session.test.ts:214-225` swaps the target list atomically, so this case is not tested.
  - While reconnecting `bindingAvailable` reads false (`session.ts:309-311`), so `fetchTree` takes the 50 ms polling path (`tree.ts:152`) even though the runtime has the binding.
- Impact: estimated. A reload or a navigation-triggered JS context clear stalls a locator poll step for seconds, past the attempt's step budget; the attempt signal cannot interrupt it because the wait is not abortable. Per affected test: seconds. Both platforms.
- Proposed fix: race `current()` against the caller's `timeoutMs` (return `cdp_timeout`), let `reconnect` skip an old page id on a `contextsCleared` reconnect until a different id appears (or a handshake timeout of about 1.5 s), and expose the pre-reconnect `bindingAvailable`. Files: `session.ts`, `tree.ts`, tests. Additive.
- Effort: M
- Risk: shortened handshake timeouts could abandon a slow but valid page on a loaded host; verify under load.
- How to verify: `session.test.ts` with `respond` returning `"silent"` for `Runtime.enable` on the first reconnect and an old page still listed; assert `evaluate(.., {timeoutMs:500})` returns within about 600 ms.
- Confidence: med (the stale-page step depends on Metro timing)
- Verified by: read; traced path `executionContextsCleared` to `reconnect` to `establish`

### 10-6 `warden ui eval|tree|reload` opens a full facet and mutates the app
- Category: perf-latency
- Severity: P2
- Known?: known-extended K17 (CLI per-call cost) and the `wdn-e2e.md:291` 0.7 s
- Evidence:
  - `withFacet` (`devtools-cli.ts:126-153@dfcc68b`) calls `openDevtoolsFacet`, which creates console capture, connects, then `attachNetwork` (`facet.ts:46-67@dfcc68b`). That is, before the user's one evaluate: `/status`, `/json/list`, WebSocket open, then six awaited RPCs (`session.ts:135-145`: `setClientMetadata`, `ReactNativeApplication.enable`, `Runtime.enable`, `runIfWaitingForDebugger`, `addBinding`, `typeof` probe), then the network-install evaluate (`network.ts:96-100@dfcc68b`), then a poll timer. Each RPC awaits the previous one.
  - `Runtime.enable` makes Hermes replay its buffered console history, which the facet parses (zod) and stores for nothing, since the CLI never reads it (`console.ts:216-231`).
  - The install patches the app's `fetch` permanently (see 10-2).
  - On Android, `uiTree` also opens a driver and takes a snapshot first, in series (10-13).
- Impact: estimated. Local RTT through Metro to the device is unmeasured here; five serial handshake RPCs plus the install are 6 round trips that could be 1-2. The documented 0.7 s wall for `eval "1+1"` includes Bun start; only the attach share is reducible. Both platforms.
- Proposed fix:
  - Add `openDevtoolsFacet({ mode: "eval" })` (or a `connectDevtools` option `lean`) for the CLI: skip console tap, skip `attachNetwork`, send the optional handshake calls without awaiting each (`Promise.all` of the three optional ones, then `Runtime.enable`), keep `addBinding` only for `tree`.
  - `uiLogs start` keeps the full facet (collector).
  - Files: `facet.ts`, `session.ts`, `devtools-cli.ts`. Additive.
- Effort: S-M
- Risk: Fusebox may need `ReactNativeApplication.enable` before `Runtime.enable` to behave; keep order but pipeline. Verify on a Fusebox dev client.
- How to verify: `facet.test.ts` asserts no `__warden_net_patched` evaluate in lean mode; on a device time `warden ui eval 1+1` (20 runs) before/after.
- Confidence: med
- Verified by: traced path from `uiEval` to `connectDevtools.handshake`

### 10-7 Collector keeps host rings it never reads; per-row file writes
- Category: perf-ram
- Severity: P2
- Known?: new
- Evidence:
  - `startCollector` passes no `consoleRing` / `networkRing` (`collector.ts:67-77@dfcc68b`), so the detached process holds 500 console lines and 2000 network entries (`console.ts:7`, `network.ts:8`, `network.ts:117@dfcc68b`) that only its `sink` ever needed; nothing reads `entries()` or `lines()` there. With `--include-bodies` an entry carries up to 64 KB request + 64 KB response text (`network.script.ts:17,89-96`), so 2000 x 128 K chars (UTF-16, up to 2 B each) is worst-case hundreds of MB in a background process, plus a second ring of the same size inside the app.
  - The `network` ring option also sizes the page ring (`network.ts:78-79@dfcc68b` passes `ring` into the install config), so lowering it for the collector needs a separate host-ring option.
  - `append` chains one `mkdir` + `appendFile` (open, write, close) per row onto an unbounded promise chain (`collector.ts:60-65@dfcc68b`, `jsonl.ts:12-16`); a burst of log lines queues closures without a bound, and each row costs about four syscalls.
- Impact: estimated. Typical entries are 0.5-5 KB, so about 1-10 MB of redundant rings; with `--bodies` tens to hundreds of MB. Per-row writes: at 1000 lines/s that is about 4000 syscalls/s of avoidable work. Host only, both platforms.
- Proposed fix: `hostRing` option on `attachNetwork` and `consoleRing: 1` in the collector; buffer rows and flush every 100-250 ms (and on finish) with one `appendFile` per file. Files: `collector.ts`, `facet.ts`, `network.ts`, `jsonl.ts`. Additive.
- Effort: S
- Risk: a crash loses up to one flush interval of lines; flush on SIGTERM already exists (`finish`).
- How to verify: `collector.test.ts` asserts the write count for a 1000-line burst; measure collector RSS with a body-heavy fixture (`ps -o rss`).
- Confidence: high on the mechanism, med on magnitude
- Verified by: read

### 10-8 Console lines are uncapped and stored twice
- Category: perf-ram
- Severity: P2
- Known?: new
- Evidence: `formatValue` returns a string argument unmodified (`console.ts:86-87@dfcc68b`) and objects with `value` as unbounded `JSON.stringify` (`:100`). `formatConsoleArgs` (`:128-135`) returns both `text` (all args joined) and `args` (each rendered), so each message lives twice. Only function text (`MAX_FUNCTION_TEXT`) is clipped. The ring is a count (500), not a size. Network bodies are capped at 64 KB and tree text at 200 characters; console is the one uncapped channel. Every line also goes to `console.jsonl` / the collector file.
- Impact: estimated. A normal line is under 1 KB (500 lines about 1 MB). One app that logs a response body or a redux state per action (100 KB-1 MB) makes the ring 100-500 MB in the spec process and a large `console.jsonl` for every failing attempt. Both platforms.
- Proposed fix: clip `text` to about 8 KB with a `… (N more chars)` suffix, clip each `args[i]` to the same, or drop `args` when it equals `[text]`. Files: `console.ts`, `devtools.types.ts` (doc only). Additive.
- Effort: S
- Risk: tests asserting full text of long lines; consumers reading `args` for exact values.
- How to verify: `console.test.ts` with a 1 MB string argument; assert the line size.
- Confidence: high
- Verified by: read

### 10-9 Console and network rings are not cut per attempt
- Category: dx
- Severity: P2
- Known?: known-confirmed K14
- Evidence: `docs/plans/wdn-e2e.md:469@dfcc68b` says the ring is not cleared per attempt. In the code nothing calls `console.mark` or `console.clear` from the runner: `runner/attempt.ts:296-310@dfcc68b` only calls `peekDevtools()` and `captureDevtoolsArtifacts` (`runner/failure.ts:82-95`), which calls `attachArtifacts`, which writes the whole buffer (`facet.ts:88-97@dfcc68b`). The only callers of `console.clear/mark` are the user-facing `device.devtools.console` wrappers (`device-devtools.ts:66-71`).
- Impact: estimated. The `console.jsonl` / `network.jsonl` of a failing test can contain up to 500 console lines and 2000 requests from earlier tests of the same spec process (so a reader debugs the wrong test), and each failure writes all of it (about 1-2 MB, with a drain round trip bounded by `CAPTURE_TIMEOUT_MS` 10 s, `failure.ts:13`). Both platforms.
- Proposed fix: add `attachArtifacts(dir, { since })`, filter console by `ts >= since` and network by `ts >= since` (entries carry `ts`), and have `attempt.ts` pass the attempt start; alternatively insert a `mark("▶ <title>")` at attempt start so a reader can find the cut. Files: `facet.ts`, `console.ts`, `network.ts`, `runner/attempt.ts` (owner 8). Additive.
- Effort: S
- Risk: low. Clock skew between device and host timestamps (console `ts` is the runtime's own): prefer a ring index recorded at attempt start (`lines().length` offset or a monotonically increasing sequence) over wall time.
- How to verify: `facet.test.ts` plus a runner test with two attempts, assert the second attempt's files exclude the first's lines.
- Confidence: high
- Verified by: read

### 10-10 Collector bookkeeping trusts a bare pid
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `startCollector` treats `state.collector.pid` as running if `kill(pid,0)` succeeds (`devtools-cli.ts:281@dfcc68b`, `processAlive` in `packages/core/src/liveness.ts`: any live process, EPERM counts as alive). `stopCollector` then `SIGTERM`s that pid (`devtools-cli.ts:319`). `startedAt` is stored (`state.ts:26`) but never compared with the process start time.
  - A collector that idle-exits (60 s default) leaves `state.collector` behind (only `stop` clears it, `devtools-cli.ts:320-321`). After enough pid churn, `logs stop` kills an unrelated process, and `logs start` answers "already collecting" for a recycled pid and starts nothing.
  - Nothing stops the collector when the lease is released or `ui close` runs (`grep collector` in `apps/cli/src/agent-ui` shows only `devtools-cli.ts` and `state.ts`), so it lingers up to 1-2 idle windows holding a Metro WebSocket.
- Impact: estimated; rare but destructive (signals a foreign process) and silent (no collection).
- Proposed fix: have the collector write its own pid + start time and a heartbeat file (or check `ps -o lstart=,command= -p <pid>` contains `ui-collect`) before trusting or killing; clear `state.collector` when the collector exits (it knows `--out`, write a `collector.json` removed on exit); stop it from the release/close path. Files: `devtools-cli.ts`, `ui-collect.ts`, `collector.ts`, `state.ts` (owner 14). Additive.
- Effort: S-M
- Risk: low.
- How to verify: `ui-devtools` tests with a fake `pidAlive` that returns true for a pid whose command is not `ui-collect`; assert no kill and a fresh start.
- Confidence: high
- Verified by: read

### 10-11 Slow measurement yields silent "not found"; `max` does not bound the work
- Category: correctness
- Severity: P2
- Known?: new
- Evidence:
  - At the 1200 ms guard (`tree.script.ts:439-442@dfcc68b`) `finish` reports whatever rects arrived. `truncated` is `more || budgetHit` (`:374`), so an un-measured screen is `truncated:false`. Components without a rect and without a `testID` are dropped by `finalize` (`:329-332`); those with a `testID` and no rect are kept without `rect`.
  - `locateByTestIdViaReact` skips any component without a rect (`react-locator.ts:46@dfcc68b`), so a testID that exists but was not measured in time looks absent; the poll then retries, which re-runs the whole tree (10-3).
  - `MEASURE_CAP` 8000 hosts and `--max` apply only to what is emitted afterwards, so `--max 5` still measures every emitted node (`:29,436-438,351`).
- Impact: estimated. On a heavy screen the accelerator can miss an element for the duration of a transition (when measure callbacks are slow), turning a 200 ms wait into a retry loop or a timeout. `warden ui tree` shows a tree with silently missing rects. Both platforms.
- Proposed fix: add `measureTimedOut: true` to the result and surface it as `truncated` plus a warning; with `max`, stop registering hosts once `max` nodes are emitted. Files: `tree.script.ts`, `tree.ts` (`scriptResultSchema`), `devtools-cli.ts` (the warning). Additive.
- Effort: S
- Risk: low; schema change must stay optional.
- How to verify: `tree.script.test.ts` with a measure stub that never calls back; expect `truncated:true`.
- Confidence: med
- Verified by: read

### 10-12 Network capture sees `fetch` only; XHR users are invisible
- Category: correctness
- Severity: P2
- Known?: new (design stated in `network.script.ts:1-8` and `docs/plans/wdn-e2e.md:147`)
- Evidence: the script patches `g.fetch` only (`network.script.ts:60@dfcc68b`) "because RN's `fetch` is built on XHR, so patching both would count every request twice". The consequence is not mentioned: apps using axios (default XHR adapter in RN), Apollo's XHR link, `expo/fetch` or native modules never appear in `network.jsonl`. Patching `XMLHttpRequest` instead would record both the XHR clients and RN's polyfilled `fetch` once.
- Impact: estimated. A failing test in an axios app has an empty `network.jsonl`; no time cost, a missing-evidence cost. Both platforms.
- Proposed fix: wrap `XMLHttpRequest.prototype.open/send/setRequestHeader` and the load/error/abort events (and read `getAllResponseHeaders`), skip Metro; keep `fetch` unpatched (or patch `fetch` only when it is not XHR-backed). Files: `network.script.ts`, tests. Additive; needs a device check on Hermes/RN 0.86.
- Effort: M
- Risk: XHR patching is invasive (streaming, blob/arraybuffer responses, `responseType`); only capture text bodies like today.
- How to verify: `network.script.test.ts` with a fake XHR; on a device fire an axios and a `fetch` call and expect two entries.
- Confidence: med
- Verified by: read

### 10-13 `warden ui tree` on Android opens the driver before the facet and defaults silently to scale 1
- Category: perf-latency
- Severity: P2
- Known?: known-extended K17
- Evidence: `uiTree` awaits `pixelRatioFor` (`devtools-cli.ts:209@dfcc68b`), which opens the Android driver (starts `warden-uiad`, about 85 ms per CLI call, K17), takes a full snapshot for `screen.scale` (`:196-202`), then `withFacet` attaches. The two are independent but sequential, and on any failure it falls back to `1` with no warning (`:199-201`), which reports dp rects as if they were px.
- Impact: estimated. About 100-300 ms per `tree` call on Android (uiad start 85 ms plus snapshot 6-30 ms, `packages/e2e/AGENTS.md`, plus adb connect), all of it serial with the attach. Android only.
- Proposed fix: run `pixelRatioFor` and the facet attach with `Promise.all`; or read the density from the app (`PixelRatio.get()` through the evaluate the tree already pays for) and drop the driver; warn when falling back to 1. Files: `devtools-cli.ts`. Additive.
- Effort: S
- Risk: low.
- How to verify: `ui-devtools.test.ts` ordering assertion; on a device time `warden ui tree` before/after.
- Confidence: med
- Verified by: read

### 10-14 Idle poll keeps the page busy when nobody reads the sink
- Category: perf-cpu
- Severity: P3
- Known?: new
- Evidence: `network.ts:133-140@dfcc68b` evaluates the drain expression every 500 ms for the facet's lifetime. In a spec process (no `sink`) `entries()` and `attachArtifacts` already drain first (`network.ts:143,152`), so the periodic drain only narrows the loss window around a JS reload. The CDP binding (`__warden_cb`) exists but the wrapper does not use it for push.
- Impact: estimated: 2 CDP round trips per second per device for the whole process; small on the host (zod parse of a short reply), a wake-up of the JS thread on the device. Needs a device measurement.
- Proposed fix: poll every 2 s without a sink, or push from the page via the binding (batched with `setTimeout`) and drop polling. Files: `network.ts`, `network.script.ts`. Additive.
- Effort: S-M
- Risk: low
- How to verify: count `Runtime.evaluate` per minute on the fake Metro in `network.test.ts`.
- Confidence: med
- Verified by: read

### 10-15 Small session leaks: `onCdp` unsubscribe, polling-path results, ring slice
- Category: robustness
- Severity: P3
- Known?: new
- Evidence:
  - `onCdp` captures `off` for the socket that was current at registration (`session.ts:330-335@dfcc68b`); after a reconnect `attach` re-registers handlers on the new socket (`:175-177`) but the returned unsubscribe only calls the stale `off`, so the handler keeps firing on the new socket. No production caller exists (`grep onCdp`: only tests).
  - `viaPolling` leaves `__warden_tree_results[requestId]` in the page when it times out (`tree.ts:88-114@dfcc68b`, `tree.script.ts:76-82`): one whole-tree JSON string per timed-out call.
  - `record` and `take` copy the buffer on every push once it is full: `buffer.slice(...)` (`console.ts:212`, `network.ts:117@dfcc68b`), O(ring) per line after the first 500/2000.
- Impact: estimated: negligible per call; P3.
- Proposed fix: unsubscribe through the current `unsubscribeCdp` map or delete the API; delete the polled key from the timeout path (an extra `delete` evaluate or a TTL in the script); use `shift()` or a circular index. Additive.
- Effort: S
- Risk: low
- How to verify: unit tests for each.
- Confidence: high
- Verified by: read

### 10-16 Fakes cannot reproduce the failure shapes above
- Category: test-gap
- Severity: P3
- Known?: new
- Evidence: `fakePage` (`devtools.testing.ts:195-215@dfcc68b`) never answers `already` and ignores the install config; `startFakeMetro` serves a target list the test swaps atomically (`session.test.ts:214-225`), so the old-page-still-listed window (10-5) and the reload-with-stale-page window do not exist; there is no case where the collector and a second consumer share a page (10-2). Replay dedupe is covered (`console.test.ts`) but only with in-process timestamps.
- Impact: n/a (tests stay green while devices fail, per the brief's rule on fakes).
- Proposed fix: add `fakePage` modes (`already` answer, shared consumers) and a `lingerOldPage` option on the fake Metro; add the cases named in 10-1, 10-2, 10-5.
- Effort: S
- Risk: none
- How to verify: the new tests fail before the fixes and pass after.
- Confidence: high
- Verified by: ran `bun test` on the 12 devtools test files (all pass)

### 10-17 `logs start` truncates the previous window's files
- Category: correctness
- Severity: P3
- Known?: new
- Evidence: `startCollector` runs `writeJsonl(consolePath, [])` and `writeJsonl(networkPath, [])` (`collector.ts:50-56@dfcc68b`) every time. A collector that idle-exited after 60 s (`:100-106`) and is then restarted by an agent erases the lines it recorded earlier, while `warden ui logs` documents that reads "work after the collector has ended too" (`devtools-cli.ts:329-333`). Also, the replay of the Hermes buffer into a fresh process (new `seen` map) re-adds old lines.
- Impact: estimated: lost evidence; agent confusion.
- Proposed fix: append instead of truncate (or write `console.<n>.jsonl` and have readers take the newest), with a `mark` line at collector start. Additive.
- Effort: S
- Risk: files grow without bound across restarts; rotate at a size.
- How to verify: `collector.test.ts` start-stop-start.
- Confidence: high
- Verified by: read

## Known items

- K14: known-confirmed. Still not cleared or marked per attempt (10-9); fix sketched with a since-cut.
- K17: known-extended. Android `warden ui tree` pays the uiad start and a snapshot for one number, serially (10-13); `eval`/`reload` do not open a driver (the driver is lazy in `run.ts:49-53`).
- K18: referenced as evidence only (boot time 4.5-6.4 s is longer than the 2 s reconnect budget, 10-1).
- K15, K16, K9: not touched.

## Gaps I could not assess here

- Real RTT per CDP call through Metro, and the share of `warden ui eval 1+1` that is attach: on a device run `time warden ui eval 1+1` 20 times with `[devtools]` logs on, and compare with `--timeout` traces; same for `warden ui tree`.
- Tree duty cycle on a real screen (10-3): during a `tap(getByTestId("x"))` that waits 3 s for a testID that accessibility hides, read `device.devtools.tree` `durationMs` from the trace and `top -pid` the app's JS thread.
- Whether Metro still lists the old page after `executionContextsCleared` (10-5): on a dev client, `curl http://127.0.0.1:<port>/json/list` in a 50 ms loop while calling `warden ui reload`.
- Android inspector `deviceName` value and whether `logicalDeviceId` is stable per emulator (10-4): `curl <metro>/json/list` with two emulators on one Metro.
- Hermes console replay size and `Runtime.enable` cost on RN 0.86.
- Fetch coverage of the example app (10-12): which HTTP client it uses.

## Owned files not read

- `packages/e2e/src/devtools/*.test.ts` were run (all pass) but only skimmed for coverage (`session.test.ts` test titles); `cdp.test.ts`, `console.test.ts`, `network.test.ts`, `collector.test.ts`, `facet.test.ts`, `inspector.test.ts`, `tree.test.ts`, `metro.test.ts`, `network.script.test.ts`, `tree.script.test.ts`, `facet.testing.ts` bodies not read line by line.
- `apps/cli/src/agent-ui/ui-devtools.test.ts` does not exist; `ui-collect.test.ts` not read.

## Questions for the user

1. On Android, how should a shared Metro tell two emulators apart (10-4)? The options are a per-device marker set by warden and read in the page, or a persisted `logicalDeviceId`; the first adds an env contract.
2. Is it acceptable for the CLI one-shots (`ui eval|tree|reload`) to stop installing the network wrapper (10-2, 10-6)? It is a behaviour change only if someone relies on `eval` as a way to start recording.

## Files read

- `docs/audit/BRIEF.md`, `docs/audit/ASSIGN-10.md`, `packages/e2e/CLAUDE.md`
- `packages/e2e/src/devtools/{cdp,session,inspector,console,network,network.script,tree,tree.script,collector,facet,metro,jsonl,devtools.types,devtools.testing}.ts`
- `apps/cli/src/agent-ui/{devtools-cli,devtools-register,run}.ts`, `apps/cli/src/commands/ui-collect.ts`
- `packages/e2e/src/{session,device-devtools,fixtures}.ts`, `packages/e2e/src/runner/{attempt,failure}.ts` (relevant parts), `packages/e2e/src/screen/{locator,context,react-locator}.ts` (relevant parts), `packages/core/src/liveness.ts`, `apps/cli/src/metro.ts` (head)
- `docs/plans/wdn-e2e.md` (A7/A8 live verification, root causes 6-7, K14, boot times)
- Ran: `bun test src/devtools/<file>.test.ts` for the 11 test files with source modules (all pass)

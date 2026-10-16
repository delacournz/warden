# 04 · android-uiad

Auditor 04. Scope: `warden-uiad` (`packages/e2e/native/android/src/.../uiad/{Main,Uia,Json}.java`), its scripts (`native/android/scripts/{build,record,smoke}.ts`, `build.test.ts`) and the TS side of the server (`src/driver/android/uiad-{protocol,client,backend,device,ops}.ts`, `uiad.testing.ts`, `fixtures/uiad-session*.ndjson`). Commit `dfcc68b`. The source under `packages/` and `apps/` is identical at HEAD (`git diff --stat dfcc68b HEAD -- packages/ apps/` is empty). Line numbers are from the files as they are now.

## Top 5 by impact

1. **04-1**: any connect failure the server does not recognise as "busy" is reported as `connect_failed`. The TS side treats that as permanent and writes `uiadUnsupported` to `$WARDEN_HOME/android/<serial>.json`. One transient failure, or a reworded busy message, then turns the server off for every later process on that serial until the dex changes. Every snapshot after that is a 1.9 s dump.
2. **04-2**: `uiad-ops` stops a healthy server on any error code that is not a refusal, even one the live server answered itself (`E_AX_UNAVAILABLE` "no root", `E_INTERNAL`, `E_BAD_REQUEST`). A `typeText`/`key` that typed nothing is then reported as a failed step. Each of these restarts counts toward the "more than 4 starts" give-up.
3. **04-5**: every `typeText` and `key` pays the full 80 ms edit quiet, because the server's `settle` counts from the moment it is called. A fill's own confirm reads already cover the window that matters (before the next press). Estimated ~1.2 s per Android rep.
4. **04-3** (K6): `fresh:true` calls `UiAutomation.clearCache()`, which exists from API 34 only. On API 26-33 it is silently skipped (`catch Throwable`), so on the unverified levels the "fresh" flag may do nothing, and nobody can tell.
5. **04-6**: the busy rule kills **any** `warden-uiad` process, including one a live warden process is using right now (`warden ui` during `warden e2e` on the same lease, or two drivers on one device). The two then take turns killing each other, and the in-flight taps come back as errors.

## Findings

### 04-1 A transient or unrecognised connect failure permanently disables the server on that serial
- **Category**: robustness
- **Severity**: P1
- **Known?**: new (adjacent to K6: the levels that would hit it are the unverified ones)
- **Evidence**:
  - `Main.java:90-98@dfcc68b`: every `Throwable` from `uia.connect()` other than `OpError` is classified by substring. `busy = message.contains("already registered") || message.contains("Already connected")`. Anything else is `detail.reason: "connect_failed"`.
  - That includes `RuntimeException("Error while connecting …")` (a `RemoteException` / `DeadObjectException` from `system_server`), a connect `TimeoutException` wrapped in `RuntimeException`, and an `InvocationTargetException` from `ctor.newInstance` (`Uia.java:85`, not unwrapped, so its message is `"null"`). A future or OEM rewording of the busy message lands here too. The only wording ever checked is API 37's (`fixtures/uiad-session-busy.ndjson:1`).
  - `uiad-backend.ts:74-81@dfcc68b`: `isPersistentStartFailure` is true for `E_UNSUPPORTED` **or** `reason === "connect_failed"`.
  - `uiad-backend.ts:137-139`: on such a failure it calls `deps.onUnsupported?.(uiadBuildId())` and then `giveUp`.
  - `android-driver.ts:258-260@dfcc68b`: it persists `uiadUnsupported: <build id>` in the per-serial state file. `uiad-backend.ts:86-87`: every later driver on that serial starts with the server off.
  - Nothing clears it except a new dex hash or an API-level change (`android-state.ts:151-161`). `grep uiadUnsupported` finds no other writer.
  - Emulator serials are reused (`emulator-5554` for any AVD on that port), so one bad start poisons every AVD at the same API level that later runs on that port.
- **Impact**: when it fires, every snapshot is a ~1.9 s `uiautomator dump` instead of ~25 ms, and every input is an `input` JVM start. Measured on the same emulator in the PERF-3.3 acceptance: three flow files took 131 s with the dump driver against 15.7 s with the server (`docs/plans/wdn-perf.md:593`). How often it fires is unmeasured. It needs a `system_server` hiccup at connect time (emulator just booted, host load average ~200 per `wdn-perf.md:441`) or a different busy wording. Platform: android.
- **Proposed fix**:
  - `Main.java`: emit `connect_failed` only for deterministic causes: `NoSuchMethodException` / `ClassNotFoundException` / `NoSuchFieldException` / `LinkageError` in the cause chain. Give everything else a new `detail.reason: "connect_error"`, unwrap `InvocationTargetException`, and walk the cause chain for the busy check.
  - `uiad-backend.ts`: persist only `E_UNSUPPORTED` and deterministic `connect_failed`. Optionally require two persistent failures from two processes before writing, or store `{build, at}` and ignore entries older than 24 h.
  - Have `warden doctor` / `warden ui status` show a saved `uiadUnsupported` and how to clear it.
  - Contract: wire, additive (one new `detail.reason`; an older host reads it as non-persistent), plus the state file shape if a timestamp is added (store).
- **Effort**: S
- **Risk**: low. A genuinely unsupported level now pays one or two failed starts per process (~100-450 ms each) before giving up for that driver. Verifying the classification needs a device: kill `system_server`'s accessibility during start, or start right after boot.
- **How to verify**:
  - `uiad-backend.test.ts`: a fatal with `detail.reason: "connect_error"` gives no `onUnsupported` call and counts as one start failure.
  - A device-free Java test of the classifier (see 04-9) over the exception chains above.
- **Confidence**: high for the mechanism (traced). Med for how often it fires.
- **Verified by**: traced path from `Main.serve` catch → `fatal` → `startUiad` → `failedStart` → `onUnsupported` → `android-driver.ts:260` state write → `createUiadBackend` `off` on the next process.

### 04-2 Errors a healthy server answered stop the server; a `typeText` that typed nothing is surfaced as a failed step
- **Category**: robustness
- **Severity**: P2
- **Known?**: new
- **Evidence**:
  - `uiad-ops.ts:55@dfcc68b`: `REFUSALS = {E_HID, E_NO_ELEMENT, E_UNSUPPORTED}`.
  - `uiad-ops.ts:102-109`: any other code calls `backend.failed(error)`, which closes the server (`uiad-backend.ts:163-168`). The verdict is then `surface` unless the request was never sent.
  - `uiad-ops.ts:112-123`: for a non-idempotent op (`typeText`, `key`, `tap`, `swipe`) `surface` returns the error as the step's result.
  - `Uia.java:608-613@dfcc68b`: `typeText` and `selectAll` start with `focusedInput()`, which throws `E_AX_UNAVAILABLE` (retryable) when the active window has no root for 500 ms. That happens before anything is injected. The server is alive and answered on the wire.
  - The same path catches `E_INTERNAL` (`Main.java:175-177`, any `Throwable` in an op) and `E_BAD_REQUEST`. The server answered all of them and is healthy.
  - On the read side, `uiad-ops.ts:150-153`: any snapshot error other than "no window yet" calls `backend.failed` and falls back to the dump. A malformed reply (`uiad-client.ts:100-109`, `E_INTERNAL`) does the same.
  - Each restart counts in `started`, and `uiad-backend.ts:100-103` gives up for the driver once `started > 3`.
  - The tests pin "a server that died is a failed step" (`uiad-ops.test.ts:352`). None covers "the server answered `E_AX_UNAVAILABLE` to `typeText`".
- **Impact**:
  - A fill that lands while a window is changing fails the step, although nothing was typed. A dump fallback that is not needed costs ~1.9 s.
  - A restart costs ~100 ms (`wdn-perf.md:441`) and is one of the four starts allowed.
  - Frequency unmeasured; android.
- **Proposed fix**:
  - In `judge`, split "the server answered `ok:false`" from transport failures (`E_TIMEOUT`, `E_HELPER_CRASHED`). The client can tag answered errors (`detail.answered: true`) in `onResponse`.
  - An answered `E_AX_UNAVAILABLE` on `typeText`/`key`/`selectAll` means nothing happened. Retry it once on the same server after ~200 ms, then fall back to `input`.
  - An answered `E_INTERNAL` / `E_BAD_REQUEST`: log it, keep the server, fall back for that call.
  - Files: `uiad-client.ts`, `uiad-ops.ts`. Contract: additive.
- **Effort**: S
- **Risk**: low. A server that answers but is wedged keeps answering errors, so cap answered `E_INTERNAL`s (for example 3 in a row) before calling `failed`. No device is needed for the logic.
- **How to verify**: `uiad-ops.test.ts` with `fakeUiad({ handle })` answering `E_AX_UNAVAILABLE` to `typeText`. Assert one server start, no surfaced error and an `input text` fallback (or a retry).
- **Confidence**: high
- **Verified by**: read; traced `Uia.focusedInput` → `Main.handle` OpError → `mapWireError` → `uiad-ops.judge` → `backend.failed`; ran `bun test src/driver/android/uiad*`.

### 04-3 `fresh:true` is a silent no-op below API 34 (`clearCache` swallowed)
- **Category**: correctness
- **Severity**: P2
- **Known?**: known-extended K6 (adds a level-dependent difference that a level-36 smoke run would not show)
- **Evidence**:
  - `Uia.java:414-421@dfcc68b`: `clearCache()` calls `ua.clearCache()` inside `catch (Throwable ignored)`. The comment says "API 31+" and "older images have no cache API; their reads were uncached".
  - The plan says `clearCache` is API 34+ (`wdn-perf.md:510`). `build.ts:30` accepts `android.jar` from platform 30. On API 26-33 the call is a `NoSuchMethodError`, swallowed on every snapshot (`Uia.java:267`) and in `focusedInput` (`Uia.java:609`).
  - Whether those levels' `UiAutomation` reads go through `AccessibilityInteractionClient`'s cache, which events maintain, is exactly what the comment assumes and nothing checks. If they do, every "fresh" snapshot on 26-33 is the `fresh:false` read, which can "lag the app by an event" (`uiad-client.ts:50-51`, `wdn-perf.md:546`).
  - The reply carries no field that says whether the cache was cleared.
- **Impact**: correctness, not time. On API 26-33 (none run on a device, `wdn-perf.md:521`) a read right after a change that sent no event yet can return the old tree. The host polls again, so the likely symptom is an extra poll, plus a rare wrong `not.toBeVisible` / `alert` verdict. Unmeasured.
- **Proposed fix**:
  - Below 34, call the hidden `AccessibilityInteractionClient.getInstance().clearCache()` by reflection: cache the `Method` once, signature per level, as `injectOne` does at `Uia.java:488-507`.
  - Report `"cache":"cleared"|"none"|"failed"` in the snapshot reply (additive wire) and note it on the span.
  - Fix the comment and set `MIN_PLATFORM` to 34 (see 04-12).
  - Files: `Uia.java`, `uiad-protocol.ts` (optional field), `uiad-ops.ts`.
- **Effort**: S
- **Risk**: low. Reflection failures fall back to today's behaviour. Needs an API 30 and API 33 emulator.
- **How to verify**: on an API 30/33 emulator, change a `Text` from JS with no layout change, snapshot within 50 ms, and compare the fresh read with `uiautomator dump`. Then `smoke.ts --serial` there.
- **Confidence**: low. The API level of `clearCache` is from the plan. Whether pre-34 UiAutomation reads are cached is unverified here, and it decides whether this is a bug or only a missing diagnostic.
- **Verified by**: read

### 04-4 Snapshot tail (K6): the traverse is one `getChild` call per node into the app's UI thread, and nothing measures the cache misses
- **Category**: perf-latency
- **Severity**: P2
- **Known?**: known-extended K6 (mechanism plus instrumentation and fix candidates)
- **Evidence**:
  - `Uia.java:267@dfcc68b` clears the client cache before every read. `Uia.java:284` takes the root with the default prefetch.
  - `Uia.java:359-402`: `dump` recurses with `node.getChild(i)` per child (`:394`). Every child the root's prefetch did not bring is a synchronous query that the app answers on its UI thread (`AccessibilityInteractionController`) and that prefetches its own batch.
  - Right after navigation that thread is busy with mount and layout. Each miss waits for a frame, so traverse time scales with misses × UI-thread latency, not with node count.
  - The plan's tail is exactly that: "30 of 88 snapshots over 150 ms … the server's own traverse is slow" right after sign-in, while a quiet screen is p50 6 ms (`wdn-perf.md:594`).
  - No reply field counts misses or remote time. `readMs` covers the whole walk (`Uia.java:305,318`).
  - No prefetch strategy is chosen. API 33+ has `getRootInActiveWindow(int prefetchingStrategy)`.
  - `isVisibleToUser` pruning (`Uia.java:395`) is local (a field on the node), so it is not the cost.
  - The nodes are never `recycle()`d. That is a no-op from API 33 and only lost pooling below it, so it is not an RSS leak.
- **Impact**:
  - Measured: p50 25 ms, p90 105 ms, p95 ~270 ms through the driver; 150-170 snapshots per warm rep (`wdn-perf.md:594`, `docs/bench/android-2026-10-16-perf.md` "driver snapshots / taps per warm rep").
  - Estimated wall gain: 0.3-1.5 s per rep. Most tail snapshots are polls during a transition the test waits out anyway, so only the poll that would have seen the new screen gets earlier. Device CPU (avg 39.7-49.6 % including the app) drops with every avoided round trip.
  - Low confidence until misses are counted.
- **Proposed fix**, in order:
  - (a) Instrument: time each `getChild`. Count calls over 1 ms as `remote` and sum their time. Return `{remote, remoteMs, rootMs}` in the snapshot data (additive wire). Note them on the span in `uiad-ops.ts:146-147`.
  - (b) On API 33+, try `getRootInActiveWindow(FLAG_PREFETCH_DESCENDANTS_DEPTH_FIRST | FLAG_PREFETCH_UNINTERRUPTIBLE)` through a cached `Method`, so the prefetch order matches the DFS. Compare `remote` before and after.
  - (c) The plan's own idea (`wdn-perf.md:546`): skip `clearCache` when a `settle` just reported `events: 0` and no input went in since. `fresh:false` reads take 3 ms. Neither is implemented: the TS never sends `fresh`, and `uiad-ops.ts:170` drops `events`.
  - Files: `Uia.java`, `uiad-protocol.ts`, `uiad-ops.ts`.
- **Effort**: M
- **Risk**: med. A prefetch strategy can change which nodes the cache holds, but not what is read, because `getChild` still answers. (c) carries staleness risk and is a policy change. All of it needs a device.
- **How to verify**: `smoke.ts` samples (fresh, cached, all), then the idiomatic Android bench. Compare `uiadMs` p95 on `todos-screen` polls after sign-in against the 270 ms baseline, and the `remote` counts.
- **Confidence**: med for the mechanism (standard platform behaviour, consistent with the measured split). Low for the size of the gain.
- **Verified by**: read; traced `uiad-ops.snapshot` → `Uia.snapshot` → `dump`.

### 04-5 The edit quiet after `typeText` / `key` is always the full 80 ms, even when the next call is a read
- **Category**: perf-latency
- **Severity**: P2
- **Known?**: new (refines the PERF-3.3 race fix, `wdn-perf.md:586`)
- **Evidence**:
  - `uiad-ops.ts:129-138@dfcc68b`: after every successful `typeText`/`key`, `edit` awaits `server.settle({quietMs: 80, timeoutMs: 1000})`.
  - `Uia.java:447@dfcc68b`: `baseline = max(start, lastEventMs, lastInputMs)`. The quiet counts from the call, so it is never shorter than `quietMs` ("waits exactly quietMs", `wdn-perf.md:445`).
  - The race this protects against is a **press** within ~20 ms after the text (`uiad-ops.ts:60-66`). But a spec `fill` follows `typeText` with confirm reads: at least `CONFIRM_READS = 2` reads `FIELD_POLL_MS = 50` ms apart (`screen/field.ts:16-21,58-90`). The next press comes ≥ 100 ms later anyway.
  - Measured `typeText` p50 202 ms, "80 ms of it the quiet wait" (`wdn-perf.md:594`).
- **Impact**:
  - Estimated: the bench suite calls `submitSignIn` 8 times per rep. That is 2 fills each, plus 1 todo fill, so ~17 `typeText` per rep (`packages/e2e-bench/suites/warden/sign-in.e2e.ts:9-24`, `helpers/flows.ts:38-39,105`, `todos.e2e.ts:11`).
  - 17 × ~75 ms ≈ 1.2-1.3 s per Android rep (~4 % of the 29 s suite), plus each Backspace after a select-all.
- **Proposed fix**:
  - Move the quiet to the next input. `uiad-ops` remembers `editAt` (host clock). Before the next `tap`/`swipe`/`key`/`typeText`, if fewer than 80 ms passed or events may still be flowing, it asks the server to settle with a new additive param `{since: "input"}`. That measures quiet from `max(lastEventMs, lastInputMs)` only and returns at once when that is already ≥ `quietMs` old.
  - Reads (snapshot, settle) skip it.
  - Files: `Uia.java` (`settle` baseline option), `Main.java` (param), `uiad-ops.ts`, `uiad-client.ts` (`settle` params type). Contract: wire, additive.
- **Effort**: S
- **Risk**: med. A press that follows text with no read in between (raw `driver.typeText` then `driver.tap`) still gets the wait, now just before the press. The 3-in-20 drop from the plan must be re-run on a device (`todo-detail` ×10, sign-in submit right after a fill).
- **How to verify**: `uiad-ops.test.ts`: `typeText` then `snapshot` sends no settle; `typeText` then `tap` sends one settle with `since: "input"` first. On device: sign-in flow ×20 with no dropped submit, and `typeText` span p50 down to ~120 ms.
- **Confidence**: med
- **Verified by**: read; traced `field.ts focusClearType` → `typing.typeText` → `android-driver.typeText` → `uiad-ops.edit` → `Uia.settle`.

### 04-6 The busy rule kills a server that a live warden process is still using
- **Category**: flake-risk
- **Severity**: P2
- **Known?**: new
- **Evidence**:
  - `uiad-device.ts:118-129@dfcc68b`: `parseHolders` marks **every** process whose args contain `nz.co.delacour.warden.uiad.Main` as `ours`.
  - `uiad-device.ts:175-181`: on busy, those are `kill`ed by pid and the start retried. The comment and AGENTS.md say this is meant for "a second warden process on the same device".
  - `warden ui` opens its own driver, and its own server, on every call (`apps/cli/src/agent-ui/ui-driver.ts:27-38`, K17). An agent that runs `warden ui snapshot` while its `warden e2e` run holds the device kills the run's server. The run's in-flight `tap`/`key`/`typeText` comes back as `E_HELPER_CRASHED` and is surfaced (`uiad-ops.ts:119`). Its next call restarts, finds the CLI's server busy, and kills that one back.
  - Each kill counts as a restart (`uiad-backend.ts:100-103`), so both sides can end up on the dump.
  - Nothing tells a stale holder (host dead) from a live one.
- **Impact**: a failed step per collision, plus up to 4 restarts per driver. Platform: android. Frequency depends on whether agents inspect a device during a run. The docs present `warden ui` as the inspection tool.
- **Proposed fix**:
  - Tag the server with its owner. Add `WARDEN_UIAD_OWNER=<hostname>:<pid>:<startTime>` to the `exec env` in `uiadLaunchCommand` (`uiad-device.ts:35-37`), and pass it as an argv to `Main` so `ps -o ARGS` shows it.
  - On busy, kill only holders whose owner pid is dead on this host (`process.kill(pid, 0)` plus a start-time check) or whose tag is missing (older builds).
  - A live owner gets a `busyError` naming it ("in use by warden pid N"), with the existing 2 s re-ask.
  - Files: `uiad-device.ts`, `Main.java` (accept and ignore the argv). Contract: additive.
- **Effort**: S
- **Risk**: low. An owner on another host sharing the emulator cannot be checked. Treat a foreign hostname as live, the safe side. Verifying needs a device.
- **How to verify**: `uiad-device.test.ts`: `ps` output with a tagged holder whose pid is alive gives a busy error and no `kill`; a dead pid gives a `kill`. On device: run `warden ui snapshot` in a loop during `warden e2e example --platform android` and check that no step fails.
- **Confidence**: high for the mechanism. Med that the scenario occurs in practice.
- **Verified by**: read; traced `launchUiad` → `parseHolders` → `kill`.

### 04-7 `build.ts --out` with no value (or `.`) deletes the current directory
- **Category**: robustness
- **Severity**: P2
- **Known?**: new
- **Evidence**: `native/android/scripts/build.ts:193-194@dfcc68b`: `const dist = resolve(outIndex >= 0 ? (argv[outIndex + 1] ?? "") : …)`. With `--out` last, `resolve("")` is `process.cwd()`. Then `build.ts:204`: `await rm(dist, { recursive: true, force: true })` deletes it. `--out .`, or `--out <existing dir>`, wipes that directory too. It runs before the toolchain check fails nothing; it runs after a successful `findToolchain`, so it fires on any machine that has an SDK.
- **Impact**: data loss on a by-hand call (`bun run --cwd packages/e2e android:build -- --out`) deletes `packages/e2e`, git-tracked work included. No time cost.
- **Proposed fix**: refuse `--out` without a value, or with a value starting with `--`. Build into `<dist>/.build-<pid>` and delete only that, plus the files the script writes (`warden-uiad.dex`, `manifest.json`), never the directory. Add the case to `build.test.ts` by exporting an `outDir(argv)` helper. Additive.
- **Effort**: S
- **Risk**: low; no device.
- **How to verify**: `build.test.ts`: `outDir(["--out"])` throws; `outDir(["--out", "x"])` resolves `x`. Read the `main` path for any other recursive `rm` of a caller-chosen path.
- **Confidence**: high
- **Verified by**: read

### 04-8 The server's ~143 MB device RSS is unattributed; no PSS, and no VM options tried
- **Category**: perf-ram
- **Severity**: P2
- **Known?**: new (the device side of K2's "RSS unattributed")
- **Evidence**:
  - `smoke.ts:520-537@dfcc68b` reads `VmRSS` only. The plan quotes "VmRSS ~143 MB" (`wdn-perf.md:450,548`).
  - An `app_process` runtime maps the boot image and framework code file-backed and shared with zygote's page cache. VmRSS counts all of it, while PSS and private-dirty, the real cost, are unknown.
  - The bench "sim" RSS (383 MB avg) is a per-process RSS sum (`docs/bench/android-2026-10-16-perf.md`, Resources note), so the server's shared pages are counted in full.
  - The launch uses no VM options (`uiad-device.ts:35-37`: `app_process / Main`). The heap grows freely with each snapshot's garbage. Per snapshot that is: one `StringBuilder` of 32 KB initial (`Uia.java:300`), `toString`, plus the copies in `Main.java:170` (concat), `:34` (`line + "\n"`) and `getBytes`. That is ~4-5 copies of a 6-30 KB payload, or ~150 KB of garbage per snapshot at 190 nodes. `pkg` alone is 28 % of the bytes (see 04-13).
- **Impact**: unknown until measured. If private-dirty is the 20-40 MB typical of a small ART process, nothing big is to be won. If the heap has grown to tens of MB of garbage, `-Xmx`/`-XX:HeapTargetUtilization` and fewer copies cut it.
- **Proposed fix**:
  - (a) Measure: in `smoke.ts`, add `cat /proc/<pid>/smaps_rollup` (Pss, Private_Dirty, Shared_Clean) and `dumpsys meminfo <pid>` after 60 snapshots and after 10 s idle.
  - (b) Try `app_process -Xms4m -Xmx32m` and `-Xusejit:false`, one at a time, against snapshot p50 and Pss.
  - (c) Write the reply straight into a reusable byte buffer: `Main.send(StringBuilder)` with an ASCII loop and one `write`, which drops 3 copies.
  - Files: `smoke.ts`, `uiad-device.ts` (launch argv), `Main.java`. Additive.
- **Effort**: M
- **Risk**: low for measuring. A heap cap too small risks `OutOfMemoryError` on a huge tree (`maxNodes` 20000), which `Main.handle` turns into `E_INTERNAL`. Needs a device.
- **How to verify**: `smoke.ts --serial` before and after, with the Pss figures in the plan table.
- **Confidence**: low (no device here)
- **Verified by**: read

### 04-9 Test gap: the Java has no tests, and the fake replays one happy path recorded on one API level
- **Category**: test-gap
- **Severity**: P2
- **Known?**: known-extended K6
- **Evidence**:
  - **No Java tests at all.** `build.test.ts` covers the build helpers; `uiad-dex.test.ts` pins the source hash. Nothing runs `Json.str`, the `Main.handle` dispatch, the settle baseline (`Uia.java:438-470`), the busy classifier (`Main.java:90-98`, see 04-1) or the `typeText` splice (`Uia.java:643-651`).
  - **The fake answers by op, not by request.** `uiad.testing.ts:58-79,150-160@dfcc68b` keeps the **first** recorded reply of each op.
    - `settle` always answers `waitedMs: 251` (`fixtures/uiad-session.ndjson`, id 3), whatever `quietMs` it gets (the edit settle asks for 80).
    - `snapshot` ignores `scope`/`fresh`/`windows`.
    - `typeText` and `selectAll` answer `E_NO_ELEMENT` by default (ids 4 and 5), which is fine but easy to misread.
    - `screenshot` and `setText`'s error replies were never recorded.
  - **The recording covers successes only, plus three refusals.** It has no `E_HID`, no `E_AX_UNAVAILABLE` for a null root, no password `E_UNSUPPORTED`, no `scope:"all"` and no `fresh:false` (`native/android/scripts/record.ts:158-206`).
  - **Fake lifecycle drifts from the real one.** The fake exits on stdin `end()` at once (`uiad.testing.ts:191-193`). The real server sees EOF only when its io thread is back in `readLine` (`Main.java:104`), so a hung op outlives its host. Only the busy/stale-kill path covers that, and no test models it.
- **Wire agreement** (op × field: Java emits / TS reads / used downstream):

  | op | Java emits | TS schema | used by driver |
  |---|---|---|---|
  | `ready` | `protocol, version, data:Health` | `readyEventSchema` (all) | `health` kept, protocol checked |
  | `snapshot` | `backend, screen{w,h,scale,rotation}, windows?, elements, truncated, nodes, readMs, ms` | `snapshotEnvelope` (all) | `rotation`, `truncated`, `ms`; **drops** `nodes`, `readMs`, `windows` |
  | node | `class, pkg, id, text, desc, hint, bounds, 12 flags, order, children` | `readNode` (all) | `rawFromUiad` (`uiautomator.ts:311-335`) **drops** `pkg`, `focusable`, `editable`, `invisible`, `order` |
  | `settle` | `quiet, waitedMs, via:"events", events, firstEventMs?, reason?` | `settleDataSchema` (all) | `quiet, waitedMs, reason`; **drops** `events`, `firstEventMs` |
  | `typeText` | `text, caret, caretPlaced` | `textDataSchema` | discarded (`mapVoid`) |
  | `tap` | `downMs, upMs, via` | none (raw) | discarded |
  | `selectAll` / `key` / `swipe` | `{length}` / `{}` / `{}` | none | discarded |
  | `setText`, `screenshot` | `{text}`, `{width,height,grabMs,encodeMs,png}` | `textDataSchema` / none | never called |
  | errors | `E_AX_UNAVAILABLE, E_UNSUPPORTED, E_HID, E_NO_ELEMENT, E_IO, E_BAD_REQUEST, E_INTERNAL` | all in `DRIVER_CODES` (`driver.types.ts:15-31`) | no code becomes `E_INTERNAL` by mapping |

  No field is renamed or mistyped across the wire. The drift is in what is dropped (04-13) and in the fake.
- **Impact**: no time cost. The bugs in 04-1, 04-2 and 04-10 sit exactly in the untested paths.
- **Proposed fix**:
  - (a) A host-JVM harness with no device and no `android.jar` at runtime. Move the pure logic into plain-Java classes with no `android.*` imports: `Json`, a `BusyClassifier.classify(Throwable)`, `Settle.verdict(start, lastEvent, lastInput, now, quietMs, timeoutMs)` with an injected clock, `TextSplice.splice(held, selStart, selEnd, text)`, and `Main.handle` over a `UiaOps` interface. Run them with `javac` + `java` in a `native/android/scripts/java.test.ts`, skipped when there is no JDK, as the build is today.
  - (b) A toolchain-free TS test that greps `Uia.java` for `Json.field(sb, first, "<k>"` / `Json.flag(…, "<k>"` and asserts the set equals `STRING_FIELDS ∪ FLAG_FIELDS ∪ {bounds, order, children}`.
  - (c) Make `fakeUiad` honour `settle.quietMs` (`waitedMs = quietMs`). Record error replies in `record.ts`: type into a password field holding text, and snapshot during an activity transition.
  - Additive.
- **Effort**: M
- **Risk**: low
- **How to verify**: the new tests fail on today's code for 04-1 (classifier) and pass after the fix.
- **Confidence**: high
- **Verified by**: read; ran `bun test src/driver/android/uiad* native/android/scripts/build.test.ts` (117 pass).

### 04-10 `ACTION_SET_SELECTION` answers false when the selection already is the requested one: `selectAll` reports `E_HID`, and `caretPlaced` is false on every recorded `typeText`
- **Category**: correctness
- **Severity**: P3
- **Known?**: new
- **Evidence**:
  - `fixtures/uiad-session.ndjson:32,34,40@dfcc68b`: all three real `typeText` replies say `"caretPlaced":false`, yet the text is right ("ada@" + "example.com" = "ada@example.com").
  - `ACTION_SET_TEXT` already puts the caret at the end, and the platform's `TextView` answers `false` for `ACTION_SET_SELECTION` when start and end equal the current selection. So `Uia.java:657-658` "fails" whenever the insert was at the end.
  - The same rule hits `selectAll` (`Uia.java:669-675`). On a field whose text is already fully selected (React Native `selectTextOnFocus`, or a second `selectAll`), `setSelection(0, length)` is `false`, which becomes `E_HID`. `uiad-ops.ts:216` then falls back to `input keycombination` (a JVM start, ~300 ms) on API 33+, or to counted Backspaces below it (`field.ts:131-137`).
- **Impact**: ~300 ms per fill into a select-on-focus field on Android (none in the bench app). `caretPlaced` cannot tell success from refusal.
- **Proposed fix**: in `setSelection`, read `getTextSelectionStart/End` (after `refresh()`). If they already equal the target, return true without acting. Report `caretPlaced` as "selection now equals caret". File: `Uia.java`. Wire semantics of `caretPlaced` are fixed; no shape change.
- **Effort**: S
- **Risk**: low; device to confirm.
- **How to verify**: re-record (`record.ts`) and expect `caretPlaced:true`. On device: `selectAll` twice on one field gives two `{length}` replies.
- **Confidence**: med. The fixture is evidence; the platform rule is from memory of `TextView.performAccessibilityActionInternal`.
- **Verified by**: read

### 04-11 `scope:"all"` turns interactive-window retrieval off before it walks the other windows
- **Category**: correctness
- **Severity**: P3
- **Known?**: new
- **Evidence**:
  - `Uia.java:271-290@dfcc68b`: the flag is switched on, `getWindows()` and each `w.getRoot()` run, and then the `finally` switches it **off** (`:289`) before `dump` walks those roots (`:308-314`).
  - For a window that is not the active one, every `getChild` the root's prefetch did not cache is then a query the system no longer allows for this client, and it comes back null. `dump` skips null children silently (`Uia.java:395`).
  - The plan's measurement fits: "`scope:"all"` + windows (191 nodes)" against 189 for the active window alone (`wdn-perf.md:440`). The status bar and the navigation bar would add far more than 2 nodes.
  - Each call also costs two `setServiceInfo` binder calls and makes `system_server` start and stop window tracking.
  - Today no production caller sends `scope` or `windows` (`grep` over `src/driver/android` and `apps/cli/src`). Only `smoke.ts:492` does.
- **Impact**: none today. The first feature to read the IME or a system overlay would get truncated trees with no error.
- **Proposed fix**: keep the flag on until `dump` has finished: move the walk inside the `try`, or switch it off after the loop at `:314`. Return `windowsTruncated` when a child query on a non-active window returned null. If the feature has no planned caller, remove `scope:"all"` from the wire instead. File: `Uia.java`.
- **Effort**: S
- **Risk**: low; device needed (parity of `scope:"all"` with `uiautomator dump --windows`, if available).
- **How to verify**: `smoke.ts`: compare the per-window node counts for the status bar with the flag kept on.
- **Confidence**: med
- **Verified by**: read

### 04-12 Build and doc drift: `MIN_PLATFORM` 30 cannot compile the source, and the plan's wire defaults differ from the Java
- **Category**: dx
- **Severity**: P3
- **Known?**: new
- **Evidence**:
  - `build.ts:30@dfcc68b`: `MIN_PLATFORM = 30` and "the newest `platforms/android-N` (N >= 30)". But `Uia.java:417` calls `UiAutomation.clearCache()`, which exists in `android.jar` 34+ (`wdn-perf.md:510`). An SDK whose newest platform is 30-33 fails at `javac` with a symbol error, not with the clear "toolchain not found" message.
  - The `build.ts:27` comment says "the server only calls API 24-26 methods itself", which is false (`clearCache`).
  - The plan's wire table gives `maxNodes` (5000) and `rootWaitMs` (500) as defaults (`wdn-perf.md:493`). The Java defaults are 20000 and 600 (`Uia.java:249,253`), and the TS sends neither. `uiad-client.ts:68` says the ready timeout is 5 s; the plan's fallback table says 3 s (`wdn-perf.md:534`).
- **Impact**: wasted time for whoever builds on an older SDK, or reads the plan as the contract.
- **Proposed fix**: `MIN_PLATFORM = 34` plus the comment fix. Update the plan table to the Java defaults, or have `uiad-ops` send `maxNodes`/`rootWaitMs` explicitly so the contract lives in the TS. Additive.
- **Effort**: S
- **Risk**: low
- **How to verify**: `build.test.ts` `pickPlatform(["android-33"])` is undefined.
- **Confidence**: high
- **Verified by**: read

### 04-13 Wire fields the host drops, and the fields it would need to attribute the K6 tail
- **Category**: dx
- **Severity**: P3
- **Known?**: known-extended K6
- **Evidence**:
  - In the recorded welcome-screen snapshot (6414 B, 47 nodes), `"pkg":…` is 1786 B (28 %) and `"order":…` 423 B (7 %). Measured with `grep -o` on `fixtures/uiad-session.ndjson` line 6. `rawFromUiad` drops both (`uiautomator.ts:311-335`).
  - The span keeps `uiadMs` only (`uiad-ops.ts:146-147`). `readMs` (traverse) vs `ms` (traverse + root wait + clearCache), and `nodes`, are dropped (`uiad-protocol.ts:161-170` has them). So a 270 ms snapshot cannot be split into "root wait" and "traverse" from `trace.jsonl`.
  - Settle `events`/`firstEventMs` and tap `via` (`inject3`/`inject2`, the hidden-API fallback signal) are dropped too.
  - Host parse is not the cost: `readSnapshotData` on that line takes 0.04 ms and `JSON.parse` 0.02 ms (bun, scratchpad micro-timing).
- **Impact**: 35 % of snapshot bytes cross adb, are escaped and are parsed for nothing; that is small (≤ 10 KB per snapshot at 190 nodes). Today the tail cannot be diagnosed from traces.
- **Proposed fix**: emit `pkg` only where it differs from the parent's (TS: inherit it in `readNode`), and `order` only when it is not the sibling index. Add `noteSpanDetail("uiadReadMs" | "uiadNodes" | "uiadInject")` and settle `events`. Files: `Uia.java`, `uiad-protocol.ts`, `uiad-ops.ts`. Contract: wire (`pkg` becomes inherited). Bump `VERSION`; protocol 1 stays when the TS inherits.
- **Effort**: S
- **Risk**: low
- **How to verify**: `uiad-nodes.test.ts` parity holds with inherited `pkg`; the span detail test in `uiad-ops.test.ts:95`.
- **Confidence**: high
- **Verified by**: read; ran a micro-timing script in the scratchpad.

### 04-14 Every server start pays a separate "is the dex there" round trip (K17)
- **Category**: perf-latency
- **Severity**: P3
- **Known?**: known-extended K17
- **Evidence**:
  - `uiad-device.ts:87-99@dfcc68b`: `ensureUiadDex` runs `uiadPresentCommand` (`[ -f ] && wc -c … && echo present`, `:54-58`) on the resident shell before every launch, then spawns the server's own `adb shell` (`:161-169`).
  - The check is right: it skips the 29-67 ms write (`wdn-perf.md:529`). But it is a full shell round trip on every start, and `warden ui` starts a server on every CLI call (K17, ~85 ms per start, `wdn-perf.md:549`).
- **Impact**: estimated one resident-shell round trip, ~5-30 ms, per start. In `warden e2e` that is once per spec process; in `warden ui` once per command.
- **Proposed fix**:
  - Fold the check into the launch: `[ "$(wc -c < F)" = N ] || exit 86; exec env CLASSPATH=F app_process / Main`.
  - On exit 86 before `ready` (`TransportClose.exitCode`), push and launch once more.
  - The daemon mode from K17 remains the bigger lever for `warden ui`.
  - File: `uiad-device.ts`. Additive.
- **Effort**: S
- **Risk**: low; device check of the exit code through `adb shell` (shell protocol v2 passes it).
- **How to verify**: `uiad-device.test.ts`: no `session.run` before the spawn when the fake exits 0. With exit 86, one push and a second spawn.
- **Confidence**: med
- **Verified by**: read

## Known items

- **K6**: known-extended.
  - 04-3: `clearCache` is a no-op below API 34, unverified.
  - 04-4: per-`getChild` round trips into the busy UI thread explain the ~270 ms p95; add `remote` counters, try a prefetch strategy.
  - 04-9: the fake and fixtures come from API 37 only.
  - 04-13: the trace cannot split the tail.
  - "Verified on API 37 only" is still true: the fixtures say `"sdk":37`.
- **K17**: known-extended (04-14). Each start also pays a separate dex-present round trip. Daemon mode is still not implemented: `ui-driver.ts` opens a driver per call. It is also the source of the cross-process kill in 04-6.
- **K2**: touched by 04-8. The device-side RSS of `warden-uiad` is VmRSS only; the bench sums RSS.

## Gaps I could not assess here

Checked and clean (not findings):
- stdin is buffered (`Main.java:102`).
- `System.out` goes to stderr before anything else (`:81`).
- `send` is synchronized and never called under `eventLock`, so a slow reader blocks only the io thread, never the event listener.
- `injectInputEvent` 3-arg is looked up once and cached (`Uia.java:488-507`). The `connect` / `disconnect` lookups run once per process.
- `Json.str` escapes everything outside 0x20-0x7e correctly, surrogate pairs included.
- Every Java error code is a `DriverErrorCode`.
- The single-flight `starting ??=` and `stop()` waiting for an in-flight start are correct.

Needs a device:
- **04-1 frequency**: start the server in a loop right after `adb wait-for-device` / `sys.boot_completed=1` on a cold emulator. Run `adb -s <serial> shell "exec env CLASSPATH=/data/local/tmp/warden-uiad-<hash8>.dex app_process / nz.co.delacour.warden.uiad.Main" < /dev/null` 20 times and collect every `fatal` message that does not say "already registered".
- **04-3**: on API 30 and 33 emulators, `smoke.ts --serial <s>`, plus a fresh snapshot within 50 ms of a JS-only text change, compared with `uiautomator dump`.
- **04-4**: after adding the `remote` counters, `smoke.ts` and the idiomatic bench (`bun run --cwd packages/e2e-bench bench run --platform android --runs 3`). Compare the `uiadMs` p95 and `remote` per snapshot on the `todos-screen` polls after sign-in.
- **04-8**:
  - `adb shell cat /proc/$(pidof app_process)/smaps_rollup` and `adb shell dumpsys meminfo <pid>`, after 60 snapshots, then after 10 s idle.
  - Repeat with `app_process -Xmx32m` and `-Xusejit:false`.
  - The device CPU split between the app and the server (`top -H -p <pid>` during a bench rep) is unknown too.
- **Hung-op lifecycle**: does a server hung in a binder call die when the host `adb` is killed (adbd SIGHUP), or only at the next `readLine`? Test: `kill -STOP` the app under test during a snapshot, kill the host adb, then `ps -A | grep warden.uiad`.
- **A11y query timeouts**: the platform's per-query timeout (~5 s) on a blocked UI thread times the number of misses can exceed the 10 s request timeout. When the app's UI thread is blocked, measure snapshot `ms` against the 10 s request timeout.

## Owned files not read

- `uiad-client.test.ts`, `uiad-device.test.ts`, `uiad-protocol.test.ts`, `uiad-nodes.test.ts`, `uiad-dex.test.ts`, `build.test.ts`: run (117 pass), not read line by line. `uiad-ops.test.ts` and `uiad-backend.test.ts`: test names read.
- `smoke.ts`: lines 1-485 and 546-659 only skimmed (grep for checks). Lines 486-545 read.
- `uiad-dex.generated.ts`: header only, as instructed.

## Questions for the user

1. Is running `warden ui` against a device while `warden e2e` runs on it (same lease) a supported use? If yes, 04-6 is P1; if no, the CLI should refuse it with a clear message instead.

## Files read

- docs/audit/BRIEF.md, docs/audit/ASSIGN-04.md, docs/audit/raw/09-device-app-launch.md (format only)
- AGENTS.md, packages/e2e/AGENTS.md (§ Android driver internals), packages/e2e/CLAUDE.md
- docs/plans/wdn-perf.md (lines 413-600 and the grep hits), docs/bench/android-2026-10-16-perf.md
- packages/e2e/native/android/src/nz/co/delacour/warden/uiad/Main.java, Uia.java, Json.java
- packages/e2e/native/android/scripts/build.ts, record.ts, smoke.ts (partial)
- packages/e2e/src/driver/android/uiad-protocol.ts, uiad-client.ts, uiad-backend.ts, uiad-device.ts, uiad-ops.ts, uiad.testing.ts, fixtures/uiad-session.ndjson, fixtures/uiad-session-busy.ndjson
- Context only: packages/e2e/src/driver/android/android-driver.ts (lines 210-300, 360-420, 485-500), android-state.ts (150-170), uiautomator.ts (305-345), packages/e2e/src/driver/ios/simd-protocol.ts (`mapWireError`, framing, schemas), driver/typing.ts, screen/field.ts, apps/cli/src/agent-ui/ui-driver.ts, packages/e2e-bench/suites/warden/{sign-in.e2e.ts,todos.e2e.ts,helpers/flows.ts}

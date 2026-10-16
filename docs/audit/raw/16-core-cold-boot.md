# 16 · core-cold-boot

Auditor 16. Scope: the claim/boot path for cold iOS simulators and Android emulators, warm reuse across runs, and probe/spawn counts on claim (`packages/core/src/{claim,allocate,inventory,liveness,shutdown-policy,config.defaults,headless}.ts`, `providers/*`, `golden/*`, `sims/slim.ts`, `apps/cli/src/{claim-flags,sim-windows,autogc,device-shutdown}.ts`, `commands/{claim,gc,golden}.ts`). Commit `dfcc68b`; HEAD `d6629f7` only adds audit docs, so no source changed. Line numbers are from the files as they are now. Costs are **measured** only where a comment, README or bench doc gives a number (cited). Everything else is **estimated**, and the arithmetic is shown. The per-step cost map for questions 1–6 is at the top of "Gaps", because most of its numbers need a device.

## Top 5 by impact

1. **16-1** (P0): the auto-gc that a `claim`/`e2e`/`batch`/`run`/`dev` starts is detached and races the claim that started it. Its idle pass shuts down the very idle device this run is about to reuse. On the "second run of the day" (more than 20 min idle) warm reuse is lost every time (iOS cold boot 6.5–11.9 s, Android a whole new emulator), and the run can be handed a device that is mid-shutdown.
2. **16-2** (P1): a device that never gets ready (iOS `bootstatus -b` hits 300 s, Android `boot_completed` never arrives) is not quarantined and not retried. The claim fails, the device stays booted with no lease, and because booted devices rank first, the next claim picks the same device and waits another 5 min.
3. **16-3** (P1): Android has no warden-owned quick-boot snapshot. Each cold emulator boots from whatever snapshot the user's AVD happens to hold (often none, so a full cold boot), and `-no-snapshot-save` never refreshes it. A warden snapshot keyed by system image would cut ~15–40 s per new emulator (estimate) and give every run the same start state.
4. **16-4** (P1): after launching an emulator, the Android `boot` step is one `adb devices -l` existence check, about 1.5 s after spawn. If adb has not registered the emulator yet, the claim fails, and it leaves a running emulator with no lease.
5. **16-13** (P2): warm reuse after a gap is undone by three timers and one hook. gc idle is 20 min and also stops the helper. Helper idle exit is 10 min (K11: 708 ms cold vs 182 ms warm). SessionEnd shuts down every warden device the session held (16-9). There is no `warden warm`. This entry lists the options and their RAM cost.

## Findings

### 16-1 Auto-gc started by a claiming command shuts down the idle device that same command is about to reuse
- **Category**: flake-risk
- **Severity**: P0
- **Known?**: new
- **Evidence**:
  - The claiming commands start gc **before** they claim:
    - `apps/cli/src/commands/claim.ts:74@dfcc68b` calls `maybeAutoGc(ctx)` before `claimWithFlags` (`:81`).
    - `apps/cli/src/commands/batch.ts:1615@dfcc68b` does the same (this is the `e2e`/`batch` path), as do `commands/run.ts:103` and `commands/dev.ts:347`.
  - `maybeAutoGc` (`apps/cli/src/autogc.ts:47-66@dfcc68b`) is due at most every 10 min (`:7`). It spawns a detached `nice -n 10 warden gc --quiet` (`:28-36`, `:65`) whenever `store.gcWork` counts an idle device. `gcWork` (`packages/core/src/store.ts:362-373@dfcc68b`) counts any device with `last_used_at <= now - idle`, no lease, and an idle threshold crossed since the last gc. So the first warden command after a ≥ 20 min gap (`config.defaults.ts:6`, `DEFAULT_IDLE_MS`) always spawns gc, and the device that is idle is exactly the warm one this run wants.
  - In the gc child (`apps/cli/src/commands/gc.ts`):
    - It reads the `leased` set once (`:129-133`), shortly after process start (bun start ~50 ms for `gc`, `wdn-perf.md` Follow-ups "gc done: 69 → 50 ms", plus the git owner lookup).
    - Then `gcPlatform` runs `provider.inventory()` (`:48`, one `simctl list` / `adb devices`), filters `idle` against that stale snapshot (`:62-64`) and calls `provider.shutdown` (`:65-69`).
    - It never re-checks a lease inside a transaction, and holds no lease of its own during the shutdown.
    - It then stops the device's helper (`:67`).
  - The claim inserts its lease only after its own inventory spawn (`packages/core/src/claim.ts:251-254@dfcc68b` then `reserve` `:126-134`). On the e2e path that comes after port leasing, the Metro spawn and the fingerprint start (`lease-session.ts` `claimAll`, owned by 12). So gc's `leased` snapshot (~60–120 ms after spawn, estimated) almost always predates the claim's lease (≥ 200–400 ms, estimated: one `simctl list` of 150–300 ms plus setup).
  - What the claim then sees depends on when the shutdown lands:
    - (a) `Booted`: reserved as `reuse`, `verifyWarm` (`claim.ts:152-155`, one `launchctl list`) may still pass, and the run is handed a device that is shutting down. Install, helper start or the first launch then fails.
    - (b) `Shutting Down`: `parseSimctlDevices` maps it to `booting` (`providers/ios.ts:94`). `allocate` ranks it **above** shut-down devices (`allocate.ts:58,80-82`) and makes it a `reuse` step (`:86`), so `realise` issues no `boot` (`claim.ts:186`) and goes straight to `bootstatus -b` on a device that is going down.
    - (c) `Shutdown`: a cold `boot`.
  - Android: gc runs `adb emu kill` and forgets the device (`providers/android.ts:296-314`). A claim that reserved `reuse` first then blocks in `adb wait-for-device` for the full `readyMs` of 300 s (`android.ts:284`), because the emulator is gone.
- **Impact**: estimated.
  - Every first run after a ≥ 20 min gap loses its warm device. That costs one cold boot: iOS 6.5 s (README.md:133, "second boot") to 11.9 s (first boot of a clone, `golden.ts:4-5`) plus a cold helper (708 vs 182 ms, K11). Android costs a whole new emulator (16-3) and, in case (a), a 300 s hang.
  - In case (a) the run fails outright, which makes this P0.
  - The timing is close enough that all three outcomes are plausible. Which one dominates needs a device.
- **Proposed fix** (additive, several layers):
  1. Call `maybeAutoGc` **after** the claim has landed: `claim.ts` after `:81`, `batch.ts` after `claimAll`, likewise in `run`/`dev`. The run's own leases then protect its devices.
  2. In `gcPlatform`, re-check each idle device inside `store.transaction`: no lease and `last_used_at` unchanged. Take a short-lived device lease labelled `gc-shutdown` (UNIQUE `resource_key`) for the length of the shutdown, so a concurrent claim sees the device as held and boots another one or waits.
  3. In `parseSimctlDevices`, map `Shutting Down` to a state that `allocate` ranks last (or treats as `shutdown`, so the claim does a real `boot` after waiting), never `reuse`.
  - Files: `commands/{claim,gc}.ts`, `batch.ts`/`run.ts`/`dev.ts` (12, 18), `providers/ios.ts`, `allocate.ts`.
- **Effort**: M
- **Risk**: low. Moving gc later delays reaping by one claim. The gc lease must be released in a `finally`.
- **How to verify**:
  - Unit test: `gc.test.ts` with an exec whose `simctl list` blocks until a claim in the same store has inserted its lease. Assert gc does not shut that device down.
  - `claim.test.ts`: `Shutting Down` is never a `reuse` step.
  - On device: let a pool sim go idle for 21 min (or `--idle 1m` with `WARDEN_AUTO_GC` forced due), run `warden e2e`, and check `warden-simd`/claim logs for a boot.
- **Confidence**: med. The mechanism and ordering are traced; the outcome mix depends on timing.
- **Verified by**: traced path from `commands/claim.ts:74` → `autogc.ts:65` → `gc.ts:129-141` → `gcPlatform` `:48-69`, and from `claim.ts:251` → `reserve`.

### 16-2 A device that never gets ready is neither quarantined nor retried, and is picked first again next time
- **Category**: robustness
- **Severity**: P1
- **Known?**: new
- **Evidence**:
  - `realise` (`packages/core/src/claim.ts:195-196@dfcc68b`): when `waitReady` fails, it returns `{ ok: ready, leaseId }` with **no `unhealthy`**. Only a failed `probe` (`:197-200`) is quarantined and re-claimed (`complete` `:333-339`, `quarantineUnhealthy` `:299-321`).
  - iOS `waitReady` is `simctl bootstatus -b` with `DEFAULT_READY_TIMEOUT_MS` 300 s (`providers/ios.ts:307-310`, `config.defaults.ts:10`). Android `waitReady` loops on `boot_completed` up to 300 s (`providers/android.ts:282-294`).
  - On failure, `complete` deletes every lease of the round (`claim.ts:336`) and fails the whole claim (`:338`). Devices in the same round that booted fine (and the stuck one) are left booted with no lease; the lease that carried `bootedByOwner` is gone.
  - Next claim: the stuck sim is now `Booted` (or `Booting`), which `allocate` ranks first (`allocate.ts:58,80-82`). `verifyWarm` fails because SpringBoard is not up (`health.ts:79-85`), so it falls back to `bootstatus -b` (`claim.ts:192-196`), another 300 s, and fails again. This repeats on every run until a human intervenes; `warden gc` shuts it down only after 20 min idle.
- **Impact**: estimated.
  - Per affected run: 300 s, then a failed run. A wedged boot (the CoreSimulator hiccup class of K16) costs 5 min per attempt, for as long as nobody notices.
  - Multi-device claims: one stuck device fails all N (no partial retry).
- **Proposed fix**:
  - Treat a `waitReady` timeout like a failed probe: return `unhealthy` with reason `not ready within Ns`, so the device is quarantined (warden-created) or skipped (foreign), shut down, and the claim retried within `MAX_HEALTH_RETRIES`.
  - Optionally cap the first `waitReady` of a **reused** device lower (for example 60 s) before falling back.
  - Files: `claim.ts`; test in `claim.test.ts`.
  - Contract: additive (the claim result shape is unchanged).
- **Effort**: S
- **Risk**: low/med. A slow-but-healthy first boot under heavy load could be quarantined. Keep 300 s for `create`, and use a shorter budget only for a reuse that was already Booted.
- **How to verify**: `claim.test.ts`: a provider whose `waitReady` fails once. Expect quarantine plus a second device, and that the stuck one is not offered again.
- **Confidence**: high
- **Verified by**: read `claim.ts` `realise`/`complete`/`noteUnhealthy`; ran `bun test packages/core/src/claim.test.ts` (green, no test covers this).

### 16-3 Android: no warden-owned quick-boot snapshot; boot time and start state depend on the user's AVD
- **Category**: cold-boot
- **Severity**: P1
- **Known?**: new
- **Evidence**:
  - The launch argv (`packages/core/src/providers/android.ts:220-230@dfcc68b`) is `-avd <avd> -port <p> -no-window -read-only -no-snapshot-save -no-boot-anim`. Nothing in the repo passes `-snapshot`, `-snapshot-load`, `-no-snapshot-load`, `-no-audio`, `-gpu`, `-cores`, `-memory`, `-no-metrics` or `-wipe-data`; `rg` over the repo finds only `-no-snapshot-save` (`android.ts:228`, `android.test.ts:212`).
  - `-no-snapshot-save` only stops the emulator *writing* on exit. Whether a boot is a quick-boot load or a full cold boot depends on whether the AVD already holds a `default_boot` snapshot. That snapshot is written by whoever last ran the AVD writable (Android Studio), and holds that person's state: apps, logged-in accounts, the app under test at some old version, the screen they left.
  - Android never boots in place: inventory lists only running emulators (`android.ts:237-243`). gc kills idle ones and forgets them (`commands/gc.ts:54-61`). So every Android cold start is this launch.
  - The bench idiomatic run created a fresh `warden-pixel-10-1`: cold rep 1 was 34.58 s vs 27.10 s on a reused emulator (`docs/bench/android-2026-10-16-perf.md:121`). That is the first rep after the claim, not the boot itself; the boot is not traced anywhere.
- **Impact**: estimated, no boot time is recorded in the repo.
  - A cold boot of an API 37 arm64 image is ~20–45 s; a quick-boot snapshot load is ~3–8 s. The saving is about 15–40 s per new emulator: on every Android run after gc, and on every run under CI `always`.
  - Isolation today is uncontrolled (user state leaks into runs), and the boot time varies with it.
- **Proposed fix** (an "Android golden", mirroring `golden/ios-golden.ts`; contract additive, but a new default, so policy):
  - Under a `golden:android:<avd>` build lock, launch the AVD **writable**, only when no instance of it runs: `-no-window -no-boot-anim -no-audio -port P`. Wait for `boot_completed` plus a settle, apply warden's baseline (animation scales 0 if the driver would set them anyway), then `adb emu avd snapshot save warden-<key>`, then `adb emu kill`.
  - Launch claims with `-read-only -snapshot warden-<key> -no-snapshot-save`. If the snapshot fails to load, fall back to today's argv.
  - Key = sha256 of: system-image `source.properties` `Pkg.Revision` + `ro.build.fingerprint` + `emulator -version` + the `hw.*` lines of the AVD `config.ini` + recipe number. A key change marks the snapshot stale, and `warden golden prune` deletes it (`adb emu avd snapshot delete` or the `snapshots/<name>` dir).
  - Trade-offs:
    - (1) Disk: a snapshot is roughly guest RAM (2–4 GB, compressed less) per AVD.
    - (2) A writable build cannot run while read-only instances of that AVD are up, so it must wait for or skip a busy AVD.
    - (3) Snapshots are tied to the emulator binary and GPU mode: an emulator update invalidates them (covered by the key).
    - (4) `sdk_gphone16k_arm64` (the bench image, `android-…perf.md:6`) is a 16 KB-page image, and snapshot support on 16 KB images must be verified on device before this becomes the default.
    - (5) Isolation gets better: every run starts from the same warden state instead of the user's.
    - (6) The guest clock jumps after a load. Harmless, but adb reconnects in ~1–2 s.
  - Other flags, each separable:
    - `-no-audio`: less host CPU, no CoreAudio init. Low risk.
    - `-no-metrics`: no usage-stats prompt or network.
    - `-gpu`: leave `auto` unless measured. `swiftshader_indirect` costs host CPU; `host` can fail headless.
    - `-cores`/`-memory`: overrides of the AVD's `hw.cpu.ncore`/`hw.ramSize`. Trades boot speed for host contention at N emulators (16-16).
- **Effort**: L
- **Risk**: med-high (snapshot load failures, 16 KB images, disk). Needs a device.
- **How to verify**: on device, over 5 runs each, time `emulator -avd X -read-only -no-snapshot-save -no-window` vs the same with `-snapshot warden-<key>` from spawn to `boot_completed=1`. Also run the bench idiomatic suite on both to check the state is equivalent.
- **Confidence**: med (mechanism high; the saving is an estimate).
- **Verified by**: read `android.ts`; ran `rg -- '-no-snapshot|-snapshot|-no-audio|-gpu'` over the repo.

### 16-4 Android `boot` right after launch is a one-shot `adb devices` check that races adb registration
- **Category**: flake-risk
- **Severity**: P1
- **Known?**: new
- **Evidence**:
  - For `action: "create"`, `realise` always calls `provider.boot` (`claim.ts:186-188@dfcc68b`).
  - Android `boot` (`providers/android.ts:275-280@dfcc68b`) runs one `adb devices -l` and returns `err("… is not running — android devices are created, not booted")` if the serial is not listed yet.
  - `create` returns as soon as `createSpawnDetached` has waited `earlyExitMs` 1.5 s (`:109-135`, race `:121`). The emulator registers with the adb server only once qemu is up, which on a cold host cache or under load can take longer than 1.5 s.
  - On that error, `complete` deletes the device lease (`claim.ts:336`) and fails the claim. The emulator keeps running, recorded in the store (`android.ts:262`) with its console-port lease (30 min TTL, `:195`) and no device lease.
  - `android.test.ts:283-303` pins the behaviour ("ok when already running, err otherwise").
- **Impact**: estimated. When it hits, the run fails. The leftover emulator is reused by the next claim, so it self-heals at the cost of a failed run. The bench's one fresh-emulator run passed (`android-…perf.md:116`), so it is not systematic.
- **Proposed fix**: the Android `create` has already launched the device, so make `boot` for a warden-created, just-launched serial poll `adb devices -l` (250 ms, ≤ 15 s) before failing. Or skip `boot` for Android creates entirely: `waitReady`'s `wait-for-device` already waits for registration. Files: `android.ts` and its test. Additive.
- **Effort**: S
- **Risk**: low
- **How to verify**: a unit test where `adb devices -l` lists the serial only on the 3rd call (claim succeeds). On device: claim 10 fresh emulators on a loaded host.
- **Confidence**: med (the window is real; its frequency is unmeasured).
- **Verified by**: traced `claim.ts:162-191` → `android.ts:245-280`.

### 16-5 Android readiness wait: 2 s poll, an untimed shell per read, and a dead emulator waited out for 300 s
- **Category**: cold-boot
- **Severity**: P2
- **Known?**: new
- **Evidence**:
  - `waitReady` (`providers/android.ts:282-294@dfcc68b`):
    - `adb -s S wait-for-device` with `timeoutMs` (`:284`).
    - Then `while (true)` runs `adb -s S shell getprop sys.boot_completed` with **no timeout** (`:287`).
    - The deadline is checked only after a read returns non-1 (`:289`), and `sleep(pollIntervalMs)` is 2 s (`:154`, `:292`).
  - `createSpawnDetached` notices an exit only in the first 1.5 s (`:121`). An emulator that dies later (HVF/AVD lock errors often print 2–5 s in) leaves `wait-for-device` waiting the full 300 s, and no `pid` is kept to check.
  - A hung `adb shell` (adbd restarting during boot) blocks the loop forever: no read returns, so the deadline is never reached.
- **Impact**: estimated.
  - The 2 s poll wastes 1 s on average (uniform 0–2 s) per cold emulator, plus one `adb shell` spawn (~20–50 ms) per 2 s.
  - Failure detection for a dead emulator: 300 s instead of ~1 s.
  - The untimed read means an unbounded hang (rare).
- **Proposed fix**:
  - One spawn with a timeout: `adb -s S wait-for-device shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 0.2; done'` and `timeoutMs` = the remaining budget. If the shell exits non-zero (adbd restart), fall back to the existing loop with a 250 ms poll and `timeoutMs: 5000` per read.
  - Keep the launched pid (return it from `create`, or record it) and race `waitReady` against `processAlive(pid)` every 500 ms, failing with `logTail` at once.
  - Files: `android.ts`, its test. Additive.
- **Effort**: S
- **Risk**: low. The shell loop must stay POSIX `sh` (toybox `[`).
- **How to verify**: unit tests for a hung `getprop` (exec never resolves) ending at the deadline, and for a dead pid failing in < 1 s. On device: time from spawn to `boot_completed` with both versions.
- **Confidence**: high
- **Verified by**: read `android.ts:109-135,282-294`.

### 16-6 Golden clones are serialised behind a 2 s-poll lock, with 3 serial pre-lock spawns and a full `simctl list` per device
- **Category**: cold-boot
- **Severity**: P2
- **Known?**: new
- **Evidence**:
  - `claim.ts:332` runs each `create` in parallel. Each calls `cloneFromGolden` (`golden/ios-golden.ts:265-282@dfcc68b`), which repeats `readGoldenTarget` (`:87-101`) **per device, before the lock**: `simctl list devicetypes -j`, `simctl list runtimes -j` (`providers/ios.ts:247-261`), then `xcodebuild -version`. That is 3 serial spawns, and their result is identical for every device of a claim.
  - Then `withBuildLock("golden:ios")` (`builds/lock.ts:60-83`). `lockDeps` (`ios-golden.ts:253-255`) sets no `pollMs`, so waiters sleep `BUILD_LOCK_POLL_MS` 2 s (`builds/builds.defaults.ts:43`) between attempts.
  - Under the lock, per device:
    - `ensureLocked` (`:236-251`) runs `simctl list devices -j` (all sims, including unavailable) and the `plutil` migration read (`:108-117`).
    - Then `simctl clone` (`:276`, no timeout). 3.7 s measured (`golden.ts:4-5`).
  - Measured context: 1 clone + boot is 3.7 + 11.9 s; 3 clones booted in parallel take ~20 s (README.md:125).
- **Impact**: estimated, for a claim of 3 new devices (the default `max` on the 14-core bench host, 16-16).
  - Pre-lock: 0.4–1.4 s (`xcodebuild -version` is the slow one).
  - Clone section: 3 × (0.2–0.4 + 3.7) ≈ 12 s serial.
  - Lock hand-offs: 2 × ~1 s average poll slack.
  - So the last device starts booting about 14 s after the first. With batched or concurrent clones and a 200 ms poll, the critical path shrinks by about 6–10 s.
  - This is only paid on pool growth (the first day, a new runtime, after a quarantine), but **on every CI run** on a clean runner.
- **Proposed fix**, cheapest first:
  - (a) `pollMs: 200` in `lockDeps`.
  - (b) Memoise `readGoldenTarget` per process (keyed by profile and runtime) and run its spawns with `Promise.all`. Read the Xcode build from `$(xcode-select -p)/../version.plist` `ProductBuildVersion` with `plutil` (~10 ms) instead of `xcodebuild -version`.
  - (c) Clone the whole batch under one lock acquisition, or make clones take a *shared* golden lease (build and prune stay exclusive). Concurrent `simctl clone` of one shut-down source must be verified on device first.
  - Files: `ios-golden.ts`, `builds/lock.ts` (17, for shared mode). Additive.
- **Effort**: S for (a)+(b); M for (c).
- **Risk**: low for (a)+(b). For (c), medium: CoreSimulator's behaviour under concurrent clones is unknown.
- **How to verify**: `ios-golden.test.ts`: two concurrent `cloneFromGolden` calls give one `readGoldenTarget` spawn set, and the waiter retries in ≤ 200 ms. On device: `warden claim ios --count 3` on an empty pool, timed.
- **Confidence**: med
- **Verified by**: traced `claim.ts:332` → `providers.ts:31-36` → `ios-golden.ts:265-282` → `builds/lock.ts:60-83`.

### 16-7 `AutomationEnabled` is not baked into the golden, so every fresh clone pays the in-sim `defaults write`
- **Category**: cold-boot
- **Severity**: P3
- **Known?**: new
- **Evidence**:
  - The golden build (`golden/ios-golden.ts:175-192@dfcc68b`: boot → bootstatus → migration → settle → shutdown) writes no preferences. `GOLDEN_RECIPE` is 1 (`golden.ts:13`).
  - The driver checks `<device>/data/Library/Preferences/com.apple.Accessibility.plist` (`packages/e2e/src/driver/ios/simctl.ts:92-93`). A fresh clone lacks the key, so open runs `simctl spawn … defaults write com.apple.Accessibility AutomationEnabled -bool true` (`simctl.ts:306-312@dfcc68b`), measured at 300–500 ms (`packages/e2e/AGENTS.md:78`).
  - In `openIosDriver` that write runs in parallel with the connect (`ios-driver.ts:536`). On the `ui` and warm paths the helper has already started, so it runs serially after it (`apps/cli/src/agent-ui/helper.ts:523-527@dfcc68b`, owned by 14).
  - The plist lives under `data/`, which `simctl clone` copies, so a golden that holds it hands it to every clone.
- **Impact**: measured per-call cost: 300–500 ms once per fresh device (first open), on the critical path of the first test or the first `warden ui` call. Per 8-test rep: ≤ 0.5 s, only on a new device.
- **Proposed fix**, two options:
  - (a) In `buildSteps`, after `waitMigrated`, run `simctl spawn <udid> defaults write com.apple.Accessibility AutomationEnabled -bool true` and bump `GOLDEN_RECIPE` to 2. Trade-off: every machine rebuilds its golden once (~2–5 min, `ios-golden.ts:201`) on the next claim; `warden golden ensure` can prewarm it.
  - (b) No rebuild: after `simctl clone`, while the clone is still shut down, write the key host-side with `plutil -replace AutomationEnabled -bool true <clone plist>` (create the file if missing). ~10 ms, but it bypasses cfprefsd's format. Safe only on a shut-down device, and needs a device check that the AX bridge honours it.
  - Contract: additive.
- **Effort**: S
- **Risk**: low for (a). Medium for (b), which needs a device.
- **How to verify**: on device: clone, boot, `plutil -extract AutomationEnabled raw` prints `true`, and the first `warden ui snapshot` shows no `defaults write` in `WARDEN_DEBUG` exec timings.
- **Confidence**: high for the mechanism; med that the key survives `simctl clone` (very likely: it is under `data/`).
- **Verified by**: read `ios-golden.ts`, `simctl.ts:92-93,306-312`, `ios-driver.ts:536`, `helper.ts:523-527`.

### 16-8 Headless hide: concurrent hides race on the global `DetachOnWindowClose`, and shut-down sims reboot one after another, unprobed
- **Category**: flake-risk
- **Severity**: P2
- **Known?**: new
- **Evidence**:
  - The hide runs inside `claimWithFlags` and is awaited before `onLeased`, so before the early warm and the install (`apps/cli/src/claim-flags.ts:186-194@dfcc68b`, `lease-session.ts:341,346`).
  - `runLegs` runs each leg's `claimWithFlags` concurrently (`lease-session.ts:371`, owned by 12). Separate agents run concurrent warden processes too.
  - `hideSimWindows` (`apps/cli/src/sim-windows.ts:266-291@dfcc68b`) reads the **machine-global** `com.apple.iphonesimulator DetachOnWindowClose` (`:214,218-224`), writes `true` when it was not on (`:272`), closes the windows, and in `finally` restores the old value (`:288-290`, `:226-232`).
  - With two concurrent hides: A reads `unset` and writes `true`. B reads `on`, so it will not restore. A finishes and deletes the key while B's close is still running. B's window close then **shuts the sim down** (the default behaviour), and B's `rebootShutDown` boots it again.
  - The reboot loop is a sequential `for` (`:315-322`): `simctl boot` plus `bootstatus -b` with a 180 s timeout per sim. A rebooted sim gets no health probe (the claim's probe ran before the hide). The `simctl boot` exit code is ignored (`:318`).
  - Cost even without a reboot, when Simulator.app is open with warden windows: `pgrep` (~10 ms, `:125`), JXA read, `defaults read`, `defaults write`, JXA close, a fixed 500 ms sleep (`:203,305`), `simctl list`, `defaults delete`. All of it is on the critical path.
- **Impact**: estimated.
  - With Simulator.app open, the hide costs ~1.0–1.5 s per claim (JXA ~100–300 ms each × 2, plus 500 ms, plus `simctl list` 150–300 ms).
  - Each spurious reboot costs 6.5 s (README.md:133); serial across N sims, that is N × 6.5–11.9 s.
  - With Simulator.app not running the hide is ~10 ms. That is the usual headless case.
- **Proposed fix**:
  - Serialise the pref dance across processes: a `store.transaction`-arbitrated meta row or a lease `headless:detach-pref` held for the whole read-write-close-restore, with a reference count so the last holder restores.
  - Run the reboots with `Promise.all`, check the `simctl boot` exit, and run `probeIosWarm` after.
  - Start the install in parallel with the hide when no reboot is needed: hide first reads the windows, and only a close that ends in a shutdown has to block the install.
  - Files: `sim-windows.ts`, `claim-flags.ts`. Additive.
- **Effort**: M
- **Risk**: medium. Window handling needs a mac with Simulator.app to verify.
- **How to verify**: `sim-windows.test.ts`: two concurrent `hideSimWindows` against a fake `defaults` store. Assert the pref is `on` throughout both closes and restored once at the end, and that the reboots start together.
- **Confidence**: med
- **Verified by**: read `sim-windows.ts`; traced `claim-flags.ts:188` ← `lease-session.ts:341` ← `runLegs`.

### 16-9 SessionEnd `--shutdown` shuts down every warden device the session held, not "what the session booted"
- **Category**: cold-boot
- **Severity**: P2
- **Known?**: new
- **Evidence**:
  - `shouldShutdown` (`packages/core/src/shutdown-policy.ts:8-11@dfcc68b`) is `bootedByOwner || wardenDevices.has(platform:id)`. Any warden-created device qualifies, even when the lease owner only reused it warm.
  - `shutdownReleasedDevices` applies it (`apps/cli/src/device-shutdown.ts:45,51,54@dfcc68b`) and stops the helper.
  - The SessionEnd hook spawns `warden release --session S --shutdown` (`apps/cli/src/commands/hook.ts:14-20`, owned by 15).
  - The user-facing fact says otherwise: `skills/warden/SKILL.md:58` ("The SessionEnd hook releases and shuts down what the session booted").
- **Impact**: estimated.
  - An agent session that claimed a warm pool sim (`warden ui --claim`, `warden claim`) shuts it down at session end, and the next session cold-boots: iOS 6.5–11.9 s plus a cold helper (708 ms, K11); Android a whole new emulator.
  - e2e leases are released at the end of the run, so `warden e2e` alone is not affected.
- **Proposed fix**, a policy choice for the user:
  - (a) Make the code match the doc: on SessionEnd, shut down only `bootedByOwner` leases. A warm device someone else booted stays up for gc's idle pass. Cost: up to 20 min of an idle booted sim's RAM (16-13).
  - (b) Keep the code and fix the SKILL fact.
  - Files: `shutdown-policy.ts` (or a `bootedOnly` option on `shutdownReleasedDevices`), `SKILL.md`.
  - Contract: cli (behaviour of `release --shutdown`). Policy change.
- **Effort**: S
- **Risk**: low (more sims stay up a bit longer).
- **How to verify**: `device-shutdown.test.ts`: a warden device whose lease has `bootedByOwner` unset survives `release --session --shutdown` under (a).
- **Confidence**: high
- **Verified by**: read `shutdown-policy.ts`, `device-shutdown.ts`, `hook.ts:14-20`, `SKILL.md:50-60`.

### 16-10 Probe time-outs under host load quarantine healthy sims for good, and a bad claim can run 3 cold boots (~100 s)
- **Category**: robustness
- **Severity**: P2
- **Known?**: known-extended K9 (heavy host load is the known regime for typing garble; the same load starves the probe)
- **Evidence**:
  - The probe (`providers/health.ts:60-71@dfcc68b`) sends two `simctl spawn` calls, each 5 s, retried once at 15 s (`:4-6,41-44`). The worst case per probe is 20 s.
  - A failure quarantines the device permanently (`claim.ts:299-321`), shuts it down sequentially (`:300,319`) and re-claims, up to `MAX_HEALTH_RETRIES` 2 (`:52,211-218`). Each retry is a new clone and boot (quarantined devices free their pool slot, `allocate.ts:92-93`).
  - Quarantine is cleared only by `warden sim unquarantine` (`commands/sim.ts:74-80`). Nothing expires it or re-probes it.
  - Under K9-level load (load average 14–41, `wdn-perf.md:685`), a `simctl spawn` taking more than 5 s and then more than 15 s is plausible, so healthy sims get quarantined and their clones pile up on disk (~30 MB each, `golden.ts:5`).
- **Impact**: estimated.
  - Worst-case claim: 3 × (clone 3.7 + boot 11.9 + probe 20 + shutdown ~2 s) ≈ 113 s before a clear error.
  - Each false quarantine costs one extra clone and boot (~15.6 s) at the moment it happens, plus the slot.
- **Proposed fix**:
  - Before quarantining on a **timeout** (not on "SpringBoard not running"), check the 1-min load average against `cores`. If the host is overloaded, re-probe once after 5 s and treat a second timeout as "skip this round" without quarantining.
  - Expire quarantines after a TTL (for example 24 h), or let `gc` re-probe booted quarantined devices.
  - Files: `health.ts`, `claim.ts`, `store` (18, quarantine TTL). Additive.
- **Effort**: M
- **Risk**: low/med. A truly hung sim gets one extra probe.
- **How to verify**: `claim.test.ts`: a probe timeout with an injected high load average gives no quarantine and one re-probe.
- **Confidence**: med
- **Verified by**: read `health.ts`, `claim.ts:208-321`, `allocate.ts:88-101`.

### 16-11 No timeout on `simctl boot`/`clone`/`create`/`list`, nor on `adb emu …`: a wedge hangs the claim, and while it holds the golden lock it blocks everyone's clones for up to 40 min
- **Category**: robustness
- **Severity**: P2
- **Known?**: known-extended K16 (a `simctl launch` once took > 30 s; the same CoreSimulator stalls hit these untimed calls)
- **Evidence**:
  - iOS: `simctl()` passes no timeout unless given (`providers/ios.ts:218-222@dfcc68b`), and `idempotent()` never passes one (`:225-231`). With no timeout: `inventory` (`:286`), `create` (`:298`), `boot` (`:305`), `shutdown` (`:312`), plus `lookupCreateTarget` (`:252,256`).
  - Golden: `clone` (`golden/ios-golden.ts:276`), `create`/`boot`/`shutdown`/`rename`/`delete` (`:208,178,182,216,170-173`) and `xcodebuild -version` (`:90`). Clone and ensure run **inside** `withBuildLock` with the claimer's pid (`builds/lock.ts:43-44`), so a hung clone keeps the golden lock alive, and other claimers wait up to `lockWaitMs` 40 min (`ios-golden.ts:49`).
  - Android: `adb -s S emu avd name` in every inventory (`providers/android.ts:162`), `adb emu kill` (`:300`) and `emulator -list-avds` (`:73`) are untimed. `bunExec` applies a timeout only when `timeoutMs` is set (`exec.ts:25`). A wedged emulator console stalls `adb emu`, so every Android claim and every gc stalls with it.
- **Impact**: estimated. Rare, but unbounded: a hung claim, plus up to 40 min of blocked clones for other agents.
- **Proposed fix**:
  - Default timeouts: list 30 s, boot 120 s, clone 120 s, create 120 s, shutdown 60 s, `xcodebuild -version` 30 s; `adb emu *` 10 s, `-list-avds` 15 s.
  - In inventory, a timed-out `emu avd name` should mark that emulator `booting` without a profile instead of failing.
  - Files: `ios.ts`, `ios-golden.ts`, `android.ts`. Additive.
- **Effort**: S
- **Risk**: low (timeouts sit well above normal times).
- **How to verify**: unit tests with an exec that never resolves (assert `timeoutMs` is passed); `ios-golden.test.ts` asserts the clone call carries one.
- **Confidence**: high
- **Verified by**: read `exec.ts:17-36`, `ios.ts`, `ios-golden.ts`, `android.ts`.

### 16-12 `slim` costs ~1.6–2.7 s per fresh sim on the critical path, the benefit is unmeasured, and a plain `claim` re-arms the full cost
- **Category**: cold-boot
- **Severity**: P2
- **Known?**: new
- **Evidence**:
  - `slimSimulator` (`packages/core/src/sims/slim.ts:178-209@dfcc68b`):
    - 1 `print-disabled` plus 1 `list` (serial).
    - Then, for each of the 36 `SLIM_DENYLIST` labels (`:14-56`), `disable` then `bootout` (`:201-207`), through `eachBounded` 8-wide (`:138,144-160`). That is 74 `simctl spawn` calls.
  - An already-slimmed sim costs 2 (`planSlim` `:112-115`, since the disabled state persists across reboots).
  - Per its comment, the disabled state is **not** cloned (`:172-173`), so every clone pays the full 74.
  - It runs in batch setup per device before jobs (`apps/cli/src/commands/batch.ts:884-888`, `batch/setup.ts:56-63`, owned by 12), for suites with `slim: true` (`apps/example/warden.config.ts:100,109`). The bench suite does not slim.
  - A plain `warden claim` of a slimmed device runs `restoreSlimmed` (`apps/cli/src/commands/claim.ts:31-51,97`): `print-disabled` plus up to 38 `enable`s, one device after another. The next e2e then slims from scratch.
  - The claimed benefit (`slim.ts:8-10`: 200–250 processes, 10–20 GB RSS as a per-process sum) has no before/after number anywhere in the repo.
- **Impact**: estimated.
  - 36 labels / 8 workers ≈ 4.5 labels × 2 spawns ≈ 9 serial `simctl spawn` calls per worker, × 150–250 ms ≈ 1.35–2.25 s, plus 2 × 150–250 ms. Total ≈ 1.6–2.7 s per fresh or restored sim, before the first test.
  - Per 8-test rep, ~0.2–0.35 s per test, and only on a fresh device.
- **Proposed fix**:
  - Measure first: physical footprint and CPU of a booted sim with and without slim (Gaps).
  - Then pick:
    - (a) Keep as is.
    - (b) Run slim concurrently with the install and the early warm instead of in setup (12): slim touches only daemons the app does not use.
    - (c) Drop `bootout` for labels that are not running (`planSlim` already knows the running set), so a fresh boot costs 36 + 2 spawns instead of 74.
    - (d) In `restoreSlimmed`, skip the restore when the next owner is also a slim suite.
  - Files: `slim.ts`, `commands/claim.ts`. Additive.
- **Effort**: S for (c); M for (b).
- **Risk**: low for (c).
- **How to verify**: `slim.test.ts`: a fresh sim with 10 of 36 labels running gives 2 + 36 + 10 spawns.
- **Confidence**: med (spawn cost estimated; label count and concurrency read).
- **Verified by**: read `slim.ts`, `commands/claim.ts`; ran `bun test packages/core/src/sims/slim.test.ts`.

### 16-13 What keeps the second run of the day from starting warm: gc idle, helper idle, SessionEnd, and no pre-boot
- **Category**: cold-boot
- **Severity**: P2
- **Known?**: known-extended K11 (cold helper 708 ms vs warm 182 ms is exactly the cost of losing residency)
- **Evidence**:
  - The local `warden e2e` default keeps sims booted after a pass (`apps/cli/src/commands/e2e.ts:229-233@dfcc68b`). PERF-4.8 landed, as claimed (`wdn-perf.md:370`).
  - What still ends warmth:
    - gc idle `DEFAULT_IDLE_MS` 20 min (`config.defaults.ts:6`) shuts the sim down and stops the helper (`commands/gc.ts:62-69`).
    - The helper exits on its own after 10 min idle (`packages/e2e/AGENTS.md:63`, `$WARDEN_SIMD_IDLE_TIMEOUT`).
    - SessionEnd shutdown (16-9).
    - The racing auto-gc (16-1).
    - Android emulators are killed and forgotten (`gc.ts:54-61`) and cannot be rebooted in place.
  - No command pre-boots the pool. `warden golden ensure` only builds the image (`commands/golden.ts:13-32`).
  - A cold start costs:
    - Boot: 6.5 s (README.md:133) or 11.9 s (first boot of a clone).
    - Helper: 544–726 ms vs 182–185 ms warm (`docs/bench/ios-2026-10-16-perf.md:26`).
    - First app launch after a boot, dominated by app boot: 4.5–6.4 s (K18, `wdn-e2e.md:392-396`, owned elsewhere).
- **Impact**: measured parts: about 7–13 s per iOS device on the first run after a gap. Android: a whole emulator cold boot (16-3).
- **Proposed fix**: options for the user, each with its RAM cost.
  - RAM per booted sim: physical footprint unmeasured. The bench shows an 11.7 GB per-process RSS sum for one sim (`ios-…perf.md:95`), which overcounts shared pages. A plausible physical footprint is 1.5–3 GB per sim (estimate). An Android emulator is `hw.ramSize` (2–4 GB) plus ~0.5–1 GB of qemu.
  - (a) `e2e.<suite>.keepBooted: "<duration>"` or a per-profile gc idle (for example 2 h on a 48 GB dev machine). RAM: N × footprint for that long.
  - (b) `warden warm ios|android [--count N]`: claim, boot, start the helper, release without shutdown. A user or a login hook runs it before work; on Android it combines with 16-3.
  - (c) Helper idle timeout equal to the gc idle (20 min) so the two expire together. ~20–40 MB per helper (unmeasured; K2).
  - (d) Keep today's defaults and fix 16-1 and 16-9 only. That gives warm reuse within 20 min, cold after.
  - Contract: config/cli additive. Policy change for (a) and (c).
- **Effort**: M
- **Risk**: low (RAM).
- **How to verify**: on device: two `warden e2e` runs 30 min apart, with and without (a), timing claim through first test (`trace.jsonl` claim spans).
- **Confidence**: med
- **Verified by**: read `e2e.ts:221-233`, `gc.ts`, `config.defaults.ts`, `commands/golden.ts`.

### 16-14 Android claim spawns: `emulator -list-avds` twice per auto-profile create, and an untimed console call per running emulator per round
- **Category**: perf-latency
- **Severity**: P3
- **Known?**: new
- **Evidence**:
  - `claimWithFlags` resolves `auto` with `listAvds` (`apps/cli/src/claim-flags.ts:167-171@dfcc68b`). `create` calls `resolveAvd` → `listAvds` again (`providers/android.ts:203-210,246`), plus a second `adb devices -l` (`:248`) after the inventory's own (`:238`).
  - `describeEmulator` runs `adb emu avd name` plus `getprop` for **every** running emulator in every claim round (`:159-177`), including foreign ones and ones leased to others.
- **Impact**: estimated. `emulator -list-avds` starts the emulator binary: ~100–300 ms, once per create. The second `adb devices` is ~20–50 ms. The per-emulator calls run in parallel: ~30–80 ms per round. About 0.15–0.4 s per cold Android claim.
- **Proposed fix**: pass the resolved AVD name from `claim-flags` into the request, or memoise `listAvds` per process. Reuse the inventory's `adb devices` output in `create`. Files: `claim-flags.ts`, `android.ts`. Additive.
- **Effort**: S
- **Risk**: low
- **How to verify**: a spawn-count test like `claim.test.ts:415-466` for Android.
- **Confidence**: high
- **Verified by**: read.

### 16-15 iOS boot path: `simctl boot` before `bootstatus -b` is a redundant spawn; the full probe right after `bootstatus` is ~2 more
- **Category**: perf-latency
- **Severity**: P3
- **Known?**: known-confirmed (PERF-4.4's "skip bootstatus + print system on a reused Booted device" landed: `claim.ts:152-155,192-194`, `claim.test.ts:437-442`)
- **Evidence**:
  - A booted-by-claim sim costs `simctl boot` (`providers/ios.ts:305`) plus `bootstatus -b` (`:308`) plus the two parallel probe spawns (`health.ts:60-71`), as pinned by `claim.test.ts:444-455`.
  - `bootstatus -b` itself boots a shut-down device, so `boot` adds one CoreSimulator round trip.
- **Impact**: estimated. ~100–200 ms per cold boot (spawn plus XPC), plus ~150–300 ms of probe after a `bootstatus` that already waited for services. Under 0.5 s per cold device.
- **Proposed fix**:
  - Call `bootstatus -b` alone. Keep `boot` only as a fallback when `bootstatus` reports "Unable to boot" for a state reason.
  - After a successful `bootstatus`, run `probeIosWarm` (1 spawn) instead of the full probe. That gives up the `launchctl print system` hang check on that path.
  - Additive.
- **Effort**: S
- **Risk**: low/med (bootstatus behaviour across Xcode versions; needs a device).
- **How to verify**: device timing of 10 boots each way. Update `claim.test.ts:444-455`.
- **Confidence**: med
- **Verified by**: read; ran `bun test packages/core/src/claim.test.ts`.

### 16-16 `defaultMax = floor(cores/4) ≤ 4` is CPU-only: 3 on the 14-core bench host, and blind to RAM
- **Category**: dx
- **Severity**: P3
- **Known?**: known-confirmed K9 (load is what breaks typing; the cap guards it)
- **Evidence**:
  - `allocate.ts:29-31@dfcc68b` gives `floor(14/4)` = **3** on the bench's M4 Pro with 14 cores and 48 GB (`docs/bench/ios-2026-10-16-perf.md:3`), not 4.
  - `claim-flags.ts:93`: `--count` above max raises max to count.
  - Per-device load from the bench (one device): sim CPU average 85 % of a core, peak 247 % (`ios-…perf.md:95`); warden host 12.1 % average (`:94`); Android device-side 49.6 % (`android-…perf.md:25`).
  - Parallel boot contention: 3 clones boot in ~20 s vs 15.6 s for one (README.md:125, golden.ts:4-5), about 1.3× slower.
  - There is no multi-device bench, so the contention at N = 3–4 during tests is unmeasured.
- **Impact**: estimated.
  - CPU: N × ~1 core average, N × ~2.5–3 cores at peak. On 14 cores the peaks saturate around N ≈ 5, so the cap of 3–4 holds peak load near 8–12 cores. That is the regime where K9 garbling was seen (load average > cores).
  - RAM is not considered. On an 8-core / 16 GB laptop, max = 2 sims at an unmeasured 1.5–3 GB each (estimate) plus Xcode could swap.
- **Proposed fix**: `defaultMax(cores, memBytes) = clamp(1, 4, min(floor(cores/4), floor((mem − 8 GB)/perDeviceGB)))`, with `perDeviceGB` measured (Gaps). Keep the cap at 4 until a multi-device bench shows typing stays lossless at more. Policy change.
- **Effort**: S
- **Risk**: low
- **How to verify**: a multi-device bench (`warden e2e example --count 3/4`) watching K9 fill garbles and settle `via:"snapshot"` rates.
- **Confidence**: med
- **Verified by**: read `allocate.ts`, `claim-flags.ts`, bench docs.

### 16-17 Android launch argv omits cheap headless flags (`-no-audio`, `-no-metrics`), and AVD `hw.*` defaults go unchecked
- **Category**: perf-cpu
- **Severity**: P3
- **Known?**: new
- **Evidence**:
  - The argv at `providers/android.ts:220-230@dfcc68b` (see 16-3). The audio backend starts in every headless emulator, and nothing reads the AVD `config.ini` `hw.cpu.ncore`/`hw.ramSize`.
  - The bench notes that `-read-only` emulators register no gRPC (`android-…perf.md:111`), which shows the argv also decides tool compatibility.
- **Impact**: estimated. `-no-audio`: a few % of one host core per emulator, plus ~100–300 ms of boot. Unmeasured.
- **Proposed fix**:
  - Add `-no-audio`; on API ≥ 30 the app under test needs no audio for these suites. Opt back in with `WARDEN_EMULATOR_ARGS`.
  - Add `-no-metrics`.
  - Log the AVD's `hw.ramSize`/`hw.cpu.ncore` in `warden doctor`.
  - Additive, but a default change for audio-using tests (policy).
- **Effort**: S
- **Risk**: low (an app whose tests rely on audio focus would differ).
- **How to verify**: on device: host CPU of the emulator process (`ps -o pcpu`) idle for 60 s, with and without `-no-audio`.
- **Confidence**: low (the size of the effect is unmeasured)
- **Verified by**: read.

## Known items

- **K9** (known-confirmed / known-extended): the `cores/4` cap guards the load regime where typing garbles (16-16). The same load starves the health probe into false quarantines (16-10).
- **K11** (known-extended): a cold helper costs 708 ms vs 182 ms warm. Residency is also lost to gc's idle shutdown (`gc.ts:67`), SessionEnd (16-9) and the auto-gc race (16-1). See 16-13 for the options.
- **K16** (known-extended): besides `simctl launch`, warden's `simctl boot/clone/create/list` and `adb emu` calls have no timeout. A clone wedged under the golden lock blocks all clones for up to 40 min (16-11).
- **K18** (known-confirmed, context only): the first app launch after a cold boot (4.5–6.4 s) is part of the cold path cost in 16-13.
- **PERF-4.4** (claimed fixed, verified landed):
  - Warm reuse is 2 spawns (`claim.test.ts:437-442`).
  - `launchctl print system` and `list` run in parallel (`health.ts:62-65`).
  - Restore only when `slimmedAt` is set (`commands/claim.ts:31-51`).
  - Slim runs 8-wide (`slim.ts:138`).
  - `pgrep` guard (`sim-windows.ts:129-132`).
  - The second hide is skipped when nothing booted (`batch.ts:1324`).
- **PERF-4.8** (claimed fixed, verified landed): the local default is `idle`, CI is `always` (`e2e.ts:229-233`).

## Gaps I could not assess here

**Per-step cost map (question 1).** C = on the critical path to the first test. Where a cost is "est", it comes from the spawn-cost assumptions in the row.

| Path | Step | Where | Cost | Basis | C? |
|---|---|---|---|---|---|
| iOS warm reuse | `simctl list devices available -j` + `launchctl list` | `claim.test.ts:437-442` | 2 spawns ≈ 300–500 ms | est | yes |
| iOS shut-down pool device | inventory | `ios.ts:286` | 150–300 ms | est | yes |
| | reserve txn | `claim.ts:90-138` | < 5 ms | est | yes |
| | `simctl boot` + `bootstatus -b` | `ios.ts:305-309` | 6.5 s (second boot) | measured, README.md:133 | yes |
| | probe (2 parallel `simctl spawn`) | `health.ts:60-71` | 150–300 ms; worst case 20 s | est | yes |
| | hide, headless, Simulator.app not running | `sim-windows.ts:129` | ~10 ms | comment `:125` | yes |
| | hide with windows open | `sim-windows.ts:266-291` | 1.0–1.5 s; + 6.5–11.9 s per sim if it shut down, serial | est | yes |
| | arrange (not headless) | `sim-windows.ts:165-185` | JXA read+move; ≤ 6 × 500 ms waiting for windows | est | yes |
| | helper cold start (early warm) | K11 | 544–726 ms (708 bench) | measured | partly (overlaps install) |
| | `AutomationEnabled`, fresh clone only | 16-7 | 300–500 ms | measured, e2e AGENTS:78 | yes on ui/warm |
| | slim, fresh sim, slim suites | 16-12 | 1.6–2.7 s | est | yes |
| | first app launch | K18 | 4.5–6.4 s | measured | yes |
| iOS pool growth | `readGoldenTarget`, 3 serial | `ios-golden.ts:87-101` | 0.4–1.4 s | est | yes |
| | golden lock hand-off | `builds/lock.ts:81` | 0–2 s per waiter | est | yes for N > 1 |
| | `list devices` + `plutil` under the lock | `ios-golden.ts:236-251` | 0.2–0.4 s | est | yes, serial |
| | `simctl clone` | `ios-golden.ts:276` | 3.7 s | measured, golden.ts:4-5 | yes, serial |
| | boot of a fresh clone | | 11.9 s; 3 in parallel ~20 s | measured, README.md:125 | yes |
| | clone failure → `simctl create` first boot | `ios.ts:294-302` | 146–239 s | measured | yes |
| iOS first golden | create → boot → `bootstatus` (≤ 15 min) → migration poll 5 s → settle (≥ 30 s floor: 3 × 10 s) → shutdown | `ios-golden.ts:41-50,175-192` | ~2–5 min | README.md:115 "a minute or two"; `:201` "~5 min" | yes, once per key |
| Android new emulator | `-list-avds` ×2, `adb devices` ×2 | 16-14 | 0.25–0.7 s | est | yes |
| | spawn + early-exit wait | `android.ts:121` | 1.5 s (overlaps the boot) | read | no |
| | `boot` existence check | `android.ts:275-280` | 20–50 ms (flaky, 16-4) | est | yes |
| | `wait-for-device` + `boot_completed` | `android.ts:282-294` | boot ~20–45 s, + ~1 s poll slack | est | yes |
| | warden-uiad start | `wdn-perf.md:443` | 76–128 ms | measured | yes |
| Android reuse | inventory + `wait-for-device` + one `getprop` | `android.ts:237-243,282-288` | ~3 + 2 spawns ≈ 100–200 ms | est | yes |

Spawn-cost assumptions used above (all estimates, measure them on device):
- `simctl list`: 150–300 ms.
- `simctl spawn`: 150–250 ms.
- `adb shell`: 20–50 ms.
- `emulator -list-avds`: 100–300 ms.
- `xcodebuild -version`: 150–800 ms.

To measure on device:
- Spawn costs, idle and under load: `hyperfine -w 2 'xcrun simctl list devices available -j' 'xcrun simctl spawn <udid> launchctl list' 'xcodebuild -version' 'emulator -list-avds' 'adb -s <serial> shell getprop sys.boot_completed'`.
- Android cold vs quick-boot (16-3): `time (emulator -avd <avd> -read-only -no-snapshot-save -no-window -no-boot-anim -port 5560 & adb -s emulator-5560 wait-for-device shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 0.2; done')`, then the same after saving a snapshot with a writable instance (`adb emu avd snapshot save warden-test`) and launching with `-snapshot warden-test`. Repeat on the 16 KB image (`sdk_gphone16k_arm64`).
- Physical RAM per booted sim and per emulator (16-13, 16-16): `footprint -p <launchd_sim pid> --all-children` (or Activity Monitor → Memory, grouped), and `footprint qemu-system-aarch64`, for 1/3/4 devices booted idle, with and without slim.
- The auto-gc race (16-1): a pool sim idle for > 20 min, then `WARDEN_DEBUG=1 warden e2e example`. Look for `simctl shutdown` from the gc child (`ps -o pid,command | grep 'gc --quiet'`) and whether the claim action is `reuse` or `boot`.
- Concurrent `simctl clone` of one golden (16-6c): `for i in 1 2 3; do xcrun simctl clone <golden> t$i & done; wait`, timed against serial.
- Whether `simctl clone` carries `AutomationEnabled` (16-7) and the slim disabled set (`slim.ts:172-173`): clone a slimmed, automation-enabled sim, boot it, then `launchctl print-disabled system` and `plutil -extract AutomationEnabled raw`.
- Multi-device contention (question 5): `warden e2e example --count 3` and `--count 4` on the 14-core host, comparing fill garbles (K9), settle `via`, and per-test p95 against `--count 1`.

**Question → finding index.**
- Q1: the table above.
- Q2: 16-3, 16-5, 16-4, 16-17. A `verifyWarm` for a reused emulator is cheap to add (one `getprop sys.boot_completed` + `pidof system_server`), but nothing shows it is needed.
- Q3: 16-15, 16-6, 16-7, 16-8, 16-12. The migration read per clone is ~10 ms, not worth changing.
- Q4: 16-13, 16-1, 16-9.
- Q5: 16-16.
- Q6: 16-10, 16-4, 16-8, and the placeholder (below).

**Placeholder lease (question 6), no finding.**
- Its TTL is `min(ttl, 5 min)` with the claimer's pid (`claim.ts:119-120`). It is deleted on a failed `create` (`claim.ts:164` → `:336`) and replaced in a transaction on success (`:167-179`).
- It outlives a failure only when the claimer is SIGKILLed, and then for ≤ 5 min after the pid dies.
- A clone that finished before such a crash is unrecorded but named `warden-<profile>-N`, so `markWardenDevices` adopts it (`inventory.ts:23-24`).

## Owned files not read

- `packages/core/src/golden/golden.testing.ts`, `ios.fixture.ts`, `android.fixtures.ts`: skimmed by grep only. They are covered by the green tests (`bun test` of the owned dirs: 154 core plus 94 CLI tests pass).
- Tests: read selectively (`claim.test.ts:415-466`, the test names in `android.test.ts` and `gc.test.ts`), not in full.

## Questions for the user

1. Android golden snapshot (16-3). Should warden own a per-AVD quick-boot snapshot and launch from it by default? That gives a faster, identical start state, but costs 2–4 GB of disk per AVD and a one-time writable boot. Or should it stay opt-in, since the user's AVD state is sometimes wanted?
2. Warm-pool policy (16-13 / 16-9). On a developer machine, which do you prefer: (a) a longer keep-booted window (for example 2 h, at roughly 1.5–3 GB per sim, unmeasured), (b) an explicit `warden warm`, or (c) today's 20 min plus the race and SessionEnd fixes only?

## Files read

- `docs/audit/BRIEF.md`, `docs/audit/ASSIGN-16.md` (and the owned-file lists of ASSIGN-12/14/15/17/18, for owner mapping).
- `docs/plans/wdn-perf.md` (Context, Targets, PERF-4.x, Results, Follow-ups, Decisions); `docs/bench/ios-2026-10-16-perf.md`, `docs/bench/android-2026-10-16-perf.md` (grepped); `README.md:110-135`; `skills/warden/SKILL.md` § Facts; `packages/core/AGENTS.md` (grepped); `packages/e2e/AGENTS.md:63,78`.
- `packages/core/src/{claim,allocate,inventory,liveness,shutdown-policy,config.defaults,headless,exec}.ts`, `providers/{ios,android,health,provider.types}.ts`, `golden/{golden,ios-golden}.ts`, `sims/slim.ts`, `builds/lock.ts`, `builds/builds.defaults.ts` (grepped), `store.ts:300-373` (grepped).
- `apps/cli/src/{claim-flags,sim-windows,autogc,device-shutdown,providers,golden-deps}.ts`, `commands/{claim,gc,golden}.ts`.
- Context only: `lease-session.ts:300-420`, `commands/batch.ts:860-905,1305-1335,1600-1620`, `batch/setup.ts:40-80`, `commands/e2e.ts:210-235`, `commands/hook.ts:12-22`, `commands/release.ts` (grepped), `packages/e2e/src/driver/ios/{simctl.ts:72-100,300-316,ios-driver.ts:515-560}`, `apps/cli/src/agent-ui/helper.ts:515-530`, `packages/core/src/builds/define-config.ts:420-440`.
- Ran: `bun test` on `packages/core/src/{providers,claim,allocate,inventory,liveness,shutdown-policy,headless,golden,sims/slim}` (154 pass), and on `apps/cli/src/{claim-flags,sim-windows,autogc,device-shutdown,commands/claim,commands/gc,commands/golden}.test.ts` (94 pass).

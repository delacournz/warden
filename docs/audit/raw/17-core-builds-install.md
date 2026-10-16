# 17 · core-builds-install

Auditor 17. Scope: `packages/core/src/builds/*`, `git-facts.ts`, `owner.ts`, `node-bin.ts`, `apps/cli/src/commands/{app,builds}.ts`. Commit `dfcc68b`. Source files are unchanged between `dfcc68b` and the checked-out HEAD; only audit docs differ. Owned tests all pass: `bun test src/builds src/git-facts.test.ts src/owner.test.ts src/node-bin.test.ts` gave 270 pass, and `apps/cli` `app.test.ts` + `builds.test.ts` gave 30 pass.

## Spawn and read counts for `app ensure`

These are traced from the code. "prepare" means `projectContext` + `computeCacheKey`, the device-independent half (`apps/cli/src/commands/app.ts:99-108@dfcc68b`). A `warden e2e --app` run does it once per platform (`apps/cli/src/lease-session.ts:285-301@dfcc68b`). The device half runs once per device, all devices in parallel (`lease-session.ts:230@dfcc68b`). The counts are for a `native+js` project such as `apps/example` with one listed dir and `cwd` = project root.

| Path | iOS spawns | Android spawns | Notes |
|---|---|---|---|
| prepare (every path) | 1 `git rev-parse` (shared with `resolveOwner`) + 1 `git config --get remote.origin.url` + 1 fingerprint process + 2 `git ls-files` = **5** | same **5** | `ensure.ts:49,61`, `project-key.ts:98`, `fingerprint.ts:102-112`, `js-inputs.ts:126-133`. The fingerprint process is `node_modules/.bin/fingerprint`, or `bunx --bun @expo/fingerprint` (`fingerprint.ts:63`). It is the expensive one. Config module evaluated once (`config.ts:360-383`) |
| cache hit + installed at hash | +1 `simctl get_app_container` + 2 `plutil` (parallel) = **8** | +1 `pm path` = **6** | `resolve.ts:95-111`, `install.ts:50-61,85-99,108-120`. Plus 2× `cachedBuild` (SELECT + UPDATE + `existsSync`), `resolve.ts:103,136` |
| cache hit, not installed / other hash | +1 `simctl install` + 1 `get_app_container` = **7** | +1 `adb install -r` + 1 `pm path` = **7** | `install.ts:146-162`. The record-hash mismatch skips `confirm` |
| cache hit, record stale (app gone) | +1 `get_app_container` + install + `get_app_container` = **8** | +`pm path` + install + `pm path` = **8** | `resolve.ts:99-101` |
| cache miss, local build, no EAS | +[lock txn] +0–1 `git rev-parse` (5 s TTL lapses during the fingerprint) + 1 `xcodebuild -version` + 1 `sh -c <build>` + 1 fingerprint + 2 `ls-files` + recursive `cp` + `diskSize` walk + install + `get_app_container` = **12–13** | +1 build + 1 fingerprint + 2 `ls-files` + `cp` + install + `pm path` = **11** | `local.ts:128-173`, `cache.ts:184-220` |
| cache miss with EAS (`native+js`) | add `git status --porcelain` + `git rev-parse HEAD` + `bunx eas-cli build:list` (+ `build:download`), each poll every 30 s | same, download via `fetch` | `ensure.ts:107-114`, `eas.ts:235-252` |

Per `warden e2e --app` run, the config module is evaluated **3×**: `findSuite`, `specBundleId` and `prepareApp`. `git config --get remote.origin.url` is spawned **2×**. One of those project keys is never used (17-12).

PERF-4.4 / PERF-4.6 check:
- **Landed:** the container from `confirm` is passed to `matches` (`ensure.ts:226`). The `stat` spawns are now an in-process `FileSize` (`install.ts:8-17,96`). Native and JS hashing run under `Promise.all` (`fingerprint.ts:102`). JS hashing uses `git ls-files -s` blob ids (`js-inputs.ts:39,100-123`), and file reads are parallel, at most 32 at once (`js-inputs.ts:42,185`). So "js-inputs reads serially" is stale.
- **Not landed:**
  - "store the artifact identity at build time": `plutil` still runs on the cached `.app` on every check (17-7).
  - "memoise the fingerprint by HEAD + dirty set + lockfile hash" (17-5).

## Top 5 by impact

1. **17-1**: K8a. A fresh checkout's first build never gets cached: `expo prebuild` moves the native fingerprint mid-build and `runLocalBuild` refuses. Merely re-keying would still make the second device in the same session rebuild.
2. **17-2**: K8b. `locateArtifact` rejects outputs older than the build start, so an up-to-date Gradle/Xcode run "finds no .apk". Together with 17-1, the cache can't fill on a fresh checkout. This broke bench runs r1/r2.
3. **17-3**: iOS `locateArtifact` takes the newest `.app` across **every** DerivedData project. A concurrent build in another worktree can be cached under this worktree's key. Fixing 17-2 naively makes this worse.
4. **17-4**: N devices each run their own `ensureApp` with no in-process single-flight. A failing build or EAS lookup runs N times in series, and on success every waiter sleeps up to 2 s for the poll.
5. **17-5**: the fingerprint memo from PERF-4.6 never landed. Every `warden e2e --app` / `app ensure` runs `@expo/fingerprint` (seconds). With sims kept warm, that cost is now on the critical path.

## Findings

### 17-1 K8a: fingerprint changes during `expo prebuild`; `runLocalBuild` refuses to cache, and re-keying alone is not enough
- Category: correctness
- Severity: P0
- Known?: known-extended K8
- Evidence:
  - `packages/core/src/builds/local.ts:168-172@dfcc68b` recomputes `computeCacheKey` after the build. Any difference returns `err("fingerprint changed during the build …; not caching")`, and `ensure.ts:210@dfcc68b` propagates it, so `app ensure` / `warden e2e --app` fails after a full native build.
  - Exact condition: the build command generates or rewrites inputs that `@expo/fingerprint` hashes. `apps/example/warden.config.ts:28,81` runs `bunx expo prebuild --platform ios --no-install && pod install` inside `build.ios`. `expo run:android` prebuilds `android/` itself when it is missing. Both dirs are git-ignored (`apps/example/.gitignore:40-41`), so every fresh worktree starts without them.
  - The fingerprint before the build has no `ios/`; the one after has `ios/`, `Podfile.lock` and `Pods`. The bench doc records the resulting move: `ios-2026-10-16-perf.md:121`, "a fresh worktree's first build changes the native fingerprint", hash `ebf4b071…`. The JS half (`jsInputs` globs `src/**`, `app.config.ts`, …) is untouched by prebuild.
  - Why "re-key to the post-build fingerprint" (`wdn-perf.md:690`) alone is not enough:
    - (a) `sessionEnsureApp` caches one `PreparedApp` (the pre-build key) per platform (`apps/cli/src/lease-session.ts:285-301@dfcc68b`). Device 2 waits on the build lock, then re-checks `steps.cached()` with the **pre-build** key (`resolve.ts:63@dfcc68b`), misses, and builds again.
    - (b) Every other fresh worktree of the same project (shared `projectKey`, `project-key.ts:54-62`) computes the pre-build key and misses forever.
    - (c) `recordInstall` stores the requested `hash` (`ensure.ts:241`), so the next run in the same worktree (now keyed post-build) reinstalls.
- Impact: measured. Bench runs `perf-android-r1` / `-r2` "never reached the tests" (`wdn-perf.md:673`). On every fresh checkout or worktree, the first `warden e2e --app` costs a full native build (minutes) and still fails.
- Proposed fix:
  - In `runLocalBuild`, record `nativeDirExisted = existsSync(join(root, platform))` before the build.
  - After the build, if `after.key !== hash`, accept when all of these hold:
    - (1) `!nativeDirExisted` and the native dir now exists;
    - (2) for `native+js`, `after.js === pre.js`;
    - (3) for native-only, the JS key is not available, so compare `git status --porcelain` with the platform dir excluded, before vs after, to rule out a mid-build source edit.
  - Return `{ artifact, postKey }`.
  - In `ensure.ts`'s build step, store under the **requested** key, which is valid because CNG output is a function of the pre-build inputs. Also upsert a second `builds` row for `postKey` with the same path, or copy it.
  - Record the install under `postKey`, which is what later runs in this worktree will compute.
  - Keep refusing when the native dir pre-existed and still changed: that is a real native edit.
  - Files: `local.ts`, `ensure.ts`, `cache.ts` (alias row; `removeBuild` already tolerates a missing dir and `cachedBuild` drops dangling rows).
  - Contract: store (an alias row, not a schema change), otherwise additive.
- Effort: M
- Risk: med. A false hit is the danger. Condition (1) limits it to CNG projects. Needs a device run on a fresh worktree (iOS + Android) to confirm the second run hits.
- How to verify:
  - `local.test.ts`: (a) fake build creates `android/`, fingerprints `["h1","h2"]` → ok with `postKey: "h2"`; (b) the dir pre-existed → still refuses; (c) JS half changed → refuses.
  - `ensure.test.ts`: after the re-key both `cachedBuild(…,"h1")` and `(…,"h2")` hit; a second `ensureApp` with `hash: "h1"` for another device does **not** run the build command.
  - On device: `git worktree add` a fresh checkout, then `warden e2e example --all` twice. The first run passes, the second shows `source: installed|cache`.
- Confidence: high
- Verified by: read; traced path from `lease-session.ts:286` through `resolve.ts:62-81` to `local.ts:168`; ran `bun test packages/core/src/builds` (the existing test `local.test.ts:129` pins the refusal)

### 17-2 K8b: `locateArtifact` accepts only outputs modified at or after the build start
- Category: correctness
- Severity: P0
- Known?: known-extended K8
- Evidence:
  - `local.ts:75-86@dfcc68b` filters candidates with `mtime >= since`, where `since = now() - 1000` (`local.ts:152`). An up-to-date Gradle run doesn't rewrite `app-release.apk`. A no-op XCBuild skips its `Touch` task, so the `.app` directory mtime stays old.
  - Exact sequence on a fresh checkout:
    - run 1 builds, then 17-1 refuses;
    - run 2 has a new (post-prebuild) key, so the cache misses and the build is up to date: "local build succeeded but no Release .apk was found" (`local.ts:163-166`);
    - every later run repeats run 2 until the APK is deleted.
  - Two traps in the obvious fix ("accept the newest candidate"):
    - `isApkOf` (`local.ts:47-52`) accepts **any** path segment ending in `release`, so `outputs/apk/androidTest/release/app-release-androidTest.apk` (left by a Detox or instrumentation build) qualifies and could be the newest file.
    - On iOS the newest candidate can belong to another project (17-3).
  - `local.test.ts:25-37@dfcc68b` pins the current rule (`since` in the future → `undefined`).
- Impact: measured. With 17-1, "a fresh checkout can't populate its Android cache without deleting the APK" (`wdn-perf.md:691`); r3 ran only after a manual delete (`wdn-perf.md:673`).
- Proposed fix:
  - When the build exits 0 and no candidate is `>= since`, fall back to the newest candidate, but only if all of these hold:
    - (a) the post-build key equals the requested key, or re-keys per 17-1;
    - (b) the candidate lies under the project (`<root>/android/...`, `<root>/ios/build/...`, or a DerivedData dir proven to belong to `root`, see 17-3);
    - (c) Android: the path has no `androidTest` segment;
    - (d) iOS: `CFBundleIdentifier` equals `bundleIdFor(project)`, which needs one `plutil` (it already runs at install).
  - Log "using up-to-date artifact <path> (mtime …)".
  - Files: `local.ts`, `local.test.ts`. Additive.
- Effort: S
- Risk: med. A build command that exits 0 without building could cache a stale artifact. Condition (a) bounds the risk to "the same inputs", because Gradle and XCBuild up-to-date checks are input-hash based. Device check: fresh checkout, Android.
- How to verify:
  - `local.test.ts`:
    - old APK (`age(…, 3600)`), build exits 0, fingerprints equal → returns the APK;
    - an `androidTest/release` APK newer than the app APK → not picked;
    - fingerprints differ → still an error.
  - On device: run `warden e2e example --platform android` twice on a fresh worktree with no APK deletion.
- Confidence: high
- Verified by: read; ran `bun test packages/core/src/builds/local.test.ts`

### 17-3 iOS artifact search picks the newest `.app` from any DerivedData project, so a parallel worktree's build can be cached under this key
- Category: correctness
- Severity: P1
- Known?: new
- Evidence:
  - `artifactCandidates` (`local.ts:69-71@dfcc68b`) lists `<root>/ios/build/…` **plus** `children(derivedData).map(d => join(d, products))`, which covers every Xcode project on the machine. `locateArtifact` then takes the newest by mtime (`local.ts:82-85`).
  - The test `local.test.ts:25-35@dfcc68b` encodes this: it picks `DerivedData/App-xyz` over `Other-abc` purely by age.
  - Two worktrees of one app build into `DerivedData/example-<hashA>` and `example-<hashB>`. Both have the same product name and bundle id, and the build lock does not serialise them because the key includes the hash (`lock.ts:8-10`).
  - When worktree A's own `.app` is not touched (an up-to-date build, 17-2) or B finishes inside A's window, A caches **B's** `.app` under A's key (`ensure.ts:211`). The post-build fingerprint check (`local.ts:168`) only looks at A's sources, so it can't notice.
  - `installApp`'s bundle-id check (`install.ts:156-160`) passes because the bundle id is the same. Later runs of A test B's code from the cache until a prune.
  - For a different app, the install "succeeds", then fails with "wrong bundle id in config?". The wrong artifact is already cached under the key.
- Impact: estimated. It is a silent wrong-binary result, not a time cost. The window is a whole native build (minutes) whenever two agents in sibling worktrees build at once, which is the multi-agent case warden exists for. It gets worse once 17-2's fallback drops the `since` filter.
- Proposed fix:
  - Keep only DerivedData dirs whose `info.plist` `WorkspacePath` is inside `project.root`. That is one `plutil -extract WorkspacePath raw` per DerivedData dir, or a cheap prefilter on the dir-name prefix (the workspace name) first.
  - Prefer `<root>/ios/build`.
  - Check `CFBundleIdentifier` of the chosen `.app`.
  - Better: have the default build command pass `-derivedDataPath ios/build`, or parse Expo's printed product path. That would need a change to `defaultBuildCommand`, which is cli-visible.
  - Files: `local.ts`, `builds.defaults.ts`, `local.test.ts`. Additive.
- Effort: M
- Risk: low for the filter. Needs a Mac to confirm the `info.plist` format and key on the installed Xcode.
- How to verify:
  - Unit: two DerivedData dirs with `info.plist` pointing at different roots; the other root's newer `.app` is ignored.
  - On device: build two worktrees at once and compare `warden builds ls` paths/sizes with each DerivedData `.app`.
- Confidence: med (whether `expo run:ios` uses default DerivedData is inferred from the search list itself)
- Verified by: read; ran `bun test packages/core/src/builds/local.test.ts`

### 17-4 Per-device `ensureApp` calls have no in-process single-flight: duplicate failing builds/EAS lookups, plus up to 2 s of poll latency
- Category: perf-latency
- Severity: P1
- Known?: new
- Evidence:
  - `installLegApp` runs `ensure` for every claimed device under `Promise.all` (`apps/cli/src/lease-session.ts:230@dfcc68b`, agent 12's file; this is the call count only). Each call reaches `resolveApp` → `locate` → `steps.lock(fetchOrBuild)` (`resolve.ts:83-93@dfcc68b`).
  - The calls share the owner and pid, but `withBuildLock` treats the second as a foreign waiter. It polls with `sleep(BUILD_LOCK_POLL_MS = 2000)` (`lock.ts:60-82`, `builds.defaults.ts:43`).
  - On success, the waiter learns of the release only at its next poll, which is 0–2 s later (mean 1 s), and only then installs.
  - On failure (build error, or an EAS miss followed by a build error), the waiter takes the lock and `fetchOrBuild` finds no cache entry (`resolve.ts:63`). It runs EAS `build:list` again (`eas.ts:245`) and the **whole local build again**. `installLegApp` waits for all devices, so the user sees the first failure only after N serial builds.
  - The same applies to the iOS + Android legs only when the hashes are equal, which they are not, so the issue is per platform.
- Impact: estimated. Cache-miss success: +1 s mean / +2 s max to the second device's install per run. Cache-miss failure with `count: 2` (the `apps/example` suites, `warden.config.ts:96,104`): time-to-error doubles. Example: a 6 min failing Release build costs 12 min.
- Proposed fix:
  - Add a module-level `Map<buildLockKey, Promise<Result<Found>>>` in `ensure.ts` and wrap the `lock(fetchOrBuild)` call in it. Same-process callers then await the first one's promise, success or error, and only foreign processes poll.
  - Optionally shorten the poll to 500 ms with back-off for foreign waiters.
  - Files: `ensure.ts` (or `resolve.ts`), with a test in `ensure.test.ts`. Additive.
- Effort: S
- Risk: low. A failure is shared by the devices of one session, which is the desired behaviour.
- How to verify: in `ensure.test.ts`, start two `ensureApp` calls with different `deviceId`s on a cache miss where the build command fails. Assert one `sh -c` call and two errors. For success, assert no `sleep` call.
- Confidence: high
- Verified by: traced path from `lease-session.ts:230` to `lock.ts:60-82` and `resolve.ts:62-81`

### 17-5 Fingerprint memo (PERF-4.6) never landed: `@expo/fingerprint` runs on every ensure
- Category: perf-latency
- Severity: P2
- Known?: claimed-fixed-not-landed (`wdn-perf.md:356-362`, "Memoise in the builds table keyed by HEAD + dirty set + lockfile hash + `app.config.*` env inputs")
- Evidence:
  - `computeCacheKey` (`fingerprint.ts:96-120@dfcc68b`) always spawns `fingerprintArgv` (`fingerprint.ts:54-64`). It has no lookup before the spawn; the only memo is per session and platform in `sessionEnsureApp` (`lease-session.ts:285-289`).
  - `runLocalBuild` runs it a second time after a build (`local.ts:168`). That second run is necessary.
  - Without a local bin it is `bunx --bun @expo/fingerprint`, which adds bunx resolution (`fingerprint.ts:63`).
  - PERF-4.8 keeps sims booted, so the claim is fast. The fingerprint, warmed in parallel with the boot (`lease-session.ts:303-314`), is therefore no longer hidden behind a boot.
- Impact: estimated, not measured; the bench docs have no fingerprint timing. `@expo/fingerprint` on an Expo SDK project (hashing `node_modules` native packages, autolinking resolution) is typically 1.5–4 s. That is +1.5–4 s per `warden e2e --app` run on warm sims, and per `warden app ensure` / `warden dev`. Per test it is under 0.5 s on an 8-test run.
- Proposed fix:
  - Add a `fingerprints` table (store change) keyed by `(root, platform, variant, fingerprint command)`. The value is the native hash plus a cheap signature:
    - `git rev-parse HEAD`;
    - sha of `git status --porcelain=v1 -z --untracked-files=all`;
    - size+mtime of `bun.lock` / `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`;
    - mtime of `node_modules/.bun-tag` / `node_modules/.package-lock.json`;
    - size+mtime of `app.json` / `app.config.*`;
    - the **existence and max mtime** of `ios/` and `android/` (git-ignored under CNG, so invisible to `git status`).
  - Skip the memo when `fingerprint.command` is set or the app config is dynamic and reads env.
  - Always recompute after a build.
  - Files: `fingerprint.ts`, `store.ts` (owner of the schema), `fingerprint.test.ts`. Contract: store.
- Effort: M
- Risk: med. A false hit installs a stale native build. Test the untracked-file, lockfile and native-dir cases, as the plan asked.
- How to verify:
  - `fingerprint.test.ts`: a second call with an unchanged signature spawns nothing; touching the lockfile, adding an untracked file, or creating `ios/` each recompute.
  - On device: `hyperfine 'warden app ensure ios --no-install'` warm, before vs after.
- Confidence: med
- Verified by: read; checked against `wdn-perf.md:356-362`

### 17-6 Android trusts the install record: no check that the installed APK is warden's build
- Category: correctness
- Severity: P2
- Known?: new
- Evidence:
  - `appMatchesArtifact` returns `ok(true)` for any non-iOS target (`install.ts:115@dfcc68b`). `probeApp` checks only that `pm path` prints `package:` (`install.ts:60`).
  - So if anything else installs the same package on a leased emulator (`expo run:android`, Android Studio, a Debug vs Release swap, an older EAS APK), `alreadyInstalled` returns true (`resolve.ts:103-110`). The run tests the wrong binary and reports `source: installed`.
  - iOS has the identity check; Android has none.
- Impact: estimated. A silent wrong-app run when the record and the device disagree. It costs nothing in the normal case.
- Proposed fix:
  - `pm path` already prints `package:/data/app/…/base.apk`. Replace the probe with one shell, `adb -s S shell 'p=$(pm path X) && echo "$p" && stat -c %s "${p#package:}"'`, and compare the size with `nodeFileSize(cachedApk)`. `base.apk` is a byte copy for non-split APKs.
  - Alternatively, record `lastUpdateTime` from `dumpsys package X` at install and compare.
  - Still one spawn.
  - Files: `install.ts`, `install.test.ts` (+ `fake-adb.ts` if it models `pm path`, owner 13/14). Wire: none (adb argv only).
- Effort: S
- Risk: low. Needs an emulator to confirm `stat -c` exists on API 30–37 (toybox has it).
- How to verify: in `install.test.ts`, a fake exec where the base.apk size differs → `matches` false → reinstall. On device: run `adb install` of a different APK of the same package, then `warden app ensure android` reinstalls.
- Confidence: med
- Verified by: read

### 17-7 iOS identity check costs 2 `plutil` per ensure and misses same-size JS changes; the container path from the install probe is thrown away
- Category: correctness
- Severity: P2
- Known?: claimed-fixed-not-landed (`wdn-perf.md:342`, "store the artifact identity at build time")
- Evidence:
  - `appIdentity` spawns `plutil -convert json` for **both** the installed container and the cached `.app` on every already-installed check (`install.ts:85-99,118@dfcc68b`). The cached side never changes for a given row, but nothing stores its identity.
  - The identity is `CFBundleVersion | exe size | main.jsbundle size` (`install.ts:98`). A one-character JS edit in a Release (`native+js`) build usually keeps the Hermes bundle size, so a build of the same version and size installed by someone else reads as "same".
  - `installApp` already runs `get_app_container` after every install (`install.ts:156`, via `isAppInstalled` → `probeApp`, which returns the container), and drops the path.
- Impact: estimated. 2 spawns per iOS ensure on the warm path, about 10–20 ms each and run in parallel, so roughly 20 ms wall and 2 process starts. The correctness hole is rare.
- Proposed fix:
  - At install, keep `probeApp`'s container and record `(container, exe ino+mtime)` from one `fs.stat` in `installs` (new nullable columns).
  - In `alreadyInstalled`, if `confirm`'s container equals the recorded one and the executable's ino+mtime is unchanged, it is the same install: 0 `plutil`.
  - Otherwise fall back to today's `appIdentity`. `simctl install` creates a new bundle container UUID each time, so any foreign reinstall changes the container path.
  - Files: `install.ts`, `cache.ts` (`InstallRecord`), `ensure.ts`, `store.ts` schema. Contract: store.
- Effort: M
- Risk: low. Needs a sim to confirm that container UUIDs change on reinstall.
- How to verify: `ensure.test.ts:102` currently pins "three spawns"; change it to one `get_app_container` and no `plutil` when the container is unchanged. On device: run `simctl install` of another build and confirm `ensure` reinstalls.
- Confidence: med
- Verified by: read; ran `bun test packages/core/src/builds/ensure.test.ts`

### 17-8 `eas-cli` calls and the Android download have no timeout while the build lock is held
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `run()` in `eas.ts:181-184@dfcc68b` calls `deps.exec(argv, { cwd, env })` with no `timeoutMs`. `exec.ts:25` passes `timeout: opts.timeoutMs`, i.e. none. This covers `build:list`, `build:download` (a large `.app` tarball) and `workflow:run`.
  - `fetchDownload` (`eas.ts:147-156`) has no `AbortSignal`, and it buffers the whole APK in memory (`arrayBuffer()` → `writeFileSync`).
  - All of this runs inside `withBuildLock` (`resolve.ts:92`). A stalled network or an eas-cli auth hang keeps the lock "alive" (pid alive, `liveness.ts:6-9`). Every other process waits up to `BUILD_LOCK_WAIT_MS` (90 min, `builds.defaults.ts:42`) and this one never falls through to the local build.
  - `EAS_TIMEOUT_MS` (45 min) only bounds the poll loop between calls (`eas.ts:109`), not a single call.
- Impact: estimated. A rare hang that blocks every warden on the machine for that hash for up to 90 min. RSS peaks at the APK size (often 50–150 MB) during a download.
- Proposed fix:
  - Pass `timeoutMs` in `run()`: 2 min for `build:list` / `workflow:run`, 20 min for `build:download`.
  - `fetchDownload`: use `AbortSignal.timeout` and stream with `Bun.write(dest, res)`.
  - A timeout counts as a miss (`act` already maps errors to a miss).
  - Files: `eas.ts`, `builds.defaults.ts`, `eas.test.ts`. Additive.
- Effort: S
- Risk: low
- How to verify: in `eas.test.ts`, assert the `timeoutMs` passed to exec for each argv. A download test with a never-resolving fetch and a short timeout returns a miss.
- Confidence: high
- Verified by: read

### 17-9 `adb install -r` has no fallback for a signature or version mismatch
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `installArgv` uses `install -r` only (`install.ts:35@dfcc68b`), with no `-d`. `installApp` turns any `Failure [` into an error (`install.ts:155`).
  - An EAS build signed with the project keystore over a local debug-keystore build, or the reverse, fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. An older cached build over a newer `versionCode` fails with `INSTALL_FAILED_VERSION_DOWNGRADE`.
  - `resolveApp` does not retry as uninstall + install unless the user passed `--install-mode reinstall` (`resolve.ts:114-119`). On iOS, `simctl install` replaces regardless.
- Impact: estimated. A hard failure of `warden e2e --app` on any emulator that previously held a differently signed build, until the user adds a flag.
- Proposed fix: add `-d` to the argv. On `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, uninstall + install once (the device is leased by the caller, so this is allowed by the foreign-device rule) and log it. Files: `install.ts`, `install.test.ts`, possibly `fake-adb.ts` (owner 13/14). Wire: adb argv only.
- Effort: S
- Risk: low. The uninstall drops app data, which is what a fresh install implies anyway.
- How to verify: in `install.test.ts`, fake `adb install` prints `Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE…]`; then expect an uninstall, a second install and success.
- Confidence: high
- Verified by: read

### 17-10 Legacy-cache import runs outside the build lock; concurrent devices race on `rmSync` + `cp` of one cache dir
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `locate` calls `steps.legacy()` **before** `steps.lock(...)` (`resolve.ts:86-92@dfcc68b`). `legacy` → `storeArtifact` (`ensure.ts:172-177`) does `rmSync(dir)`, `mkdirSync`, then `await cp(...)` (`cache.ts:192-203`).
  - With `count: 2`, both per-device `ensureApp` calls (17-4) reach it together. B's `rmSync` deletes A's half-copied `.app`. A's `cp` can fail with ENOENT, or both write the same files, and A may already be running `simctl install` from a path B is deleting.
  - `warden builds import` (`apps/cli/src/commands/builds.ts:146-158`) also calls `storeArtifact` without the lock.
- Impact: estimated. A flaky first run when `cacheDirs` / `LEGACY_CACHE_DIRS` is in use (`builds.defaults.ts:49-51`, salient). It is niche, but it fails a run.
- Proposed fix: move the legacy step into `fetchOrBuild`, after the cache re-check and under the lock. Or make `storeArtifact` copy into `dir.tmp-<pid>` and `renameSync` it into place (atomic). Files: `resolve.ts`, `cache.ts`, `resolve.test.ts`. Additive.
- Effort: S
- Risk: low
- How to verify: `resolve.test.ts` asserts `legacy` runs inside `lock`. A `lock.race-fixture.ts`-style two-process test with a legacy dir expects both to succeed with one copy.
- Confidence: high
- Verified by: read; traced path from `lease-session.ts:230` to `cache.ts:192`

### 17-11 Build cache is never pruned automatically, and "being installed" builds are not protected
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `pruneBuilds` is called only from `warden builds prune` (`apps/cli/src/commands/builds.ts:81`; it has no other caller). `DEFAULT_MAX_CACHE_SIZE` (20G, `builds.defaults.ts:25`) is enforced only when the user runs that command.
  - A `native+js` project creates a new cache entry, a full Release `.app` / `.apk`, for **every JS change** (`fingerprint.ts:115-119`), so the cache grows on each edit.
  - `planPrune` (`prune.ts:30-42`) says builds "being fetched/installed right now are never removed". But a cache-hit install never takes the build lock (`resolve.ts:84-85`), so only fetches are protected. LRU order makes deleting the just-touched build unlikely, but not impossible under a tight `--max-size`.
  - `forgetInstall` (`cache.ts:268-272`) has no callers.
- Impact: estimated. At ~50–150 MB per Release build and a few dozen JS iterations a day, that is GBs per day per project with no bound. The disk fills silently.
- Proposed fix:
  - After a successful `storeArtifact` with source `build` or `eas`, run a best-effort `pruneBuilds({ maxBytes: DEFAULT_MAX_CACHE_SIZE })` (or from `warden gc`, owner of gc).
  - Exclude builds whose `lastUsedAt` is within the last N minutes, so an install in flight is safe.
  - Fix the comment, or take a shared read lease during install.
  - Files: `prune.ts`, `ensure.ts` (or `gc.ts`). Policy change: auto-pruning is new behaviour users would notice.
- Effort: S
- Risk: low/med. It could evict a build a sibling worktree wants next, which costs a rebuild.
- How to verify: in `prune.test.ts`, a build used within the grace window is kept even if over budget. In `ensure.test.ts`, the cache total stays ≤ budget after many stores.
- Confidence: high
- Verified by: read

### 17-12 One `warden e2e --app` run evaluates `warden.config.ts` 3× and spawns `git config` for a project key `specBundleId` never uses
- Category: perf-cpu
- Severity: P3
- Known?: new
- Evidence:
  - `findWardenConfig` busts the require cache and re-runs the module on every call (`config.ts:363-364@dfcc68b`). It is reached from `findSuite` (`packages/core/src/affected/affected.ts:57`), `specBundleId` → `projectContext` (`apps/cli/src/e2e/launch.ts:26`), and `prepareApp` → `projectContext` (`app.ts:104`).
  - `specBundleId` needs only `bundleIdFor` but pays `readProjectKey`: `realpathSync` + `git config --get remote.origin.url` (`project-key.ts:98`, `ensure.ts:61`).
  - `delete require.cache[path]` drops only the top module, so a config that imports a sibling file sees a stale copy in the same process. This is harmless today, since there is no long-lived reader.
  - `findWardenConfig`'s `env` defaults to `process.env` (`config.ts:392`), and the `affected` / `preset` callers don't pass `ctx.env`. A config function can therefore see different envs within one run.
- Impact: estimated. A Bun transpile + eval + zod parse of a ~4 KB config is about 2–5 ms, times 3, plus about 5 ms for one git spawn: roughly 10–20 ms per run, host only.
- Proposed fix: add a per-process memo in `findWardenConfig` keyed by `(path, mtimeMs, size)`. Add a `projectKey: false` option to `projectContext` (or a `loadProjectOnly`) for `specBundleId`. Files: `config.ts`, `ensure.ts`, `launch.ts` (owner of the e2e CLI). Additive.
- Effort: S
- Risk: low (keyed by mtime)
- How to verify: `config.test.ts` checks that a second call with an unchanged mtime does not re-run the module (a counter in a fixture config), and that touching the file re-runs it.
- Confidence: high
- Verified by: read; grep of callers

### 17-13 `warden app fingerprint` with no platform fingerprints iOS then Android serially
- Category: dx
- Severity: P3
- Known?: new
- Evidence: `fingerprintCmd` loops `for (const platform of platforms) await fingerprint(...)` (`apps/cli/src/commands/app.ts:282-287@dfcc68b`). The two `@expo/fingerprint` runs are independent processes.
- Impact: estimated. About 1.5–4 s saved per invocation (one fingerprint's runtime), host CPU-bound.
- Proposed fix: `Promise.all(platforms.map(...))`, keeping output order. Files: `app.ts`, `app.test.ts`. Additive.
- Effort: S
- Risk: low (log lines interleave; buffer them per platform)
- How to verify: `app.test.ts` with a fake exec that records start order; both start before either resolves.
- Confidence: high
- Verified by: read

### 17-14 Build-lock wait (90 min) is shorter than a legitimate holder (45 min EAS + 60 min build)
- Category: robustness
- Severity: P3
- Known?: new
- Evidence:
  - The holder's `fetchOrBuild` can run `resolveFromEas` for up to `EAS_TIMEOUT_MS` (45 min, `builds.defaults.ts:30`) and then `runLocalBuild` for up to `LOCAL_BUILD_TIMEOUT_MS` (60 min, `:35`) plus two fingerprints.
  - A waiter gives up after `BUILD_LOCK_WAIT_MS` (90 min, `:42`; `lock.ts:74-76`) with "timed out waiting for build lock" while the holder is still making progress.
- Impact: estimated. A rare spurious failure for the second process on a slow EAS + build path.
- Proposed fix: base the waiter deadline on the holder's lease progress (have the holder heartbeat the build lease, then time out only when the heartbeat stalls), or set the wait to ≥ EAS + build + fingerprint. Files: `lock.ts`, `builds.defaults.ts`. Policy change: a timeout users see.
- Effort: S
- Risk: low
- How to verify: in `lock.test.ts`, a holder that heartbeats past `waitMs` does not cause a waiter timeout.
- Confidence: high
- Verified by: read

### 17-15 Per-command git-facts memo still expires after 5 s, and `clean` installs re-probe what `confirm` just saw
- Category: perf-cpu
- Severity: P3
- Known?: new
- Evidence:
  - `CommandContext.git` is `createGitFactsCache()` with the default 5 s TTL (`apps/cli/src/context.ts:39`, `git-facts.ts:45`). The TTL exists for `warden serve` (`git-facts.ts:31-35`), yet a one-shot `warden e2e` / `app ensure` re-spawns `git rev-parse` for any read more than 5 s after the first. One example: `cacheEnv` → `gitToplevel` runs after a multi-second fingerprint (`local.ts:120-131`).
  - `keepInstalled` with `installMode: "clean"` calls `resetAppData`, which re-runs `isAppInstalled` (`install.ts:272`) right after `alreadyInstalled`'s `confirm` (`resolve.ts:97`).
  - `uninstallApp` probes before and after (`install.ts:134,140`).
- Impact: estimated. 1–3 spawns per run (about 5–15 ms on iOS, where `simctl` costs about 50–150 ms each).
- Proposed fix: `createGitFactsCache({ ttlMs: Infinity })` for one-shot commands (keep 5 s in `serve`). Pass `confirm`'s result into `reset`. Files: `context.ts` (owner of the CLI context), `install.ts`, `resolve.ts`. Additive.
- Effort: S
- Risk: low
- How to verify: `ensure.test.ts` counts spawns for a `clean` ensure already at the hash (expect one fewer `get_app_container`).
- Confidence: high
- Verified by: read

## Known items

- K8: known-extended (17-1, 17-2).
  - Both bugs are confirmed with the exact lines.
  - The proposed rule for 17-1 must also cache under the **requested** key and alias the post-build key, or device 2 of the same session (and every other fresh worktree) rebuilds.
  - The fallback for 17-2 must exclude `androidTest` APKs and other projects' DerivedData (17-3).

## Gaps I could not assess here

- `@expo/fingerprint` wall time on `apps/example`, cold and warm. On the Mac, run `hyperfine -w1 'node_modules/.bin/fingerprint fingerprint:generate --platform ios' 'node_modules/.bin/fingerprint fingerprint:generate --platform android'` in `apps/example`. That gives the real number for 17-5 and 17-13.
- Whether `expo run:ios` builds into default DerivedData, and the format of `DerivedData/*/info.plist` (`plutil -p ~/Library/Developer/Xcode/DerivedData/example-*/info.plist`). This is needed for 17-3.
- Whether an up-to-date XCBuild touches the `.app` dir mtime (17-2, iOS). Build twice, then `stat -f %m …/Release-iphonesimulator/example.app`.
- Whether the iOS simulator bundle-container UUID changes on reinstall (17-7). Run `xcrun simctl get_app_container <udid> <id>`, `simctl install` again, then repeat the first command.
- Whether Android `base.apk` has the same size as the cached APK and `stat -c %s` is present on API 30–37 (17-6).
- `simctl install` / `get_app_container` / `adb install` wall times. The bench docs report no install timings, so the device-half costs in the table are counts, not milliseconds.

## Owned files not read

- `packages/core/src/builds/define-config.ts`: skimmed for types only, as assigned.
- `app-option.schema.ts`, `builds.testing.ts`: read only for the type shapes used.
- Test files beyond `local.test.ts` and the test names of `ensure.test.ts`: not read line by line; ran them.

## Questions for the user

1. For 17-1, is caching a CNG build under its **pre-prebuild** key acceptable, on the assumption that prebuild output is a pure function of the config inputs? If not, the fix degrades to re-key only, and every fresh worktree rebuilds once.
2. For 17-11, should the cache auto-prune to 20G after each store, or only from `warden gc`?

## Files read

- `docs/audit/BRIEF.md`, `docs/audit/ASSIGN-17.md`
- `docs/plans/wdn-perf.md` (PERF-4.3/4.4/4.6, Results, Follow-ups); `docs/bench/ios-2026-10-16-perf.md` and `docs/bench/android-2026-10-16-perf.md` (grep)
- `packages/core/src/builds/{ensure,resolve,install,cache,fingerprint,js-inputs,local,lock,prune,project-key,config,compiler-cache,builds.defaults,eas,lock.race-fixture}.ts`, `local.test.ts` (parts)
- `packages/core/src/{git-facts,owner,node-bin}.ts`; `liveness.ts`, `store.ts` (`reclaimStale`), `exec.ts` (grep), `affected/affected.ts:40-80`
- `apps/cli/src/commands/{app,builds}.ts`, `apps/cli/src/project-context.ts`, `apps/cli/src/e2e/launch.ts`, `apps/cli/src/lease-session.ts:215-380`, `apps/cli/src/claim-flags.ts:115-121`, `apps/cli/src/context.ts` (grep), `apps/cli/src/commands/e2e.ts` (grep)
- `apps/example/warden.config.ts`, `apps/example/.gitignore`

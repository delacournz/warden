# Assignment 17 · `core-builds-install` (opus, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/17-core-builds-install.md` and `docs/audit/raw/17-core-builds-install.jsonl`.

## Improvement goal

Make `warden app ensure` and the per-device install faster, turn the two known fresh-checkout cache bugs (K8) into fix-shaped findings, and find lock-contention and repeated-work costs in config/git-facts loading.

## Owned files

- `packages/core/src/builds/{ensure,resolve,install,cache,fingerprint,js-inputs,local,lock,prune,project-key,config,compiler-cache,app-option.schema,builds.defaults,builds.testing,lock.race-fixture}.ts` and tests (`ensure.test.ts` 480, `js-inputs.test.ts` 486, `config.test.ts` 448, `install.test.ts` 373, `fingerprint.test.ts`, `resolve.test.ts`, `lock.test.ts`, `cache.test.ts`, `local.test.ts`, …); skim `define-config.ts` (635, public types) and `eas.ts` (253) only
- `packages/core/src/{git-facts,owner,node-bin}.ts` and tests
- `apps/cli/src/commands/{app,builds}.ts` and tests
- Read-only context: `packages/core/AGENTS.md` (builds row); `docs/plans/wdn-perf.md` PERF-4.3, PERF-4.4, PERF-4.6 and the Follow-ups rows for spawner, conductor and lead (K8).

Not yours: the claim/boot path (16), `lease-session.ts`'s install call sites (12: cite call counts only).

## What prior reads found (verify)

- Install on a cold device with a cached build: `xcrun simctl install <udid> <app>` (`install.ts:29,32-36`, `INSTALL_TIMEOUT_MS` 10 min) then `xcrun simctl get_app_container <udid> <bundleId>` (`:156`); warm with an install record: `get_app_container` then 2 parallel `plutil -convert json -o - <app>/Info.plist` (`:85-99,108-120`); Android: `adb install -r` + `pm path` (record: `pm path` only, `:115` matches check is iOS-only). PERF-4.4 said: pass the container path from `confirm` instead of calling `get_app_container` again, replace 4 `stat` spawns with `fs.stat`, store artifact identity at build time: which landed?
- `fingerprint.ts:71-118`: PERF-4.6 said run `@expo/fingerprint` and `jsInputsHash` with `Promise.all`, use `git ls-files -s` blob ids for clean tracked files, memoise by HEAD + dirty set + lockfile hash: which landed? `js-inputs.ts` reads files serially?
- `builds/config.ts:363`: `warden.config.ts` is `require`d with the cache busted on every lookup (called from `affected.ts:57` and `ensure.ts:51`): how many times per `warden e2e` run, and the cost of evaluating the config module each time.
- `git-facts.ts:50`: memo TTL 5 s per cwd; `owner.ts` git spawns; `resolveOwner` via `Bun.spawnSync`.
- `lock.ts`: build lease under `store.transaction`, `BUILD_LOCK_POLL_MS` 2 s, `BUILD_LOCK_WAIT_MS` 90 min; `lock.race-fixture.ts`.
- K8: `local.ts:120` area `locateArtifact` accepts only outputs modified at or after the build start (an up-to-date Gradle/xcodebuild run reports "no Release .apk was found"); `ensure.ts` refuses to cache when the native fingerprint changed during the build (`expo prebuild` creating `ios/`/`android/` mid-build).

## Starting hotspots

- Spawn and read counts for `app ensure` on: cache hit + installed; cache hit + not installed; cache miss (local build); for iOS and Android. A table.
- The two K8 bugs: exact conditions, a proposed rule (re-key to the post-build fingerprint when the JS key is unchanged and the native dir did not exist before; accept the newest candidate when the build succeeded and the post-build key equals the requested key), and the tests to add.
- `resolve.ts` 5-step resolver: order of cheap vs expensive checks; `confirm` round trips.
- `cache.ts` / `prune.ts`: builds table queries per call, pruning cost, disk hygiene.
- `project-key.ts`: git spawns per read (PERF-4.3 said 3 → 1 via git-facts).
- `config.ts` (472): zod parse + `defineConfig` evaluation cost; whether the parsed config could be cached per (path, mtime) within a process.
- `compiler-cache.ts`: what it caches and whether it is keyed safely.
- `eas.ts`: `EAS_POLL_MS` 30 s and timeouts (skim).
- `commands/app.ts` (346) / `builds.ts`: `--json` paths, spinner cost, repeated `projectContext` reads.

# Assignment 20 · `cross-cutting-risk` (opus, medium)

Read `docs/audit/BRIEF.md` first. Outputs: `docs/audit/raw/20-cross-cutting-risk.md` and `docs/audit/raw/20-cross-cutting-risk.jsonl`.

## Improvement goal

Red-team the code added in the six commits for correctness and robustness gaps that **span owners** or live in your exclusive themes. You are not auditing performance. Twenty other agents each own a file set and will report races inside their own files; your findings must either cross two or more owners' files or fall in these themes: signals and teardown ordering, shell/argv quoting and injection, `$WARDEN_HOME` state files and their staleness, un-awaited promises and dropped `Result` values, detached children outliving their parent, and error paths that turn a `Result` error into a silent success.

## Entry points (read-only)

- `git diff --stat 2b87ba3^..dfcc68b -- apps/cli/src packages/e2e/src packages/core/src` to see the shape of the change; `git log --oneline 2b87ba3^..dfcc68b`.
- Greps across `apps/cli/src`, `packages/e2e/src`, `packages/core/src` (skip `*.test.ts` on the first pass, then use the tests to see what is covered): `spawn(`, `Bun.spawn`, `spawnSync`, `.kill(`, `process.kill`, `unlinkSync`, `rmSync`, `setInterval`, `setTimeout(`, `writeFileSync`, `renameSync`, `Bun.connect`, `Bun.listen`, `process.on(`, `void ` (fire-and-forget), `.catch(() =>`, `catch {}`, `as any`, `!.`, `JSON.parse(`, `\${` inside strings passed to `sh -c`, `adb shell`, `simctl spawn`, `osascript`, `launchctl`.
- Files you may read that no one else audits: `apps/cli/src/{update,hooks}/**`, `apps/cli/src/commands/{install,update,doctor,doctor-helper}.ts`.
- Context: `AGENTS.md` rules ("sqlite `BEGIN IMMEDIATE` is the cross-process mutex", "never shut down a device warden didn't create or lease", "side effects are injected"), `apps/cli/AGENTS.md`, `packages/e2e/AGENTS.md`, `packages/core/AGENTS.md`.

## Themes with concrete starting points

1. **Spawn arbitration vs crashes.** `apps/cli/src/agent-ui/helper.ts`: the `simd_spawn:<udid>` meta row taken in a txn, then a detached spawn: if the spawner dies between the two, who clears the row, and do later callers wait forever or spawn a second helper (one-helper-per-sim rule)? Same shape in `packages/e2e/src/driver/android/uiad-backend.ts` single-flight start and in `packages/core/src/builds/lock.ts`.
2. **Teardown and signals.** `apps/cli/src/commands/batch.ts` SIGINT/SIGTERM handlers, `holdLeases`, `releaseDevices` + `after` hooks (`device-lease.ts`), `lease-session.ts` release paths on thrown errors, `metro.ts` process-group kill, `record.ts`/`video.ts` recorders, `collector.ts` (devtools) detached process, `warden-simd` and `warden-uiad` children: which can outlive the parent, which are killed twice, which never. The SessionEnd hook spawning a detached `warden release --shutdown`.
3. **Shell and argv.** Every place a user- or device-derived string reaches `sh -c`, `adb shell <string>`, `xcrun simctl spawn <udid> <argv>`, `osascript`, `launchctl`: `android-argv.ts` quoting (`textArgvs`), `uiad-device.ts` dex path and `ps` parsing, `sim-windows.ts` JXA script with sim names, `setup` strings from `warden.config.ts`, `batch` `{job}` placeholder expansion (`core/batch/expand.ts`), `metro.ts` argv, `install.ts` paths with spaces.
4. **State files under `$WARDEN_HOME`.** `ui/<udid>/{state,last-snapshot}.json`, `ui/<serial>/android-dump-route`, `android/<serial>.json`, `simd/<udid>.sock`, `install-origin.json`, `logs/<serial>.log`, the sqlite db: atomic writes (rename), schema validation on read, staleness (helper pid reuse, binary mtime), cleanup on release/gc, concurrent writers from two `warden ui` processes.
5. **Dropped results and fire-and-forget.** `Result`/`AsyncResult` values whose `ok` is never checked; `void somePromise` without a `.catch`; `Promise.all` where one rejection abandons siblings mid-side-effect (claim's `realise`, install per device, `shutdownReleasedDevices`); `catch {}` swallowing an error that later reads as success (e.g. settle returning `{quiet:false}` where the caller treats it as quiet).
6. **Frozen contracts in practice.** Any code that casts around `driver.types.ts` or re-reads `WARDEN_*` env with different parsing than `env.ts`.

## Output rules

Each finding names the owners it crosses (`cross_owner`), the realistic trigger (a sequence a user or CI could produce, not a theoretical one), the observable damage (lost lease, orphan process, wrong device touched, silent pass), and the smallest fix. Mark `needs_device` honestly: most of these can be verified with the fakes.

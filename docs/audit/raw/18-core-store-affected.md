# Audit 18 · core-store-affected

Commit `dfcc68b`. Scope: sqlite store, port leasing, `warden affected` (git, graph, snapshot, select), `run`/`dev` start paths, batch scheduler. Timings below come from this box (shared with 20 other agents, no devices), so they are order-of-magnitude, not bench numbers. Where I say "measured here" I ran it; the bench docs have no number for this area.

## Top 5 by impact

1. 18-1 `warden affected` drops untracked files when the warden config is not at the repo root (this repo's own `apps/example` layout): new flows / new screens do not select anything until committed.
2. 18-2 `isPortFree` reports every port busy on a host without IPv6 (Bun gives no `code` on the `::` bind error): no port lease is possible; `ports.test.ts:203` fails here.
3. 18-3 The import graph (about 410 ms cold, measured here) is built even when a `runAll` glob already selected every flow and the graph is never read.
4. 18-4 A cold graph walk costs about 400 ms (TypeScript load plus resolution), is paid again after every edit of a dirty tree, and the on-disk import cache does not reduce it.
5. 18-5 A crashed `warden run` / `dev` keeps its device and ports leased for up to the 30 min TTL (dead pid + fresh heartbeat counts as alive).

## Findings

### 18-1 `changedFiles` mixes repo-root-relative and cwd-relative paths, so untracked files vanish in a subdirectory config
- Category: correctness
- Severity: P1
- Known?: new
- Evidence:
  - `packages/core/src/affected/git.ts:57` runs `git diff --name-status -M -z <mb> --` (paths relative to the repo root), but `git.ts:59` runs `git ls-files --others --exclude-standard -z` with `cwd` = the config dir (`affected.ts:417` passes `suite.configDir`). `ls-files` prints paths relative to its cwd unless `--full-name` is given.
  - `affected.ts:398-408` (`rebase`) then does `relative(configDir, join(top, path))` on every path, assuming repo-root-relative. An untracked `src/new.ts` under `apps/example` becomes `<top>/src/new.ts`, i.e. `../../src/new.ts` relative to the config dir, so `inside()` is false and the file is dropped.
  - Repro (scratch repo, config dir `apps/x`): `changedFiles` returned `{"path":"apps/x/src/a.ts","status":"modified"}` for the tracked edit and `{"path":"src/new.ts","status":"added"}` for the untracked `apps/x/src/new.ts` (should be `apps/x/src/new.ts`). Ran from `/tmp/.../scratchpad/repo/apps/x` with `bun t.ts`.
  - `git.test.ts:37` only covers a config at the repo root. `apps/example/warden.config.ts` is in a subdirectory, so the shipped example layout is affected.
- Impact: false negatives in flow selection for local and agent runs, which are the runs where files are not yet committed. A new untracked flow file under `e2e/` is not even reported as changed, so `warden e2e` skips it; a new untracked source file only selects flows through its (tracked, modified) importers. No time cost; it silently narrows what a gate runs. CI (everything committed) is unaffected.
- Proposed fix: add `--full-name` to the `ls-files` call (`git.ts:59`) so both lists are root-relative; add a `git.test.ts` case with the config dir two levels below the root and an untracked file in it, and one in `affected.test.ts` through `rebase`. Additive.
- Effort: S
- Risk: low. No device needed. The only behaviour change is that previously dropped untracked files now count.
- How to verify: `bun test packages/core/src/affected/git.test.ts` with the new subdir case (fails before, passes after); `warden affected example --explain` in `apps/example` after `touch src/lib/newfile.ts` lists the file.
- Confidence: high
- Verified by: traced path from `affected.ts:417` through `git.ts:41-67` to `affected.ts:398`, and reproduced in a scratch git repo.

### 18-2 `isPortFree` treats an IPv6 bind failure with no `code` as "busy", so no port can be leased on hosts without IPv6
- Category: robustness
- Severity: P1
- Known?: new
- Evidence:
  - `ports.ts:38-41`: the `error` handler marks only `EADDRNOTAVAIL` / `EAFNOSUPPORT` as `"unsupported"`; every other error is `"busy"`. `ports.ts:47` probes `::` by default, and `ports.ts:55-58` returns false on the first `"busy"`. The doc comment on `ports.ts:49-51` promises "hosts without IPv6 are skipped".
  - On this host (no `/proc/net/if_inet6`, Bun 1.4.2) `listen({host:"::"})` fails with `{"msg":"Failed to listen at ::","name":"Error"}`, with no `code`. So `isPortFree(anyPort)` is false, and `claimPorts` returns `no free port in <from>–<to>` for every range (reproduced: `claimPorts` on 47600:20 failed).
  - Real in-use ports do carry a code: with a `Bun.listen` holder, both `127.0.0.1` and `0.0.0.0` report `EADDRINUSE`.
  - `bun test packages/core/src/ports.test.ts` fails 1 test here: `isPortFree (real sockets) > bound port is busy, free again after stop` at `ports.test.ts:203` (expected true after `server.stop`, got false).
- Impact: any `warden run`, `dev`, `batch`/`e2e` with `--port`, and Android console ports claimed through `claimPorts` fail on Linux CI containers or VMs with IPv6 disabled (the `ci` owner kind exists for exactly this). Not an issue on macOS. The failure is total, not a slowdown, and the message blames the range instead of the probe.
- Proposed fix: in `probe`, call a bind "busy" only for `EADDRINUSE` / `EACCES`; any other error on a wildcard host is "unsupported" (skipped), and on an explicit host stays false. Keep the existing tests; add a unit test that injects a code-less error for `::`. Additive.
- Effort: S
- Risk: low. A misclassified exotic error (for example `EMFILE`) would read as free, which the lease insert and the later bind still catch. No device needed.
- How to verify: `bun test packages/core/src/ports.test.ts` passes on an IPv6-less host.
- Confidence: high
- Verified by: ran `bun test packages/core/src/ports.test.ts` (1 fail) and a bind script for `127.0.0.1`, `0.0.0.0`, `::`.

### 18-3 `computeAffected` builds the import graph although a `runAll` hit makes it unreachable
- Category: perf-latency
- Severity: P2
- Known?: new
- Evidence:
  - `affected.ts:457` sets `needsGraph` from "some flow has entries and there is at least one change". `affected.ts:463` then loads the graph per platform.
  - `select.ts:168-176` (`reasonsFor`) calls `importReasons` only when `runAll.length === 0` (`select.ts:172`), and `runAll` is non-empty as soon as one changed path matches a `runAll` glob (`select.ts:205-208`). In that case every graph lookup is skipped, but the graph was already built.
  - Measured here on `apps/example` with `--base HEAD~5` (that diff touches `package.json`, a `runAll` hit): cold (`affected2` dir wiped) 471 ms and 507 ms, snapshot miss 470 and 484 ms, snapshot hit 58 and 54 ms. Output was identical: all 6 flows selected with `run-all` reasons.
- Impact: measured here, about 410 ms saved on the cold or miss path of each `warden e2e` / `warden affected` whose diff touches a `runAll` file (lockfile, `package.json`, native config: typical PRs that bump dependencies); about 50 ms on the snapshot-hit path (the `snapshotKey` git spawns and hashing). iOS and Android alike (host-side). Per 8-test rep this is a once-per-invocation saving, not per test.
- Proposed fix: compute `runAll` hits first (export the `changedPaths` + `runAll` step from `select.ts`, or a small `needsImportGraph(suite, changes)`) and set `needsGraph = false` when any hit exists. Optionally defer the graph load until the first flow's `importReasons` needs it by making `imports` a lazy accessor. Additive.
- Effort: S
- Risk: low. `select.test.ts` already pins the "runAll suppresses the import walk" behaviour; add a `computeAffected` test with a fake `exec` that counts worker spawns. No device needed.
- How to verify: `bun test packages/core/src/affected`; then `warden affected example --base HEAD~5` twice with a wiped `$WARDEN_HOME/affected`, expect no `graph-worker` spawn.
- Confidence: high
- Verified by: traced `affected.ts:457-477` to `select.ts:168-176`, and ran `computeAffected` with timing.

### 18-4 Cold graph walk is about 400 ms, re-paid after every edit, and the import cache does not help
- Category: perf-latency
- Severity: P2
- Known?: new (PERF-5.2 landed as designed; this adds the cost of the miss path)
- Evidence:
  - Miss path: `graph-process.ts:121-142` runs `bun graph-worker.ts <request>` (or `<self> __affected-graph`), which loads TypeScript, builds a `ts.ModuleResolutionCache` per tsconfig and resolves every import of every reachable file through `ts.resolveModuleName` (`graph.ts:190-196`, `198-212`).
  - Measured here on the example suite (211 reachable files): worker wall time 419, 407, 393 ms; in-process split `import typescript` 224 ms (752 ms on the first, cold-disk run), `createImportGraph` about 200 ms including config parsing, walk 112 ms. `graph-worker.ts:150` still says the compiler costs "90 ms and ~90 MB"; on this box it is 2 to 8 times that.
  - Wiping only the snapshots (import cache warm) gave 470/484 ms versus 471/507 ms cold: the `ImportCache` (`cache.ts`) stores specifiers only, so it saves `scanImports` but not resolution, which is the cost. `real(target)` (`graph.ts:194`, `realpathSync`) is also called uncached for every resolved import of every file.
  - Any edit changes the snapshot key (`graph-snapshot.ts:277` hashes each dirty file), so each `warden e2e` after an edit pays the walk again. CI starts with an empty `$WARDEN_HOME`, so it always pays it.
  - Failure mode: `graph-process.ts:105` allows 120 s (`WORKER_TIMEOUT_MS`); on a timeout or crash `graph-process.ts:139` redoes the same walk in this process, loading TypeScript into the parent. A slow-walk case therefore costs up to 120 s plus the same walk again.
- Impact: estimated about 300 ms per `warden e2e` invocation on a miss that cannot be avoided by 18-3 (220 ms TypeScript load plus the memoisable part of the 112 ms walk); a full Bun-resolver replacement would remove about 330 ms (TypeScript load plus walk) but is not free of semantic risk. Host-side, both platforms. Not per test.
- Proposed fix (cheapest first): (a) memoise `real()` and `existsSync` results per walk (`graph.ts:38-44`, `85`); (b) lower `WORKER_TIMEOUT_MS` to about 20 s and skip the in-process retry after a timeout (return a warning that selects all flows, which is the safe direction); (c) persist resolved edges per file keyed by mtime/size plus the `node_modules` / tsconfig state already in `snapshotKey`, so an edit re-resolves only dirty files (changes `GRAPH_VERSION`, additive); (d) long term, resolve relative imports with a platform-suffix probe and use `Bun.resolveSync` for bare / `paths` specs, keeping TypeScript only as a fallback. Update the stale 90 ms comment.
- Effort: (a)(b) S; (c) M; (d) L
- Risk: (c) and (d) change what counts as a resolved import; guard with `graph.test.ts` fixtures for `paths`, `baseUrl`, `.ios.tsx` / `.native.tsx`, workspace symlinks and `customConditions`. No device needed, but run `warden affected` over the example and compare `--json` before and after.
- How to verify: `WARDEN_HOME=<tmp> warden affected example --base HEAD~5` cold versus after an edit, with timings; `bun test packages/core/src/affected/graph*.test.ts`.
- Confidence: med (timings are noisy on a shared host; mechanism is certain)
- Verified by: ran `graph-worker.ts` directly three times and an in-process phase breakdown; read `graph.ts`, `graph-process.ts`, `cache.ts`.

### 18-5 A crashed lease holder keeps its device and ports for up to the 30 min TTL
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `liveness.ts:7-9`: a lease is alive if the heartbeat is within the TTL, or the pid is alive. `config.defaults.ts:2` sets the TTL to 30 min and `:8` the heartbeat to 30 s. `liveness.test.ts:31` pins "dead pid but fresh heartbeat is alive".
  - `warden run` / `dev` / `batch` heartbeat every 30 s (`lease-session.ts:471-473`) and store their own pid on the lease. If that process is killed (SIGKILL, OOM, power) the pid is dead but the last heartbeat is at most 30 s old, so `reclaimStale` (`store.ts:279-287`, also used by `claimPorts` at `ports.ts:142`) keeps the lease for up to 30 min. The next `warden e2e` then waits for that device (or boots another one) and its ports.
  - Separately, `processAlive` is `kill(pid, 0)`; a recycled pid keeps a lease alive past the TTL for as long as the unrelated process runs.
- Impact: not per test. After a hard kill of a supervising CLI, up to 30 min of an unusable device, or one extra cold boot (about 41 s Android, per the bench docs). Estimated: affects only crash recovery; frequency unknown.
- Proposed fix: let leases created by a supervising process (`run`, `dev`, `batch`, `e2e`) carry the heartbeat period (new nullable column via an appended migration), and treat "dead pid and no heartbeat for 3 periods" as stale for those; leave pid-less and hook-claimed leases on the TTL. Store the process start time next to the pid to defeat pid reuse. Contract: store (migration). Policy change.
- Effort: M
- Risk: med. A suspended laptop that resumes would look dead for a moment; the 3-period grace and the live-pid check already cover that. Needs `liveness.test.ts`, `store.test.ts` migration test, and a race test (reclaim versus heartbeat).
- How to verify: unit tests with fake clock and `pidAlive`; manual: `kill -9` a `warden run`, then `warden claim` within 2 minutes should reuse the device.
- Confidence: med (the 30 min behaviour is deliberate and tested; whether it should stay for supervised leases is a product call)
- Verified by: read.

### 18-6 A blocked `BEGIN IMMEDIATE` freezes the whole process, then throws inside the heartbeat timer
- Category: robustness
- Severity: P2
- Known?: new
- Evidence:
  - `store.ts:394` sets `busy_timeout = 15000`; `store.ts:186-189` takes the write lock with the synchronous `bun:sqlite` API, so the sqlite busy handler sleeps on the JS thread for up to 15 s.
  - `lease-session.ts:471-473` heartbeats from a `setInterval` (`intervalEvery`, `lease-session.ts:501-503`) with no `try`/`catch`; `store.heartbeat` (`store.ts:272-276`) opens a `BEGIN IMMEDIATE`. After the 15 s block it throws `SQLITE_BUSY` from a timer callback, an uncaught exception that ends `warden run` / `dev` / `batch` while its child (the test run, Metro) may still be running and its leases stay alive for the TTL (see 18-5).
  - Every transaction I read is short and synchronous (`claim.ts:167`, `ports.ts:140`, `builds/lock.ts:38`, `providers/android.ts:181,306`, `sims/delete.ts:38`), so this needs a stuck writer (a process stopped with SIGSTOP or under a debugger, or a very slow disk). I did not reproduce the 15 s case.
- Impact: low probability, high blast radius: all warden processes stall together for 15 s, then supervisors die. Not a latency issue in normal runs (an empty transaction costs about 0.011 ms, `openStore` warm 0.33 ms, cold 12.6 ms, measured here).
- Proposed fix: wrap the heartbeat callback in `try`/`catch` (log once, retry next tick); lower `busy_timeout` for heartbeat and `autogc` connections or use a short-timeout retry loop with `await Bun.sleep` so timers keep running; keep 15 s only for explicit claims. Additive.
- Effort: S
- Risk: low. Needs a two-connection test (one holds `BEGIN IMMEDIATE`, the other times out) with a shortened `busy_timeout`; no device.
- How to verify: new test in `store.test.ts` and `lease-session.test.ts` (heartbeat throwing does not escape).
- Confidence: med
- Verified by: traced path from `lease-session.ts:471` to `store.ts:186`.

### 18-7 A retry runs on the same worker, so one bad device spends every retry and drains the queue
- Category: flake-risk
- Severity: P2
- Known?: new (related to K5 and K7, not the same item)
- Evidence: `schedule.ts:68-77` loops `while (await attempt(w, ...))` for the retries of a job on the worker that failed it, before that worker pulls anything else. Workers pull from one shared queue (`schedule.ts:71`), so a device that fails fast (wedged AX guest, K7; crashed app) finishes each job in seconds, goes back to the queue, and fails again, each job getting its `retry` attempts on that same device. The type comment says this is intended (`schedule.ts:29-30`).
- Impact: a device-specific fault converts into test failures that a different device would have passed, which the retry was meant to absorb. Estimated for an 8-test rep on 2 workers with one bad device: the bad worker can burn up to 8 x (1 + retry) failing attempts; each is a flake that retry cannot fix.
- Proposed fix: on a retry, requeue the job at the front tagged `avoid: worker` so another worker takes it (same worker only if it is the last one); add a per-worker consecutive-failure breaker that stops a worker pulling after N failures and reports it. Policy change (retry semantics). Files: `batch/schedule.ts`, `batch/schedule.test.ts`; callers in `batch.ts` (agents 12/13).
- Effort: M
- Risk: med. Warm-device assumptions (installed build, `warden-simd` resident) are per device, so a retry on another device pays one extra warm-up; needs the batch grid output to show the move. Testable with the fake `run` in `schedule.test.ts`; confirming the benefit needs devices.
- How to verify: new `schedule.test.ts` cases (job fails on worker 0, passes on worker 1; single worker still retries in place).
- Confidence: med
- Verified by: read.

### 18-8 Warm `warden affected` path is a chain of 6 git spawns plus synchronous content hashing
- Category: perf-latency
- Severity: P3
- Known?: new (the plan's "affected 5 to 4 spawns" at `wdn-perf.md:679` is stale: `snapshotKey` added two spawns per platform)
- Evidence: per platform, in order: `rev-parse` (facts), `merge-base`, `diff` (`git.ts:54,57`), `ls-files` (`git.ts:59`), then `snapshotKey` runs `rev-parse --show-toplevel HEAD` and `status --porcelain` in parallel (`graph-snapshot.ts:251-254`). Traced here with an `exec` wrapper: 3, 4, 35, 6 ms, then 2 and 8 ms; total warm `computeAffected` 56 ms (one platform), 93 ms when the suite has no `platform` (the second platform repeats the two `snapshotKey` spawns, `affected.ts:462`). `ls-files`, `snapshotKey` and `changedFiles` are independent of each other, and `snapshotKey` needs nothing from the changes. `graph-snapshot.ts:213-223,277` reads and hashes every dirty file's content synchronously (up to `MAX_DIRTY` 2000 files x 256 KB), including images and logs.
- Impact: estimated 15 to 25 ms per `warden e2e` invocation from running the git calls concurrently (the diff dominates at 35 ms, so the floor is about `rev-parse` + `merge-base` + `diff`). Hashing is small for normal trees (tens of files) but can block the loop for hundreds of ms on a tree with thousands of dirty files.
- Proposed fix: start `ls-files` and the `snapshotKey` git calls with the facts call (`Promise.all`); take HEAD from `git status --porcelain=v2 --branch -z` (`# branch.oid`) to drop the extra `rev-parse`; hash content only for code, tsconfig and `package.json` files and use size + mtime for the rest. Additive. Files: `git.ts`, `graph-snapshot.ts`, `affected.ts`.
- Effort: S
- Risk: low. `git.test.ts`, `graph-snapshot.test.ts` cover the shapes; no device.
- How to verify: `bun test packages/core/src/affected`; compare the spawn trace.
- Confidence: high
- Verified by: ran `computeAffected` with a timing `exec`; read.

### 18-9 `warden run` and `warden dev` load the builds config schemas (zod) at registration (K4)
- Category: perf-latency
- Severity: P3
- Known?: known-extended K4
- Evidence: `lease-session.ts:12` statically imports `defaultAppDeps`, `prepareApp`, `ensurePreparedApp` from `commands/app.ts`, which imports `builds/ensure`, `builds/config` (zod, `affected.schema`, `preset.schema`). `run.ts:16-31` imports `lease-session`, so `run` and `dev` pull it in even when no `--app` is given. Measured here with a `require.cache` preload: `warden run --help` loads 166 modules with zod; `claim --help` 52 without; `version` 27. Eight-run averages: `version` 45 ms, `claim --help` 54 ms, `run --help` 104 ms, `dev --help` 96 ms, `affected --help` 90 ms (affected needs the config legitimately). `dev.ts` itself is fine: `devScheme` is lazy and Android-only (`dev.ts:359-361,427`), so PERF-4.5's `expo config` item landed.
- Impact: measured here, about 50 ms per `warden run` / `warden dev` start. Host CPU/RSS only; not per test.
- Proposed fix: make the `app` imports in `lease-session.ts` dynamic (`await import("./commands/app")` inside `sessionEnsureApp` / `warmSessionApp`) and add a `startup.test.ts` assertion that `run --help` loads no zod. Additive. Files: `lease-session.ts` (not mine; agent 12/16 area), `run.ts`, `startup.test.ts`.
- Effort: S
- Risk: low.
- How to verify: `bun test apps/cli/src/startup.test.ts`.
- Confidence: high
- Verified by: ran the preload module listing and timings.

### 18-10 Import cache is written non-atomically and never pruned
- Category: robustness
- Severity: P3
- Known?: new
- Evidence: `cache.ts:116-120` does `writeFileSync(path, JSON.stringify(...))` straight onto the live file (the snapshot writer next door uses temp + rename, `graph-snapshot.ts:299-302`). One file serves every platform and every process for a config dir (`affected.ts:458-459`), so two `warden affected --platform ios|android` runs in parallel (the documented usage in `affected.ts:171`) can leave a reader with a torn file, which parses as empty (`cache.ts:96-101`) and costs a full re-scan. Entries are keyed by absolute path and never removed, so deleted or renamed files accumulate.
- Impact: perf only, never wrong results (a torn cache reads as empty). Negligible per run.
- Proposed fix: write to `<path>.<pid>.tmp` then `renameSync`; on `save`, drop entries whose file no longer exists. Additive.
- Effort: S
- Risk: low.
- How to verify: extend `affected` cache tests.
- Confidence: high
- Verified by: read.

### 18-11 `warden e2e` computes both platforms, in series, then rejects the ambiguity
- Category: perf-latency
- Severity: P3
- Known?: new
- Evidence: `affected.ts:422-425` selects both platforms when neither the call nor the suite names one; `affected.ts:462-477` runs them one after the other (`await` inside the `for`), each with its own `snapshotKey` and, on a miss, its own worker (18-4). `e2e.ts:109-118` (`onePlatform`) then returns the error `suite ... runs on ios and android — pass --platform`, after `plan` (`e2e.ts:249-251`) has already paid for both.
- Impact: error path of `warden e2e`: about 2 x 0.4 s cold (estimated from 18-4) wasted before the message. For `warden affected` on a dual-platform suite the second platform is serial; running them concurrently halves wall time. Neither is per test.
- Proposed fix: `AffectedInput.requireOnePlatform` so `computeAffected` fails right after `findSuite`; `Promise.all` over platforms once 18-10 makes the shared import cache safe. Additive.
- Effort: S
- Risk: low.
- How to verify: `affected.test.ts` with a fake `exec` counting spawns.
- Confidence: high
- Verified by: traced path from `e2e.ts:249` to `affected.ts:462`.

### 18-12 Snapshot key can serve a stale graph in two edge cases
- Category: correctness
- Severity: P3
- Known?: new
- Evidence: `graph-snapshot.ts:243-248` says ignored files "are not source", yet the walker resolves into any repo file outside `node_modules` (`graph.ts:195`), including generated files under gitignored paths; editing one does not change the key, so the old table is reused. Also the key is computed before the worker walks (`graph-process.ts:133-140`): an edit during the walk is stored under the pre-edit key, and reverting the edit later hits a table built from the edited tree.
- Impact: rare; wrong `import` reasons (a flow not selected or selected needlessly) until the next HEAD or dirty change.
- Proposed fix: recompute the key after the walk and skip the write when it differs; include the stat of resolved gitignored files (the worker can report them in the table) in the key. Table format change, so bump `GRAPH_VERSION`.
- Effort: M
- Risk: low.
- How to verify: `graph-snapshot.test.ts` case that mutates a file between key and write.
- Confidence: low
- Verified by: read.

## Known items

- K4 (`run`/`dev` load zod config schemas eagerly): known-extended, 18-9. Measured 166 modules versus 52 for `claim`, about 50 ms.
- K5 (static sharding): not the same as `batch/schedule.ts`, which is a shared FIFO queue pulled by free workers (dynamic); 18-7 covers its retry-on-same-worker rule.
- K7 (AX guest wedge): the failure that makes 18-7 matter; no new mechanism.
- Plan items verified: PERF-5.3 `synchronous = NORMAL` landed (`store.ts:396`, pinned by `store.test.ts:188`); PERF-5.2 landed (`graph.ts` only `import type`s TypeScript; `loadTs` is dynamic at `graph.ts:28-31`; the parent loads it only in the `walkHere` fallback, `graph-process.ts:81-89`); PERF-4.5 `devScheme` landed (`dev.ts:359-361`, lazy, Android-only, started beside the claim); PERF-4.3 "`affected` 5 to 4 spawns" is true for `changedFiles`/`findSuite` but total is 6 per platform (18-8).
- "Store is already fine" (`wdn-perf.md:50`): confirmed. WAL, `busy_timeout`, `bun:sqlite` `db.query` statement cache, short synchronous transactions. Measured here: cold `openStore` 12.6 ms (creates and migrates), warm 0.33 ms, empty transaction 0.011 ms. The one caveat is the synchronous busy wait (18-6).
- Verified fine, no finding: `claimPorts` probe is 0.74 ms per port over 3 hosts (about 15 binds, under 10 ms per spec including the 4-port slack); `claimRunPorts` loops specs serially before the device claim (`lease-session.ts:389-400`), which costs a few ms and does not justify a multi-span transaction; `types.ts`, `duration.ts`, `exec.ts` are light; `select.ts` glob construction per match costs 8 ms for 50 flows x 200 files x 5 patterns (precompiling saves 4 ms); `findWardenConfig` re-requires the config each call but costs 1 to 2 ms warm; `flows.ts` scan is a handful of syscalls per flow; `batch/expand.ts` and `preset.ts` are a single regex replace and a one-time resolve.
- Race fixtures: `store.race-fixture.ts` (6 processes, 30 ms sleep inside the transaction) proves mutual exclusion of `BEGIN IMMEDIATE`; `ports.race-fixture.ts` (6 processes, probe sleeps outside the transaction) proves the probe-then-lease path yields distinct ports. Not covered: two claims racing for the last device and claim versus gc (`claim.ts`, agent 16), reclaim versus heartbeat on the same lease, a real (unfaked) bind race between probe and the consumer's own bind, and the busy-timeout path (18-6).

## Gaps I could not assess here

- Compiled-binary worker: `<self> __affected-graph` start cost (bytecode load of the 116 MB binary, K3). Measure on a Mac: `time warden __affected-graph '<request>'` against the same request through `bun graph-worker.ts`.
- Graph cost on a large monorepo: run `warden affected <suite> --base origin/main` with a wiped `$WARDEN_HOME/affected` and count files in the table; the 400 ms here is for 211 files.
- 18-1 and 18-2 on a macOS host: 18-1 is OS-independent; 18-2 should be a no-op there (confirm `isPortFree` on a Mac and on an IPv6-less Linux CI runner).
- 18-5: `kill -9` a `warden run` on a real device and time how long until `warden claim` reuses the device.

## Owned files not read

- `packages/core/src/types.ts` and `duration.ts` read in full; `affected/fixture.testing.ts`, `affected/affected.schema.ts`, `batch/preset.schema.ts` and the test files other than the ones named in Findings were not read line by line (tests were run: `src/affected` and `src/batch`, 128 pass; `ports.test.ts` 1 fail, see 18-2).
- `apps/cli/src/commands/dev.test.ts`, `run.test.ts`, `affected.test.ts`: not read.

## Questions for the user

1. Is the "dead pid + fresh heartbeat stays alive for the TTL" rule in `liveness.ts` a product decision (survive a CLI restart that keeps working) or an accident? It decides whether 18-5 should shorten crash recovery for supervised leases.
2. Should `warden e2e` ever select flows from untracked files in a subdirectory config (18-1)? I assumed yes, since the code already tries to include them.

## Files read

`docs/audit/BRIEF.md`, `docs/audit/ASSIGN-18.md`, `packages/core/CLAUDE.md`; `packages/core/src/{store,ports,exec,duration,liveness,git-facts}.ts`, `store.race-fixture.ts`, `ports.race-fixture.ts`, parts of `store.test.ts`, `ports.test.ts`, `claim.ts`, `providers/android.ts`, `builds/lock.ts`, `builds/config.ts`, `sims/delete.ts`; `packages/core/src/affected/{git,cache,graph-snapshot,graph-process,graph-worker,graph,select,flows,affected}.ts`; `packages/core/src/batch/{schedule,expand,preset}.ts`; `apps/cli/src/commands/{affected,affected-graph,run,dev}.ts`, parts of `commands/e2e.ts`, `lease-session.ts`, `startup.test.ts`; `docs/plans/wdn-perf.md` (PERF-4.3, 4.5, 5.2, 5.3, follow-ups). Ran: `bun test packages/core/src/ports.test.ts packages/core/src/store.test.ts`, `bun test packages/core/src/affected packages/core/src/batch`, and scratch scripts under `scratchpad/home-18` and `scratchpad/repo`.

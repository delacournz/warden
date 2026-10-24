# WDN-PRIV-0: cross-worktree iOS build baseline

Date 2026-10-22. Machine: macOS (Darwin 25.6), Xcode 26.6 (17F113), ccache 4.12.3, iPhone 17 sim (iOS 26.x), shared with other agents (CPU contention is real noise, see caveats).
App: `apps/example` (Expo SDK 57, RN 0.86.3, 545 CompileC + 122 SwiftCompile tasks), variant `dev` (`warden dev ios`).

## Headline findings

1. **Shared cache tier works across worktrees.** Second worktree, same native fingerprint: `app cache`, no compile, 6 s.
2. **ccache is never invoked on Xcode 26.6.** warden sets `USE_CCACHE=1` / `CCACHE_DIR` etc. and they reach the compile tasks, but RN's `ccache-clang.sh` runs `exec $CCACHE_BINARY clang "$@"` and `CCACHE_BINARY` is only a Pods *build setting*, which Xcode does not export to compiler task env. It is empty, so it execs plain `clang`. Result: `<WARDEN_HOME>/ccache` is never even created; 0 ccache calls. Proven by logging inside the wrapper (`BIN=[]`), and fixed by exporting `CCACHE_BINARY=/opt/homebrew/bin/ccache` in the build env (`BIN=[/opt/homebrew/bin/ccache]`, cache populated). **Fix for PRIV-5/6: `compilerCacheEnv` must also set `CCACHE_BINARY` (resolve `ccache` on PATH).**
3. **Xcode compilation cache is not active.** `COMPILATION_CACHE_ENABLE_CACHING=YES` is only passed as an env var; it is a build setting, so xcodebuild ignores it (CAS dir `~/Library/Developer/Xcode/DerivedData/CompilationCache.noindex` stayed at 28 KB across full builds). Passing it as an xcodebuild argument grew the CAS (28 -> 60 KB on a single small pod), so it must be an argument (or injected via xcconfig), not env. Note the CAS lives in global DerivedData, not in WARDEN_HOME.
4. **Even with ccache working, cross-worktree hit rate is 0%.** Same-path rebuild hits 100% (545/545), different worktree hits 0/545. The CompileC command lines differ in the DerivedData directory (`wardenexample-<hash of workspace path>`) which appears in `-I...hmap`, `-ivfsoverlay` etc., outside `CCACHE_BASEDIR` (= git toplevel), so the hash changes. The plan already rejected sharing DerivedData; the viable lever is making those args path-independent (e.g. a fixed `-derivedDataPath`/`SYMROOT`-style location per project key, or rewriting via `CCACHE_BASEDIR` covering DerivedData), to be investigated in PRIV-5/6.

## Results

Times are wall seconds from `warden dev ios --json` start to the first stdout line (build/install done, Metro up, dev client opened). Dedicated `WARDEN_HOME` per row group (see method).

| # | Scenario | Tier | Wall | CompileC sum | ccache (this run) |
|---|----------|------|------|--------------|-------------------|
| a | cold: no cached build, empty home, wt1 | local build | 400 s | 2866 s | not invoked (0 calls) |
| b | warm, same worktree, app already installed | installed | 4 s | - | - |
| b2 | same, app uninstalled first | cache | 2 s | - | - |
| c | worktree 2, same fingerprint, app uninstalled | cache (shared) | 6 s | - | - |
| d | worktree 2, native change (new Info.plist key; fingerprint changed) | local build | 229 s | 1259 s | not invoked (0 calls) |
| e1 | as (a) with `CCACHE_BINARY` fixed, fresh home2, wt1 | local build | 227 s | 1229 s | 545 calls, 0 hits (cold) |
| e2 | as (d) with fix, same ccache as e1, wt2 | local build | 215 s | 1230 s | 545 calls, **0 hits (0%)** |
| e3 | wt2 rebuilt from empty DerivedData, ccache from e2 | local build | 162 s | ~0 (no CompileC in timing) | 545 calls, **545 hits (100%, direct)** |

Fingerprints: original `88824ffa...`, native change `b16ea1a9...` (wt2 `app.config.ts` `ios.infoPlist.NSCameraUsageDescription` added).
Xcode compilation cache: 28 KB before and after every row (inactive, see finding 3).

Other timing (e1, `-showBuildTimingSummary`): SwiftCompile 113 s, PhaseScriptExecution ~50-68 s, SwiftEmitModule ~19-57 s. Swift (122 tasks, not cached by ccache) bounds the floor: e3 at 162 s is ccache's best case, only ~30% below a no-ccache build, because Swift compile + prebuild/pod install + link remain.

## Method

- warden run from source: `bun apps/cli/src/cli.ts dev ios --udid <udid> --json` in `apps/example` (no `cli:link`).
- Sim claimed once with `warden claim ios --json --label priv0 --ttl 4h` in the real home (lease `l_b666ac978399`), udid passed with `--udid`; released by id afterwards. Mac kept awake with `caffeinate -dimsu`.
- Dedicated temp `WARDEN_HOME` (own `warden.db`, `builds/`, `ccache/`) so the user's real cache was untouched: `home` for a-d, `home2` for e1/e2, `home3` (copy of `home2/ccache`) for e3.
- Worktree 1 = this checkout; worktree 2 = second `git worktree` of the same commit (same remote -> same project key `github.com/delacournz/warden:apps/example`).
- Before (b2, c, d, e) the app was `simctl uninstall`ed from the leased sim so the "installed" tier did not short-circuit. Before e1 and e3 the matching `DerivedData/wardenexample-*` dirs (mine only) were deleted to force a real compile.
- `xcodebuild` wrapped by a PATH shim appending `-showBuildTimingSummary` and logging its env; ccache stats via `ccache --print-stats` / `--show-stats -v` with `CCACHE_DIR=<home>/ccache` before and after.
- Root-cause probes: temporary `echo` line in the worktree's `node_modules/react-native/scripts/xcode/ccache-clang.sh` (reverted); `xcodebuild -scheme EXJSONUtils clean build` with/without `CCACHE_BINARY` and `COMPILATION_CACHE_ENABLE_CACHING=YES` as env vs arg; diff of the CompileC argv for `NSDictionary+EXJSONUtils.m` between wt1 and wt2.

## Caveats

- Wall times are not controlled: other agents were building on the machine. Rows a vs e1 are the same work (no ccache effect) yet CompileC sum was 2866 s vs 1229 s, so compare a only loosely; e1/e2/e3 ran back to back.
- Single run per row, no repeats.
- Row d and e2 change only an Info.plist key, so the compile work is identical to a; a real native dep change would rebuild more.
- Pods (545 CompileC) dominate; the app target is tiny.

## Raw ccache stats (cumulative per home, after each run)

```
e1  (home2): Cacheable 545/547   Hits 0/545      Misses 545    (cold)
e2  (home2): Cacheable 1090/1094 Hits 0/1090     Misses 1090   (+545 calls, 0 hits: other worktree)
e3  (home3): Cacheable 1635/1641 Hits 545/1635   Misses 1090   (+545 calls, 545 direct hits: same path)
a, d (home): ccache dir never created; default ~/Library/Caches/ccache untouched since 2026-10-17
```

## Inputs for PRIV-5 / PRIV-6

- PRIV-6 reporting must treat "ccache calls = 0" as a first-class outcome, otherwise the stat looks like a miss rather than a broken setup.
- Set `CCACHE_BINARY` in `compilerCacheEnv` (and check `ccache` exists), pass `COMPILATION_CACHE_ENABLE_CACHING=YES` as an xcodebuild setting, then re-run this bench.
- Make compiler args independent of the workspace-hashed DerivedData path so cross-worktree ccache can hit (currently 0%).
- Raw per-run logs were kept in the agent scratchpad (`out/*.xcodebuild.log`, `*.ccache.*`), not committed (40k lines each).

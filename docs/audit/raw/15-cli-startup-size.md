# Audit 15 · cli-startup-size

Method note: no compiled binary exists here, so start-up numbers are source mode (`bun apps/cli/src/cli.ts`, one process, other agents running: treat ms as +-15 %). Bundle sizes come from `bun build` into the scratchpad (`--target=bun`, `--outdir`), which is the same bundler `--compile` uses. I accidentally wrote `apps/cli/src/cli-sm.js{,.map}` once (a `--sourcemap=linked` build with `--outfile`); the coordinator flagged it and I deleted both files, `git status` is clean.

## Top 5 by impact
1. 15-1 `typescript` rides in the compiled binary for one rarely used subcommand: 27.9 MB (24 %) of the 116 MB binary (measured payload).
2. 15-2 `run` / `dev` / `app` (and `lease-session` users) load zod through `ensure.ts` and `dev.ts`: +95 modules, +12.6 MB RSS, roughly 25-50 ms per call (K4).
3. 15-4 The npm node shim uses `spawnSync` and never forwards signals: a SIGTERM to the shim pid orphans a running `warden run` child and its leases.
4. 15-3 `startup.test.ts` guards no allowlist for `run`/`dev`/`app`/`hook`/`ls`/`devices`/`check`/`port`; the K4 regression is unguarded.
5. 15-5 Root `--help` and `help <cmd>` import all 28 commands (286 modules, ~54 MB RSS source mode).

## Findings

### 15-1 `typescript` is bundled into every binary for `__affected-graph` only
- Category: perf-ram (size, K3)
- Severity: P1
- Known?: known-extended K3
- Evidence: `packages/core/src/affected/graph.ts:29@dfcc68b` does `await import("typescript")`; `graph.ts:3` is type-only. It uses `ts.sys`, `getParsedCommandLineOfConfigFile`, `createModuleResolutionCache`, `preProcessFile`, `resolveModuleName` (graph.ts:141-191), i.e. tsconfig parsing and module resolution only. `apps/cli/src/commands/affected-graph.ts:36@dfcc68b` imports `graph-worker` dynamically, but a compile bundles every dynamic import with a literal. `apps/cli/src/update/source-build.ts:202-217@dfcc68b` has no `--external`. Measured with `bun build --target=bun --minify --bytecode --sourcemap=linked apps/cli/src/cli.ts --outdir <scratch>` (415 modules): js 4.63 MB + jsc 14.59 MB + map 16.63 MB = 35.8 MB. With `--external typescript` (401 modules): 0.94 + 3.57 + 3.42 = 7.9 MB. Bun 1.4.2 itself is 79.5 MB, 79.5 + 35.8 = 115.3 MB, which matches the reported 116 MB.
- Impact: measured, -27.9 MB (-24 %) on a 116 MB binary, on every platform; also shrinks the four npm platform tarballs and the `warden update` download. RSS effect unknown (embedded bytecode/map may be paged lazily): needs a compiled-binary measurement. Also removes the 13.2 MB of TS source map.
- Proposed fix: add `--external typescript` to `compileArgs`; in `graph.ts` `loadTs()` resolve typescript from the analysed project (`createRequire(join(repoRoot, "package.json"))("typescript")`), fall back to bare `import("typescript")` (source mode), and if neither resolves return a clear warning so `affected` runs all flows (the existing `warning` channel in `graph-process.ts`). Alternative: ship `graph-worker.js` as a separate asset in the platform package. Files: `apps/cli/src/update/source-build.ts`, `packages/core/src/affected/graph.ts`, `source-build.test.ts`. Additive.
- Effort: M
- Risk: Expo/RN projects nearly always have `typescript`; a project without it loses diff mode (degrades to all flows). `source-build.test.ts` bundles cli.ts and must still pass. Needs a compiled binary run of `warden affected` to verify.
- How to verify: `bun build --compile` both ways and compare `ls -l`; `warden version` RSS (`/usr/bin/time -l`); `warden affected` in a fixture project with and without typescript.
- Confidence: high (sizes), med (RSS effect)
- Verified by: ran `bun build` x4 into scratch, read graph.ts, traced affected-graph.ts to graph-worker.

### 15-2 `run`, `dev`, `app` import zod eagerly (K4)
- Category: perf-latency
- Severity: P2
- Known?: known-extended K4
- Evidence: chain `commands/run.ts:6-31` -> `lease-session.ts:12` -> `commands/app.ts:4-5` -> `core/builds/ensure.ts:9-10,22` -> `builds/config.ts:5-6` (`e2eSuiteSchema`, `batchPresetSchema`), `builds/eas.ts:5`, `builds/fingerprint.ts:3` (`z.object({hash})` at :11). `commands/dev.ts:11,95-96` also builds two tiny zod schemas at module top. `ls` -> 25 modules, `run --help` -> 165 modules of which 95 are `/zod/` (probe scripts importing each module: ensure/config/fingerprint/eas/local/lease-session/app/run/project-context all show 95; builds/install and cache show 0). Source mode, 20-run averages: `ls --json` 46-48 ms, `run --help` 98-100 ms, `dev --help` ~100, `app --help` 119; `import "zod"` alone ~26-30 ms over bare bun (4 ms). RSS (Bun resourceUsage maxRSS): `version` 35.8 MB, `ls` 38.2, `run --help` 48.4.
- Impact: measured in source mode, ~12.6 MB RSS and ~25-50 ms on each `run`/`dev`/`app` call (one per agent session or per `warden e2e` worker via `app ensure`); compiled bytecode will shrink the ms but not the RSS ratio. Estimated 25 ms x 1 call per run; not per test.
- Proposed fix: lazy `await import("./config.schema")` etc. at the parse sites: move the zod schemas in `builds/config.ts` into `config.schema.ts` imported inside `loadProject`; `eas.ts` schemas and `fingerprint.ts` `hashJson` parse inside the function via dynamic import (or hand-written `typeof` checks as the wire validators do); `dev.ts` replace the two schemas with `isRecord` checks. Owners: core (builds) agent + me for dev.ts. Additive.
- Effort: M
- Risk: `loadProject` is on the path of every `run --app`; the lazy import moves cost, not removes it, for projects that have a `warden.config`. Pure CPU/RSS win only for commands that never load a config. No device needed.
- How to verify: extend `startup.test.ts` (see 15-3) asserting `/node_modules/zod/` absent for `run --help` and `dev --help`; re-time with the probe above.
- Confidence: high
- Verified by: ran probes per module, traced path from run.ts to ensure.ts to zod.

### 15-3 `startup.test.ts` has no guard for the commands agents call most
- Category: test-gap
- Severity: P2
- Known?: known-extended K4
- Evidence: `apps/cli/src/startup.test.ts@dfcc68b` asserts only `version`, `heartbeat --help`, `claim --help`, `ls --json` (ora/clack only), `gc`, `release`, `batch/e2e --help` (drivers), `ui *`. Nothing for `run`, `dev`, `app`, `hook`, `devices`, `check`, `port`, and no zod/`/packages/e2e/` assertion on `heartbeat`/`claim`/`ls`/`hook`. I measured current module counts: version 26, ls 25, port 29, check 47, devices 47, hook 43, heartbeat 48, claim 51, release 52, run/dev/app 161-165 (zod), e2e 205, batch 192, `--help` 286. `bun test apps/cli/src/startup.test.ts` passes (16 tests, 2 s).
- Impact: not a speed gain by itself; it is what stops `version`-class commands regressing and pins the 15-2 fix.
- Proposed fix: add a table test `{ args, forbid: [zod, ora, clack, /packages/e2e/, typescript] }` for hook, heartbeat, claim, ls, devices, check, port (all currently clean) and, after 15-2, run/dev/app. Test-only, additive.
- Effort: S
- Risk: none
- How to verify: `bun test apps/cli/src/startup.test.ts`
- Confidence: high
- Verified by: ran bun test; module lists via a preload script.

### 15-4 npm shim: `spawnSync`, no signal forwarding
- Category: robustness
- Severity: P2
- Known?: new
- Evidence: `apps/cli/src/npm/shim-main.ts:35-42@dfcc68b` runs `spawnSync(binary, argv, {stdio:"inherit"})`. spawnSync blocks the event loop, so no `process.on("SIGTERM"/"SIGHUP")` handler can run; the default action kills node and leaves the compiled child running. Ctrl-C at a terminal is fine (process-group SIGINT) but `kill <pid>` of the shim (an agent harness stopping `npx @delacour/warden run -- ...`, a timeout wrapper) leaves `warden run` alive, so the lease heartbeat keeps going and the device stays held until the child's own exit. It also holds a ~40 MB node process plus node's ~40 ms boot for the whole run on npm installs (estimated, not measured here).
- Impact: correctness of lease release on kill; plus fixed node boot + RSS per npm-installed call (hooks/heartbeat).
- Proposed fix: `spawn` (async) with `stdio:"inherit"`, forward SIGINT/SIGTERM/SIGHUP to the child, exit with the child's code or re-raise its signal; or `exec` semantic via `process.binding`-free approach is not available in node, so async spawn it is. Files: `shim-main.ts`, `shim.test.ts` (only `locateBinary` tested today). Also document that `warden install` should link the binary directly (AGENTS says it does for global installs) so hooks avoid the shim. Additive.
- Effort: S
- Risk: low; test on linux/mac with a sleeping child.
- How to verify: script: shim -> `run -- sleep 60`, `kill -TERM <shim>`, assert no `sleep` and no lease remain.
- Confidence: med (reasoned from node semantics; not executed, no npm package here)
- Verified by: read.

### 15-5 Root `--help`, `help <cmd>` and unknown commands load all 28 commands
- Category: perf-latency
- Severity: P3
- Known?: new
- Evidence: `apps/cli/src/command.ts:411-420@dfcc68b` (`runLazyProgram` loads every entry when there is no target); `startup.test.ts:61-63` pins it as intended. Measured source mode: `--help` 286 modules, ~156 ms, 54.4 MB vs `version` 46-53 ms, 35.8 MB. `help claim` goes through the same branch (first arg `help` is not an entry).
- Impact: ~100 ms once per human `--help`; agents that run `warden help <cmd>` pay the same. Low frequency.
- Proposed fix: for `help <cmd>` load only `<cmd>` and rewrite argv to `<cmd> --help`; for root help generate the argument placeholders into `registry.ts` (test-pinned like `registry.test.ts`). Additive, but `help.test.ts` snapshots must be reviewed, not regenerated blindly.
- Effort: M
- Risk: help snapshot drift
- How to verify: `help.test.ts`, `registry.test.ts`
- Confidence: high
- Verified by: ran timing/RSS probes.

### 15-6 `native/scripts/deps.ts`: download has no timeout, `--from-source` is not idempotent, swap is not atomic
- Category: robustness
- Severity: P3
- Known?: new
- Evidence: `packages/e2e/native/scripts/deps.ts:78@dfcc68b` `fetchImpl(url)` with no `AbortSignal`: a stalled GitHub download hangs a CI job to the runner limit. `deps.ts:185-202` `buildFromSource` never reads the stamp (`readStamp` is used only by `installLibraries`, :124), so a second `--from-source` re-runs `build.sh build libraries` (minutes) even when `.warden-idb.json` says `source` + same version, contradicting the header "Idempotent" (:9). `deps.ts:106-116` `swapIn` does `rm(dest)` then `rename(staged,dest)`: between them `native/idb-libraries` does not exist (a concurrent `swift build` fails with a missing Package.swift), and two parallel runs can hit ENOTEMPTY. `.staging-<pid>` dirs of a killed run are never reaped. `deps.ts:11-12`/lock hard-codes the `macos-arm64` tarball with no arch check, so an x64 runner fails later in `swift build` with an opaque linker error.
- Impact: CI/dev robustness only; no runtime effect.
- Proposed fix: `AbortSignal.timeout(120_000)`; early return in `buildFromSource` when the stamp is `source` at the lock version and `layoutProblem` is empty (flag `--force`); rename `dest` to `dest.old-<pid>` then rename staged in, then rm old; reap `*.staging-*` older than a day; fail fast with `process.arch !== "arm64"`. Additive.
- Effort: S
- Risk: low; `deps.test.ts` covers the pure parts, add stamp/early-return cases.
- How to verify: `bun test packages/e2e/native/scripts/deps.test.ts`; on a mac, run `deps --from-source` twice and time the second.
- Confidence: high
- Verified by: read.

### 15-7 Published e2e bundle is unminified and loads zod at import
- Category: perf-latency
- Severity: P3
- Known?: new
- Evidence: `apps/cli/src/npm/e2e-bundle.ts:15-24@dfcc68b` sets no `minify`. I built it to scratch: `index.mjs` 30 KB, `chunk` 147 KB, `preload.mjs` 210 KB (includes the ~33 KB dex base64 once), so a spec process parses ~390 KB of JS plus `zod` (`E2E_EXTERNALS`, 7 `import { z }` sites in the chunk). Per spec process zod costs ~26-30 ms source-mode (probe above). Dex base64 is also compiled into the CLI binary through the Android driver (~33 KB, negligible).
- Impact: estimated 5-10 ms for parsing the unminified bundle plus ~28 ms zod per spec process if zod is only needed on error/health paths; 8 tests/rep share one process per spec file, so small. Not worth more than a low-priority look; owner of `packages/e2e` (uiad-protocol) decides on zod.
- Proposed fix: `minify: { whitespace: true, syntax: true }` in `bundleE2e` (keep identifiers for readable stacks); `e2e-bundle.test.ts` string checks still hold for the dex. Additive.
- Effort: S
- Risk: low
- How to verify: `bun test apps/cli/src/npm/e2e-bundle.test.ts`; time `bun -e 'import "<out>/index.mjs"'`.
- Confidence: med
- Verified by: ran Bun.build via `e2e-bundle-main.ts` into scratch.

## Known items
- K3: extended. 116 MB = bun 79.5 MB + 35.8 MB payload; typescript is 27.9 MB of that (15-1). Compiled `version` RSS 57 MB not reproducible here (source mode 35.8 MB).
- K4: extended. Exact import chain and cost (15-2); guard missing (15-3).
- Verified landed: lazy ora/clack (`ui.ts:18-19`, test passes), per-command lazy load (`command.ts:411`), `version` = 26 modules and no zod/e2e, gc/release/ui guards green, `compileArgs` has `--minify --bytecode --sourcemap=linked`, `scripts/build.ts` removes the stray map, no top-level await in cli.ts.

## Gaps I could not assess here
- Compiled binary cold start/RSS for `version` and `run --help`, with and without `--external typescript` and with `--sourcemap=none`: `bun scripts/build.ts` on a mac, then `/usr/bin/time -l ./dist/warden version` x20.
- Whether embedded sourcemap (16.6 MB) or bytecode counts toward RSS at start.
- npm shim signal behaviour (15-4) and node boot cost: `npx` install on a mac.
- `build:release` cross-target compiles (4 sequential `bun build --compile`, `scripts/build.ts:44-51`, each downloads its target runtime): CI wall time, could parallelise.

## Owned files not read
`apps/cli/src/{device-state,lease-select,running-apps,testing,simctl.testing,skill-cli,install-flags,project-context}.ts` beyond the import lines; `commands/{check,ls,devices,port,release,version(partly)}.ts` bodies (only their module lists measured); `npm/{declarations,config-entry,helper.testing}.ts` bodies and most `*.test.ts`; `scripts/{link,helper-asset(read),bench-flow-poller}.ts`. The skill embedding (`skill.ts`, 50 KB of markdown) was read and is negligible.

## Questions for the user
1. Is it acceptable that `warden affected` needs `typescript` installed in the analysed project (15-1), or must the binary stay self-contained?

## Files read
BRIEF.md, ASSIGN-15.md, apps/cli/AGENTS.md, apps/cli/src/{cli,command,context,ui,output,spinner-context,bounded,providers,golden-deps,skill,startup.test}.ts, commands/{registry,heartbeat,affected-graph,run(imports),dev(imports),app(imports)}.ts, update/{source-build,build-info}.ts, scripts/{build,npm-packages,helper-asset}.ts, npm/{e2e-bundle,e2e-bundle-main,e2e-stage,e2e-bundle.test,manifests,platforms,shim,shim-main,helper,helper-stage,helper-asset}.ts, packages/core/src/affected/{graph,graph-worker,graph-process}.ts, builds import heads, packages/e2e/native/scripts/{deps,build}.ts, docs/plans/wdn-perf.md (grep).

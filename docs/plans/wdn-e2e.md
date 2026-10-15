# WDN-E2E — `@delacour/warden-e2e`: warden's own mobile e2e stack

Plan ID: **WDN-E2E** · Base: this worktree's branch `feature/faster-local-e2e-runner`, rebased onto `origin/main` @ `b43e121` (PR #22) on 2026-10-15 · Copy this file to `docs/plans/wdn-e2e.md` in phase D1 (repo convention).

## What PR #22 (`b43e121`, squash of 9 changes) means for this plan

Generic infrastructure to **keep and integrate** (do not rewrite): log stamping (`apps/cli/src/batch/stamp-lines.ts`, `stamped-log.ts`, `WARDEN_LOG_TIMESTAMPS=1` → runners print no clock), the TUI (`batch/tui.ts`: `FlowMark`, `TrackedFlow`, `RunnerReport` type, `applyFlowMarks`, `applyRunnerReport`, `Display.flows`/`Display.report`, the 1 s `flowPoller` seam), headless (`packages/core/src/headless.ts`, `apps/cli/src/sim-windows.ts` `hideSimWindows` + `DetachOnWindowClose`, `WARDEN_HEADLESS`, `headless` report fields), `installMode: "clean"|"reinstall"` + `resetKeychain` (`packages/core/src/builds/install.ts` `resetAppData`/`resetIos`/`resetSimKeychain`, `app-option.schema.ts`, `apps/cli/src/install-flags.ts`), `onLeased`/`leasedProgress` (`lease-session.ts`), concurrent shutdown, `apps/example/e2e/helpers/launch.ts`.

Coupled to agent-device / tester.army, to **retarget or delete** (tracked in T7/T8/T10/T11 below): `batch/warm-runners.ts` (+ `warmPools`, `WARM_TIMEOUT_MS`, `BatchDeps.agentDeviceBin`, `SessionHooks.warmRunners`, suite `warmRunners`, `WARDEN_AGENT_SESSION`, `AGENT_DEVICE_STATE_DIR`/`{stateDir}` incl. the `runEnv` strip) → becomes `warmDrivers` (see Decision 7); the `✓/❯/×` line parser `flowMarks()` in `batch/flow-progress.ts` → `results.jsonl` reader; `runnerReport()`/`reportOutputDir()` in `batch/runner-report.ts` (tester.army `report.json`, `--output`/`.e2e`) → `results.jsonl` reader feeding both the TUI and per-flow verdicts; example `e2e.config.ts`, `e2e/helpers/{timestamps,flows}.ts`, `runner` argv, devDependencies; docs lines in `guides/run-e2e.mdx` (32, 80, 83), `guides/headless.mdx` (16–17 drive path), `guides/e2e.mdx` (65), `guides/affected-e2e.mdx` (14), `reference/configuration.mdx` (170, 201), `reference/cli.mdx` (89, 139), `skills/warden/SKILL.md` (30, 50–56), README (220–222); `reference/environment.mdx` also lacks `WARDEN_LOG_TIMESTAMPS`.

Headless implication for the driver: a headless sim has no Simulator.app window at all and `hideSimWindows` may reboot a device; the host-side HID/AX driver never depends on Simulator.app (CoreSimulator HID, in-sim AX bridge, framebuffer screenshots), and warden starts helpers only **after** the hide step (order stays setup → openOnDevices → hide → warm → jobs).

## Context

Today `warden e2e` only leases devices, installs the build, starts Metro and spawns a foreign runner: tester.army `e2e` + `@e2e-dev/mobile`, which drive the simulator through callstack `agent-device`. That stack is slow: agent-device installs and starts an XCUITest runner app on the simulator (`xcodebuild test-without-building`, ~20 s per session, ~170 MB DerivedData per Xcode/runtime), keeps a detached daemon, and every flow pays the warm-up again. Argent is faster (host-side HID binary + an in-sim AX service) but its daemon/tool-server is slow and its binaries are closed source.

Goal: replace all three with **`@delacour/warden-e2e`**, a warden-owned package that (1) lets tests be written as TypeScript spec files with `test`/`expect`/`screen`/`device`/`app`, (2) lets warden drive iOS simulators and Android emulators itself with no app installed on the device and no daemon, and (3) gives agents an `agent-device`-style CLI (`warden ui …`) on the same driver. Scope: React Native / Expo apps only, iOS first-class, Android via adb.

Best-of-three mix: argent's host driver + in-sim AX bridge + RN devtools facet + flows; agent-device's `snapshot -i` / `@refs` / selectors / `--settle` diff; tester.army's spec API, locators, polling matchers, report + failure artifacts.

## Decisions (made with the user on 2026-10-15)

| # | Decision | Why |
|---|---|---|
| 1 | **iOS driver = own Swift helper `warden-simd`** linking idb's MIT `FBControlCore` / `FBSimulatorControl` / `FBSimulatorAX` via idb's **library package** (`idb-libraries.macos-arm64.tar.gz`, pinned tag, sha256 in `native/idb.lock.json`; git submodule `packages/e2e/native/idb` at the same tag for `--from-source` builds/patches). | Host-side HID (Indigo on Xcode 26, DTUHID on Xcode 27, negotiated by idb) and AX via the pre-built, pre-signed in-sim `SimulatorFrameworkBridge-iOS` guest (whole tree in one round trip, ~30 ms warm, spawned by `SimDevice.spawn`, shared across processes, idle-exits) with host-side `AccessibilityPlatformTranslation` (`ax`) as fallback. No runner app, no daemon. Same technique argent and idb use. |
| 2 | **Spec runner = `bun test` + preload.** `@delacour/warden-e2e` exports `test`/`describe`/hooks/`expect` wrapping `bun:test`. | Timeouts, `-t`, `--bail`, junit reporter for free; bun is the repo runtime; warden already requires it for `warden.config.ts`. |
| 3 | **v1 scope**: iOS driver, spec API, `warden e2e` built-in runner, example-app migration, **plus** Android driver (adb + uiautomator, no instrumentation APK), `warden ui` agent CLI, RN Metro/Hermes CDP facet (logs/network/eval/React tree), recorded flows (`.flow.json`) with replay + export to `*.e2e.ts`. | User's choice. |
| 4 | Driver code lives in `packages/e2e/src/driver/` (not core); the CLI imports `@delacour/warden-e2e/driver/*` from the workspace; the npm package bundles it. Core stays leases/providers/builds. | Keeps the private-API surface in one package; core remains free of UI automation. |
| 5 | `warden-simd` ships **inside `@delacour/warden-darwin-arm64/bin/`** next to `warden` (binary + `Resources/SimulatorFrameworkBridge-iOS` + two tiny stub frameworks), ad-hoc signed, no hardened runtime (same posture as brew `idb_companion`). **darwin-x64 gets no helper in v1** (idb ships arm64 only). | Already-published platform packages; `cp -R` of a dir. |
| 6 | `warden ui` enforces leases **in-process on every call** (owner stable via `CLAUDE_CODE_SESSION_ID`), refuses unleased/foreign devices unless `--claim`; no new PreToolUse matcher. **Argent compat is removed in A12**: `ARGENT_MATCHER`, `patchArgentRules`, the `argent-rules` install step and their tests go; the PreToolUse hook keeps only SessionEnd + any non-argent MCP matchers. | Stronger than a hook; the stated pain was daemons and stolen devices. |
| 7 | Helper lifecycle: one `warden-simd --socket $WARDEN_HOME/simd/<udid>.sock --idle-timeout 10m` per device, spawn-on-demand arbitrated under `store.transaction` (no lockfiles). **`warden e2e`/`batch` pre-warm it** in the slot PR #22 used for agent-device (`warmDrivers` suite option, default true, replaces `warmRunners`): after `hideSimWindows`, for every leased iOS device in parallel, spawn the socket helper and take one snapshot so the in-sim AX bridge guest is resident; jobs get `WARDEN_SIMD_SOCKET=<path>`. Spec workers connect to that socket (ms) and fall back to spawning on **stdio** when unset (by-hand runs). `warden ui` uses the same socket. | Daemon-free, warm **between flows** (the per-flow mode pays nothing per job), warm between agent calls. Helper starts after the hide step so a headless reboot never severs it. |
| 8 | Ops that stay on `xcrun simctl` / `adb` in TS: launch/terminate/openurl/install/uninstall/privacy/keychain/push/pbcopy/appearance/status_bar/recordVideo. Helper does only what simctl cannot: AX snapshot/hitTest, HID, fast screenshot, orientation, quiescence, lock/shake. | Minimise private-API surface; these are public, off the hot path, already have `fakeExec` fixtures. |
| 9 | **Custom `runner` argv is removed now.** The built-in bun runner is the only runner; `mode: "single"` = one `bun test` process **per device**, flows round-robin sharded. New `spec` block replaces `runner`; `{flow} {flowPath} {flows} {flowPaths} {stateDir}` placeholders, `runnerArgv`/`singleRunnerArgv`, `AGENT_DEVICE_STATE_DIR` and the `runIssues` placeholder rules are deleted; a config that still sets `runner` fails validation with a migration message. | bun runs files serially in one process; per-device sharding keeps parallelism; no escape hatch to maintain. |
| 10 | Verdicts and **live progress** come from `results.jsonl` written by the spec process (per test): the existing 1 s `flowPoller` reads it instead of scraping `✓/❯` log lines, `applyFlowMarks`/`applyRunnerReport` and the TUI stay as they are, and `e2e-report.json` gets real per-flow verdicts in `single` mode too. Exit code is the fallback only. | Today exit-code-only + log scraping; structured results are the point of owning the runner. |
| 13 | The spec runner's console output follows PR #22's log convention: `▶ test |ios| <file> › <title>` / `■ … <status> <N.NN>s on <device>` / `▸`/`▪` per step (`trace.jsonl` events mirrored to stdout), no clock of its own when `WARDEN_LOG_TIMESTAMPS=1`. `app.clearData()` / `app.reinstall()` reuse core `resetAppData` / install (`builds/install.ts`), honouring `resetKeychain`. | Keeps stamped logs and the documented log format; no second data-wipe implementation. |
| 11 | Network facet = JS `fetch` interceptor via `Runtime.evaluate` (not CDP `Network.*`, flag-gated on RN 0.8x); console = `Runtime.consoleAPICalled`; React tree = fiber walk over `__REACT_DEVTOOLS_GLOBAL_HOOK__` (argent's approach, reimplemented from its Apache JS, no binaries). Dev-client builds only. | Deterministic on RN 0.86 / Expo 57. |
| 12 | Flows: `.flow.json` stores **resolved selectors** (never `@refs`), replay never rewrites the file, YAML import not in v1. | Determinism; argent/maestro YAML semantics are runner-bound. |

## Architecture

```
*.e2e.ts ──import──▶ @delacour/warden-e2e (test/expect/screen/device/app)
                         │ Session (env WARDEN_*) ── Driver (iOS | Android)
                         │                             ├─ iOS: warden-simd (stdio/socket NDJSON) + xcrun simctl
                         │                             └─ Android: persistent `adb shell` + uiautomator dump + input
                         └ devtools (Metro /json/list → Hermes CDP): eval, console, fetch log, React tree
warden e2e ──spawns──▶ bun test --preload @delacour/warden-e2e/preload <abs flow paths>   (env below)
warden ui  ──uses────▶ Driver via socket helper; refs in $WARDEN_HOME/ui/<udid>/last-snapshot.json
```

### Repo layout (new / touched)

```
packages/e2e/                                   @delacour/warden-e2e (workspace private; npm manifest generated)
  package.json  tsconfig.json  biome.jsonc      exports "./*": "./src/*.ts"; scripts fmt lint check typecheck test native:deps native:build native:smoke
  native/
    idb/                                        git submodule facebook/idb @ pinned tag (same as idb.lock.json)
    idb.lock.json                               { version, tarball, sha256 }
    idb-libraries/  dist/                       gitignored (deps output / build output)
    ios/Package.swift  Sources/warden-simd/{main,Protocol/{Wire,NDJSON},Server/{Stdio,Socket,Dispatcher},Device/Session,Ops/{Snapshot,Input,Keyboard,Screenshot,Settle,Health},Model/Element}.swift
    ios/Tests/warden-simdTests/                 XCTest: codec, keyboard map, role map, document→model fixtures (no simulator)
    scripts/{deps,build,smoke,fake-simd}.ts
  src/
    index.ts  preload.ts  env.ts  session.ts  errors.ts
    driver/{driver.types,errors,refs,settle,open}.ts
    driver/ios/{locate-helper,simd-client,simd-protocol,simctl,ios-driver}.ts
    driver/android/{adb-session,uiautomator,android-driver}.ts
    driver/driver.testing.ts                    FakeDriver (scripted snapshots, recorded calls, fake clock)
    runner/{test,scope,fixtures,attempt,results,artifacts}.ts
    screen/{locator,query,nodes,roles,text,actions,poll,render,selector}.ts   (render/selector shared with warden ui)
    expect/{expect,matchers}.ts   app.ts  device.ts
    devtools/{metro,inspector,cdp,session,console,network,tree,collector}.ts
    flows/{flow.schema,record,replay,export}.ts (+ export.golden/)
apps/cli/src/commands/ui.ts  apps/cli/src/agent-ui/{device,output,helper,snapshot,refs,target,actions,query,record,devtools-cli,bench}.ts
apps/cli/src/device-lease.ts                    ensureCallerLease (factored from hooks/claude-pretool.ts) + releaseDevices() choke point
apps/cli/src/e2e/{bun-runner,launch,verdicts}.ts
apps/cli/src/npm/{manifests,declarations}.ts  apps/cli/scripts/npm-packages.ts  .github/workflows/{release,ci}.yml
packages/core/src/affected/affected.schema.ts  packages/core/src/builds/define-config.ts  packages/core/src/sims/slim.ts
apps/example/{package.json,warden.config.ts,e2e/**,AGENTS.md}   (e2e.config.ts deleted)
apps/docs/content/docs/{guides/e2e,guides/run-e2e,guides/agents,guides/agent-ui(new),reference/{cli,configuration,environment,e2e-driver(new)}}.mdx  README.md  skills/warden/SKILL.md  AGENTS.md
```

## `warden-simd` protocol (v1)

Invocation: `warden-simd --udid <UDID> [--socket <path> [--idle-timeout <s>]] [--hid indigo|dtuhid] [--ax axbridge|ax] [--resources <dir>] [--log <file>]`; `--version`, `--health --udid X` one-shot. Exit 0 ok / 2 args / 3 device-bootstrap (after `fatal` event) / 4 internal.

NDJSON, one object per line: request `{"id","op",…,"timeoutMs"?}`; response `{"id","ok":true,"data"}` or `{"id","ok":false,"error":{"code","message","retryable","detail"?}}`; events `{"event":"ready",protocol:1,version,udid,hid:{transport},ax:{default,bridge},screen:{width,height,scale}}`, `{"event":"log",level,message,op?,id?}`, `{"event":"fatal",error}`. Responses may be out of order; HID ops are serialised. `unit: "pt"` (default, portrait-up points = AX frame space) or `"norm"`.

Ops: `health` · `snapshot{interactiveOnly?,backend?,keys?,maxDepth?,maxNodes?}` → `{backend,screen,modal?,truncated,elements,ms}` (axbridge default, per-request fallback to `ax` on `bridgeUnavailable`/`applicationUnavailable`/`applicationNotResponding`; `log` event on fallback) · `elementAtPoint{x,y,reachability?}` · `alertButtons` (derived; `ax` first since it sees SpringBoard UI) · `tap{x,y,count?,durationMs?}` · `longPress` · `swipe{from,to,durationMs?,momentum?}` (`momentum:false` = eased composite + 150 ms hold) · `drag` · `pinch` · `pressButton{home|lock|side|siri|volumeUp|volumeDown|applePay|shake}` · `key{usage,modifiers?}` · `typeText{text}` (own ASCII→USB-usage map with Shift; stops at first unmappable char → `E_UNSUPPORTED_TEXT{rest}`; TS falls back to `simctl pbcopy` + `paste`) · `paste` · `screenshot{scale?,path?}` · `orientation{set?}` · `settle{quietMs,timeoutMs}` (axbridge quiescence stream `run_loop_idle`+`animations_inactive`; `E_UNSUPPORTED` on `ax` → TS hash polling) · `shutdown`.

Error codes: `E_BAD_REQUEST E_TIMEOUT E_NOT_BOOTED E_UNKNOWN_UDID E_HID E_AX_UNAVAILABLE E_APP_UNAVAILABLE E_APP_NOT_RESPONDING E_NO_ELEMENT E_UNSUPPORTED E_UNSUPPORTED_TEXT E_IO E_INTERNAL` (+ TS-side `E_HELPER_MISSING E_HELPER_CRASHED E_STALE_REF`).

Normalized `Element` (shared with Android): `{ id, role, rawType, label?, identifier?(testID), value?, text?, placeholder?, frame{x,y,width,height}, normFrame, traits[], enabled, focused?, hidden?, selected?, checked?, hittable?, tapPoint?, pid?, depth, children[] }`. Role map: XCUI type → `button|text|textfield|securefield|searchfield|image|switch|slider|link|cell|list|scrollview|tab|tabbar|alert|sheet|keyboard|navbar|toolbar|window|application|other`; trait `button` upgrades `Other`. Android: class → role, `resource-id` (pkg prefix stripped) → identifier, `content-desc` → label, `bounds` → frame, flags → traits.

Key idb calls (verify names in the submodule when implementing): `SimulatorControlBootstrap.withConfiguration` → `set.simulator(withUDID:)`; `sim.hid.connect()` / `SimulatorHID(for:transport:)`, `SimulatorHIDEvent.tapAt/swipe/drag/pinchAt/shortButtonPress/shortKeyPress/keyboard/delay/composite`, `hid.send(event:logger:drain:.perEvent)`; `sim.uiAutomation(backend: .axBridge(persistence: .shared, automationMode: true))` and `.accessibility`; `describe(.frontmost, options{format:.complete, filter:.interactable|.all, keys})`, `hitTest(at:)`, `quiescence(.frontmost, parameters:)`; `SimulatorScreenshotCommands(simulator:).take`; `sim.orientation`, `sim.hardware.lock/shake`; `BundledResources.hostDirectoryPath` for the guest. Helper lookup (TS): `WARDEN_SIMD` (file) → `WARDEN_HELPER_DIR` → dir of `realpath(process.execPath)` → `packages/e2e/native/dist` (source) → `$WARDEN_HOME/simd/<warden version>/` → `E_HELPER_MISSING` with `warden doctor` hint.

## Android driver (TS only, v1)

One `adb -s <serial> shell` process per driver (commands + `echo "__WDN_<id>_$?__"` sentinel, FIFO, respawn once). Snapshot: `uiautomator dump /dev/stdout` (fallback `/sdcard` file) → hand-written XML walker → `Element`; `interactiveOnly` keeps clickable/long-clickable/checkable/scrollable/EditText + ancestors. Input: `input tap|swipe|keyevent|text` (ASCII only, quoted; else `E_UNSUPPORTED_TEXT`); pinch `E_UNSUPPORTED`. App: `am start -a VIEW -d`, `monkey -p <pkg> 1`/`am start -n`, `am force-stop`, `pm clear`, host `adb install -r`. Alerts: `android:id/button1|2|3`, permission-controller allow button. Settle: hash polling (`settle.ts`). Screenshot: reuse `batch/screenshot.ts` argv. At open: `getprop sys.boot_completed`, animations off (`settings put global *_animation_scale 0`). Expected: tap ~60–120 ms, dump 300–900 ms. Later accelerator (not v1): 30 KB instrumentation APK behind the same `Driver`.

## Public spec API (`@delacour/warden-e2e`)

```ts
import { test, describe, beforeEach, afterEach, beforeAll, afterAll, expect, E2eError } from "@delacour/warden-e2e";
test("title", { timeout?, skip?, only?, platforms?, retry? }, async ({ app, device, screen, platform }) => { … });
test.use({ timeout?, actionTimeout?, assertionTimeout?, launch?: "fresh"|"none" }); test.extend<Extra>({ fixture: async (base, use) => … }); test.skip/skipIf/only/todo; describe(title, { serial? }, body)
screen.getByTestId(id) | getByText(t,{exact?,visible?}) | getByLabel | getByPlaceholder | getByRole(role, name?, {checked?,disabled?,selected?}) | getByValue | locator("id=x role=button") | tapAt({x,y}) | swipe({direction|from,to}) | scrollUntilVisible(locator,{direction?,maxSwipes?})
locator.filter({hasText?,has?}).first()/last()/nth(i); .tap({position?}) .longPress({durationMs?}) .fill(text) (verifies value, retries once; secure fields skip verify) .type(text) .clear() .press("Enter"|…) .swipe() .scrollTo()
locator.text() value() count() all() allTexts() isVisible() isHidden() isEnabled() isChecked() boundingBox() waitFor({state,timeout})   // reads never wait; text() falls back to descendant text (iOS empty-container case)
expect(locator).toBeVisible/toBeHidden/toHaveText(t,{exact?})/toContainText/toHaveValue/toBeChecked({checked?})/toHaveCount(n)/toBeEnabled/toBeDisabled ({timeout}) · .not · expect.soft(locator)   // poll 100 ms, default 5 s; non-locator expect = bun's
app.open({url?,args?,env?}) close() restart() reinstall() clearData() isRunning()
device.alert("accept"|"dismiss"|{button}) → boolean · openLink(url,{accept?}) (iOS auto-accepts "Open in…?") · home() back() orientation() appearance() clipboard()/setClipboard() hideKeyboard() · screenshot(name) · snapshot({interactiveOnly?}) (text tree) · settle({quietMs?,timeout?}) · devtools (dev client: evaluate(expr), reloadJs(), console, network, tree)
```

Semantics kept from `@e2e-dev/mobile`: `text`/`label` queries answer innermost match only (iOS repeats RN Text labels on parents); role queries and `visible:true` drop hidden nodes; actions/reads require exactly one match (`LOCATOR_NOT_FOUND` / `LOCATOR_AMBIGUOUS`); `count/isVisible` never wait. `expect` is a **wrapper** around bun's (not `expect.extend`): `isLocator(actual)` → `LocatorAssertions`, else bun's; statics copied. `test` wraps bun's `test(title, body, {timeout: timeout+30s, retry})`; hooks/`use`/`extend` live in a module-level scope stack (bun hooks take no args); each attempt runs under an `AbortSignal` deadline that every driver call and poll honours; on failure writes `failure.png` + `screen-at-failure.txt` (+ `console.jsonl`/`network.jsonl` when devtools attached) and appends to `results.jsonl`. `.only` recorded → fails the gate under `CI`.

Env contract (spec process; written by `warden e2e`, usable by hand): `WARDEN_UDID` `WARDEN_PLATFORM` `WARDEN_BUNDLE_ID` `WARDEN_APP_PATH?` `WARDEN_METRO_URL?` `WARDEN_LAUNCH_ARGS` (JSON array) `WARDEN_E2E_OUT` `WARDEN_E2E_TIMEOUT|ACTION_TIMEOUT|ASSERTION_TIMEOUT` `WARDEN_E2E_FLOWS_DIR` `WARDEN_HELPER_DIR` `WARDEN_SIMD?` `WARDEN_SIMD_SOCKET?` (pre-warmed helper; else stdio spawn) plus the existing `WARDEN_HEADLESS`, `WARDEN_LOG_TIMESTAMPS`, `WARDEN_WORKER/JOB/JOB_SEQ/PASS/LEG/BATCH_DIR/PORT(S)`. Removed: `WARDEN_AGENT_SESSION`, `AGENT_DEVICE_STATE_DIR`, `WARDEN_FLOWS`, `WARDEN_FLOW_PATHS`. Preload is optional and a no-op without `WARDEN_UDID` (safe in `bunfig.toml`).

Artifacts: `<WARDEN_E2E_OUT>/results.jsonl` (`TestResult{file,title[],status:passed|failed|skipped|timed-out,durationMs,startedAt,only?,error?,artifacts?,device}`) and `<out>/<flowId>/<title-slug>-<hash6>/{failure.png,screen-at-failure.txt,trace.jsonl,console.jsonl?,network.jsonl?,screenshots/NNN-name.png}`; warden sets `WARDEN_E2E_OUT=<batchDir>/e2e/<worker>-<seq>`.

## `warden e2e` integration + config

- Schema (`affected.schema.ts`, `define-config.ts`): delete `runner`; add `spec?: { bundleId?, launchArgs?, timeout?("2m"), actionTimeout?("30s"), assertionTimeout?("5s") }`; a leftover `runner` key → zod issue `e2e.<suite>.runner was removed: flows run with @delacour/warden-e2e, see spec`. Bundle id default via `bundleIdFor(project, platform)` as `metroPlan` does; launch args = `--initialUrl <metroUrl>` (Metro suites; refactor `metro.ts` to export `devClientLaunchArgs(url, launchArgs)`) + `metro.launchArgs` + `spec.launchArgs`.
- `apps/cli/src/e2e/bun-runner.ts`: argv `<bun> test --preload <resolved @delacour/warden-e2e/preload> --timeout <spec.timeout+30s> [--reporter=junit --reporter-outfile <out>/junit.xml] <abs flow paths…>`; `<bun>` = `WARDEN_BUN` → `Bun.which("bun")` → error `bun >= 1.3 is required on PATH (or set WARDEN_BUN)`; preload via `Bun.resolveSync(..., suite.cwd)` → error `bun add -d @delacour/warden-e2e`. Per-flow mode unchanged (one process per flow per device); single mode = per-device shards `i % n`.
- `apps/cli/src/e2e/verdicts.ts`: read every `results.jsonl`, group by realpath → flow; flow `failed` if any test failed/timed-out or exit ≠ 0; `FlowVerdict.tests[]` in `e2e-report.json` (keeps the `headless` field); `printVerdict` lists failing tests + artifact dir; exit-code fallback with warning when the file is missing. `batch/runner-report.ts` becomes `resultsReport(jsonlText, flows, since)` producing the existing `RunnerReport` type (per device via `TestResult.device.udid`), used by `readRunnerReport`/`Display.report` and by `verdicts()` so single-mode flows get individual verdicts.
- Live progress: `batch/flow-progress.ts` `flowMarks(logText, flows)` → `resultsMarks(jsonlText, flows)`; `flowPoller` reads `<out>/results.jsonl` of each worker's current job (path known from the job env) instead of the log; enabled for both modes (per-flow mode gets per-test cells for free via `tests[]`); `--no-tui` `announceFlows` unchanged.
- Pre-warm: `batch/warm-runners.ts` → `batch/warm-drivers.ts` (`warmDrivers(run)`: per leased iOS device spawn/connect the socket helper via the e2e driver's `connectHelper`, take one `snapshot` to make the bridge guest resident, log `logs/warm-<worker>.log`, 120 s timeout, warn-only; `SpawnOptions.warm` + `track` kept for SIGINT; `BatchDeps.agentDeviceBin` deleted; `SessionHooks.warmRunners` → `warmDrivers`; suite `warmRunners` → `warmDrivers` in schema + `define-config.ts`). Jobs receive `WARDEN_SIMD_SOCKET`.
- Remove `AGENT_DEVICE_STATE_DIR`/`{stateDir}` (`batch.ts` plan/runEnv strip, `RunVars`, `expand.ts`, tests, docs) and `WARDEN_AGENT_SESSION`.

## `warden ui` (agent CLI)

Global: `--udid|--serial|--lease`, `--claim`, `--json`, `--timeout <ms>`, `--no-record`. Device resolution: flags → `WARDEN_UDID` → `WARDEN_UDIDS` (if one) → caller's leases (one → use; none/many → exit 2 with hint). Lease check = `ensureCallerLease` factored from `hooks/claude-pretool.ts:119` (own → heartbeat; foreign live → exit 2 `blockMessage`; stale/none → only with `--claim`).

| Subcommand | Notes |
|---|---|
| `status` · `open <bundleId\|url> [--relaunch] [--metro <url>] [--args…]` · `close [--app] [--release]` | `--metro` reuses `devClientLaunchArgv`/deep link, stores `metroUrl` in `state.json` |
| `snapshot [-i] [--all] [--settle [ms]] [--depth n]` · `find <sel>` | line = `@e3 [button] "Sign in" id=sign-in-submit value="…" enabled hittable (x,y w×h)`; header prints generation; `--settle` = two equal hashes ≥250 ms apart (default 3000 ms) then `+/-/=` diff keyed id → role+label → path |
| `press\|tap <target> [--settle] [--verify]` · `longpress` · `fill <target> <text> [--secure] [--no-verify]` · `type <text> [--submit]` · `key <name>` · `swipe <dir\|x1 y1 x2 y2> [--from <target>]` · `scroll <dir> [amount] [--until <sel>] [--in <target>] [--max]` | target = `@eN` \| selector \| `x y`; `@eN` from the latest snapshot of this device, re-verified by id→role+label→path when older than 30 s or `--verify`; mismatch = `stale_ref` exit 4 |
| `wait <sel>\|absent <sel>\|text "…"\|stable [ms]` · `is <sel> visible\|hittable\|enabled\|checked\|selected\|focused` · `get <sel> text\|value\|label\|id\|role\|frame\|count` | poll 100 ms, default 5000; reason codes `wait_target_absent` etc.; `is` exits 0/1 |
| `screenshot [path]` · `alert accept\|dismiss\|get` · `home` `back` `rotate <o>` `appearance <m>` · `video start\|stop` | |
| `eval <expr> [--await]` · `tree [--all] [--max]` · `logs [n]\|start\|stop\|mark\|clear` · `network [n] [--include headers,body] [--id]` · `reload` | dev client only; else `devtools_unavailable` exit 3 |
| `record start <name>\|stop\|status` · `replay <file> [--from i] [--update-snapshots]` · `export <file> --to e2e/<name>.e2e.ts [--ids …]` · `bench [--runs]` | |

Selector grammar: `id=<v> label=<v> text=<v> role=<v> value=<v> editable=true|false nth=<i>`, `<v>` = bare | `"quoted"` | `/regex/`; `id` exact; `label/text/value` case-insensitive substring; action ambiguity → most specific visible (exact > substring > smallest frame > reading order). Exit codes: 0 ok · 1 failed/usage · 2 lease · 3 engine unavailable · 4 stale ref · 130. `--json` envelope `{ok, command, device, generation?, durationMs, result} | {ok:false, error:{code,message,hint?}}`. State: `$WARDEN_HOME/ui/<udid>/{last-snapshot.json,state.json,shots/}` (atomic writes). Helper: `connectHelper(udid)` connect → else unlink stale, take `simd_spawn:<udid>` meta under `store.transaction`, `spawnDetached`, poll socket ≤5 s. `releaseDevices()` (new CLI choke point used by `release`, `lease-session.release`, SessionEnd, gc, `release --bad`) stops the helper; gc removes dead-pid socket files.

## Devtools facet (`packages/e2e/src/devtools/`)

`findMetro`: `--metro` → `WARDEN_METRO_URL` → `state.json.metroUrl` → owner's port leases probed with `metroOwner` (`ours` only). `inspector.ts`: `GET /status` then `/json/list`, drop `vm === "don't use"`, filter by pinned `logicalDeviceId` else sim name (`deviceName`), prefer Fusebox (`prefersFuseboxFrontend` / `[C++ connection]`), persist `logicalDeviceId`. `cdp.ts`: Bun WebSocket JSON-RPC + `Runtime.addBinding("__warden_cb")` for async scripts. `session.ts`: `FuseboxClient.setClientMetadata`, `ReactNativeApplication.enable`, `Runtime.enable`, `Runtime.runIfWaitingForDebugger`; `evaluate`, `reloadJs` (`Page.reload` → `POST /reload`), reconnect on close/`executionContextsCleared`. `console.ts` → `console.jsonl` + ring 500 (verify Hermes replay-on-enable on RN 0.86 in A7). `network.ts`: `fetch` patch (ring 2000, headers, text bodies <64 KB, Metro URLs filtered; XHR not patched to avoid double count). `tree.ts`: fiber walk (largest root, prune inactive screens, testID/label/text, `measureInWindow` → `nativeFabricUIManager.measure` → `UIManager.measureInWindow`, 1200 ms guard, parent dedup) → `{screen, components[{id,name,testID,label,text,rect,parent}]}`; used by `warden ui tree` and as `getByTestId` accelerator (`source:"react"`) when AX lacks a plain `View testID`. `collector.ts`: hidden `warden ui-collect` for `logs start` (optional, idle-exits).

## Flows (`packages/e2e/src/flows/`)

`flow.schema.ts` (zod, `v:1`): `{ name, createdAt, recordedOn{platform,device,screen,app?,metro?}, steps[] }`; steps `open|press|longpress|fill|type|key|swipe|scroll|wait|is|get|alert|home|back|reload|rotate|appearance|snapshot|screenshot` each with `{i, at, snapshotHash?, note?}`; targets `{kind:"selector", selector, chain[] (id → role+label → role+text → path), landmark{role,frame,label?}}` or `{kind:"coords", x, y, warning}`; text matching `WARDEN_UI_SECRET_*` stored as `{secret: NAME}`. Record: `state.json.recording`, every `warden ui` action appends (txn + atomic rewrite). Replay: resolve chain per step against fresh snapshot, landmark check (role equal, centre within 40 pt), `--settle` as recorded, hash mismatch = `drift` warning, failed selector = `replay_divergence` exit 1 with step + snapshot excerpt; never rewrites unless `--update-snapshots`. Export: codegen to the spec API (`id`→`getByTestId(ids.x)`, `label`→`getByLabel`, `text`→`getByText`, `role+label`→`getByRole`, waits→matchers, scroll→`scrollUntilVisible`, coords→`// FIXME` `device.tapAt`), `ids` map generated or merged from `--ids`; golden tests.

## Speed targets (asserted by `scripts/smoke/ui-bench.ts`, manual/nightly, ×1.5 tolerance)

| metric | target |
|---|---|
| cold helper spawn → first `snapshot -i` | < 1500 ms |
| warm `snapshot -i` (axbridge) | p50 < 60 ms, p95 < 120 ms |
| `press x y` (HID only) | p50 < 30 ms |
| `press --settle` on static screen | < 600 ms |
| `tree` (dev client) | < 250 ms |
| Android `snapshot -i` / `tap` | < 800 ms / < 120 ms |
| spec `openDriver` with resident bridge | < 500 ms |

## Phases

Issue titles: `warden-e2e <ID> - <gitmoji> <type>: <desc>`. Each ≤ 1 day; acceptance criteria (AC) inline. Any agent can pick one up with only this file + the named source files.

### Driver (D)

| ID | Title | Deps | AC |
|---|---|---|---|
| WDN-E2E-D1 | ✨ feat(e2e): package scaffold + driver types/errors/refs/hash-settle | — | `packages/e2e` per AGENTS checklist; `driver.types.ts` (`Driver`, `Element`, `Snapshot`, `DriverError`, `DriverResult<T>` on `AsyncResult`), `errors.ts`, `refs.ts` (preorder `@eN`, `E_STALE_REF` on generation mismatch), `settle.ts` (`settleByHash(poll,{quietMs,timeoutMs,now,sleep})`), `driver.testing.ts` FakeDriver; root `typecheck/check/test` green; copy this plan to `docs/plans/wdn-e2e.md` |
| WDN-E2E-D2 | ✨ feat(e2e): NDJSON simd client + fake helper + locate-helper | D1 | `simd-client.ts` (spawn/connect, id multiplexing, per-op timeouts, events, exit → `E_HELPER_CRASHED`, respawn once), `simd-protocol.ts` zod, `locate-helper.ts` order as above, `native/scripts/fake-simd.ts`; tests: handshake, out-of-order, timeout, fatal mapping, crash+respawn, lookup order with temp dir |
| WDN-E2E-D3 | 🔧 chore(e2e): native toolchain — idb submodule+lock, `native:deps`, `Package.swift`, health-only `warden-simd`, `native:build`, CI native job | — | `.gitmodules` idb @ pinned tag; `deps.ts` (tarball+sha256, `--from-source` via `./build.sh build libraries && build library-package`); `main/Wire/NDJSON/Session.open/health`; `build.ts` stages `native/dist/{warden-simd,Resources/SimulatorFrameworkBridge-iOS,*Stub.framework}` + ad-hoc codesign + `manifest.json`; `ci.yml` macOS job (paths filter) runs deps+build+`swift test`; on a booted warden sim `{"id":"1","op":"health"}` answers with `hid.transport` and `ax.bridge:"available"` |
| WDN-E2E-D4 | ✨ feat(simd): AX ops — snapshot/elementAtPoint/alertButtons, backend fallback, role map | D3 | `Ops/Snapshot.swift`, `Model/Element.swift`; on example app `snapshot{interactiveOnly:true}` contains every testID in `apps/example/e2e/helpers/ids.ts` with frames; warm snapshot `ms` ≤ 60; with a permission alert up `alertButtons` lists buttons and `snapshot` reports `backend:"ax"`; XCTest fixtures for document→model |
| WDN-E2E-D5 | ✨ feat(simd): HID ops — tap/longPress/swipe/drag/pinch/pressButton/key/typeText/paste, serialised actor, `unit:"norm"` | D3 | smoke: tap testID, type `Hello, World 123!` and read it back via snapshot value; `typeText("é")` → `E_UNSUPPORTED_TEXT{rest:"é"}`; swipe changes a list snapshot; `home` → SpringBoard; `health` reports negotiated transport (and `--hid indigo` on Xcode 26) |
| WDN-E2E-D6 | ✨ feat(simd): screenshot/orientation/settle/socket mode/idle exit/shutdown | D3 | PNG dims = `screen×scale`; orientation set+read; `settle` quiet in <400 ms on idle screen, `quiet:false` under animation with `timeoutMs:300`; two sequential socket clients reuse one process; exits after `--idle-timeout 2` |
| WDN-E2E-D7 | ✨ feat(e2e): iOS TS driver (simd + simctl ops + settle/paste fallbacks) + `native:smoke` | D2 D4 D5 D6 | unit tests (fake-simd + fakeExec) for every `Driver` method; `native:smoke --udid` passes on the example Release build: launch, snapshot, tap, fill, swipe, screenshot, settle, terminate |
| WDN-E2E-D8 | ✨ feat(e2e): Android adb session + uiautomator parser (pure, fixtures) | D1 | sentinel parsing/exit codes/queueing/respawn with a fake adb script; parser tests (resource-id strip, bounds, roles, interactiveOnly, password→securefield) on a real dump fixture |
| WDN-E2E-D9 | ✨ feat(e2e): Android driver ops + smoke | D8 | argv/escaping tests; smoke on a warden emulator runs the D7 scenario (minus pinch); tap < 150 ms logged |
| WDN-E2E-D10 | 🔧 chore(cli): ship warden-simd — npm staging (`bin/**`), release.yml (deps cache + native build before `build:release`), release tgz `warden-simd-darwin-arm64.tgz`, `warden doctor` check, `reference/e2e-driver.mdx` | D3 D7 | `build:release && build:npm` on arm64 stages `dist/npm/warden-darwin-arm64/bin/{warden,warden-simd,Resources/…,*.framework}`; manifests tests updated; linux/x64 unchanged; doctor shows transport/bridge |
| WDN-E2E-D11 | 🐛 fix(e2e): hardening — `slim.ts` NEVER_DISABLE (`dtuhidd`, bridge), AutomationEnabled write at open, bridge-stale recovery (2× `E_AX_UNAVAILABLE` → shutdown+respawn), crash recovery, latency log | D7 D9 | slim test; killing the guest (`simctl spawn <udid> killall SimulatorFrameworkBridge-iOS`) recovers in one retry; killing warden-simd mid-test yields one `E_HELPER_CRASHED` then success |

### TypeScript spec API + `warden e2e` (T)

| ID | Title | Deps | AC |
|---|---|---|---|
| WDN-E2E-T1 | ✨ feat(e2e): query model — `LocatorExpression`, `resolve()`, `nodes.ts`, `roles.ts`, `text.ts`, `selector.ts`, `render.ts` (pure) | D1 types | tests: innermost text/label, strict one-match, scope, filter, nth, visible; RN iOS value prefix (`checkbox, unchecked`), switch 1/0, Android classes; render matches the `warden ui` line format; selector parser round-trips |
| WDN-E2E-T2 | ✨ feat(e2e): session — `env.ts` zod, lazy driver, artifacts dirs, `results.jsonl`, `trace.jsonl`, `preload.ts` | D1 D2 | by-hand `WARDEN_UDID=… bun test ./x.e2e.ts` reaches the driver; unset env → preload no-op; results line written even when the test throws |
| WDN-E2E-T3 | ✨ feat(e2e): `test`/`describe`/hooks/`extend`/`use`/`only`/`skip`, deadline+AbortSignal, failure capture, console reporter lines (`▶`/`■` per test, `▸`/`▪` per step from `trace.jsonl`, no clock under `WARDEN_LOG_TIMESTAMPS=1`) | T2 | hook order; `extend` teardown after failure; never-resolving action → `TIMEOUT` and the next test starts clean; `failure.png` + `screen-at-failure.txt`; `only` recorded; reporter golden output matches `guides/run-e2e.mdx` sample |
| WDN-E2E-T4 | ✨ feat(e2e): locator actions + reads (actionability wait, fill verify/retry, scrollUntilVisible, text fallback) | T1 T2 (D2 fake) | FakeDriver tests for every action; secure fields skip verify; `scrollUntilVisible` stops when visible / after `maxSwipes` |
| WDN-E2E-T5 | ✨ feat(e2e): `expect` wrapper + 9 matchers + `.not` + `expect.soft` + `index.ts` types | T1 T3 | fake-clock polling at 100 ms; non-locator `expect(1).toBe(1)` typed as bun's; soft failures aggregate |
| WDN-E2E-T6 | ✨ feat(e2e): `App` + `Device` fixtures (alert heuristics, openLink auto-accept, settle, snapshot, screenshot, home/back/orientation/appearance/clipboard/hideKeyboard; `app.clearData()`/`reinstall()` via core `resetAppData`/install with `resetKeychain`) | T2 | alert accept/dismiss/button/none→false; openLink accepts "Open in…?" within 3 s; `app.open` passes `WARDEN_LAUNCH_ARGS` + call args; `clearData` calls `resetAppData` argv (fakeExec) |
| WDN-E2E-T7 | ✨ feat(cli): built-in runner — schema (`runner` + `warmRunners` removed with migration errors, `spec` + `warmDrivers` added), launch-arg/bundle-id derivation (`devClientLaunchArgs`), `bun-runner.ts` argv+env, bun/preload lookup, single-mode shards, delete `runnerArgv`/`singleRunnerArgv`/flow placeholders/`AGENT_DEVICE_STATE_DIR`/`{stateDir}`/`WARDEN_AGENT_SESSION`/`BatchDeps.agentDeviceBin` | T2 env names | `e2e.test.ts` via `batch.testing.ts` (`warms()`, `agentDeviceBin`, `warmExit` harness bits replaced): argv/env per job, shard `i % n`, errors for missing bun/preload/bundle id, `runner`/`warmRunners` keys → migration errors; no state-dir / `{flowPath}` / agent-session mention left in cli/core/docs |
| WDN-E2E-T8 | ✨ feat(cli): structured verdicts + live progress from `results.jsonl` — `resultsMarks` replaces `flowMarks`, `resultsReport` replaces `runnerReport`/`reportOutputDir`, `flowPoller` re-pointed (both modes), `FlowVerdict.tests`, single-mode per-flow verdicts, per-test printing, exit-code fallback, `.only`-in-CI gate | T7 T2 | tests passed/failed/no-results/unparseable; `tui.test.ts` snapshots unchanged; `flow-progress.test.ts`/`runner-report.test.ts` rewritten on JSONL fixtures; `e2e-report.json` carries `tests[]` + `headless` |
| WDN-E2E-T13 | ✨ feat(cli): `warmDrivers` — `batch/warm-drivers.ts` replaces `warm-runners.ts`: per leased iOS device connect/spawn the socket helper (`connectHelper` from A2) + one snapshot, parallel, 120 s warn-only, `logs/warm-<worker>.log`, jobs get `WARDEN_SIMD_SOCKET`; spec `Session` prefers the socket | T7 A2 D6 | harness test: warm step runs after hide and before the first job, failure only warns, env present on jobs; smoke: second flow on the same sim starts with a warm snapshot < 100 ms |
| WDN-E2E-T9 | 🔧 chore(cli): publish `@delacour/warden-e2e` — `e2eManifest`, staging (`Bun.build` index+preload, `external:["bun:test"]`, `.d.ts` via `npm/declarations.ts`), release order, AGENTS.md rule update | T2 D10 | `build:npm` stages `dist/npm/warden-e2e/{index.mjs,preload.mjs,index.d.ts}`; `npm pack` installs into a scratch project and `import { test } from "@delacour/warden-e2e"` typechecks; peer `@delacour/warden` exact version + protocol handshake |
| WDN-E2E-T10 | ♻️ refactor(example): migrate — deps, delete `e2e.config.ts` + `e2e/helpers/timestamps.ts`, helpers (`clearSystemPrompts` → `device.alert`, drop `fillField`/`acceptOpenIn`/`leasedDevices`/`devClientLaunchArguments`), flows import, `warden.config.ts` suites drop `runner` (keep `app: true`, `slim`, `metro`, `mode:"single"`), add `spec`, AGENTS.md (drop `WARDEN_AGENT_SESSION`/`warmRunners`/`timestampsReporter`/`report.json`/Node note) | T3–T7 | `typecheck && check` in `apps/example`; `warden e2e example --dry-run --all` lists 5 flows; no `e2e`/`@e2e-dev/mobile` reference left |
| WDN-E2E-T11 | 📝 docs: `guides/e2e` (65), `guides/run-e2e` (32, 80, 83, 85–93 sample from the new reporter), `guides/headless` (16–17 drive path), `guides/affected-e2e` (14), `reference/configuration` (170, 201 → `warmDrivers`, `spec`), `reference/cli` (89, 139), `reference/environment` (+`WARDEN_LOG_TIMESTAMPS`, `WARDEN_SIMD_SOCKET`, −`WARDEN_AGENT_SESSION`), README, SKILL.md (30) | T7 T8 T9 T13 | `grep` clean of `agent-device`/`tester.army`/`stateDir`/`warmRunners`/`WARDEN_AGENT_SESSION` outside `docs/plans`; docs build |
| WDN-E2E-T12 | ✅ test: real smoke — `warden e2e example --all` and `example-dev --all` on 2 sims, replace `expectLabel` if `text()` fallback holds, fix flakes, document the command | all | both suites green twice in a row; forced failing assertion produces the artifacts |

### Agent CLI + devtools + flows (A)

| ID | Title | Deps | AC |
|---|---|---|---|
| WDN-E2E-A1 | ✨ feat(cli): `warden ui` skeleton — registry, global flags, `resolveUiDevice`, `ensureCallerLease` factored from the hook, JSON envelope + exit codes, `status` | core | foreign live lease → exit 2 `blockMessage`; no lease w/o `--claim` → exit 2 hint; `--claim` leases + later calls heartbeat; `WARDEN_UDID` resolves; hook tests unchanged |
| WDN-E2E-A2 | ✨ feat(cli): iOS helper lifecycle — `connectHelper` (txn-arbitrated spawn, socket wait), `stopHelper`, `releaseDevices()` wired into release/lease-session/SessionEnd/gc, gc of dead helpers | D2 D6 | concurrent connects spawn one helper (race fixture); stale sockets unlinked; `warden release` + SessionEnd stop helper; `close` ≤ 2.5 s even if `shutdown` ignored |
| WDN-E2E-A3 | ✨ feat(cli): snapshot model — text lines, `-i`, hash, `+/-/=` diff, `last-snapshot.json`/`state.json`, generation + stale rules, target grammar + matcher | T1 (`render`, `selector`) | golden tests full/`-i`; diff keyed id→role+label→path; ambiguity by specificity, `nth=`; `stale_ref` with hint; generation bumps on snapshot/settle/find only |
| WDN-E2E-A4 | ✨ feat(cli): actions — open/close/press/longpress/fill/type/key/swipe/scroll/alert/home/back/rotate/appearance/screenshot/video, `--settle` diff, `--verify` | A1 A2 A3 D7 (D9 for Android) | FakeDriver records expected primitives; `--settle` ends on two equal hashes ≥250 ms apart; `fill` verifies (secure → `unconfirmed`); `@ref` > 30 s re-verifies; `open --metro` stores url and launches with `--initialUrl` / deep link |
| WDN-E2E-A5 | ✨ feat(cli): queries — `wait` (visible/absent/text/stable), `is`, `get`, `find`, reason codes | A3 A4 | 100 ms polling, deadline ±1 tick; `is` exits 0/1; `get count`; `find` bumps generation |
| WDN-E2E-A6 | ✨ feat(e2e): devtools core — `metro.ts`, `inspector.ts`, `cdp.ts`, `session.ts`; `warden ui eval\|reload\|status` lines | — (CLI glue after A1) | `selectTarget` fixture table (Fusebox/legacy/multi-device/pinned/decoy vm); `findMetro` never picks `foreign`; evaluate surfaces `exceptionDetails`; reconnect after socket close < 2 s; release build → `devtools_unavailable` exit 3; CDP tested against an in-process Bun WebSocket server |
| WDN-E2E-A7 | ✨ feat(e2e): console + network — jsonl, replay-buffer check on RN 0.86, fetch interceptor, `collector.ts` + `logs start/stop/mark/clear`, `network`, failure artifact attachment | A6 T3 | console lines carry level/text/source; network excludes Metro, caps 2000, headers/body on request; failed spec attempt dir has `console.jsonl` + `network.jsonl`; replay-buffer finding recorded in Status |
| WDN-E2E-A8 | ✨ feat(e2e): React tree — `tree.ts` script, `warden ui tree`, `getByTestId` accelerator (`source:"react"`), dp→px | A6 T1 | rects for example testIDs; inactive screens pruned; non-accessible `View testID` resolves via tree and taps centre; `--max` bounds output |
| WDN-E2E-A9 | ✨ feat(e2e): flows — schema, `record start/stop/status` (ref → resolved target chain + landmark, secrets), `replay` with divergence/drift, `--update-snapshots`, `--from` | A3 A4 A5 | cross-process append order; replay passes on unchanged app, `replay_divergence` with step index when a selector vanishes, `drift` on hash change w/o failing, file untouched unless `--update-snapshots` |
| WDN-E2E-A10 | ✨ feat(e2e): `export` flow → `*.e2e.ts` codegen with `ids` generate/merge, golden tests | A9 T5 | golden spec using every step kind typechecks against the package; secrets → `process.env.NAME`; coords → `// FIXME` |
| WDN-E2E-A11 | ✨ feat(cli): `warden ui bench` + `scripts/smoke/ui-bench.ts` + targets doc | A2–A5 (D9) | `bench --json` emits p50/p95 per metric; smoke fails over target×1.5; numbers recorded in Status |
| WDN-E2E-A12 | 📝 docs + 🔥 removal: SKILL.md `## Driving a device (warden ui)`, README, `guides/agents.mdx`, new `guides/agent-ui.mdx`, `reference/cli.mdx`, example AGENTS.md accessibility rule; **remove argent compat** — `ARGENT_MATCHER` + argent branch in `hooks/claude-pretool.ts`, `patchArgentRules` + argent rule text diff, the `argent-rules` step in `commands/install.ts`, their tests, `hooks/claude-settings.ts` matcher entries | A1–A5 A9 A10 | no `agent-device`/`argent` mention outside `docs/plans`; `warden install --dry-run` diff reviewed (hook config loses the argent matcher, keeps SessionEnd); hook tests updated |

## Implementation team (minimum 5, maximum 15 subagents, run in parallel per wave)

The lead session (this one) is the integrator: it spawns the team each wave with `isolation: "worktree"`, reviews/merges each agent's PR into `feature/cetus`, runs the root `typecheck/check/test`, and resolves cross-agent interface drift (the `Driver`/`Element` types in D1 and the env names in T2 are the shared contracts; agents must not change them without telling the lead).

| Agent | Role | Issues (in order) |
|---|---|---|
| `simd-core` | Swift: toolchain + protocol + session | D3 → D6 |
| `simd-ax` | Swift: AX ops + role map | D4 (after D3's health build) |
| `simd-hid` | Swift: HID ops + keyboard | D5 (after D3) |
| `driver-ts` | TS driver client + iOS driver | D1 → D2 → D7 → D11 |
| `driver-android` | Android session/parser/driver | D8 → D9 |
| `spec-query` | Locator query model, roles, render, selector, actions | T1 → T4 |
| `spec-runner` | Session/env/results, `test` wrapper, expect/matchers | T2 → T3 → T5 |
| `spec-fixtures` | `App`/`Device` fixtures | T6 (after T2) |
| `cli-e2e` | `warden e2e` built-in runner + verdicts/progress + config + warmDrivers | T7 → T8 → T13 |
| `cli-ui` | `warden ui` skeleton, helper lifecycle, snapshot/refs, actions, queries | A1 → A3 → A2 → A4 → A5 |
| `devtools` | Metro/CDP facet: session, console, network, tree | A6 → A7 → A8 |
| `flows` | record/replay/export | A9 → A10 (after cli-ui A5) |
| `packaging` | npm staging, release workflow, doctor, bench | D10 → T9 → A11 |
| `migration-docs` | example app migration, docs, skill, argent removal | T10 → T11 → A12 |
| `smoke` | real-device verification, flake fixes, bench numbers | T12 (final wave; may be the lead itself) |

That is 14 agents (15 with a separate `smoke` agent); minimum concurrency per wave is 5.

| Wave | Agents active (issues) | Gate |
|---|---|---|
| 0 | `simd-core` (D3), `driver-ts` (D1), `spec-query` (T1), `spec-runner` (T2 env/schema half), `cli-e2e` (T7 schema half) | package scaffold + health-only helper build; shared types frozen |
| 1 | `simd-ax` (D4), `simd-hid` (D5), `simd-core` (D6), `driver-ts` (D2), `driver-android` (D8), `spec-runner` (T2), `cli-e2e` (T7), `cli-ui` (A1), `devtools` (A6) | protocol client + Swift ops + Android parser + session + runner argv |
| 2 | `driver-ts` (D7), `driver-android` (D9), `spec-runner` (T3), `spec-query` (T4), `spec-fixtures` (T6), `cli-ui` (A3, A2) | real driver smoke on iOS/Android |
| 3 | `spec-runner` (T5), `cli-e2e` (T8, T13), `packaging` (D10), `cli-ui` (A4, A5), `devtools` (A7, A8) | spec API complete; helper shipped + pre-warmed; CLI actions |
| 4 | `packaging` (T9, A11), `migration-docs` (T10), `flows` (A9), `driver-ts` (D11) | npm package; example migrated; flows |
| 5 | `migration-docs` (T11, A12), `flows` (A10) | docs; argent removed |
| 6 | `smoke` (T12 + bench numbers) | gate: both example suites green twice; bench within targets |

Each implementing agent: own worktree branched from `feature/faster-local-e2e-runner` (= `origin/main` `b43e121`; rebase onto it again if main moves), one issue per PR titled with the issue title, TDD (`bun test <path>` after each change), `bun run typecheck && bun run check` before commit, no `any`, Biome, no real simctl/adb in `bun test` (smoke scripts are separate), never add `Co-Authored-By`. Agent briefs are self-contained: the issue row from this file, the shared contracts (D1 types, T2 env), and the named source files.

## Verification

1. Unit: `bun run test` at root (FakeDriver/fake-simd/fake-adb; CDP against in-process WS server; golden files for render/diff/export).
2. Native: `bun run --cwd packages/e2e native:deps && native:build && swift test`; `native/dist/warden-simd --health --udid <booted warden sim>` shows `hid.transport` + `ax.bridge:"available"`.
3. Driver smoke (manual, booted sims from `warden claim ios --json`): `bun packages/e2e/native/scripts/smoke.ts --udid <udid>` and `--serial <emu>`.
4. Spec runner: `cd apps/example && bun run e2e -- --all` (Release, 2 sims, per-flow) and `bun run e2e:dev -- --all` (dev client + warden Metro, per-device shards); inspect `<batchDir>/e2e/*/results.jsonl`, `e2e-report.json` `tests[]`, and a forced failure's `failure.png`/`screen-at-failure.txt`/`console.jsonl`.
5. Agent loop: `warden claim ios --json` → `warden ui open nz.co.delacour.warden.example --udid X` → `snapshot -i` → `press @eN --settle` → `wait id=todos-screen` → `record start/stop` → `replay` → `export` → `close --release`.
6. `warden ui bench --json` within targets; `warden doctor` reports the helper; `bun run --cwd apps/cli build:release && build:npm` stages all packages; `npm pack` of `warden-e2e` installs into a scratch Expo app and typechecks.

## Risks

- Private API drift per Xcode (CoreSimulator version gates, DTUHID XPC, AXRuntime): pinned idb tag + submodule for patches + `health`/`doctor` surfacing + macOS CI job.
- idb Swift API churn: thin `Session`/`Ops` layer, XCTest fixtures fail loudly.
- arm64-only helper; Intel macs get a clear `E_HELPER_MISSING`.
- AX sparsity for plain `View testID` (release builds): axbridge granularity + React-tree accelerator (dev) + example AGENTS rule to mark targets `accessible`.
- System UI covering the app: per-request `ax` fallback; `alertButtons` starts with `ax`.
- `uiautomator dump /dev/stdout` in non-pty shells: file fallback.
- Hermes console replay-on-enable may be absent on some versions: `logs start` collector is the guaranteed path.
- Helper orphans / two owners: idle exit, gc of dead-pid sockets, lease check before connecting, socket `0600`.

## Resolved questions (user, 2026-10-15)

1. darwin-x64 helper: **skip in v1**, clear `E_HELPER_MISSING`.
2. Argent compat (`ARGENT_MATCHER`, rule patch, install step): **remove in A12**.
3. `@delacour/warden-e2e` versioning: **lock-step** with `@delacour/warden` (same tag, exact peer, protocol handshake).
4. Custom `runner` argv: **removed now** (T7); built-in bun runner only.

## Status (2026-10-15)
Planned; nothing implemented. Replanned after rebasing onto PR #22 (`b43e121`): pre-warm slot, live progress, report reader, log stamping, headless, installMode and the example config are now integrated (see "What PR #22 means" above; T7/T8/T13/T10/T11 updated). Research notes that produced this plan: idb main is XcodeGen static libs + published library package (not SwiftPM-built); `SimulatorFrameworkBridge-iOS` is prebuilt/signed and must ship unmodified; AutomationEnabled is asserted by the axbridge backend; bun 1.3.14 `bun test` supports `--preload`, `--timeout`, `--bail`, `-t`, `--reporter=junit`; Claude Code exports `CLAUDE_CODE_SESSION_ID` so lease owner is stable across Bash calls.


**Implemented (2026-10-16)**, merged on `feature/faster-local-e2e-runner`: D1-D11 (D11 real-device checks still to do), T1-T8, T10, T11, T13, A1-A4, A6, A7, and A12 part 1 (argent compat and YAML flow discovery removed). `warden e2e` runs `*.e2e.ts` specs with `bun test` and `@delacour/warden-e2e`; verdicts and live progress come from `results.jsonl`; the example app is migrated; the docs describe the spec API, config and environment. **Open:** A5, A8, A9, A10, A11, A12 part 2 (the `warden ui` guide and SKILL section), T9 (npm publish of `@delacour/warden-e2e`) and T12 (smoke gate + bench numbers).

**A7/A8 live verification (2026-10-16): done on iPhone 17 (iOS sim) against the `example-dev` dev client (fingerprint `e7dad4ac`, Expo Metro, Hermes/Fabric RN 0.86, `warden dev ios` cache hit, no xcodebuild).**
- **Bug found and fixed:** every `warden ui eval|tree|logs|network|reload` failed with `could not connect to inspector socket`. Metro's inspector proxy (`verifyClient`) answers a debugger upgrade that has no `Origin` header with 401. `openCdp` now sends an `Origin` (`inspectorOrigin`: `http://127.0.0.1:<port>`; with `http://localhost:<port>` the handshake passes but the socket is dropped, 1006, on Expo's Metro). The fake Metro (`devtools.testing.ts`) now enforces the same check (401 without a local Origin), so all 185 devtools tests exercise it; added `inspectorOrigin` and Origin tests in `cdp.test.ts`.
- **Works live:** `eval "1+1"` -> `2` (~0.7 s wall incl. bun start); `tree` returns the React component tree with testIDs, text and rects (12 components on the welcome screen); `tree` `durationMs` 141-168 ms warm (about 0.6 s wall per CLI call); `logs start` + `eval console.log/warn/error` + `logs 20` show level and text with Hermes timestamps; `network 10` records `fetch` (200 with duration, and a refused connection as `ERR`; requests to Metro itself are skipped by design); `reload` (`Page.reload` unsupported, falls back to `POST /reload`, method `http`) takes 0.7-2.2 s, the collector logs `JS context cleared, reconnecting` then `reconnected`, the network wrapper is re-installed and capture continues; `logs stop` kills the collector and clears `state.json.collector`.
- **Hermes console replay-on-enable:** confirmed. `Runtime.enable` replays buffered `consoleAPICalled` (a freshly started collector after `logs clear` immediately showed `Running "main"` and an `after-reload` line logged minutes before it attached). Each replayed line appears exactly once even though several earlier connections had enabled Runtime, so the (timestamp, text) dedupe in `console.ts` holds.
- **Not reproduced:** after the very first `reload` (about 4 min after launch, machine under heavy load) the app stopped responding (`snapshot` timed out, Metro listed no inspector target, no rebundle logged; the collector gave up after 10 reconnects with `ended (lost)`); `terminate` + `ui open` recovered it, and two later reloads were clean. Treat as a likely app/sim stall under load; `reload` itself reported `reloaded (http)`.
- Note: `warden ui logs|network` without a running collector reads the previous run's jsonl; `logs start` before the interaction is required, and a collector from before an app restart ends as `lost`.
- Needs `warden-simd` (`WARDEN_SIMD=<path>/dist/warden-simd`) for `ui open/press/snapshot`; not present in a fresh worktree until `packages/e2e/native` is built.

**WDN-E2E-A11 (2026-10-16): `warden ui bench` + `scripts/smoke/ui-bench.ts`.** `warden ui bench [--runs n] [--metro url] [--json]` (`apps/cli/src/agent-ui/bench.ts`, targets in the exported `BENCH_TARGETS`, tolerance `BENCH_TOLERANCE` = 1.5); run the smoke with `bun run smoke:ui-bench -- [--udid <id>] [--platform ios|android] [--bundle <id>] [--runs <n>]` (claims a device unless `--udid`, opens `nz.co.delacour.warden.example`, exits 1 over target x1.5, releases only the lease id it claimed). The example app must be installed first (`cd apps/example && warden app ensure ios --udid <udid>`).

First numbers, iPhone 17 sim on a very loaded machine (load average 160-650, another agent building with xcodebuild; helper = the `dist/warden-simd` of another worktree via `WARDEN_SIMD`), release build so no dev client (`tree` skipped). ms:

| metric | run 1 p50 / p95 | run 2 p50 / p95 | target | n |
|---|---|---|---|---|
| helperColdToSnapshot | 1153.5 / 3312.3 | 752.0 / 766.9 | < 1500 | 3 |
| snapshotWarm | 70.3 / 131.0 | 47.1 / 53.5 | p50 < 60, p95 < 120 | 20 |
| pressHid | 2.6 / 8.3 | 1.2 / 1.9 | < 30 | 20 |
| pressSettle | 443.9 / 458.2 | 413.8 / 439.4 | < 600 | 5 |
| tree | skipped (devtools_unavailable) | skipped | < 250 | 0 |
| openDriver | 571.7 / 732.8 | 728.0 / 752.9 | < 500 | 5 |

Both runs passed the x1.5 gate (exit 0). `openDriver` is over its plain target but inside the tolerance in both runs and is the one to look at when the machine is quiet (it includes the driver's own setup besides the socket connect). `tree` and Android numbers are still to be recorded (needs a dev-client run and an emulator).

**Android real-device pass of `warden ui` (2026-10-16).** Pixel 10 AVD (`warden-pixel-10-1`, Android 17 / sdk 37, 1080x2424), claimed with `warden claim android`, driven with `warden ui … --serial <serial>`. No Android build of the example app exists (`warden builds` lists only iOS) and a Gradle release build would not fit the budget on this machine, so everything ran against the Expo dev launcher of the already-installed `nz.co.delacour.ui.playground` (a Compose screen with a text field, buttons and a tab bar). Machine load average was 50-170 throughout (other agents building), so absolute times are 3-10x what a quiet machine gives; relative findings hold.

Worked end to end: `status`, `open`, `snapshot [-i]`, `find`, `press @eN [--settle]` (a "did not settle" notice is only a warning), `press text=…`, `fill` (read-back included), `get value|count|frame`, `is focused`, `wait`/`wait text`/`wait absent`, `scroll down [--until]`, `swipe`, `screenshot`, `video start|stop` (valid MP4), `rotate` (portrait/landscape, snapshot reports 2424x1080), `appearance`, `back`, `home`, `alert get` (null, no real permission dialog was triggered, only fake-host tests cover `detectAlert`), `record start` -> `press` -> `wait` -> `press` -> `record stop`, `replay` (2 steps, both ok, ~2.4 s each), `export --to` (valid spec), `close --app --release`, `bench`. Not run: `eval|tree|logs|network|reload` (dev-client facet, needs the example dev build).

Timings under load 50-170 (ms): snapshot -i 3000-5700 warm (14000 on the very first call, which probes dump routes), `bench`: snapshotWarm p50 2372 / p95 4851 (target < 800, FAIL under load), pressHid p50 94 / p95 265 (target < 120, ok); tap via `ui press` 2400-4000 wall (process start + lease check + snapshot to resolve the target), raw `input tap` 73-350; fill 10-17 s (tap + clear + type + 2-4 read-back snapshots), screenshot 1400-2900, rotate 560-780, scroll 3000, replay step ~2400. Driver open is 2 adb round trips now (was 6).

Failures found and fixed (all with fake-host tests, no real adb in `bun test`):
1. `uiautomator dump /dev/stdout` and `exec-out … /dev/tty` return `ERROR: null root node` (or only the trailer) on this image while a window is opening or the machine is loaded; only the `/sdcard` file route worked at times and `tty` at others. The working route was re-probed by every `warden ui` call (each call is a new process): 2 failed dumps = +8 s. Now remembered per device in `$WARDEN_HOME/ui/<serial>/android-dump-route` and passed to the driver (`dumpRoute` / `onDumpRoute`); snapshot retries an `E_AX_UNAVAILABLE` dump 3x with 400 ms between.
2. The file route could return the PREVIOUS screen when the new dump failed (`cat` of a stale `/sdcard/warden-ui.xml`). It now does `rm -f` first and echoes uiautomator's own error text when no file appears.
3. `elementAtPoint` reused a snapshot up to 1 s old, so `fill`'s hit-test read-back could see the value from before typing. Any input command (tap, text, key, swipe, rotate) and any `app.launch|terminate|openUrl|clearData` now drops the cached snapshot.
4. `input text` escaping: spaces -> `%s`, shell metacharacters quoted. A literal `%s` (previously rejected) and `%` followed by a space (`50% off`, which `input text` mangles into `50%%soff`) are now typed by splitting the string into several `input text` calls so the `%` ends a call (`textArgvs`). Verified on the device: `it's 100% safe, 50% off %s "q" a&b (c) <x>|y;z `w` $HOME end` and `a b%s 50% off` read back byte for byte. Non-ASCII stays `E_UNSUPPORTED_TEXT` (no IME/clipboard path). A text of N pieces gets a timeout of 10 s + 8 s per piece (each `input text` is a JVM start; the fixed 10 s timed out under load).
5. `fill` cleared an existing value with one `input keyevent` process per character (13 characters = 13 JVM starts). Android now offers `pressKeyRepeat` (one `input keyevent 67 67 67 …` call, chunks of 32; verified on the device) and `driver/typing.ts` `pressKeys` uses it when the driver has it (`canRepeatKeys`, an optional addition next to the frozen `Driver`).
6. `open` cost: boot flag, `wm size` and `wm density` are now one probe command and the three animation-scale settings one command.

Android `fill` goes through the same layer as iOS: `typing.ts` (whole string in one `typeText`, no pacing needed) and the `screen/field.ts` read-back (`CONFIRM_READS`, stale-risk run), the field value being the node's `text`.

Still open: a real permission-dialog `alert` run; example-app Android build (`warden app ensure android --project example`) and a re-run of `bench` on a quiet machine (the snapshotWarm target of < 800 ms is unverified; a dump alone took 3.5-8 s here); `drag` on Android is hold-then-move since the follow-up (sdk 26+: `input motionevent` DOWN, 8 interpolated MOVEs, UP in one shell line, CANCEL on failure; below 26 or with an unreadable sdk it falls back to one long `input swipe`, no hold; every `input` is a process start so the sleeps are lower bounds; NOT yet verified on a device, load was above 80); `pinch` and `clipboard` stay `E_UNSUPPORTED` and non-ASCII `typeText` stays `E_UNSUPPORTED_TEXT`.

**ui-bench after D11 / open-path fix (2026-10-16, simd-core).** `bun run smoke:ui-bench` twice, iPhone 17 sim (own lease, released), release example app, helper rebuilt from this branch (`15a7c60`), load average 190 / 302 / 362 (run 1) and 239 / 302 / 359 (run 2), i.e. a heavily loaded machine, not a quiet one. `tree` skipped both times (`devtools_unavailable`): no Metro / dev client was running, and starting one was not cheap, so `warden ui bench --json --metro` was not run. ms:

| metric | target | run 1 p50 | run 1 p95 | n | run 2 p50 | run 2 p95 | n | verdict |
|---|---|---|---|---|---|---|---|---|
| helperColdToSnapshot | <1500 | 3593.1 | 6379.1 | 3 | 958.9 | 997.8 | 3 | run 1 FAIL (x2.4), run 2 ok |
| snapshotWarm | p50 <60 / p95 <120 | 106.3 | 148.5 | 20 | 64.6 | 80.2 | 20 | misses the p50 target on both runs (FAIL x1.8, then slow x1.08); p95 ok on run 2 |
| pressHid | <30 | 7.5 | 19.9 | 20 | 3.7 | 13.5 | 20 | ok |
| pressSettle | <600 | 442.5 | 496.1 | 5 | 411.7 | 430.8 | 5 | ok |
| tree | <250 | - | - | 0 | - | - | 0 | skip (no dev client) |
| openDriver | <500 | 8.8 | 9.8 | 5 | 8.4 | 10.4 | 5 | ok (was 570-730 on the loaded machine; 418 measured warm before the fix, now ~7) |

Targets were not tuned. `snapshotWarm` still misses its plain p50 target on this machine (64.6 to 106.3 ms vs 60) and `helperColdToSnapshot` missed in one of two runs; both should be re-run on a quiet machine before calling them real. `openDriver` meets its target by a wide margin (the in-sim `AutomationEnabled` write that cost 380-480 ms per open is now skipped when the sim plist already has it).

**Relaunch bug bisect (2026-10-16, WDN-E2E devtools/T10 follow-up): after an app relaunch the helper's `axbridge` read fails and `snapshot` falls back to `ax`, which sees a single empty 0x0 root.**
Repro with `warden ui` only, on a leased iPhone 17 sim (`1A0EC51B`, cetus `warden-simd` built 03:13 = after 681d09a): `ui open <bundle> --metro <url>` -> `snapshot -i` ok (`axbridge`, 34 of 127 elements) -> `ui open --relaunch` (or plain `simctl launch --terminate-running-process`) -> `snapshot -i` = `ax`, `0 of 1 elements`. The helper log has one `axbridge -> ax fallback: The application with pid <NEW pid> did not respond to an accessibility request before it timed out` (warn, op snapshot) per read. The screenshot shows the app rendered normally (no sheet), the app's main thread is idle (`sample`).

| # | Experiment (state: broken, unless noted) | Result |
|---|---|---|
| 1 | Release build instead of the dev client (`cc063702`, no Metro), 3 relaunches | same failure every time, including the first read after install: not dev-client specific |
| 2 | `snapshot{backend:"axbridge"}` | `E_APP_NOT_RESPONDING` (retryable: true, `detail.pid` = the new pid). `snapshot{backend:"ax"}` = 0 elements, 1 node (the empty root) |
| 3 | `settle{bundleId}` or `settle{}`, then `snapshot` | RECOVERS: `axbridge`, full tree (35-46 nodes) on every try, dev and Release. `settle` took 1.0-1.7 s `via:"stream"` on the dev client, 2.3 s / 8 s `via:"snapshot"` (stuck stream -> fallback) elsewhere. Without a settle first, the same sequence stays broken |
| 3b | `warden ui open --relaunch --settle`, then `snapshot` | NOT fixed (the CLI's settle does not repair it) |
| 4 | restart the helper (`ui close`, then `snapshot`) | fixed: fresh helper + fresh guest read the already-relaunched app fine (`axbridge`, 39 elements). SIGKILL of only the AX bridge guest (helper left running) also fixes it: the next read falls back once, then `axbridge` is back |
| 5 | wait: 25 s idle with no AX calls, 20-30 s of polling (`ui wait`), 6 snapshots over 24 s | never recovers by waiting: not timing |
| 6 | `health` (no probe) | still says `ax.bridge: "available"` while every read fails: misleading. `health{probe:true}` reports `bridge: "failed"` with the same `did not respond ... pid <new pid>` text |
| 7 | pid | the pid in every error is the CURRENT app's new pid (differs from the pre-relaunch one), so not a stale-pid lookup. `screenshot` before the snapshot does not help |
| 8 | the launched app is in the foreground | yes; `simctl launch` ok, Metro lists the new inspector target, the app renders |

Reading: the long-lived AX guest (`automationMode: true`, `.exclusive`) loses its ability to read a NEW process of the same bundle id. `settle` (its stream restart "re-enables automation mode") or recycling the guest restores it; nothing else tried does. So the app is up and idle; the guest's per-application automation state is what goes stale across a relaunch (inside `axBridgeReader`, not in the TS client). Suggested helper fixes: on `E_APP_NOT_RESPONDING` from the `axbridge` reader recycle the guest (or restart the quiescence stream) and retry once before falling back to `ax`; recycle/re-arm on the `launch`/`terminate` the helper sees; make `health` reflect the last read failure. TS-side stop-gap (not done): after `app.launch`, run `settle({bundleId})` before returning (costs 1-8 s per launch).
Impact: any `warden e2e` spec process that relaunches the app (`launch: "fresh"` before every test) fails every test after the first on a warm helper, e.g. several `example-dev` flows in one process; I did not test why single-launch flows pass. A `warden ui open --relaunch` followed by `snapshot` is affected the same way.

**Relaunch fix verification (2026-10-16, helper built from simd-core's d32682d, then 7773fb7).**
- d32682d (single shared guest + empty-root re-read): `ui` relaunch x3 clean on Release and the dev client, a 3-launch spec (`launch` x3 in one process) 3/3, and `warden e2e example-dev` multi-flow runs got past the relaunch. simd-core later showed the real trigger is the helper idle-closing its quiescence stream after 10 s, which my fast cycles (<= 8 s between relaunches) did not exercise.
- 7773fb7 (on not-responding, open a quiescence stream, wait for its first state, re-read, then fall back to `ax`): Release build, idle 15 s (so the stream has closed), then `simctl launch --terminate-running-process`, snapshot, x3: `axbridge`, 35 nodes every time, first read 2.0-3.0 s (the extra stream open), helper log `axbridge: The application with pid <new> did not respond ...; opening a quiescence stream and reading again` once per cycle and no `axbridge -> ax fallback`. `example-dev`: three `launch` tests in one process pass 3/3 (7-9 s each); `sign-in` (3 tests), `devtools` pass.
- Not relaunch related, still failing intermittently on `example-dev`: (a) `openSignIn` tapped Next twice 55 ms apart and the second tap was dropped mid-transition (`welcome-get-started` never appeared); fixed in `apps/example/e2e/helpers/flows.ts` by awaiting the step title between taps (as `onboarding.e2e.ts` does), after which every flow gets past onboarding; (b) after sign-in the screen reports `modal present` (83 elements, the todos screen is in the tree but its testIDs are filtered behind a system sheet, most likely the Keychain "Save Password?" sheet that appears after `expectTodosAfterSignIn` returned), so `todo-input` / `settings-email` are not found: `todos` and `settings` fail on this, with or without the devtools flow in the process. `devtools` (one launch, reload at the end) passed 5 of 6 runs; the one failure was a post-`reloadJs` snapshot timeout while the machine was busy, not reproduced in 10+ manual reloads.

**T12 AC "replace `expectLabel` if `text()` fallback holds" (2026-10-16, simd-core).** Nothing to replace: `expectLabel` and every label-based workaround were removed in the T10 migration (7fa02fb); `apps/example/e2e` uses only `getByTestId(..).toHaveText(..)`, plus one `getByText(..).toBeVisible()` where text is meant. The descendant-text fallback holds on real iOS (Release, `warden e2e example --flows todos,settings,todo-detail,onboarding`): `todos-remaining` is an `[other]` container whose text sits in a child `[text]`, and `toHaveText("1 left" / "2 left" / "0 left")` passes through the fallback (`todos` and `onboarding` passed). The two failing flows failed on a system sheet, not on text reads: `settings` (sign-out tap blocked, "Save Password?" sheet in `screen-at-failure.txt`) and `todo-detail` (todo title not found behind the Keychain "Save Password?" / "Open in warden-example?" sheets), the same Keychain-sheet issue as (b) above; `expectTodosAfterSignIn` returns before that sheet appears. No workaround was kept for text, none needed.

**Post-sign-in "modal present" and the example-app crash (2026-10-16).**
- Confirmed: the sheet is the iOS "Save Password?" sheet (buttons `Not Now` / `Save`). It appears 1.3-2 s AFTER the todos screen is visible (so `expectTodosAfterSignIn` returned before it existed), `alertButtons` sees it and `device.alert("dismiss")` presses `Not Now` (probe: `alertPressed=true`, sheet gone next read). The interactive snapshot filters the app's testIDs while it shows. Fix: `dismissSavePassword(device)` in `apps/example/e2e/helpers/flows.ts` polls `device.alert("dismiss")` for 5 s after the todos screen shows. No `device.ts` change needed (the "Save Password" / "Not Now" alert case is already unit-tested).
- Sim-level switch: tried `defaults write` on `com.apple.mobilesafari`, `com.apple.AuthenticationServicesCore.AuthenticationServicesAgent` (ShouldAutoFillPasswordsFromKeychain / shouldAutoFillPasswords), `-g` and `com.apple.Preferences` AutoFillPasswords: none removed the sheet (writing `-g` / Preferences keys left the app unstable); reverted. The real toggle is MDM/profile restricted (`isUserAllowedToTogglePasswordAutoFillEnabledState`), so skipped.
- Main remaining flake is NOT the sheet: the example app aborts (SIGABRT) on the `com.pulsar.audio` thread (`AURemoteIO::Cleanup` -> `_ReportRPCTimeout`, react-native-pulsar's AVAudioEngine) at random points in a run (crash reports `~/Library/Logs/DiagnosticReports/wardenexample-*.ips` at 03:53, 04:07, 04:12, 04:34, 04:47, 04:49). The app then comes back on the welcome screen, so the next locator fails (`todo-input`, `welcome-title`, `sign-in-email` "fill did not take" ...). `todos` alone on one sim passed 1 of 3 after the sheet fix. Aliasing `react-native-pulsar` to a JS stub did not help (the native engine starts at launch; it crashed on every launch). Needs an app/native fix (drop pulsar from e2e builds or keep its audio engine off in simulators), not a runner change.

**D11 recovery regression smoke on the final build (2026-10-16, simd-core, `f0b18cd`+).** iPhone 17 sim (own lease, released), Release example app (`cc063702`), helper built from this branch. Load average 440 / 409 / 313 during the runs (many agents building and running e2e), so every latency is a loaded-machine number. Helper lines in `~/.warden/simd/<udid>.log` and every payload showed no `fallback` and no repair warn during the relaunch runs.

| check | method | result | verdict |
|---|---|---|---|
| `smoke.ts --kill-bridge` | SIGKILL of the exclusive AX guest | recovered on the first retry: `ok (778 ms, 116 nodes)`, pkill signalled it | pass |
| `smoke.ts --kill-helper` | SIGKILL of warden-simd during a 3 s long press | in-flight call `E_HELPER_CRASHED` once, `[simd] respawning helper (1/1)`, next tap `ok` in 209 ms incl. respawn | pass |
| relaunch x N, no fallback | terminate + launch, first `snapshot` | no read (about 50 across the runs) fell back to `ax`, 0 repair warns (no `E_APP_NOT_RESPONDING` path hit) | pass |
| relaunch x N, first read < 300 ms | same, 4 s after launch | quiet-ish window: 11 reads p50 242 ms, 8 of 11 < 300, max 725 ms (113 173 725 223 333 267 346 282 119 69 242); under heavier load (load 440): 223-1605 ms | partial: target holds only at moderate load, never fails, never falls back |
| settle, idle screen < 400 ms | `settle{quietMs:250}` on the idle welcome screen | 252, 257, 261, 258, 259, 267 ms, all `via:"stream"` | pass |
| settle under animation | `settleTimeoutMs:300` with a CSS-animated page in Safari | `quiet:false` x3 at 307-315 ms (`via:"stream"`) | pass |
| settle right after a relaunch | terminate + launch, immediate `settle{bundleId}` (what `app.launch` + settle costs) | works: 1.6-2.9 s `via:"stream"` (the app's own boot, the screen is still the launch screen with 5 nodes). Intermittent (about 1 cycle in 3 under this load): the stream stays on the old process, so `settle` returns `quiet:false, reason:"frontmost_mismatch"` after the full 8 s, or restarts and falls back to snapshot stability after 5-6 s. Same rate with `WARDEN_SIMD_STREAM_IDLE_S=1` (3 of 8), so it is not caused by the lifetime stream | open, see below |
| second helper on the same sim | a second `warden-simd --socket ...` process (stale/foreign helper) while the leased helper reads, with and without relaunches | no read in either helper stuck or failed (reads 56-1100 ms, no `E_APP_NOT_RESPONDING`). `settle` in the leased helper degrades from 258 ms to `via:"snapshot"` at 2.4-2.9 s (`quiet:true`, still correct) for as long as the other helper's stream is open, and the same for the other helper. With `WARDEN_SIMD_STREAM_IDLE_S=1` on both and 4 s gaps, the leased helper's settles stayed on the stream (0.9-1.4 s, the cost of reopening it), 1 of 5 ended `quiet:false` at 3 s; concurrent activity still collides | pass (no stick), degradation documented |

Open items from this run:
1. `settle` after a relaunch can burn the whole timeout (`frontmost_mismatch`) or 5-6 s (fallback). The one restart after `restartAfterMs` often re-latches the old process while the new one is still launching. Candidate fix (not done, needs a quiet machine to verify): on mismatch, wait for the launch to finish (resolved pid reported frontmost by `launchctl`) before restarting, and restart repeatedly every 1 s instead of once. Callers that follow `app.launch` with a snapshot-based wait (the TS `screen` layer) are not affected.
2. A SpringBoard-owned prompt left over (my Maps "Allow location" alert) makes `settle{bundleId}` report a legitimate `frontmost_mismatch`; it is not a helper bug.

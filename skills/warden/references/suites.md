# Suites: `warden e2e`, `warden affected`, `e2e.<suite>` config

Read this to run, select, configure or debug a suite. Spec authoring is in `specs.md`.

## `warden e2e [suite]`

Selects the specs a change needs, leases devices, runs one `bun test` per spec (or per device), gates on the result. `[suite]` is optional with one suite. With no suite configured (and none named), an Expo app with an `e2e/` dir gets a default suite: every spec there, no git diff, 2 devices, iOS unless `--platform android`, the dev client on warden's Metro (`warden init` writes it out to edit). `--install-mode` / `--reset-keychain` (and the deprecated hidden `--clean` = `--install-mode reinstall`) need the suite to install an app (`app` in its config, or `--app`); otherwise refused before any device is claimed.

```bash
warden e2e example --dry-run --explain     # what would run and why, nothing leased
warden e2e example                         # the specs this branch needs
warden e2e example --all                   # every spec
warden e2e example --specs todos,settings  # exactly these ids / globs
```

| Flag | Meaning |
|---|---|
| `--base <ref>` | diff against merge-base with this ref (suite `base`, default `main`) |
| `--platform ios\|android` | default: the suite's platform. A suite with no `platform` runs both: `e2e` refuses without it (`warden affected` reports both) |
| `--files <list>` | comma-separated changed files instead of git |
| `--all` / `--specs <ids\|globs>` | skip the diff. Exclusive with each other, and neither combines with `--files` |
| `--required-only` | only specs with `required: true` |
| `--explain` / `--dry-run` | print why each spec was selected / select, run nothing |
| `--report <file>` | also write `e2e-report.json` there |
| `--json-lines` | stdout is NDJSON: `{"event":"test",spec,file,title[],status,durationMs,error?,code?,line?,artifacts?,device}` per test as it finishes, then `{"event":"report",report}`. Progress stays on stderr |
| `--devices default\|all\|<profile,...>` | which `devices` legs run |
| `--no-shutdown` | keep devices up after a pass (default: shut down those warden created, locally and under CI; suite `shutdown`) |
| `--dev` | the dev client (kind `dev`) on a Metro warden starts: the suite's `metro` block, or the defaults when it has none. Not with `--kind` / `--variant` |
| `--kind dev\|simulator\|release` | build kind the devices get (default: the suite's `app.kind`, else `simulator`; `release` on a physical run). `dev` starts Metro like `--dev` |
| `--no-warm` | skip the iOS driver warm-up (never skipped for an iPhone: its jobs reach the runner host through it) |
| `--physical` / `--serial <serial...>` / `--udid <udid...>` | run on physical phones/tablets, see "Physical devices". `--serial` is Android, `--udid` is iOS (CoreDevice UDID); naming devices implies `--physical`. Win over the suite's `physical` |
| `--perf [captures]` | profile every attempt: bare = metrics, frames, logs; or `--perf=react,js`, `all` (names: `all js react native metrics frames logs`). Reports land in the attempt's `perf/` dir; suite/top-level `perf.budgets` make a breach fail the test (`PERF_BUDGET`) |
| claim flags | `--profile --runtime --count --max --wait --no-wait --priority --ttl --label --adopt --headless --no-headless --slim --no-slim --biometrics --camera --json` (`--json` prints the e2e report) |
| lease flags | `--port <from:span>` (repeatable), `--app --install-mode clean\|reinstall --reset-keychain --project --bundle-id --variant --kind --no-eas --no-build` |
| batch flags | `--retry --passes --serve --serve-ready --serve-timeout --job-timeout --record <dir> --logs <dir> --no-tui` |

Suite settings are defaults. A flag passed on the command line wins.

**Verdict (stderr):** failed specs with their tests, then `warden e2e: tests <n> passed · <n> failed · <n> skipped`, `<k>/<n> failed tests share one error: <msg>` when 2+ do (usually the root cause, not the specs), `evidence in <batchDir>`, then `<k>/<n> spec(s) passed — gate passed|failed`.

**GitHub Actions** (`GITHUB_ACTIONS=true`, automatic): one `::error` per failed test on its spec file at the line it failed (`::warning` for an optional spec; a spec with no results is annotated on the file), paths relative to `GITHUB_WORKSPACE`; on stdout, on stderr with `--json` / `--json-lines`. A markdown table of failed tests is appended to `$GITHUB_STEP_SUMMARY`.

**Exit codes:** `0` every required spec passed (or nothing affected, or dry-run). `1` the gate failed or an error. `130` interrupted.

**Preflight (fails before any claim):** `@delacour/warden-e2e` resolves (the repo's copy at warden's version, else the one warden ships). No bun install needed: warden runs the specs as bun itself (`BUN_BE_BUN=1`), or with `WARDEN_BUN` when set. **What runs:** `bun test --preload @delacour/warden-e2e/preload --timeout <spec timeout + 30s> <files>`.

- `isolate: device` (default): one `shard-<k>` process per device, specs spread round-robin by sorted id. A crash fails the spec it hit and the ones it never reached; a retry reruns only the specs that did not pass.
- `isolate: spec`: one process per spec, one worker per device (the default with `passes > 1`).

## `warden affected [suite]`

```bash
warden affected example --base origin/main --explain
warden affected example --platform ios | warden batch ios --jobs-from - -- <cmd> {job}
```

Flags: `--base --platform --files --required-only --explain --strict --json`.

merge-base with `--base`, then `git diff --name-status -M` plus untracked files. Changes outside `scope` or matching `ignore` drop out. A `runAll` match selects every spec. Otherwise a spec is selected by its `paths` globs or by the import graph from its `entries` (up to `maxDepth` hops; `routerRoot` adds `_layout` files; cache in `$WARDEN_HOME/affected`). Then `always` specs, `unmapped` specs and `unmatched` changes apply.

Default output is one spec id per line. `--strict` exits `3` when a change reaches no spec.

## Suite schema `e2e.<suite>`

Paths and globs are relative to `warden.config.ts`. Unknown keys are errors.

### Selection
| Key | Default | Meaning |
|---|---|---|
| `specsDir` | required | dir of `*.e2e.ts` files |
| `specs` | `{}` | `{ <id\|glob>: { entries, paths, platforms?, maxDepth?, required? } }` |
| `runAll` / `ignore` / `always` | `[]` | globs: select all / select nothing / spec ids that always run |
| `include` / `exclude` | `[]` | spec-id globs that may / never be selected |
| `scope` | `[]` | only changes matching these count |
| `unmatched` | `skip` | `run-all` or `skip` for a counted change that reaches no spec |
| `unmapped` | `run` | `run` or `skip` for a spec with no entries/paths |
| `base` | `main` | git ref |
| `maxDepth`, `tsconfig`, `routerRoot` | none | import-graph tuning |
| `platform` | both | `ios` or `android` |
| `required` | `true` | default for specs that do not set it |

### Devices and Metro
| Key | Default | Meaning |
|---|---|---|
| `devices` | none | `[{ profile, count = 1, env?, default = true }]`. Replaces `profile` / `count`. At least one leg must be default |
| `count`, `profile` | claim defaults | single pool |
| `runtime` | newest installed | iOS simulator runtime for the run's devices and their golden: `latest`, `iOS-26-5`, `26.5`. Applies to every `devices` leg. `--runtime` wins. Not installed → the run fails before any claim, listing the installed runtimes (never another runtime). Skipped with a note on an Android run. `warden golden key --profile <p> --runtime <r>` names the golden the run uses. See "Pin the iOS runtime" |
| `metro` | none | `{ enabled = true, port = "8081:100", launchArgs = [], open = true, env, prewarm = true, readyTimeout = "2m" }`. warden starts one Metro for the run and points the dev client at it. Applies only with `--dev` / kind `dev`, unless the suite pins `app.variant` or `app.kind: "dev"`, or installs no app. Without Metro (kind `simulator` / `release`) its `env` is still the bundle env: `EXPO_PUBLIC_*` values land in the repacked / built JS (and its cache key), over `.env*` and the shell |
| `headless` | off | keep Simulator.app windows closed (top-level `headless` is the default; `--headless` / `--no-headless` win) |
| `slim` | on | iOS only: simulator daemons specs never need are off from first boot. `false` leaves them running; `true` is the default profile; `{ except?: string[]; keep?: string[] }`: `except` keeps whole categories running (ids from `warden sim profiles`, e.g. `store` for push/StoreKit, `web` for universal links, `search` Spotlight, `pim` Contacts/Calendar pickers, `photos` photo picker), `keep` keeps single `com.apple.*` labels. Unknown ids fail config load. `--no-slim` / `WARDEN_SLIM=0` opt out. Skipped with a note on an Android run; refused on a suite fixed to `platform: "android"` |
| `physical` | off | `true` = any ready physical device, `{ ids: [...] }` = exactly these (adb serials / CoreDevice UDIDs). Also per `devices` leg (a leg's wins). Not with `slim` / `headless` / `biometrics` / `conditions` (config error). Command-line `--physical` / `--serial` / `--udid` win. See "Physical devices" |
| `reclaim` | `none` | `erase` \| `uninstall` \| `none`: what happens to the suite's devices when they are released. Top-level `reclaim` and `batches.<preset>.reclaim` work the same (suite / preset wins over top level, which wins over `WARDEN_RECLAIM`). See "Reclaim on release" |
| `biometrics` | off | devices have a fingerprint (Android) / Face ID (iOS) enrolled before any app install. Own pool and golden: profile `<profile>+bio`. Top-level `biometrics` and `batches.<preset>.biometrics` work the same (suite / preset wins over top level); `--biometrics` on claim/run/batch/e2e turns it on for one run |
| `golden` | off | iOS: `true` clones the suite's new sims from a golden (first-booted, settled sim built once per profile + runtime). Off: each new sim is a fresh `simctl create` + first boot, and `warden ci cache --suite <name>` prints `golden: null`, so the e2e action restores, builds, saves and collects no golden. Pool sims already there are reused either way; `WARDEN_GOLDEN=0` turns it off for every claim |
| `warmDrivers` | on | iOS: start every device's driver helper before the specs, one device after the other; each retries its first snapshot (one read per try) with backoff (2 s, then 5 s) for up to 2 min before it goes cold |

### Conditions
| Key | Default | Meaning |
|---|---|---|
| `conditions` | none | `{ network?, location?, clock?, permissions?, locale?, timezone?, a11y?, keyboard? }` at the top level or per suite (a suite's key replaces the top-level one per area): the device state every spec starts from, applied before the app launches and put back after each spec. `network`: `"online" \| "offline"`, a preset (`edge 3g 4g lte wifi slow lossy`) or `{ latencyMs, jitterMs, downKbps, upKbps, lossPct }`. `location`: `{ lat, lon, altM? }` or `"city-run" \| "city-bike" \| "freeway"`. `clock`: an ISO instant (keeps running), `{ at, frozen? }` or `{ offset: "2d" }`. On iOS a declared `network` / `clock` launches the app with the network dylib, so specs can change it later. `permissions`: `{ location: "denied", camera: "granted", … }` (names as `device.permissions.set`, applied before the app launches). `locale`: a BCP 47 tag. `timezone`: an IANA name. `a11y`: `{ textSize?, boldText?, contrast?, reduceMotion? }`. `keyboard`: `"software"` (the default: the on-screen keyboard stays up while specs type) or `"hardware"` (hidden); applied to every spec on a warden-leased device, never a physical one. A bad value fails config load |

### Accessibility
| Key | Default | Meaning |
|---|---|---|
| `a11y` | none | `{ rules?, ignore?: [{ rule, identifier? }], minSeverity?: "error" \| "warning" }` at the top level or per suite (a suite's key replaces the top-level one, per key). Defaults for `device.a11yAudit()` / `toPassA11yAudit()`; written to the spec process as `WARDEN_A11Y_AUDIT`. Setting it (even `{}`) also launches iOS apps with the injected library (`WARDEN_A11Y=1`); `warden e2e --a11y` does that for a suite without the key. Rules: `a11y.md` |

### Camera
| Key | Default | Meaning |
|---|---|---|
| `camera` | none | per suite: `{ back?, front? }`, each a path or `{ path, loop? }` (video loop, default true), relative to the config file; png jpg heic mp4 mov. Applied before each spec's first `app.open()` (exported to the spec as `WARDEN_CAMERA_FEEDS`), put back after each spec. Android legs of the suite claim `--camera` (profile `<p>+cam`, cold boot); iOS needs no special device. A missing or unsupported file fails the spec `INVALID_ARGUMENT` (`E_CAMERA_NOT_FOUND` / `E_CAMERA_MEDIA`). Refused with `physical`. Specs change it with `device.camera` |

### App, ports, serve, setup
| Key | Default | Meaning |
|---|---|---|
| `app` | none | `true` or `{ installMode, resetKeychain, variant \| kind }`: install the project's app on each device first. `kind` (`dev` \| `simulator` \| `release`, default `simulator`) picks the build; `variant` keeps the old variant build and its `metro` (not together with `kind`) |
| `project` | config dir | `projects[].name`; specs, serve and setup run in its root |
| `ports` | none | `["<from>[:<span>]"]`, exported as `WARDEN_PORT_<i>` and `WARDEN_PORTS` |
| `env` | none | added to serve, setup and spec env |
| `serve` / `serveReady` / `serveTimeout` | none | `sh -c` once per run before the first spec (own process group), killed once after the last. One process shared by every device, leg, retry, `passes` repeat and shard, never restarted, so its state (users, codes) lives for the whole run and specs must isolate themselves (e.g. a unique user per test). A fixed port still held by a leftover process is not detected by `serveReady`. `serveReady` is `http://...`, `tcp:PORT` or `file:PATH`. Both need `serve` |
| `setup` | none | `sh -c` once per device before its first spec; `{udid}` is substituted. A non-zero exit drops that device |

### Runtime
| Key | Default | Meaning |
|---|---|---|
| `spec` | `{}` | `{ bundleId, launchArgs, timeout = "2m", actionTimeout = "30s", assertionTimeout = "5s" }`. `bundleId` defaults to the project's |
| `isolate` | `device` | `device` or `spec` (`spec` when `passes > 1`) |
| `shutdown` | `always` (`idle` under `CI`) | `always`: shut down warden's devices (and close their windows) after a passed gate; ephemeral iOS sims are then deleted. `idle`: leave them booted for the next run (`warden gc` reaps idle ones). A failed run always leaves them up |
| `jobTimeoutMs` | `600000` | per spec: a process past this for each spec it runs is killed and counts as failed |
| `passes` | `1` | consecutive green runs needed per spec. `isolate: device` with `passes > 1` is an error |
| `retry` | `0` | re-run a failed job on the same device. Under `isolate: device` a retry reruns only the specs that did not pass |
| `perf` | none | `{ budgets: { startupColdMs, jankPct, maxCommitMs, p95CpuPct, peakMemoryMb } }` ceilings (lower is better) for `device.perf.stop()`; each key replaces the top-level `perf.budgets` one |

Removed: `warmRunners` (use `warmDrivers`).

## Build kinds and the repack

`app: true` installs the `simulator` kind: a Release build with no JS embedded, built once per native fingerprint (`kinds.simulator` config, built-in command by default), then this worktree's JS is bundled (Hermes-compiled, ad-hoc re-signed) into a clone of it: a repack keyed by the JS content (`jsKey`: `kinds.simulator.jsInputs` + bundle env + native fingerprint), not by branch. Same JS in two worktrees = one repack. The run repacks once before the first device installs, not per device. `--dev` / `--kind dev` runs the dev client on Metro; `--kind release` the JS-embedded build.

| `projects[].kinds.<kind>` | Meaning |
|---|---|
| `build` | `{ ios?, android? }` build command replacing the kind's built-in one |
| `env` | env of the build and of the JS bundle step (`EXPO_PUBLIC_*`, `NODE_ENV`); part of the `jsKey` |
| `jsInputs` | globs of the JS sources `simulator` / `release` key on (default: every tracked file but `ios/`, `android/`, `node_modules`) |

- Device builds (iPhone / iPad, `--udid` or `--physical`): `--kind dev|release` build with `xcodebuild -destination generic/platform=iOS -allowProvisioningUpdates CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=<team>` into `ios/build` (`<Config>-iphoneos`), cached under `<nativeFp>/device/<team>/<kind>/` with the team in the key (another team, or another `ios.device.bundleIdentifier`, is another build; a simulator build is never reused). Team: `WARDEN_IOS_TEAM_ID`, then `ios.teamId`, then the one keychain team (`ios_team_ambiguous` otherwise). No kind on an iPhone means `release`; `--kind simulator` and `--variant` fail (a repack cannot be re-signed yet). Installed, probed and removed with `xcrun devicectl device install app|info apps|uninstall app`; the install record (`installs` table, build key) plus the phone's `CFBundleVersion` decide whether the app is current. `--install-mode clean` reinstalls (data cannot be wiped in place), `--reset-keychain` is refused. `projects[].ios.device.bundleIdentifier` replaces `PRODUCT_BUNDLE_IDENTIFIER` when your id belongs to another Apple team. A phone the app's profile does not list is registered once automatically (a build with `-destination id=<udid>`, then the cached build is rebuilt and installed again; registered UDIDs are recorded beside the build); if it still fails, `device_not_in_profile`; EAS builds are never used. Android phones keep the host-built kinds (all ABIs; `abi_mismatch` guards the install).
- `warden repack ios|android` makes (or finds) the repack and prints `baseHash`, `jsKey`, `artifact`, `reused|repacked`, `bundleMs`; `--force` rebuilds a cached one. A repack is bound to the base it was cloned from (hash of the base's executable + signature, `Info.plist`, `CodeResources`; Android: the apk): after `builds import --kind simulator-base` replaces the base under the same fingerprint, the next repack is rebuilt on its own (`reason: "base-changed"`; `base-unrecorded` once for repacks made before this tracking; `signer-changed` when an Android repack was signed by another key than its base. Android signs a repack only with a keystore whose certificate is the base's signer, else it falls back to a full simulator build), and devices reinstall it.
- Android repack needs the SDK build-tools (`zipalign`, `apksigner`, `aapt2`) and system `zip` / `unzip`. It signs with the keystore Gradle signed the base with: warden copies it beside the base APK (`signing.keystore` + owner-only `signing.json` in the cache dir; never logged or sent) when it builds the base, so a repack needs no `android/`. Order tried: that cached keystore, the project's `android/app/debug.keystore`, `~/.android/debug.keystore`; the first whose certificate is the base's signer wins. A base from `builds import` (CI prebuilt base) or built before this has no cached keystore: it relies on the project / `~/.android` match, else the run builds the `release` kind. The Android simulator base is a plain `assembleRelease` whose embedded bundle is stale on purpose: the repack replaces it. Default Android builds (`dev`, `release`, kind-less) are `expo prebuild` when `android/` is missing, then `cd android && ./gradlew app:assemble<Debug|Release> -PreactNativeArchitectures=<host ABI>`: never `expo run:android`, which installs on whatever emulator is booted.
- Android can't repack new image / raw resources (they live in the compiled resource table): that run builds the `release` kind instead and logs why (`new Android resource(s): … needs a full build`; `fallbackReason` in `--json`). A changed vector drawable is not detected: the base's copy is kept.
- A project's `fingerprint.include: "native+js"` / `fingerprint.jsInputs` belong to the kind-less flow (variants, `warden app ensure` with no `--kind`): `--kind dev|simulator` warns once on stderr that they are ignored. Move them into `kinds.simulator.jsInputs`.
- `warden builds ls` shows each build's kind, base (native fingerprint), jsKey, worktree and branch.

## CI: reuse a prebuilt base and the golden

A fresh runner otherwise builds the simulator base (a Release `xcodebuild`) and the iOS golden (~4 min first boot) every run.

In GitHub Actions use the composite action `delacournz/warden/.github/actions/e2e` (inputs `working-directory suite profile count retry args app-path warden-version bun-version install-command xcode-path headroom-gb report-path cache cache-prefix js-inputs save-cache artifacts upload-artifacts retention-days artifact-name`; outputs `report-path`, `passed`, `cache-groups`, `artifact-groups`, `artifact-paths`): it installs warden and bun (from npm), runs `warden doctor --fetch-helper`, caches the build, the JS repacks and the golden (restore and save separate, save only after a green run with `save-cache: true`, so not on pull requests; `cache: none` skips `actions/cache` and the golden export but still imports the golden, so you store the `cache-groups` paths yourself and run the golden's `beforeSave` when your cache missed it), prints each `screen-at-failure.txt` into the log, then collects artifact groups `report batches logs app golden` (`app` and `golden` as `app.tar` / `golden.tar` in `$RUNNER_TEMP/warden-artifacts`, keeping exec bits and symlinks; `tar -xf golden.tar -C ~/warden-goldens` then `warden golden import`) and uploads each as `<artifact-name>-<group>` (`artifacts: all` default = every group after a green run (less `golden` when restored from the cache), `report,batches,logs,golden` after a failed one; a list picks groups, `none` skips; `logs` always collected, even with a list or `none`; the golden is exported only when built and not yet in `~/warden-goldens`, never built for it; `upload-artifacts: false` only collects, upload from the `artifact-paths` JSON `{group: [path]}` yourself). Docs: `/docs/e2e/ci`. By hand, the steps are:

| Step | Command |
|---|---|
| every cache key and path at once (any CI) | `warden ci cache --json [--project <dir>] [--prefix warden-e2e-v1] [--profile <p>] [--js-input <pathspec>]… [--golden-dir ~/warden-goldens] [--suite <name>]` → `{builds, repack, golden}`, each `{kind, key, paths}`; `golden` is `null` when the suite (`--suite`, else the only one) does not set `golden: true`; `kind: "paths"` = store the dirs as they are (a `!` path is excluded); `kind: "archive"` (golden) adds `afterRestore` / `beforeSave` commands to run around them. Keys: `<prefix>-builds-<os>-<arch>-<fp>`, `<prefix>-repack-<os>-<arch>-<fp>-<js>`, `<prefix>-<os>-<arch>-<golden>` (`RUNNER_OS-RUNNER_ARCH` when set). iOS only |
| base key (the native fp the base is filed under) | `warden app fingerprint ios --kind simulator --json` → `.fingerprints.ios`, `.hashes.ios` (`<fp>:base`). Not `@expo/fingerprint`'s hash |
| seed the base from another job's `.app` | `warden builds import path/App.app --kind simulator-base [--hash <fp>] [--project <dir>] --json` |
| golden cache key | `warden golden key [--profile <p>] [--runtime <r>]` → `warden-golden-<profile>-<key>-r<recipe>` (Xcode build + runtime build + device type + recipe) |
| restore golden | `warden golden import <dir>` (exit 0; missing dir, stale or broken archive, golden already here → skipped with reason; the next claim builds it) |
| save golden on a cache miss | `warden golden export <dir> [--profile <p>] [--runtime <r>]` (builds it first if missing) → `<dir>/<name>/{golden.json,device/}` (~2 GB). Exit 1 on a golden that never settled (still usable locally); `--allow-unsettled` exports it anyway (`"unsettled": true` in `--json`), for a runner too small to ever settle one. Run it only after a green run (`success()`, never `!cancelled()`) |

- A simulator `.app` built with `CODE_SIGNING_ALLOWED=NO` has no entitlements, so Keychain calls fail with `errSecMissingEntitlement` (-34018): build with `CODE_SIGN_IDENTITY=-`. `builds import` warns when the `.app` has no `application-identifier` (`applicationIdentifier: false` in `--json`).
- Repack cache for CI: `~/.warden/builds/*/ios/*/simulator/repacks`, keyed on the fingerprint plus a hash of the project's JS inputs; cache the rest of `~/.warden/builds` apart from it. A restored base / repack dir with no `warden.db` row is registered on first use (source `restored`), never rebuilt.
- `--kind simulator-base` checks the `.app`: `DTPlatformName` `iphonesimulator`, a slice for this Mac (`arm64` on Apple silicon: `ARCHS=arm64`), `CFBundleIdentifier` = the project's iOS bundle id (`--bundle-id` overrides), no Debug / dev-client payload (`<exe>.debug.dylib`, `EXDevLauncher`, `EXDevMenu`). An embedded `main.jsbundle` is stripped from the cached copy (`strippedBundle: true`); every repack writes its own. Android: not supported (`--kind` is iOS only).
- `golden import` registers a fresh `-wip` device with `simctl create`, copies the archive over its dir (not `device.plist`), re-points absolute symlinks to the new udid, checks the first-boot migration record and `AutomationEnabled`, then renames it: no CoreSimulatorService restart, other sims untouched. `--platform android` is refused for key / export / import.

## Pin the iOS runtime

Accessibility values change between iOS releases, so a suite should run on one runtime locally and on CI. Set `runtime` in the suite (or pass `--runtime`); a runtime that is not installed fails before any claim with `iOS runtime "<r>" is not installed (installed: …)`. Devices and goldens are matched on the runtime (`27.0`, `iOS-27-0` and `iOS 27.0` are the same), so a pool never hands the run a sim on another one.

```ts
e2e: { mobile: { specsDir: "e2e", platform: "ios", profile: "iphone-17", runtime: "27.0" } }
```

```bash
warden golden key --profile iphone-17 --runtime 27.0   # the cache key of the golden the run uses
warden e2e mobile --all                                 # runs on 27.0 (suite runtime)
warden e2e mobile --all --runtime 26.5                  # flag overrides the suite
```

## Example config (`apps/example/warden.config.ts`)

```ts
const BUNDLE_ID = "nz.co.delacour.warden.example";
const DEV_MENU_OFF = ["-EXDevMenuShowsAtLaunch", "NO", "-EXDevMenuIsOnboardingFinished", "YES",
	"-EXDevMenuShowFloatingActionButton", "NO"];
const SPEC = { bundleId: BUNDLE_ID } satisfies WardenE2eSpec;
const SIGNED_IN = ["src/app/welcome.tsx", "src/app/sign-in.tsx"];

const AFFECTED = {
	project: "example",
	specsDir: "e2e",
	platform: "ios",
	routerRoot: "src/app",
	maxDepth: 3,
	unmatched: "run-all",
	runAll: ["package.json", "app.config.ts", "metro.config.js", "src/components/ui/**", "src/styles/**",
		"src/lib/**", "src/hooks/**"],
	ignore: ["**/*.test.ts", "**/*.md", "warden.config.ts", "biome.jsonc", "tsconfig.json"],
	specs: {
		onboarding: { entries: ["src/app/welcome.tsx"] },
		"sign-in": { entries: SIGNED_IN },
		todos: { entries: [...SIGNED_IN, "src/app/(tabs)/todos.tsx"] },
		// todo-detail, settings, devtools: same shape
	},
} satisfies Partial<WardenE2eSuite>;

// project: kinds: { simulator: { env: { EXPO_PUBLIC_E2E: "1" }, jsInputs: ["src/**", "assets/**", ...] } }
// `warden e2e example`: the repacked simulator build. `warden e2e example --dev`: dev client on the suite's `metro`
e2e: {
	example: {
		count: 2,
		app: true,
		slim: true,
		spec: SPEC,
		metro: { env: { EXPO_PUBLIC_E2E: "1" }, launchArgs: DEV_MENU_OFF },
		jobTimeoutMs: 15 * 60_000,
		...AFFECTED,
	},
},
```

## Physical devices

`warden e2e <suite> --physical [--platform android]`, `--serial <adb serial…>` (Android), `--udid <CoreDevice UDID…>` (iOS), or `physical` in the suite / a leg. `run` and `batch` take the same three flags. The leg runs on the named (else any one ready) phone, never creates or boots one, so `--count`, `--max`, `--slim`, `--headless`, `--runtime`, `--adopt`, `--biometrics` are refused with it (the device count is the number of ids).

A physical leg does none of: reboot, headless hide, window arrange, slim, golden clone, shutdown on finish. A suite `setup` command still runs. `WARDEN_UDIDS` / `WARDEN_UDID` carry the adb serial / CoreDevice UDID, and each job gets `WARDEN_DEVICE_KIND=physical` (a mixed run: only the phone's jobs).

- Android: the APK installs through `adb install -r` after an ABI check (`abi_mismatch`). Default kind on a physical run is `release` (not the x86_64 `simulator` repack); `--kind dev|release` or the suite's `app.kind` picks. `--install-mode clean|reinstall` only touches the suite's own bundle id; any other package is `E_REFUSED` (`physical_protected`).
- iOS: warden starts the phone's runner host (`__ios-runner-host`, signs and builds the runner on first use) before the specs and hands each job `WARDEN_IOS_RUNNER_SOCKET`. A lost runner connection restarts the host once and reruns the test; the phone is never rebooted and `simctl` never runs. `--app` / a suite `app` installs a **device build** (below); `WARDEN_BUNDLE_ID` is `projects[].ios.device.bundleIdentifier` when set, else the suite's.
- The driver of a physical iPhone has no pinch and no multi-touch. Mark a spec that needs them `test("zoom", { requires: ["pinch"] }, ...)` (or `"multiTouch"`): it is skipped at collection on a physical iPhone and runs elsewhere. On other devices the driver decides at run time (Android without `warden-uiad` throws `INVALID_ARGUMENT`; use `platforms` there).

## Env the spec process gets

Set by warden. Never export these for a suite run.

| Source | Variables |
|---|---|
| spec contract | `WARDEN_UDID WARDEN_PLATFORM WARDEN_BUNDLE_ID WARDEN_DEVICE_NAME WARDEN_LAUNCH_ARGS WARDEN_E2E_OUT WARDEN_E2E_TIMEOUT WARDEN_E2E_ACTION_TIMEOUT WARDEN_E2E_ASSERTION_TIMEOUT WARDEN_E2E_SPECS_DIR WARDEN_HELPER_DIR WARDEN_SIMD_SOCKET WARDEN_VERSION` |
| batch job | `WARDEN_WORKER WARDEN_JOB WARDEN_JOB_SEQ WARDEN_PASS WARDEN_BATCH_DIR WARDEN_PORT` (first leased port; the e2e package does not read it) `WARDEN_METRO_URL` (with `metro`) `WARDEN_LEG` (with `devices`) |
| lease | `WARDEN_UDIDS WARDEN_UDID_<i> WARDEN_PORTS WARDEN_PORT_<i> WARDEN_LEASE_IDS WARDEN_HEADLESS` · `WARDEN_DEVICE_KIND=physical` (all devices phones) |
| physical iPhone | `WARDEN_IOS_RUNNER_SOCKET` (the runner host's socket) `WARDEN_IOS_RUNNER_RESTART` (JSON argv the session runs once on a lost runner connection) |
| app / log | `WARDEN_APP_PATH WARDEN_APP_HASH` (with `app`) `WARDEN_LOG_TIMESTAMPS` |
| runner | `BUN_BE_BUN=1` (a compiled warden runs as bun; the preload drops it, so a `warden` a spec spawns stays warden) |
| a11y | `WARDEN_A11Y_AUDIT` (JSON of the suite's `a11y`) `WARDEN_A11Y=1` (iOS: inject loaded; with an `a11y` key or `--a11y`) |
| perf | `WARDEN_BIN` (argv `device.perf` shells out to) `WARDEN_PERF` (with `--perf`) `WARDEN_PERF_BUDGETS` (with budgets) |

## Batch dir

`--record <dir>`, else `$WARDEN_HOME/batches/<id>/`.

```
batch.json  tui.cast  metro.log  e2e-report.json
logs/<w>-<seq>-<job>[.passN].log     (+ .png of the device on failure; `<job>` is `shard-<k>` under isolate device)
logs/setup-<w>.log  logs/warm-<w>.log
e2e/<w>-<seq>[-p<N>]/results.jsonl        (-pN: pass N+1 of an attempt, with passes > 1)
e2e/<w>-<seq>[-p<N>]/<specId>/<title>-<hash6>/   trace.jsonl screenshots/ failure.png screen-at-failure.txt console.jsonl network.jsonl perf/ (with --perf)
```

`e2e-report.json`: `{ suite, platform, base?, isolate, ok, headless, batchDir?, specs[], only?, setup?, warm? }`. iOS `warm[]`: per device `{ worker, udid, ok, error?, axRecovery?, dropped?, quarantined? }`; `axRecovery` `{ outcome: "recovered" }` (backboardd restarted), `{ outcome: "rebooted" }` (the sim rebooted) or `{ outcome: "failed", error, stage? }` (`stage`: `log`, `restart` or `reboot`) when the warm-up found the sim's accessibility service wedged (troubleshooting 119); `dropped: true` = its reads still timed out and it ran no spec, `quarantined: true` = also quarantined for 24 h with a `warm: ` reason (`warden sim unquarantine <udid>` lifts it now). Each spec has `verdict`, `attempts`, `tests[]`; a failed test carries `line` (where it failed in the spec, from the stack) when the spec is on its stack.

iOS bridge stalls (the in-sim accessibility bridge did not answer and the read went to `ax`) show in three places:

| Where | What |
|---|---|
| `results.jsonl` `bridge` | `{ fallbacks, first, last }`: how many reads of the test left `axbridge`, and the first and last with `reason` / `code` plus the stall fields below. Absent when every read was on the bridge |
| `trace.jsonl` `driver.snapshot` span | `fallback` (reason), `stallStage`, `stallReadMs`, `stallDeadlineMs`, `stallGuestAgeMs`, `stallCold`, `stallCooldownMs`, `stallProbes`, `stallRecycles`, `stallRecyclesExhausted`; a failed read's span also carries the helper's `bridgeRecycles` / `bridgeRecyclesExhausted` from `health` |
| `screen-at-failure.txt` line 2 | `# read on ax: axbridge stalled (stage read · read 12004 ms of a 12000 ms deadline · cold (first read) · …)`: that tree may lack testIDs |

Stall fields: `stage` `connect` (no bridge reader) / `read` (a bridge read stalled or failed) / `warm-up` (joined a stalled background warm-up) / `cooldown` (bridge skipped after a stall); `readMs` how long the bridge read ran; `deadlineMs` its deadline (the cold one on a first read); `guestAgeMs` how long the AX guests had been up; `cold` no answer yet since helper start / guest recycle / launch; `cooldownRemainingMs` cooldown left; `probes` bridge reads failed in a row; `recycles` stalled guests the helper had ended before this read (absent while none), `recyclesExhausted` every recycle it may do was spent (3, or `WARDEN_SIMD_BRIDGE_MAX_RECYCLES`); `axWedge` `checking` both readers were silent and the helper checks for a wedged accessibility service, `axWedgeRestarts` backboardd restarts it made (troubleshooting 119). A helper built before this sends only the reason. Fixes: troubleshooting 112.

`batch.json` jobs (one per attempt) may carry `logDrainMs`: ms spent draining the job's log pipes after it exited, summed over its `passes`.

## When it fails, in order

1. `e2e-report.json`: which specs, which verdict, which device.
2. `e2e/<w>-<seq>/results.jsonl`: which test and the error.
3. The test dir: `screen-at-failure.txt` first, then `failure.png`, `trace.jsonl`, `console.jsonl`.
4. `logs/<w>-<seq>-<job>.log` and its `.png`.
5. `metro.log`, `logs/warm-*.log`, `logs/setup-*.log`.
6. A crash: `~/Library/Logs/DiagnosticReports/<app>-*.ips`.

A failed run leaves sims booted (so does a passed one with `shutdown: "idle"`, until `warden gc` reaps them as idle). Clean up with `warden release <leaseId> --shutdown` (a parent session: `--mine --shutdown`). A device that keeps failing: `warden release <id> --bad "<why>"`.

## `warden run` and `warden batch`

| Command | Env and behavior |
|---|---|
| `warden run <platform> -- <cmd>` | `--physical` / `--serial` / `--udid` run it on phones (`WARDEN_DEVICE_KIND=physical`). Child gets `WARDEN_UDIDS WARDEN_UDID_<i> WARDEN_LEASE_IDS WARDEN_PORTS WARDEN_PORT_<i>`, `WARDEN_HEADLESS=1` when headless, `WARDEN_APP_PATH WARDEN_APP_HASH` with `--app`. `--json`: first stdout line `{ leases, ports, cmd }`, the child's stdout goes to stderr |
| `warden batch <platform\|preset> --jobs a,b -- <cmd>` | `--physical` / `--serial` / `--udid` as for `run`; a phone's jobs also get `WARDEN_DEVICE_KIND=physical` (an iPhone's `WARDEN_IOS_RUNNER_SOCKET`). Per job `WARDEN_UDID WARDEN_WORKER WARDEN_DEVICE_NAME WARDEN_JOB WARDEN_JOB_SEQ WARDEN_PASS WARDEN_BATCH_DIR WARDEN_PORT`. `{job} {udid} {worker} {seq}` are substituted in the command; `{port} {metroUrl}` in `serve` and `serveReady`. Jobs also come from `--jobs-from <file\|->` (one per line). A job killed by `--job-timeout` exits `124` |

`warden batch <name>` runs the `batches.<name>` preset of `warden.config.ts` (`ios` / `android` are reserved names); flags passed alongside override it. Preset keys: `platform` (required) `cmd` (required) `project count max profile runtime label ttl wait ports app headless slim biometrics reclaim retry passes env serve serveReady serveTimeout jobs jobsFrom record logs`. At most one of `jobs` / `jobsFrom` (`jobsFrom`: a file, `-`, or `{ command }`).

## Headless, slim, warm, versions

- Headless: `--headless` on claim/run/batch/e2e, `headless: true` in a suite, or `WARDEN_HEADLESS=1`. `warden dev` honors only an explicit `--headless`. warden never launches Simulator.app and closes the windows of devices it leased. That needs Accessibility permission for the terminal, and a failure only warns. Xcode 27's Device Hub: headless opens none of its windows and never launches it; a non-headless claim opens one window per sim it booted (only while Device Hub already runs) and tiles them (`warden arrange [--open <udid…>]`). Don't quit Device Hub mid-run (it shuts every booted sim down) and don't tap a leased sim in it (it can swallow warden's input until the sim reboots). Android is always headless.
- Slim is on by default for warden-created iOS sims (`--no-slim`, `slim: false` or `WARDEN_SLIM=0` to opt out; also a top-level `slim` in `warden.config.ts`). A spec needing a trimmed service sets `slim: { except: ["store"] }`. `warmDrivers` (default on, `--no-warm` to skip) starts one `warden-simd` per device after setup, found through `WARDEN_SIMD_SOCKET`.
- iPhone runner signing (physical iOS): `ios: { teamId?, runnerBundleId? }` in `warden.config.ts`; `WARDEN_IOS_TEAM_ID` wins over `teamId`. With neither, warden uses the team of the `Apple Development` identities in the keychain when they belong to exactly one team, else the build fails `ios_team_ambiguous` listing the teams (set one of the two). `runnerBundleId` defaults to `nz.co.delacour.warden.runner.<team id, lower case>`; set it when Apple says the id is taken (`bundle_id_taken`). The runner is built with `xcodebuild build-for-testing -allowProvisioningUpdates -destination id=<udid>` from sources embedded in warden, cached in `$WARDEN_HOME/ios-runner/<team>/<xcode build>-<source hash>/`; it is rebuilt for a phone not yet in the profile and when the profile expires within 24 h (free teams: 7 days). Build failures carry a code and a hint: `no_account` `no_team` `ios_team_ambiguous` `bundle_id_taken` `device_locked` `developer_mode_off` `runner_untrusted` `ui_automation_disabled` `device_busy` `ddi_unavailable` `unsupported_os` `build_failed`.
- Reclaim on release (opt-in): `reclaim: "erase" | "uninstall" | "none"` in a suite, preset or the top level (precedence: suite / preset > top level > `WARDEN_RECLAIM` > `none`). Applies when `e2e` / `batch` / `run` / `release` / `ui close --release` end a lease on a used device, not to gc's stale-lease reclaim or failed-claim cleanup. The device is held by a `reclaiming` lease (up to 3 min) so no claim takes it mid-reclaim. iOS `erase` = shutdown + `simctl erase`; `uninstall` = remove the `User` apps (keeps `com.apple.*` and warden's runner `nz.co.delacour.warden.runner.*`; needs a booted sim, a shut-down one is left with a note). Android: `erase` is `uninstall` of the third-party packages (`pm list packages -3`), because emulators run `-read-only` and have no safe in-place wipe. Only warden-created devices: foreign, golden, human-quarantined and physical devices are skipped with a note. A failure quarantines the device with a `reclaim: ` reason; `warden gc` retries at +30 s, +60 s (cap 5 min), 3 tries in all, then it stays quarantined: `warden sim unquarantine <udid>` (troubleshooting 97).
- Biometrics: `biometrics: true` (top level, suite or preset) or `--biometrics` makes devices profile `<profile>+bio`. Android: the golden snapshot enrolls a fingerprint (screen-lock PIN `1111`), is saved past the lock screen with the screen kept on, and the AVD gets `hw.fingerprint=yes`; a claim builds a missing snapshot inline (~80 s); prebuild with `warden golden ensure --platform android --profile pixel-10+bio`. iOS: no golden; the provider enrolls on every boot of a `+bio` sim, and the e2e session enrolls again at start (`WARDEN_BIOMETRICS=1`), before app install.
- `@delacour/warden-e2e` must equal the warden version. After upgrading warden: `bun add -d @delacour/warden-e2e@<version>`.

## Lease drift: `warden doctor --leases`

`warden doctor --leases [--fix] [--json]` compares the lease registry with what the providers list. Exit 0 = no drift left, 1 = drift remains (`--fix` that resolves everything exits 0; `--fix` without `--leases` exits 2). `--json`: `{ ok, findings[], fixed, skipped[] }`, each finding `{ kind, severity (drift|info), fixable, fixed, message, ... }`. A platform whose inventory cannot be read (no Xcode / adb) is listed in `skipped` and its device checks are not run.

| Finding | Severity | Meaning | `--fix` |
|---|---|---|---|
| `lease_missing_device` | drift | a live device lease on a device the provider no longer lists (physical phones are never flagged) | deletes the lease (logs `expired` if it was granted) |
| `untracked_booted` | drift | a booted warden-created device with no lease and no `devices` record, so `warden gc`'s idle pass cannot see it (a recorded device is idle-tracked; the warm pool is always recorded) | report only |
| `stale_placeholder` | drift | a `pending:` create placeholder older than the ready timeout (5 min) whose holder pid is dead or whose heartbeat ran past its ttl | deletes it |
| `dead_queue_row` | drift | a boot-queue row whose waiter pid is dead | deletes it |
| `device_missing` | drift | an iOS sim recorded in the store that is neither listed nor on disk (Android records follow running emulators and are `gc`'s to forget) | forgets the record unless a lease holds it |
| `marker_mismatch` | drift | the sim's ownership marker names another warden instance, or is unreadable | report only |
| `marker_missing` | info | a recorded sim made before markers existed | report only |
| `stale_claim_key` | info | an idempotency key whose claim holds no lease or queue row, older than the ready timeout | deletes the key |
| `orphan_reclaim_state` | info | reclaim retry state for a device no longer in a reclaim quarantine | deletes it |

`--fix` only deletes registry rows, each re-checked inside one store transaction. It never shuts down, erases or deletes a device and never touches a leased or foreign one.

**Ownership marker.** Every iOS sim warden creates (fresh or cloned from a golden) gets `.warden-owned.json` `{instanceId, name, createdAt}` in its `~/Library/Developer/CoreSimulator/Devices/<udid>/` dir; `instanceId` is this `WARDEN_HOME`'s random id (store `meta` `instance_id`, created once). Shutdown on release, health-monitor reboots, reclaim `erase` / `uninstall`, `sims prune`, `sims delete` and gc's ephemeral-sim sweep refuse a sim whose marker names a different instance (treated as foreign). A sim with no or an unreadable marker keeps the old rules. Android emulators carry no marker (AVDs are shared definitions, not created per claim).

## Lease history: `warden events` and `warden stats`

Every device lease leaves a trail in an append-only log in the store, written in the same transaction as the change it records. Kept 7 days; `warden gc` prunes older rows (`WARDEN_EVENTS_DAYS=<n>`, a positive integer; a bad value prunes at 7 and gc notes it).

| Command | Behavior |
|---|---|
| `warden events [--since <dur>] [--lease <id>] [--owner <s>] [--follow] [--json]` | Oldest first. `--since` takes `30s` `10m` `2h` `7d`. `--lease` is an exact lease id. `--owner` matches the owner key (`agent:<sessionId>`, `user:<pid>`, `ci:<runId>`) or any substring of it. `--json`: `{ "events": [...] }`. `--follow` polls every 1 s until Ctrl-C and prints only new events (add `--since` for history first); with `--json` it prints NDJSON, one event per line |
| `warden stats [--since <dur>] [--json\|--csv]` | Default `--since 7d`. `claims` (distinct claim ids requested), `wait` (requested → granted, one sample per granted device: `count` `medianMs` `p95Ms`), `duration` (granted → released/expired, per lease ended in the window), `peakConcurrency` overall and per `platform` + `profile` (with `grants`). `--csv` prints `scope,platform,profile,metric,value` rows (durations in ms). `--json` and `--csv` together is a usage error (exit 1) |

Event types (`snake_case`): `requested` (a claim call started) · `queued` (it started waiting; once per claim call, `data.reason` as in `warden queue`) · `granted` (`data.waitMs`, `action` `reuse\|boot\|create\|leased`; `leased` = `warden ui` took a named device) · `released` / `expired` (`data.heldMs`; `expired` = stale, reclaimed by a claim or `warden gc`) · `heartbeat_lost` (a holder's heartbeat found its lease gone) · `evicted` (an idle device shut down for the queue head) · `quarantined` / `unquarantined` · `shutdown` (`data.cause` `idle\|release`) · `device_unhealthy` (health monitor: `data.reason`, `data.consecutive`; physical or foreign devices only report) / `device_recovered` (rebooted under the same lease: `data.attempts`, `data.durationMs`). Fields: `at` (ms), `leaseId`, `resourceKey`, `ownerKey`, `label`, `claimId`, `data`.

Only device leases that were granted are logged. A claim rolled back before it was handed out (boot failed, health probe failed) logs `requested` and nothing else; ports, build locks, create placeholders and warden's own housekeeping holds are never logged. Leases taken before this log existed show no `released`.

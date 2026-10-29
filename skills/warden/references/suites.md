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
| `--devices default\|all\|<profile,...>` | which `devices` legs run |
| `--no-shutdown` | keep devices up after a pass (default: shut down those warden created, locally and under CI; suite `shutdown`) |
| `--dev` | the dev client (kind `dev`) on a Metro warden starts: the suite's `metro` block, or the defaults when it has none. Not with `--kind` / `--variant` |
| `--kind dev\|simulator\|release` | build kind the devices get (default: the suite's `app.kind`, else `simulator`). `dev` starts Metro like `--dev` |
| `--no-warm` | skip the iOS driver warm-up |
| `--perf [captures]` | profile every attempt: bare = metrics, frames, logs; or `--perf=react,js`, `all` (names: `all js react native metrics frames logs`). Reports land in the attempt's `perf/` dir; suite/top-level `perf.budgets` make a breach fail the test (`PERF_BUDGET`) |
| claim flags | `--profile --runtime --count --max --wait --no-wait --priority --ttl --label --adopt --headless --no-headless --slim --no-slim --json` (`--json` prints the e2e report) |
| lease flags | `--port <from:span>` (repeatable), `--app --install-mode clean\|reinstall --reset-keychain --project --bundle-id --variant --kind --no-eas --no-build` |
| batch flags | `--retry --passes --serve --serve-ready --serve-timeout --job-timeout --record <dir> --logs <dir> --no-tui` |

Suite settings are defaults. A flag passed on the command line wins.

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
| `metro` | none | `{ enabled = true, port = "8081:100", launchArgs = [], open = true, env, prewarm = true, readyTimeout = "2m" }`. warden starts one Metro for the run and points the dev client at it. Applies only with `--dev` / kind `dev`, unless the suite pins `app.variant` or `app.kind: "dev"`, or installs no app. Without Metro (kind `simulator` / `release`) its `env` is still the bundle env: `EXPO_PUBLIC_*` values land in the repacked / built JS (and its cache key), over `.env*` and the shell |
| `headless` | off | keep Simulator.app windows closed (top-level `headless` is the default; `--headless` / `--no-headless` win) |
| `slim` | on | iOS only: simulator daemons specs never need are off from first boot. `false` leaves them running; `true` is the default profile; `{ except?: string[]; keep?: string[] }`: `except` keeps whole categories running (ids from `warden sim profiles`, e.g. `store` for push/StoreKit, `web` for universal links, `search` Spotlight, `pim` Contacts/Calendar pickers, `photos` photo picker), `keep` keeps single `com.apple.*` labels. Unknown ids fail config load. `--no-slim` / `WARDEN_SLIM=0` opt out. Skipped with a note on an Android run; refused on a suite fixed to `platform: "android"` |
| `warmDrivers` | on | iOS: start every device's driver helper before the specs |

### Conditions
| Key | Default | Meaning |
|---|---|---|
| `conditions` | none | `{ network?, location?, clock?, permissions?, locale?, timezone?, a11y? }` at the top level or per suite (a suite's key replaces the top-level one per area): the device state every spec starts from, applied before the app launches and put back after each spec. `network`: `"online" \| "offline"`, a preset (`edge 3g 4g lte wifi slow lossy`) or `{ latencyMs, jitterMs, downKbps, upKbps, lossPct }`. `location`: `{ lat, lon, altM? }` or `"city-run" \| "city-bike" \| "freeway"`. `clock`: an ISO instant (keeps running), `{ at, frozen? }` or `{ offset: "2d" }`. On iOS a declared `network` / `clock` launches the app with the network dylib, so specs can change it later. `permissions`: `{ location: "denied", camera: "granted", … }` (names as `device.permissions.set`, applied before the app launches). `locale`: a BCP 47 tag. `timezone`: an IANA name. `a11y`: `{ textSize?, boldText?, contrast?, reduceMotion? }`. A bad value fails config load |

### App, ports, serve, setup
| Key | Default | Meaning |
|---|---|---|
| `app` | none | `true` or `{ installMode, resetKeychain, variant \| kind }`: install the project's app on each device first. `kind` (`dev` \| `simulator` \| `release`, default `simulator`) picks the build; `variant` keeps the old variant build and its `metro` (not together with `kind`) |
| `project` | config dir | `projects[].name`; specs, serve and setup run in its root |
| `ports` | none | `["<from>[:<span>]"]`, exported as `WARDEN_PORT_<i>` and `WARDEN_PORTS` |
| `env` | none | added to serve, setup and spec env |
| `serve` / `serveReady` / `serveTimeout` | none | `sh -c` before the specs, killed at the end. `serveReady` is `http://...`, `tcp:PORT` or `file:PATH`. Both need `serve` |
| `setup` | none | `sh -c` once per device before its first spec; `{udid}` is substituted. A non-zero exit drops that device |

### Runtime
| Key | Default | Meaning |
|---|---|---|
| `spec` | `{}` | `{ bundleId, launchArgs, timeout = "2m", actionTimeout = "30s", assertionTimeout = "5s" }`. `bundleId` defaults to the project's |
| `isolate` | `device` | `device` or `spec` (`spec` when `passes > 1`) |
| `shutdown` | `always` | `always`: shut down warden's devices (and close their windows) after a passed gate. `idle`: leave them booted for the next run (`warden gc` reaps idle ones). A failed run always leaves them up |
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

- `warden repack ios|android` makes (or finds) the repack and prints `baseHash`, `jsKey`, `artifact`, `reused|repacked`, `bundleMs`; `--force` rebuilds a cached one.
- Android repack needs the SDK build-tools (`zipalign`, `apksigner`, `aapt2`) and system `zip` / `unzip`. It signs with the project's `android/app/debug.keystore` when present (the base's signer), else the default debug keystore. The Android simulator base is a plain `assembleRelease` whose embedded bundle is stale on purpose: the repack replaces it.
- Android can't repack new image / raw resources (they live in the compiled resource table): that run builds the `release` kind instead and logs why (`new Android resource(s): … needs a full build`; `fallbackReason` in `--json`). A changed vector drawable is not detected: the base's copy is kept.
- A project's `fingerprint.include: "native+js"` / `fingerprint.jsInputs` belong to the kind-less flow (variants, `warden app ensure` with no `--kind`): `--kind dev|simulator` warns once on stderr that they are ignored. Move them into `kinds.simulator.jsInputs`.
- `warden builds ls` shows each build's kind, base (native fingerprint), jsKey, worktree and branch.

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

## Env the spec process gets

Set by warden. Never export these for a suite run.

| Source | Variables |
|---|---|
| spec contract | `WARDEN_UDID WARDEN_PLATFORM WARDEN_BUNDLE_ID WARDEN_DEVICE_NAME WARDEN_LAUNCH_ARGS WARDEN_E2E_OUT WARDEN_E2E_TIMEOUT WARDEN_E2E_ACTION_TIMEOUT WARDEN_E2E_ASSERTION_TIMEOUT WARDEN_E2E_SPECS_DIR WARDEN_HELPER_DIR WARDEN_SIMD_SOCKET WARDEN_VERSION` |
| batch job | `WARDEN_WORKER WARDEN_JOB WARDEN_JOB_SEQ WARDEN_PASS WARDEN_BATCH_DIR WARDEN_PORT` (first leased port; the e2e package does not read it) `WARDEN_METRO_URL` (with `metro`) `WARDEN_LEG` (with `devices`) |
| lease | `WARDEN_UDIDS WARDEN_UDID_<i> WARDEN_PORTS WARDEN_PORT_<i> WARDEN_LEASE_IDS WARDEN_HEADLESS` |
| app / log | `WARDEN_APP_PATH WARDEN_APP_HASH` (with `app`) `WARDEN_LOG_TIMESTAMPS` |
| runner | `BUN_BE_BUN=1` (a compiled warden runs as bun; the preload drops it, so a `warden` a spec spawns stays warden) |
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

`e2e-report.json`: `{ suite, platform, base?, isolate, ok, headless, batchDir?, specs[], only?, setup? }`. Each spec has `verdict`, `attempts`, `tests[]`.

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
| `warden run <platform> -- <cmd>` | child gets `WARDEN_UDIDS WARDEN_UDID_<i> WARDEN_LEASE_IDS WARDEN_PORTS WARDEN_PORT_<i>`, `WARDEN_HEADLESS=1` when headless, `WARDEN_APP_PATH WARDEN_APP_HASH` with `--app`. `--json`: first stdout line `{ leases, ports, cmd }`, the child's stdout goes to stderr |
| `warden batch <platform\|preset> --jobs a,b -- <cmd>` | per job `WARDEN_UDID WARDEN_WORKER WARDEN_DEVICE_NAME WARDEN_JOB WARDEN_JOB_SEQ WARDEN_PASS WARDEN_BATCH_DIR WARDEN_PORT`. `{job} {udid} {worker} {seq}` are substituted in the command; `{port} {metroUrl}` in `serve` and `serveReady`. Jobs also come from `--jobs-from <file\|->` (one per line). A job killed by `--job-timeout` exits `124` |

`warden batch <name>` runs the `batches.<name>` preset of `warden.config.ts` (`ios` / `android` are reserved names); flags passed alongside override it. Preset keys: `platform` (required) `cmd` (required) `project count max profile runtime label ttl wait ports app headless slim retry passes env serve serveReady serveTimeout jobs jobsFrom record logs`. At most one of `jobs` / `jobsFrom` (`jobsFrom`: a file, `-`, or `{ command }`).

## Headless, slim, warm, versions

- Headless: `--headless` on claim/run/batch/e2e, `headless: true` in a suite, or `WARDEN_HEADLESS=1`. `warden dev` honors only an explicit `--headless`. warden never launches Simulator.app and closes the windows of devices it leased. That needs Accessibility permission for the terminal, and a failure only warns. Xcode 27's Device Hub: headless opens none of its windows and never launches it; a non-headless claim opens one window per sim it booted (only while Device Hub already runs) and tiles them (`warden arrange [--open <udid…>]`). Don't quit Device Hub mid-run (it shuts every booted sim down) and don't tap a leased sim in it (it can swallow warden's input until the sim reboots). Android is always headless.
- Slim is on by default for warden-created iOS sims (`--no-slim`, `slim: false` or `WARDEN_SLIM=0` to opt out; also a top-level `slim` in `warden.config.ts`). A spec needing a trimmed service sets `slim: { except: ["store"] }`. `warmDrivers` (default on, `--no-warm` to skip) starts one `warden-simd` per device after setup, found through `WARDEN_SIMD_SOCKET`.
- `@delacour/warden-e2e` must equal the warden version. After upgrading warden: `bun add -d @delacour/warden-e2e@<version>`.

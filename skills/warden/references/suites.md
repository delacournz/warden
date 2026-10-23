# Suites: `warden e2e`, `warden affected`, `e2e.<suite>` config

Read this to run, select, configure or debug a suite. Spec authoring is in `specs.md`.

## `warden e2e [suite]`

Selects the flows a change needs, leases devices, runs one `bun test` per flow (or per device), gates on the result. `[suite]` is optional with one suite. With no suite configured (and none named), an Expo app with an `e2e/` dir gets a default suite: every spec there, no git diff, 2 sims, the dev client on warden's Metro (`warden init` writes it out to edit).

```bash
warden e2e example --dry-run --explain     # what would run and why, nothing leased
warden e2e example                         # the flows this branch needs
warden e2e example --all                   # every flow
warden e2e example --flows todos,settings  # exactly these ids / globs
```

| Flag | Meaning |
|---|---|
| `--base <ref>` | diff against merge-base with this ref (suite `base`, default `main`) |
| `--platform ios\|android` | default: the suite's platform |
| `--files <list>` | comma-separated changed files instead of git |
| `--all` / `--flows <ids\|globs>` | skip the diff. Exclusive with each other, and neither combines with `--files` |
| `--required-only` | only flows with `required: true` |
| `--explain` / `--dry-run` | print why each flow was selected / select, run nothing |
| `--report <file>` | also write `e2e-report.json` there |
| `--devices default\|all\|<profile,...>` | which `devices` legs run |
| `--no-shutdown` | keep devices up after a pass (default: shut down those warden created under CI; locally they stay booted and `warden gc` reaps them when idle; suite `shutdown`) |
| `--no-warm` | skip the iOS driver warm-up |
| claim flags | `--profile --runtime --count --max --wait --ttl --label --adopt --headless --no-headless --json` (`--json` prints the e2e report) |
| lease flags | `--port <from:span>` (repeatable), `--app --install-mode clean\|reinstall --reset-keychain --project --bundle-id --variant --no-eas --no-build` |
| batch flags | `--retry --passes --serve --serve-ready --serve-timeout --job-timeout --record <dir> --logs <dir> --no-tui` |

Suite settings are defaults. A flag passed on the command line wins.

**Exit codes:** `0` every required flow passed (or nothing affected, or dry-run). `1` the gate failed or an error. `130` interrupted.

**Preflight (fails before any claim):** bun >= 1.3 on PATH (or `WARDEN_BUN`), and `@delacour/warden-e2e` in the project. **What runs:** `bun test --preload @delacour/warden-e2e/preload --timeout <spec timeout + 30s> <files>`.

- `isolate: device` (default): one `shard-<k>` process per device, flows spread round-robin by sorted id. A crash fails the flow it hit and the ones it never reached; a retry reruns only the flows that did not pass.
- `isolate: flow`: one process per flow, one worker per device (the default with `passes > 1`). `mode: single` / `per-flow` is the old spelling.

## `warden affected [suite]`

```bash
warden affected example --base origin/main --explain
warden affected example --platform ios | warden batch ios --jobs-from - -- <cmd> {job}
```

Flags: `--base --platform --files --required-only --explain --strict --json`.

merge-base with `--base`, then `git diff --name-status -M` plus untracked files. Changes outside `scope` or matching `ignore` drop out. A `runAll` match selects every flow. Otherwise a flow is selected by its `paths` globs or by the import graph from its `entries` (up to `maxDepth` hops; `routerRoot` adds `_layout` files; cache in `$WARDEN_HOME/affected`). Then `always` flows, `unmapped` flows and `unmatched` changes apply.

Default output is one flow id per line. `--strict` exits `3` when a change reaches no flow.

## Suite schema `e2e.<suite>`

Paths and globs are relative to `warden.config.ts`. Unknown keys are errors.

### Selection
| Key | Default | Meaning |
|---|---|---|
| `flowsDir` | required | dir of `*.e2e.ts` files |
| `flows` | `{}` | `{ <id\|glob>: { entries, paths, platforms?, maxDepth?, required? } }` |
| `runAll` / `ignore` / `always` | `[]` | globs: select all / select nothing / flow ids that always run |
| `include` / `exclude` | `[]` | flow-id globs that may / never be selected |
| `scope` | `[]` | only changes matching these count |
| `unmatched` | `skip` | `run-all` or `skip` for a counted change that reaches no flow |
| `unmapped` | `run` | `run` or `skip` for a flow with no entries/paths |
| `base` | `main` | git ref |
| `maxDepth`, `tsconfig`, `routerRoot` | none | import-graph tuning |
| `platform` | both | `ios` or `android` |
| `required` | `true` | default for flows that do not set it |

### Devices and Metro
| Key | Default | Meaning |
|---|---|---|
| `devices` | none | `[{ profile, count = 1, env?, default = true }]`. Replaces `profile` / `count`. At least one leg must be default |
| `count`, `profile` | claim defaults | single pool |
| `metro` | none | `{ enabled = true, port = "8081:100", launchArgs = [], open = true, env, prewarm = true, readyTimeout = "2m" }`. warden starts one Metro for the run and points the dev client at it |
| `headless` | off | keep Simulator.app windows closed |
| `slim` | off | iOS only: switch off simulator daemons flows never need, before `setup`. Skipped with a note on an Android run; refused on a suite fixed to `platform: "android"` |
| `warmDrivers` | on | iOS: start every device's driver helper before the flows |

### App, ports, serve, setup
| Key | Default | Meaning |
|---|---|---|
| `app` | none | `true` or `{ installMode, resetKeychain, variant }`: install the project's app on each device first |
| `project` | config dir | `projects[].name`; specs, serve and setup run in its root |
| `ports` | none | `["<from>[:<span>]"]`, exported as `WARDEN_PORT_<i>` and `WARDEN_PORTS` |
| `env` | none | added to serve, setup and spec env |
| `serve` / `serveReady` / `serveTimeout` | none | `sh -c` before the flows, killed at the end. `serveReady` is `http://...`, `tcp:PORT` or `file:PATH`. Both need `serve` |
| `setup` | none | `sh -c` once per device before its first flow; `{udid}` is substituted. A non-zero exit drops that device |

### Runtime
| Key | Default | Meaning |
|---|---|---|
| `spec` | `{}` | `{ bundleId, launchArgs, timeout = "2m", actionTimeout = "30s", assertionTimeout = "5s" }`. `bundleId` defaults to the project's |
| `isolate` | `device` | `device` or `flow` (`flow` when `passes > 1`) |
| `shutdown` | `idle` locally, `always` under CI | `always`: shut down warden's devices after a passed gate. `idle`: leave them booted for the next run (`warden gc` reaps idle ones). A failed run always leaves them up |
| `jobTimeoutMs` | `600000` | per flow: a process past this for each flow it runs is killed and counts as failed |
| `passes` | `1` | consecutive green runs needed per flow. `isolate: device` with `passes > 1` is an error |
| `retry` | `0` | re-run a failed job on the same device |

Removed: `runner` (use `spec`), `warmRunners` (use `warmDrivers`).

## Example config (`apps/example/warden.config.ts`)

```ts
const BUNDLE_ID = "nz.co.delacour.warden.example";
const DEV_MENU_OFF = ["-EXDevMenuShowsAtLaunch", "NO", "-EXDevMenuIsOnboardingFinished", "YES",
	"-EXDevMenuShowFloatingActionButton", "NO"];
const SPEC = { bundleId: BUNDLE_ID } satisfies WardenE2eSpec;
const SIGNED_IN = ["src/app/welcome.tsx", "src/app/sign-in.tsx"];

const AFFECTED = {
	project: "example",
	flowsDir: "e2e",
	platform: "ios",
	routerRoot: "src/app",
	maxDepth: 3,
	unmatched: "run-all",
	runAll: ["package.json", "app.config.ts", "metro.config.js", "src/components/ui/**", "src/styles/**",
		"src/lib/**", "src/hooks/**"],
	ignore: ["**/*.test.ts", "**/*.md", "warden.config.ts", "biome.jsonc", "tsconfig.json"],
	flows: {
		onboarding: { entries: ["src/app/welcome.tsx"] },
		"sign-in": { entries: SIGNED_IN },
		todos: { entries: [...SIGNED_IN, "src/app/(tabs)/todos.tsx"] },
		// todo-detail, settings, devtools: same shape
	},
} satisfies Partial<WardenE2eSuite>;

// `example`: Release build, one process per flow. `example-dev`: dev client on warden's Metro, one process per device
e2e: {
	example: {
		count: 2,
		app: true,
		slim: true,
		spec: SPEC,
		...AFFECTED,
	},
	"example-dev": {
		count: 2,
		app: { variant: "dev" },
		metro: { env: { EXPO_PUBLIC_E2E: "1" }, launchArgs: DEV_MENU_OFF },
		jobTimeoutMs: 15 * 60_000,
		slim: true,
		spec: SPEC,
		...AFFECTED,
	},
},
```

## Env the spec process gets

Set by warden. Never export these for a suite run.

| Source | Variables |
|---|---|
| spec contract | `WARDEN_UDID WARDEN_PLATFORM WARDEN_BUNDLE_ID WARDEN_DEVICE_NAME WARDEN_LAUNCH_ARGS WARDEN_E2E_OUT WARDEN_E2E_TIMEOUT WARDEN_E2E_ACTION_TIMEOUT WARDEN_E2E_ASSERTION_TIMEOUT WARDEN_E2E_FLOWS_DIR WARDEN_HELPER_DIR WARDEN_SIMD_SOCKET WARDEN_VERSION` |
| batch job | `WARDEN_WORKER WARDEN_JOB WARDEN_JOB_SEQ WARDEN_PASS WARDEN_BATCH_DIR WARDEN_PORT` (first leased port; the e2e package does not read it) `WARDEN_METRO_URL` (with `metro`) `WARDEN_LEG` (with `devices`) |
| lease | `WARDEN_UDIDS WARDEN_UDID_<i> WARDEN_PORTS WARDEN_PORT_<i> WARDEN_LEASE_IDS WARDEN_HEADLESS` |
| app / log | `WARDEN_APP_PATH WARDEN_APP_HASH` (with `app`) `WARDEN_LOG_TIMESTAMPS` |

## Batch dir

`--record <dir>`, else `$WARDEN_HOME/batches/<id>/`.

```
batch.json  tui.cast  metro.log  e2e-report.json
logs/<w>-<seq>-<job>[.passN].log     (+ .png of the device on failure)
logs/setup-<w>.log  logs/warm-<w>.log
e2e/<w>-<seq>/results.jsonl
e2e/<w>-<seq>/<flowId>/<title>-<hash6>/   trace.jsonl screenshots/ failure.png screen-at-failure.txt console.jsonl network.jsonl
```

`e2e-report.json`: `{ suite, platform, base?, mode?, ok, headless, batchDir?, flows[], only?, setup? }`. Each flow has `verdict`, `attempts`, `tests[]`.

`batch.json` jobs (one per attempt) may carry `logDrainMs`: ms spent draining the job's log pipes after it exited, summed over its `passes`.

## When it fails, in order

1. `e2e-report.json`: which flows, which verdict, which device.
2. `e2e/<w>-<seq>/results.jsonl`: which test and the error.
3. The test dir: `screen-at-failure.txt` first, then `failure.png`, `trace.jsonl`, `console.jsonl`.
4. `logs/<w>-<seq>-<job>.log` and its `.png`.
5. `metro.log`, `logs/warm-*.log`, `logs/setup-*.log`.
6. A crash: `~/Library/Logs/DiagnosticReports/<app>-*.ips`.

A failed run leaves sims booted (so does a passed local one, until `warden gc` reaps them as idle). Clean up with `warden release <leaseId> --shutdown` (a parent session: `--mine --shutdown`). A device that keeps failing: `warden release <id> --bad "<why>"`.

## `warden run` and `warden batch`

| Command | Env and behavior |
|---|---|
| `warden run <platform> -- <cmd>` | child gets `WARDEN_UDIDS WARDEN_UDID_<i> WARDEN_LEASE_IDS WARDEN_PORTS WARDEN_PORT_<i>`, `WARDEN_HEADLESS=1` when headless, `WARDEN_APP_PATH WARDEN_APP_HASH` with `--app` |
| `warden batch <platform> --jobs a,b -- <cmd>` | per job `WARDEN_UDID WARDEN_WORKER WARDEN_DEVICE_NAME WARDEN_JOB WARDEN_JOB_SEQ WARDEN_PASS WARDEN_BATCH_DIR WARDEN_PORT`. `{job} {udid} {worker} {seq}` are substituted in the command; `{port} {metroUrl}` in `serve` and `serveReady`. A job killed by `--job-timeout` exits `124` |

## Headless, slim, warm, versions

- Headless: `--headless` on claim/run/batch/e2e, `headless: true` in a suite, or `WARDEN_HEADLESS=1`. `warden dev` honors only an explicit `--headless`. warden never launches Simulator.app and closes the windows of devices it leased. That needs Accessibility permission for the terminal, and a failure only warns. Xcode 27's Device Hub has one window for every sim, so there is nothing to close or tile; don't tap a leased sim in Device Hub (it can swallow warden's input until the sim reboots). Android is always headless.
- `slim: true` trims simulator daemons per device (iOS). `warmDrivers` (default on, `--no-warm` to skip) starts one `warden-simd` per device after setup, found through `WARDEN_SIMD_SOCKET`.
- `@delacour/warden-e2e` must equal the warden version. After upgrading warden: `bun add -d @delacour/warden-e2e@<version>`.

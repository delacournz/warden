/**
 * The public, documented shape of `warden.config.ts`, published as `@delacour/warden/config`.
 *
 * Self-contained on purpose (no imports): `apps/cli/scripts/npm-packages.ts` emits this file as a
 * single `config.d.ts` + `config.mjs`. `define-config.test.ts` asserts every type here accepts exactly
 * what the zod schemas in `config.ts` / `preset.schema.ts` / `affected.schema.ts` accept.
 *
 * @example
 * ```ts
 * // warden.config.ts
 * import { defineConfig } from "@delacour/warden/config";
 *
 * export default defineConfig({
 *   projects: [{ name: "salient", root: "apps/salient/app", bundleId: { ios: "com.example.salient" } }],
 * });
 * ```
 *
 * @packageDocumentation
 */

/** A device platform warden can lease. */
export type WardenPlatform = "ios" | "android";

/**
 * Install the project's app on every leased device before the first job.
 *
 * - `true` installs the cached / built app (`WARDEN_APP_PATH` / `WARDEN_APP_HASH` are exported).
 * - `{ clean: true }` also uninstalls it first, so each run starts from a fresh container (`--clean`).
 * - `{ variant: "e2e" }` installs that {@link WardenProject.variants} build instead of the project's own.
 * - `{}` is the same as `true`.
 */
export type WardenAppOption = boolean | { clean?: boolean | undefined; variant?: string | undefined };

/** A value per platform, e.g. a bundle id or a build command. */
export interface WardenPerPlatform {
	/** iOS value (bundle identifier, build command…). */
	ios?: string | undefined;
	/** Android value (application id / package, build command…). */
	android?: string | undefined;
}

/** How the build cache / install key is computed. */
export interface WardenFingerprint {
	/**
	 * Own fingerprint command; `{platform}` is substituted. Stdout is JSON `{ "hash": "…" }` or a bare hash.
	 *
	 * @default `@expo/fingerprint`
	 * @example "bun run --silent fingerprint:{platform}"
	 */
	command?: string | undefined;
	/**
	 * What the key covers.
	 *
	 * - `"native"`: the native fingerprint only.
	 * - `"native+js"`: also a content hash of {@link WardenFingerprint.jsInputs}, for Release builds that embed the JS bundle.
	 *
	 * @default "native"
	 */
	include?: "native" | "native+js" | undefined;
	/**
	 * Required with `include: "native+js"`, not allowed otherwise. Globs, relative to the project root,
	 * of the JS sources in the bundle. A glob starting with `../` reaches outside the project (a workspace
	 * package the bundle embeds). Only git-tracked and untracked-not-ignored files count.
	 *
	 * @example ["src/**", "../../../packages/engine/src/**"]
	 */
	jsInputs?: string[] | undefined;
}

/** EAS build lookup for a project. */
export interface WardenEas {
	/**
	 * EAS build profile to look builds up under.
	 *
	 * @default "development-simulator"
	 */
	profile?: string | undefined;
	/**
	 * EAS workflow file to trigger on a cache miss.
	 *
	 * @example ".eas/workflows/dev-build.yml"
	 */
	workflow?: string | undefined;
	/**
	 * Trigger {@link WardenEas.workflow} when no EAS build matches.
	 *
	 * @default false
	 */
	trigger?: boolean | undefined;
}

/** Local build, the resolver's last resort. */
export interface WardenBuild extends WardenPerPlatform {
	/**
	 * Which build a local build produces. Sets where the artifact is searched (`<Config>-iphonesimulator`,
	 * `apk/release`) and, unless `ios` / `android` is set, the default command
	 * (`--configuration Release` / `--variant release`).
	 *
	 * @default "Debug"
	 */
	configuration?: "Debug" | "Release" | undefined;
	/**
	 * Inject shared compiler caches into local builds so a native rebuild in one worktree reuses another's
	 * compiled objects: ccache (`$WARDEN_HOME/ccache`, `CCACHE_BASEDIR` = git toplevel), Xcode 26
	 * compilation caching, and the Gradle build cache. `false` turns them off.
	 *
	 * @default true
	 */
	cache?: boolean | undefined;
}

/**
 * A named build of a project (`dev`, `e2e`…), picked with `--variant`, `app: { variant }` or `warden dev`
 * (which uses `dev` when it exists). Each key set here **replaces** the project's own, wholesale.
 *
 * @example { dev: { build: { configuration: "Debug" }, fingerprint: { include: "native" } } }
 */
export interface WardenVariant {
	/** Replaces {@link WardenProject.fingerprint}. */
	fingerprint?: WardenFingerprint | undefined;
	/** Replaces {@link WardenProject.eas}. */
	eas?: WardenEas | undefined;
	/** Replaces {@link WardenProject.build}. */
	build?: WardenBuild | undefined;
}

/** An app warden builds, caches and installs. */
export interface WardenProject {
	/** Project name, used in the cache key and referenced by `batches.*.project` / `e2e.*.project`. */
	name: string;
	/**
	 * Project directory, relative to the config file.
	 *
	 * @default "."
	 */
	root?: string | undefined;
	/** Bundle id / package per platform. Required when the project has a dynamic `app.config.*`. */
	bundleId: WardenPerPlatform;
	/** How the build cache key is computed. */
	fingerprint?: WardenFingerprint | undefined;
	/** EAS build lookup. Without it, EAS is used only when the project has an `eas.json`. */
	eas?: WardenEas | undefined;
	/**
	 * Local build command per platform, used as the last resort.
	 *
	 * @example { ios: "bunx expo run:ios --no-install --no-bundler" }
	 */
	build?: WardenBuild | undefined;
	/**
	 * Named builds, e.g. a Debug dev client next to a Release e2e build. Each has its own cache key, so
	 * every worktree with the same fingerprint reuses one build per variant.
	 */
	variants?: Record<string, WardenVariant> | undefined;
	/** Extra (legacy) cache roots laid out as `<dir>/<hash>/*.app|*.apk`, imported on demand. `~` expands to `$HOME`. */
	cacheDirs?: string[] | undefined;
}

/** A file of jobs, `-` for stdin, or a `sh -c` command whose stdout lines are the jobs. */
export type WardenJobsFrom =
	| string
	| {
			/** `sh -c` command whose stdout lines are the jobs; a nonzero exit fails the batch. */
			command: string;
	  };

/**
 * A saved `warden batch` invocation, run with `warden batch <name>`. Each field mirrors the flag of the
 * same name; flags on the command line override it and `-- <cmd>` overrides `cmd`.
 *
 * Runs in its project's root, or the config file's directory when there is no `project`.
 */
export interface WardenBatchPreset {
	/** A `projects[].name`: its root is the preset's cwd, and `app` installs its build. */
	project?: string | undefined;
	/** Platform of the devices to claim. */
	platform: WardenPlatform;
	/**
	 * Devices to claim.
	 *
	 * @default 1
	 */
	count?: number | undefined;
	/** Max warden devices of this profile. */
	max?: number | undefined;
	/**
	 * Device profile.
	 *
	 * @example "iphone-17"
	 */
	profile?: string | undefined;
	/**
	 * Runtime.
	 *
	 * @example "latest"
	 */
	runtime?: string | undefined;
	/**
	 * Label on the device and port leases.
	 *
	 * @default the preset name
	 */
	label?: string | undefined;
	/**
	 * Lease TTL without heartbeat (`30s`, `10m`, `2h`).
	 *
	 * @default "30m"
	 */
	ttl?: string | undefined;
	/** Wait this long for free devices (`30s`, `10m`, `2h`). */
	wait?: string | undefined;
	/**
	 * `FROM[:SPAN]` port specs, exported as `WARDEN_PORT_<i>`.
	 *
	 * @example ["8091:20"]
	 */
	ports?: string[] | undefined;
	/** Ensure the app on every device first. */
	app?: WardenAppOption | undefined;
	/**
	 * Re-run a failed job up to N times on the same device.
	 *
	 * @default 0
	 */
	retry?: number | undefined;
	/**
	 * A job passes only after N consecutive green runs on its device.
	 *
	 * @default 1
	 */
	passes?: number | undefined;
	/** Added to the serve and job env. */
	env?: Record<string, string> | undefined;
	/** Long-lived `sh -c` command started before the jobs. */
	serve?: string | undefined;
	/**
	 * Wait for `http://…`, `tcp:PORT` or `file:PATH` (relative to the preset's cwd) before the jobs.
	 *
	 * @example "file:e2e-artifacts/batch/session.json"
	 */
	serveReady?: string | undefined;
	/**
	 * Give up waiting for `serveReady` after this long.
	 *
	 * @default "10m"
	 */
	serveTimeout?: string | undefined;
	/** The jobs. At most one of `jobs` / `jobsFrom`. */
	jobs?: string[] | undefined;
	/** Where the jobs come from. At most one of `jobs` / `jobsFrom`. */
	jobsFrom?: WardenJobsFrom | undefined;
	/** iOS: record every simulator and the TUI into this dir. */
	record?: string | undefined;
	/** Per-job log dir. */
	logs?: string | undefined;
	/**
	 * Per-job argv; `{job}` `{udid}` `{worker}` `{seq}` are substituted.
	 *
	 * @example ["bun", "scripts/e2e/run-ios.ts", "--attach", "{job}", "--device", "{udid}"]
	 */
	cmd: string[];
}

/** `e2e.<suite>.flows.<id|glob>`: what a flow covers and whether it gates. */
export interface WardenE2eFlow {
	/**
	 * Files the flow drives (screens / routes); everything they import, transitively, selects it.
	 *
	 * @default []
	 */
	entries?: string[] | undefined;
	/**
	 * Extra globs that select the flow when a changed file matches.
	 *
	 * @default []
	 */
	paths?: string[] | undefined;
	/**
	 * Platforms the flow runs on.
	 *
	 * @default from the id (`-ios-` / `-android-`), then the `launch` map, else both
	 */
	platforms?: WardenPlatform[] | undefined;
	/** Overrides the suite's `maxDepth`. */
	maxDepth?: number | undefined;
	/** A failure fails `warden e2e`; `false` = reported only. Defaults to the suite's `required`. */
	required?: boolean | undefined;
}

/**
 * `e2e.<suite>.metro`: one warden-owned Metro per run. It is started in the project root on a leased
 * port, counts as ready only once that port is verified to serve this checkout (never another
 * worktree's Metro), and is stopped at the end. Runners get `WARDEN_METRO_URL` / `WARDEN_PORT`.
 */
export interface WardenE2eMetro {
	/** @default true */
	enabled?: boolean | undefined;
	/**
	 * Where the Metro port is leased from (`<from>[:<span>]`).
	 *
	 * @default "8081:100"
	 */
	port?: string | undefined;
	/**
	 * Extra launch arguments when warden opens the app on each device (iOS: after `--initialUrl <metroUrl>`).
	 *
	 * @default []
	 */
	launchArgs?: string[] | undefined;
	/**
	 * Open the app on each device once Metro is ready. `false` for a runner that installs the app
	 * itself and so has to launch it too (`WARDEN_METRO_URL` is what it points the dev client at).
	 *
	 * @default true
	 */
	open?: boolean | undefined;
	/** Added to Metro's env only. */
	env?: Record<string, string> | undefined;
	/**
	 * Build the bundle once before the first flow, so no flow pays for (or times out on) the cold build.
	 *
	 * @default true
	 */
	prewarm?: boolean | undefined;
	/**
	 * Give up waiting for Metro after this long.
	 *
	 * @default "2m"
	 */
	readyTimeout?: string | undefined;
}

/** `e2e.<suite>.devices[]`: one leg of the run with its own device pool. */
export interface WardenE2eDeviceLeg {
	/** Device profile; also the leg's name (`{leg}`, `WARDEN_LEG`, `--devices <profile>`). */
	profile: string;
	/**
	 * Devices to claim for this leg.
	 *
	 * @default 1
	 */
	count?: number | undefined;
	/** Added to this leg's setup and runner env. */
	env?: Record<string, string> | undefined;
	/**
	 * `false`: the leg only runs with `--devices all` or `--devices <profile>`.
	 *
	 * @default true
	 */
	default?: boolean | undefined;
}

/**
 * `e2e.<suite>`: the flows `warden affected` selects and `warden e2e` runs. Every path and glob is
 * relative to the config file.
 */
export interface WardenE2eSuite {
	/**
	 * `projects[].name`: the runner, `serve` and `setup` run in its root and `app` installs its build.
	 * Needed when the config has several projects and warden runs from the repo root.
	 */
	project?: string | undefined;
	/** Directory of flows: YAML files, or `*.e2e.ts(x)` tests whose other `.ts` files are helpers (searched recursively; dot dirs, `node_modules` and `__baselines__` skipped). */
	flowsDir: string;
	/**
	 * Runner argv. `{udid}` `{worker}` `{seq}` `{leg}` `{port}` `{metroUrl}` `{stateDir}` are substituted;
	 * per flow also `{flow}` `{flowPath}`. In `mode: "single"` an argument that is exactly `{flows}` /
	 * `{flowPaths}` becomes one argument per selected flow (they are also in `WARDEN_FLOWS` /
	 * `WARDEN_FLOW_PATHS`, comma-separated).
	 *
	 * @example ["<flow-runner>", "run", "{flowPath}", "--device", "{udid}"]
	 */
	runner: string[];
	/**
	 * `"per-flow"`: one runner process per flow, one worker per device. `"single"`: one runner process
	 * per device leg for every selected flow; the runner shards over `WARDEN_UDIDS` itself and its exit
	 * code is the verdict of all of them.
	 *
	 * @default "per-flow"
	 */
	mode?: "per-flow" | "single" | undefined;
	/**
	 * A runner process still going after this many milliseconds is killed (screenshot first) and counts
	 * as failed.
	 *
	 * @default 600000 (10 min)
	 */
	jobTimeoutMs?: number | undefined;
	/**
	 * Device legs: each claims its own pool and runs the selected flows, concurrently with the others.
	 * Replaces `profile` / `count`.
	 *
	 * @example [{ profile: "iphone-17", count: 2 }, { profile: "ipad-pro-11-inch-m5", default: false, env: { E2E_LAYOUT: "regular" } }]
	 */
	devices?: WardenE2eDeviceLeg[] | undefined;
	/** Dev-client suites: warden starts one Metro for the run on a leased port and points the app at it. */
	metro?: WardenE2eMetro | undefined;
	/** tsconfig for files with no `tsconfig.json` between them and the config file. */
	tsconfig?: string | undefined;
	/**
	 * File-based router directory: `_layout` files above an entry count as entries.
	 *
	 * @example "apps/mobile/src/app"
	 */
	routerRoot?: string | undefined;
	/** Default platform. Without it `warden affected` reports both and `warden e2e` needs `--platform`. */
	platform?: WardenPlatform | undefined;
	/**
	 * Git ref changes are measured against (merge-base with HEAD).
	 *
	 * @default "main"
	 */
	base?: string | undefined;
	/**
	 * Import hops from an entry that still select a flow.
	 *
	 * @default unlimited
	 */
	maxDepth?: number | undefined;
	/**
	 * Globs: a matching change selects every flow (lockfile, native dirs, bundler config…).
	 *
	 * @default []
	 * @example ["bun.lock", "apps/mobile/ios/**"]
	 */
	runAll?: string[] | undefined;
	/**
	 * Globs: matching changes are ignored (docs, unit tests…).
	 *
	 * @default []
	 */
	ignore?: string[] | undefined;
	/**
	 * Flow ids / globs that always run.
	 *
	 * @default []
	 */
	always?: string[] | undefined;
	/**
	 * Flow-id globs: only matching flows are ever selected. Lets one `flowsDir` feed several suites.
	 *
	 * @default [] (all flows)
	 */
	include?: string[] | undefined;
	/**
	 * Flow-id globs that are never selected (e.g. flows another suite owns).
	 *
	 * @default []
	 */
	exclude?: string[] | undefined;
	/**
	 * Changed-file globs: only matching changes count at all.
	 *
	 * @default [] (every change)
	 */
	scope?: string[] | undefined;
	/**
	 * A counted change that reaches no flow (no `paths` / `entries` / `runAll` match, not `ignore`d):
	 * `"run-all"` selects every flow, so a new `src/` area never silently runs nothing; `"skip"` selects nothing.
	 *
	 * @default "skip"
	 */
	unmatched?: "run-all" | "skip" | undefined;
	/**
	 * Flows with no `entries` / `paths`: run every time, or only via `runAll` / `always`.
	 *
	 * @default "run"
	 */
	unmapped?: "run" | "skip" | undefined;
	/**
	 * Consecutive green runs a flow needs on the same device.
	 *
	 * @default 1
	 */
	passes?: number | undefined;
	/**
	 * Re-run a failed flow up to N times.
	 *
	 * @default 0
	 */
	retry?: number | undefined;
	/** Devices to claim (not with `devices`). */
	count?: number | undefined;
	/** Device profile (not with `devices`). */
	profile?: string | undefined;
	/** Ensure the app on every device first. */
	app?: WardenAppOption | undefined;
	/** Ports leased for the run (`<from>[:<span>]`), exported as `WARDEN_PORT_<i>` / `WARDEN_PORTS` to serve, setup and every runner. */
	ports?: string[] | undefined;
	/** Added to the serve, setup and runner env. */
	env?: Record<string, string> | undefined;
	/** `sh -c` once per run before the flows, in its own process group; killed at the end. `{port}` / `{metroUrl}` are substituted. `--serve` overrides. */
	serve?: string | undefined;
	/** Wait for `http://…`, `tcp:PORT` or `file:PATH` (relative to the project root) before starting; `{port}` is the first leased port (`"tcp:{port}"`). Needs `serve`. */
	serveReady?: string | undefined;
	/**
	 * Give up waiting for `serveReady` after this long (`30s`, `10m`). Needs `serve`.
	 *
	 * @default "10m"
	 */
	serveTimeout?: string | undefined;
	/**
	 * `sh -c` once per leased device, after the app install and before that device's first flow
	 * (`{udid}` is substituted). A non-zero exit drops that device; its flows go to the others.
	 */
	setup?: string | undefined;
	/** iOS only: switch off the simulator daemons flows never need on each leased device, before `setup`. */
	slim?: boolean | undefined;
	/**
	 * Default `required` for flows that don't set it.
	 *
	 * @default true
	 */
	required?: boolean | undefined;
	/**
	 * Per flow id or glob.
	 *
	 * @default {}
	 * @example { "qa-login": { entries: ["apps/mobile/src/app/(auth)/login.tsx"] }, "store-*": { required: false } }
	 */
	flows?: Record<string, WardenE2eFlow> | undefined;
}

/**
 * `warden.config.ts`: set at least one of `projects`, `batches` and `e2e`. Without `projects`, app builds
 * fall back to detecting `app.json` / `app.config.*`.
 */
export interface WardenConfig {
	/** Apps warden builds, caches and installs. With several, the one containing the cwd is picked. */
	projects?: WardenProject[] | undefined;
	/** Named `warden batch` presets. `ios` and `android` can't be used as names. */
	batches?: Record<string, WardenBatchPreset> | undefined;
	/** Named `warden affected` / `warden e2e` suites. */
	e2e?: Record<string, WardenE2eSuite> | undefined;
}

/** What a config function receives. */
export interface WardenConfigContext {
	/** Absolute directory of the config file; relative paths in the config resolve against it. */
	configDir: string;
	/** The environment warden runs with. */
	env: Record<string, string | undefined>;
}

/** What `warden.config.ts` may `export default`: a config, or a sync function returning one. */
export type WardenConfigExport = WardenConfig | ((context: WardenConfigContext) => WardenConfig);

/**
 * Type a `warden.config.ts` export with autocompletion and docs. Returns its argument unchanged.
 *
 * @example
 * ```ts
 * export default defineConfig(({ env }) => ({
 *   projects: [{ name: "app", bundleId: { ios: env.IOS_BUNDLE_ID ?? "com.example.app" } }],
 * }));
 * ```
 */
export function defineConfig(config: WardenConfigExport): WardenConfigExport {
	return config;
}

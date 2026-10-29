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
 * - `{ installMode: "clean" }` gives each run fresh app data without reinstalling an unchanged build (`--install-mode clean`).
 * - `{ installMode: "reinstall" }` uninstalls the app first, then installs it, every run (`--install-mode reinstall`).
 * - `{ installMode, resetKeychain: true }` also resets the iOS simulator's keychain (`--reset-keychain`); needs `installMode`.
 * - `{ clean: true }` is the deprecated spelling of `{ installMode: "reinstall" }`.
 * - `{ variant: "e2e" }` installs that {@link WardenProject.variants} build instead of the project's own.
 * - `{ kind: "simulator" }` installs that {@link WardenBuildKind} instead (not together with `variant`).
 * - `{}` is the same as `true`.
 */
export type WardenAppOption =
	| boolean
	| {
			installMode?: "clean" | "reinstall" | undefined;
			resetKeychain?: boolean | undefined;
			/** @deprecated use `installMode: "reinstall"` */
			clean?: boolean | undefined;
			variant?: string | undefined;
			kind?: WardenBuildKind | undefined;
	  };

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
	eas?: WardenEas | false | undefined;
	/** Replaces {@link WardenProject.build}. */
	build?: WardenBuild | undefined;
}

/**
 * What a cached build is for.
 *
 * - `"dev"`: Debug, JS from Metro at runtime. The default of `warden ui open` / `warden dev`.
 * - `"simulator"`: Release for a simulator / emulator whose JS is swapped by a repack (iOS `SKIP_BUNDLING=1`, Android
 *   plain `assembleRelease`; its embedded bundle is replaced). The app's JS is repacked into a clone of this build, keyed by the content
 *   of the JS sources, so a JS edit costs seconds, not a native rebuild. The default of `warden e2e`.
 * - `"release"`: Release with the JS bundle embedded at build time; the key also covers the JS sources.
 */
export type WardenBuildKind = "dev" | "simulator" | "release";

/** Overrides of one {@link WardenBuildKind}'s built-in defaults. */
export interface WardenKind {
	/**
	 * Replaces the kind's built-in build command, per platform. The project's own top-level `build` is not read
	 * for a kind.
	 *
	 * @example { ios: "SKIP_BUNDLING=1 bunx expo run:ios --configuration Release --no-install --no-bundler" }
	 */
	build?: WardenPerPlatform | undefined;
	/**
	 * Env of the build and of the JS bundle step (`EXPO_PUBLIC_*`, `NODE_ENV`…). Part of the repack key: another
	 * value is another repack.
	 */
	env?: Record<string, string> | undefined;
	/**
	 * Globs, relative to the project root, of the JS sources the JS key covers (`simulator`: the repack key,
	 * `release`: the build key). A `!` prefix excludes (`"!docs/**"`); a glob starting with `../` reaches a workspace
	 * package the bundle embeds. Ignored by `dev`.
	 *
	 * @default every file git tracks (or would) under the project root except `ios/`, `android/` and `node_modules`
	 * @example ["src/**", "assets/**", "app.config.ts", "../../packages/ui/src/**"]
	 */
	jsInputs?: string[] | undefined;
}

/** Per-kind overrides, `projects[].kinds`. */
export interface WardenKinds {
	dev?: WardenKind | undefined;
	simulator?: WardenKind | undefined;
	release?: WardenKind | undefined;
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
	/**
	 * How the app is run: `"expo"` (`expo start` + a dev client) or bare `"react-native"` (`react-native start`,
	 * `react-native build-ios` / `build-android`, the app itself pointed at Metro).
	 *
	 * @default `"expo"` when the project's package.json depends on `expo`, `"react-native"` when only on `react-native`
	 */
	framework?: "expo" | "react-native" | undefined;
	/** How the build cache key is computed. */
	fingerprint?: WardenFingerprint | undefined;
	/**
	 * EAS build lookup. Without it, EAS is used only when the project has an `eas.json`.
	 * `false`: never consult eas-cli, even with an `eas.json` present.
	 */
	eas?: WardenEas | false | undefined;
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
	/**
	 * Per-kind overrides of the built-in `dev` / `simulator` / `release` builds, picked with `app: { kind }` or
	 * `--kind`. Kinds sit on top of {@link WardenProject.variants}: both keep working, but a build is one or the other.
	 */
	kinds?: WardenKinds | undefined;
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
	/**
	 * iOS: close the Simulator.app windows of this run's devices. Overrides the top-level `headless`;
	 * `--headless` / `--no-headless` override both.
	 */
	headless?: boolean | undefined;
	/**
	 * iOS: slim the simulator daemons of this run's devices (on by default). `false` turns it off; an object keeps
	 * parts running (`except`: category ids, `keep`: single `com.apple.*` labels). Overrides the top-level `slim`;
	 * `--slim` / `--no-slim` override both.
	 */
	slim?: boolean | { except?: string[] | undefined; keep?: string[] | undefined } | undefined;
	/** Per-job log dir. */
	logs?: string | undefined;
	/**
	 * Per-job argv; `{job}` `{udid}` `{worker}` `{seq}` are substituted.
	 *
	 * @example ["bun", "scripts/e2e/run-ios.ts", "--attach", "{job}", "--device", "{udid}"]
	 */
	cmd: string[];
}

/** `e2e.<suite>.specs.<id|glob>`: what a spec covers and whether it gates. */
export interface WardenE2eSpecEntry {
	/**
	 * Files the spec drives (screens / routes); everything they import, transitively, selects it.
	 *
	 * @default []
	 */
	entries?: string[] | undefined;
	/**
	 * Extra globs that select the spec when a changed file matches.
	 *
	 * @default []
	 */
	paths?: string[] | undefined;
	/**
	 * Platforms the spec runs on.
	 *
	 * @default from the id (`-ios-` / `-android-`), else both
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
 * worktree's Metro), and is stopped at the end. Specs get `WARDEN_METRO_URL` / `WARDEN_PORT`.
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
	 * Open the app on each device once Metro is ready. `false` for a spec that installs the app
	 * itself and so has to launch it too (`WARDEN_METRO_URL` is what it points the dev client at).
	 *
	 * @default true
	 */
	open?: boolean | undefined;
	/** Added to Metro's env only. */
	env?: Record<string, string> | undefined;
	/**
	 * Build the bundle once before the first spec, so no spec pays for (or times out on) the cold build.
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

/** Ceilings `device.perf.stop()` holds a perf report to; a breach fails the test with `PERF_BUDGET`. All lower-is-better. */
export interface WardenPerfBudgets {
	/** Cold start, ms. */
	startupColdMs?: number | undefined;
	/** Share of janky frames, percent. */
	jankPct?: number | undefined;
	/** The slowest React commit, ms. */
	maxCommitMs?: number | undefined;
	/** 95th percentile app CPU, percent. */
	p95CpuPct?: number | undefined;
	/** Peak memory (PSS on Android, RSS on iOS), MB. */
	peakMemoryMb?: number | undefined;
}

/** `perf` (top level, or `e2e.<suite>.perf`): profiling settings for specs that use `device.perf`. */
export interface WardenPerfConfig {
	/** Budgets; a metric the report has no number for (its capture did not run) cannot breach. */
	budgets?: WardenPerfBudgets | undefined;
}

/** `conditions.network` as a custom shape: the fields of a `custom` network condition. */
export interface WardenCustomNetwork {
	/** Added round-trip time, ms. */
	latencyMs?: number | undefined;
	/** Plus or minus spread on the latency, ms. */
	jitterMs?: number | undefined;
	/** Download rate, kilobits per second (0 = unlimited). */
	downKbps?: number | undefined;
	/** Upload rate, kilobits per second (0 = unlimited). */
	upKbps?: number | undefined;
	/** Share of packets lost, 0-100. */
	lossPct?: number | undefined;
}

/**
 * `conditions` (top level, or `e2e.<suite>.conditions`): the device state every spec of the suite starts from.
 * `network`, `location` and `clock` are applied before the app launches and put back after each spec;
 * `permissions`, `locale`, `timezone` and `a11y` are accepted but not applied yet (`warden e2e` says so once).
 */
export interface WardenConditionsConfig {
	/** `online`, `offline`, a preset (`edge`, `3g`, `4g`, `lte`, `wifi`, `slow`, `lossy`) or custom shaping. iOS launches the app with the network dylib so specs can change it later. */
	network?:
		| "online"
		| "offline"
		| "edge"
		| "3g"
		| "4g"
		| "lte"
		| "wifi"
		| "slow"
		| "lossy"
		| WardenCustomNetwork
		| undefined;
	/** A point, or one of the bundled scenarios (`city-run`, `city-bike`, `freeway`). */
	location?: "city-run" | "city-bike" | "freeway" | { lat: number; lon: number; altM?: number | undefined } | undefined;
	/** An ISO instant the clock starts at (and keeps running from), `{ at, frozen }`, or `{ offset }` ("2d") from now. */
	clock?: string | { at: string; frozen?: boolean | undefined } | { offset: string } | undefined;
	/** Not applied yet. */
	permissions?: Record<string, "granted" | "denied" | "unset"> | undefined;
	/** Not applied yet. */
	locale?: string | undefined;
	/** Not applied yet. */
	timezone?: string | undefined;
	/** Not applied yet. */
	a11y?: Record<string, unknown> | undefined;
}

/** `e2e.<suite>.spec`: how `warden e2e` runs the `*.e2e.ts` specs (`bun test` with `@delacour/warden-e2e`). */
export interface WardenE2eSpec {
	/** The app under test. Default: the suite project's `bundleId` for the platform. */
	bundleId?: string | undefined;
	/** Launch arguments `app.open()` passes, after `--initialUrl <metro url>` and `metro.launchArgs`. */
	launchArgs?: string[] | undefined;
	/**
	 * Per-test timeout.
	 *
	 * @default "2m"
	 */
	timeout?: string | undefined;
	/**
	 * Per-action timeout (tap, fill, waiting for an element).
	 *
	 * @default "30s"
	 */
	actionTimeout?: string | undefined;
	/**
	 * Polling timeout of `expect(locator)`.
	 *
	 * @default "5s"
	 */
	assertionTimeout?: string | undefined;
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
	/** Added to this leg's setup and spec env. */
	env?: Record<string, string> | undefined;
	/**
	 * `false`: the leg only runs with `--devices all` or `--devices <profile>`.
	 *
	 * @default true
	 */
	default?: boolean | undefined;
}

/**
 * `e2e.<suite>`: the specs `warden affected` selects and `warden e2e` runs. Every path and glob is
 * relative to the config file.
 */
export interface WardenE2eSuite {
	/**
	 * `projects[].name`: the specs, `serve` and `setup` run in its root and `app` installs its build.
	 * Needed when the config has several projects and warden runs from the repo root.
	 */
	project?: string | undefined;
	/** Perf budgets for this suite; each key replaces the top-level `perf.budgets` one. */
	perf?: WardenPerfConfig | undefined;
	/** Device conditions every spec of this suite starts from; each area replaces the top-level one. */
	conditions?: WardenConditionsConfig | undefined;
	/** Directory of specs: `*.e2e.ts(x)` specs whose other `.ts` files are helpers (searched recursively; dot dirs, `node_modules` and `__baselines__` skipped). */
	specsDir: string;
	/** How the specs run: the app under test, its launch arguments and the timeouts. */
	spec?: WardenE2eSpec | undefined;
	/**
	 * `"device"`: one `bun test` process per device runs its share of the specs (sharded round-robin by
	 * spec id), so a device's specs run in order in one process and the devices run in parallel.
	 * `"spec"`: one process per spec, one worker per device: slower (each process pays bun's start,
	 * the preload and a driver connect), but a spec can never see what the one before left behind and
	 * the devices share the specs dynamically. With `passes` above 1 the default is `"spec"`.
	 *
	 * @default "device"
	 */
	isolate?: "device" | "spec" | undefined;
	/**
	 * What happens to the devices warden booted when the gate passes. `"always"`: shut them down.
	 * `"idle"`: leave them booted, so the next run skips the 10-30 s boot, and let `warden gc` shut
	 * them down once they have sat idle. A failed run always leaves them up. `--no-shutdown` wins.
	 *
	 * @default "always"
	 */
	shutdown?: "always" | "idle" | undefined;
	/**
	 * Per spec: a spec process still going after this many milliseconds for each spec it runs (one
	 * spec, or a device's share of them with `isolate: "device"`) is killed (screenshot first) and
	 * counts as failed.
	 *
	 * @default 600000 (10 min)
	 */
	jobTimeoutMs?: number | undefined;
	/**
	 * Device legs: each claims its own pool and runs the selected specs, concurrently with the others.
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
	 * Import hops from an entry that still select a spec.
	 *
	 * @default unlimited
	 */
	maxDepth?: number | undefined;
	/**
	 * Globs: a matching change selects every spec (lockfile, native dirs, bundler config…).
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
	 * Spec ids / globs that always run.
	 *
	 * @default []
	 */
	always?: string[] | undefined;
	/**
	 * Spec-id globs: only matching specs are ever selected. Lets one `specsDir` feed several suites.
	 *
	 * @default [] (all specs)
	 */
	include?: string[] | undefined;
	/**
	 * Spec-id globs that are never selected (e.g. specs another suite owns).
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
	 * A counted change that reaches no spec (no `paths` / `entries` / `runAll` match, not `ignore`d):
	 * `"run-all"` selects every spec, so a new `src/` area never silently runs nothing; `"skip"` selects nothing.
	 *
	 * @default "skip"
	 */
	unmatched?: "run-all" | "skip" | undefined;
	/**
	 * Specs with no `entries` / `paths`: run every time, or only via `runAll` / `always`.
	 *
	 * @default "run"
	 */
	unmapped?: "run" | "skip" | undefined;
	/**
	 * Consecutive green runs a spec needs on the same device.
	 *
	 * @default 1
	 */
	passes?: number | undefined;
	/**
	 * Re-run a failed spec up to N times.
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
	/** Ports leased for the run (`<from>[:<span>]`), exported as `WARDEN_PORT_<i>` / `WARDEN_PORTS` to serve, setup and every spec process. */
	ports?: string[] | undefined;
	/** Added to the serve, setup and spec env. */
	env?: Record<string, string> | undefined;
	/** `sh -c` once per run before the specs, in its own process group; killed at the end. `{port}` / `{metroUrl}` are substituted. `--serve` overrides. */
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
	 * `sh -c` once per leased device, after the app install and before that device's first spec
	 * (`{udid}` is substituted). A non-zero exit drops that device; its specs go to the others.
	 */
	setup?: string | undefined;
	/**
	 * iOS only: switch off the simulator daemons specs never need on each leased device, before `setup`.
	 * Skipped with a note on an Android run; refused on a suite fixed to `platform: "android"`.
	 * An object keeps parts running: `except` lists category ids (see `warden sim profiles`), `keep`
	 * lists single `com.apple.*` launchd labels. `false` turns it off.
	 */
	slim?: boolean | { except?: string[] | undefined; keep?: string[] | undefined } | undefined;
	/** Removed: renamed `warmDrivers`. */
	warmRunners?: undefined;
	/**
	 * iOS: before the specs, start every leased device's automation helper at once (and take one
	 * snapshot), so the first spec on each device does not pay the cold start. A failed warm-up only warns.
	 *
	 * @default true
	 */
	warmDrivers?: boolean | undefined;
	/**
	 * iOS: close the Simulator.app windows of this run's devices, so it shows nothing even with Simulator.app
	 * open. Overrides the top-level `headless`; `--headless` / `--no-headless` override both. Android is always headless.
	 */
	headless?: boolean | undefined;
	/**
	 * Default `required` for specs that don't set it.
	 *
	 * @default true
	 */
	required?: boolean | undefined;
	/**
	 * Per spec id or glob: what each spec covers and whether it gates. Not to be confused with
	 * {@link WardenE2eSuite.spec}, which sets how every spec runs.
	 *
	 * @default {}
	 * @example { "qa-login": { entries: ["apps/mobile/src/app/(auth)/login.tsx"] }, "store-*": { required: false } }
	 */
	specs?: Record<string, WardenE2eSpecEntry> | undefined;
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
	/**
	 * iOS: close the Simulator.app windows of every device an `e2e` suite or `batches` preset leases (default for
	 * those that don't set `headless`). `warden dev` ignores it. `WARDEN_HEADLESS=1` is the fallback below it.
	 */
	headless?: boolean | undefined;
	/**
	 * iOS: switch off the simulator daemons specs never need on every simulator warden creates (claim, run, dev,
	 * e2e, batch). On by default. `false` turns it off; an object keeps parts running (`except`: category ids, see
	 * `warden sim profiles`; `keep`: single `com.apple.*` launchd labels). An `e2e` suite's `slim` overrides it,
	 * `--slim` / `--no-slim` override both, `WARDEN_SLIM=0` is the fallback below it.
	 *
	 * @default true
	 */
	slim?: boolean | { except?: string[] | undefined; keep?: string[] | undefined } | undefined;
	/** Perf budgets every `e2e` suite starts from (a suite's own `perf.budgets` replace them per key). */
	perf?: WardenPerfConfig | undefined;
	/** Device conditions every `e2e` suite starts from (a suite's own `conditions` replace them per area). */
	conditions?: WardenConditionsConfig | undefined;
	/** Android emulator settings. */
	android?: WardenAndroidSettings | undefined;
}

/** Android emulator settings (`android`). */
export interface WardenAndroidSettings {
	/**
	 * Launch claimed emulators from warden's own quick-boot snapshot of the AVD (built once per AVD from a
	 * cold boot) instead of the AVD's `default_boot` or a cold boot. Default true; `WARDEN_ANDROID_SNAPSHOT=0`
	 * / `=1` override it.
	 */
	snapshot?: boolean | undefined;
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

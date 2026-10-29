import type {
	WardenConfig,
	WardenE2eSpec,
	WardenE2eSuite,
	WardenVariant,
} from "@delacour/warden-core/builds/define-config";

/** The example app's bundle id (iOS bundle identifier and Android package). */
const BUNDLE_ID = "nz.co.delacour.warden.example";

/**
 * Turns off the Expo dev menu at launch, its first-run onboarding sheet and the floating action
 * button, none of which a spec should ever have to dismiss.
 */
const DEV_MENU_OFF = [
	"-EXDevMenuShowsAtLaunch",
	"NO",
	"-EXDevMenuIsOnboardingFinished",
	"YES",
	"-EXDevMenuShowFloatingActionButton",
	"NO",
];

/** How `warden e2e` runs the specs: `bun test` with `@delacour/warden-e2e`, driving this app. */
const SPEC = { bundleId: BUNDLE_ID } satisfies WardenE2eSpec;

/** Every spec drives these screens before its own (fresh launch → welcome → sign-in). */
const SIGNED_IN = ["src/app/welcome.tsx", "src/app/sign-in.tsx"];

/**
 * `ios/` is generated (CNG) and `expo run:ios --no-install` skips CocoaPods, so a fresh worktree
 * needs the native project and its pods before the build.
 */
const IOS_NATIVE = "bunx expo prebuild --platform ios --no-install && pod install --project-directory=ios";

/** Spec discovery + the spec → screen graph `warden affected` uses, shared by every run of the suite. */
const AFFECTED = {
	project: "example",
	specsDir: "e2e",
	platform: "ios",
	routerRoot: "src/app",
	maxDepth: 3,
	unmatched: "run-all",
	runAll: [
		"package.json",
		"app.config.ts",
		"metro.config.js",
		"src/components/ui/**",
		"src/styles/**",
		"src/lib/**",
		"src/hooks/**",
	],
	ignore: ["**/*.test.ts", "**/*.md", "warden.config.ts", "biome.jsonc", "tsconfig.json"],
	specs: {
		onboarding: { entries: ["src/app/welcome.tsx"] },
		"sign-in": { entries: SIGNED_IN },
		todos: { entries: [...SIGNED_IN, "src/app/(tabs)/todos.tsx"] },
		"todo-detail": { entries: [...SIGNED_IN, "src/app/(tabs)/todos.tsx", "src/app/todo/[id].tsx"] },
		settings: { entries: [...SIGNED_IN, "src/app/(tabs)/settings.tsx"] },
		devtools: { entries: ["src/app/welcome.tsx"] },
		perf: { entries: [...SIGNED_IN, "src/app/(tabs)/todos.tsx"] },
		gestures: { entries: ["src/app/welcome.tsx", "src/app/gestures.tsx", "src/modules/gestures"] },
		biometrics: { entries: ["src/app/welcome.tsx", "src/app/biometrics.tsx", "src/modules/biometrics"] },
	},
} satisfies Partial<WardenE2eSuite>;

/**
 * What the simulator kind's JS key covers: the app's own sources and the files Metro / Expo read. Editing a spec or
 * this config re-bundles nothing.
 */
const JS_INPUTS = ["src/**", "assets/**", "app.config.ts", "index.ts", "metro.config.js", "package.json"];

/**
 * The benchmark's pinned app (`bun run bench app build`): a Release `EXPO_PUBLIC_E2E=1` build with the JS
 * embedded, keyed on native + JS (the kind-less flow, so it names its own `build` and `fingerprint`). The root
 * project sets `eas: false` because `eas.json` exists only for the `bench` profile: `warden e2e example` and
 * `warden dev` must never call eas-cli. This variant is the only place a profile and workflow are named, and
 * `bench app build --eas` is the only caller that asks for them. `trigger: false`: warden never starts the
 * workflow itself. The workflow lives in `.eas/workflows/bench-build.yml`.
 */
const bench = {
	eas: { profile: "bench", workflow: ".eas/workflows/bench-build.yml", trigger: false },
	build: {
		configuration: "Release",
		ios: `${IOS_NATIVE} && EXPO_PUBLIC_E2E=1 bunx expo run:ios --configuration Release --no-install --no-bundler`,
		android: "EXPO_PUBLIC_E2E=1 bunx expo run:android --variant release --no-install --no-bundler",
	},
	fingerprint: { include: "native+js", jsInputs: JS_INPUTS },
} satisfies WardenVariant;

/**
 * warden config for the example app, on build kinds: `warden e2e example` installs the `simulator` kind (a Release
 * build with no JS embedded, built once per native fingerprint) and repacks this worktree's JS into it in seconds
 * (`EXPO_PUBLIC_E2E=1` baked in), so a JS edit never rebuilds native. `--dev` flips the same suite to the `dev`
 * kind (Debug dev client) against a Metro warden starts for the run (`metro`), one spec process per device.
 * `warmDrivers: false` opts out of the simulator-driver pre-warm.
 *
 * ```bash
 * warden e2e example                 # specs this branch needs, 2 sims (--all: every spec)
 * warden e2e example --dev --all     # same specs on the dev client + warden's Metro
 * warden e2e example --specs perf --perf  # profile every attempt too (reports under each attempt's perf/)
 * warden e2e biometrics --all       # the biometrics spec alone, on +bio devices (the example suite excludes it)
 * warden affected example            # which specs this branch needs
 * warden repack ios                  # just the repacked simulator build (cached per JS)
 * warden dev ios                     # cached Debug dev client + Metro
 * ```
 */
export default {
	projects: [
		{
			name: "example",
			bundleId: { ios: BUNDLE_ID, android: BUNDLE_ID },
			eas: false,
			kinds: {
				simulator: { env: { EXPO_PUBLIC_E2E: "1" }, jsInputs: JS_INPUTS },
			},
			variants: { bench },
		},
	],
	perf: { budgets: { jankPct: 5, maxCommitMs: 100, p95CpuPct: 90, peakMemoryMb: 600 } },
	e2e: {
		example: {
			count: 2,
			app: true,
			slim: true,
			spec: SPEC,
			metro: { env: { EXPO_PUBLIC_E2E: "1" }, launchArgs: DEV_MENU_OFF },
			jobTimeoutMs: 15 * 60_000,
			exclude: ["biometrics"],
			...AFFECTED,
		},
		biometrics: {
			count: 1,
			app: true,
			slim: true,
			biometrics: true,
			spec: SPEC,
			metro: { env: { EXPO_PUBLIC_E2E: "1" }, launchArgs: DEV_MENU_OFF },
			jobTimeoutMs: 15 * 60_000,
			include: ["biometrics"],
			...AFFECTED,
		},
	},
} satisfies WardenConfig;

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

/** Spec discovery + the spec → screen graph `warden affected` uses, shared by both suites. */
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
		gestures: { entries: ["src/app/welcome.tsx", "src/app/gestures.tsx", "src/modules/gestures"] },
	},
} satisfies Partial<WardenE2eSuite>;

/**
 * The benchmark's pinned app (`bun run bench app build`): the project's own Release `EXPO_PUBLIC_E2E=1`
 * build, keyed on native + JS (`build` and `fingerprint` are inherited). The root project sets
 * `eas: false` because `eas.json` exists only for the `bench` profile: `warden e2e example` and
 * `warden dev` must never call eas-cli. This variant is the only place a profile and workflow are
 * named, and `bench app build --eas` is the only caller that asks for them. `trigger: false`: warden
 * never starts the workflow itself. The workflow lives in `.eas/workflows/bench-build.yml`.
 */
const bench = {
	eas: { profile: "bench", workflow: ".eas/workflows/bench-build.yml", trigger: false },
} satisfies WardenVariant;

/**
 * warden config for the example app: a Release simulator build (JS embedded, no Metro at test time,
 * `EXPO_PUBLIC_E2E=1` baked in) keyed on native + JS, a Debug dev-client variant keyed on native
 * only, and two e2e suites over the same `@delacour/warden-e2e` specs (`bun test` specs):
 * - `example`: the Release build, one spec process per spec;
 * - `example-dev`: the dev client against a Metro warden starts for the run, one spec process per device.
 * `warmDrivers: false` opts out of the simulator-driver pre-warm.
 *
 * ```bash
 * warden e2e example                 # specs this branch needs, 2 sims (--all: every spec)
 * warden e2e example-dev --all       # same specs on the dev client + warden's Metro
 * warden affected example            # which specs this branch needs
 * warden dev ios                     # dev variant: cached Debug dev client + Metro
 * ```
 */
export default {
	projects: [
		{
			name: "example",
			bundleId: { ios: BUNDLE_ID, android: BUNDLE_ID },
			eas: false,
			build: {
				configuration: "Release",
				ios: `${IOS_NATIVE} && EXPO_PUBLIC_E2E=1 bunx expo run:ios --configuration Release --no-install --no-bundler`,
				android: "EXPO_PUBLIC_E2E=1 bunx expo run:android --variant release --no-install --no-bundler",
			},
			fingerprint: {
				include: "native+js",
				jsInputs: ["src/**", "assets/**", "app.config.ts", "index.ts", "metro.config.js", "package.json"],
			},
			variants: {
				dev: {
					build: { configuration: "Debug", ios: `${IOS_NATIVE} && bunx expo run:ios --no-install --no-bundler` },
					fingerprint: { include: "native" },
				},
				bench,
			},
		},
	],
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
} satisfies WardenConfig;

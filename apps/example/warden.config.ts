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

/** The Conditions screen behind its deep link (no sign-in gate). */
const CONDITIONS = ["src/app/welcome.tsx", "src/app/conditions.tsx", "src/modules/conditions"];

/** The screens a Settings row pushes (`app/settings` opens each one and goes Back). */
const SETTINGS_ROWS = [
	"gestures",
	"conditions",
	"keyboard-sheet",
	"a11y",
	"camera",
	"biometrics",
	"network",
	"location",
	"clock",
];

/**
 * `ios/` is generated (CNG) and `expo run:ios --no-install` skips CocoaPods, so a fresh worktree
 * needs the native project and its pods before the build.
 */
const IOS_NATIVE = "bunx expo prebuild --platform ios --no-install && pod install --project-directory=ios";
/** Android twin: generate `android/`, then Gradle alone (`expo run:android` installs on whatever emulator is booted). */
const ANDROID_NATIVE = "bunx expo prebuild --platform android --no-install";

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
		"app/onboarding": { entries: ["src/app/welcome.tsx", "src/app/sign-in.tsx"] },
		"app/auth": { entries: [...SIGNED_IN, "src/app/(tabs)/settings.tsx", "src/modules/session"] },
		"app/todos": {
			entries: [...SIGNED_IN, "src/app/(tabs)/todos.tsx", "src/app/todo/[id].tsx", "src/modules/todos"],
		},
		"app/settings": {
			entries: [
				...SIGNED_IN,
				"src/app/(tabs)/settings.tsx",
				"src/app/(tabs)/todos.tsx",
				...SETTINGS_ROWS.map((route) => `src/app/${route}.tsx`),
			],
		},
		"app/devtools": { entries: ["src/app/welcome.tsx"] },
		"app/perf": { entries: [...SIGNED_IN, "src/app/(tabs)/todos.tsx"] },
		"framework/queries": { entries: [...SIGNED_IN, "src/app/(tabs)/todos.tsx"] },
		"framework/matchers": { entries: [...SIGNED_IN, "src/app/(tabs)/todos.tsx"] },
		"framework/actions": { entries: [...SIGNED_IN, "src/app/(tabs)/todos.tsx", "src/app/(tabs)/settings.tsx"] },
		"framework/runner": { entries: ["src/app/welcome.tsx"] },
		"framework/device": { entries: ["src/app/welcome.tsx"] },
		"app/gestures": { entries: ["src/app/welcome.tsx", "src/app/gestures.tsx", "src/modules/gestures"] },
		"app/keyboard": { entries: ["src/app/welcome.tsx", "src/app/keyboard-sheet.tsx", "src/modules/keyboard"] },
		"conditions/network": {
			entries: [...CONDITIONS, "src/app/network.tsx", "src/modules/network", "src/modules/showcase"],
		},
		"conditions/location": {
			entries: [...CONDITIONS, "src/app/location.tsx", "src/modules/location", "src/modules/showcase"],
		},
		"conditions/clock": {
			entries: [...CONDITIONS, "src/app/clock.tsx", "src/modules/clock", "src/modules/showcase"],
		},
		biometrics: {
			entries: ["src/app/welcome.tsx", "src/app/biometrics.tsx", "src/modules/biometrics", "src/modules/showcase"],
		},
		a11y: { entries: ["src/app/welcome.tsx", "src/app/a11y.tsx", "src/modules/a11y"] },
		camera: { entries: ["src/app/welcome.tsx", "src/app/camera.tsx", "src/modules/camera"] },
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
		android: `${ANDROID_NATIVE} && cd android && EXPO_PUBLIC_E2E=1 ./gradlew app:assembleRelease`,
	},
	fingerprint: { include: "native+js", jsInputs: JS_INPUTS },
} satisfies WardenVariant;

/** Spec ids of the device-conditions specs: they run in the `conditions` suite, not in `example`. */
const CONDITION_SPECS = "conditions/**";

/**
 * What the `example` and `conditions` suites share. The `conditions` suite declares `conditions.network: "online"`,
 * which launches the app on iOS with the warden network dylib (a plain launch cannot be steered later), so its specs
 * can change network and clock mid-test without `relaunch`; every other spec keeps the plain launch.
 */
const EXAMPLE_SUITE = {
	count: 2,
	app: true,
	slim: true,
	spec: SPEC,
	metro: { env: { EXPO_PUBLIC_E2E: "1" }, launchArgs: DEV_MENU_OFF },
	jobTimeoutMs: 15 * 60_000,
	...AFFECTED,
} satisfies WardenE2eSuite;

/**
 * warden config for the example app, on build kinds: `warden e2e example` installs the `simulator` kind (a Release
 * build with no JS embedded, built once per native fingerprint) and repacks this worktree's JS into it in seconds
 * (`EXPO_PUBLIC_E2E=1` baked in), so a JS edit never rebuilds native. `--dev` flips the same suite to the `dev`
 * kind (Debug dev client) against a Metro warden starts for the run (`metro`), one spec process per device.
 * `release` is what a physical phone installs (`--physical` / `--udid`): the same Release build with the JS embedded and
 * the e2e flag baked in, signed for the phone (a device build, never a simulator one). `warmDrivers: false` opts out of the simulator-driver pre-warm.
 *
 * ```bash
 * warden e2e example                 # specs this branch needs, 2 sims (--all: every spec)
 * warden e2e example --dev --all     # same specs on the dev client + warden's Metro
 * warden e2e example --specs app/perf --perf  # profile every attempt too (reports under each attempt's perf/)
 * warden e2e conditions              # network / location / clock specs (iOS app launched with the network dylib)
 * warden e2e a11y                  # the accessibility spec (iOS launched with the a11y library)
 * warden e2e biometrics --all        # the biometrics spec alone, on +bio devices (the example suite excludes it)
 * warden e2e camera --all            # the camera spec alone: suite feed qr-hello, Android claimed with --camera
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
				release: { env: { EXPO_PUBLIC_E2E: "1" }, jsInputs: JS_INPUTS },
			},
			variants: { bench },
		},
	],
	perf: { budgets: { jankPct: 5, maxCommitMs: 100, p95CpuPct: 90, peakMemoryMb: 600 } },
	e2e: {
		example: {
			...EXAMPLE_SUITE,
			exclude: [CONDITION_SPECS, "biometrics", "a11y", "camera"],
		},
		conditions: {
			...EXAMPLE_SUITE,
			include: [CONDITION_SPECS],
			conditions: { network: "online" },
		},
		a11y: {
			...EXAMPLE_SUITE,
			count: 1,
			a11y: { minSeverity: "error" },
			include: ["a11y"],
		},
		biometrics: {
			...EXAMPLE_SUITE,
			count: 1,
			biometrics: true,
			include: ["biometrics"],
		},
		camera: {
			...EXAMPLE_SUITE,
			count: 1,
			camera: { back: "e2e/fixtures/camera/qr-hello.png" },
			include: ["camera"],
		},
	},
} satisfies WardenConfig;

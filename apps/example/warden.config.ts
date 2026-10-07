import type { WardenConfig } from "@delacour/warden-core/builds/define-config";

/** Every flow drives these screens before its own (fresh launch → welcome → sign-in). */
const SIGNED_IN = ["src/app/welcome.tsx", "src/app/sign-in.tsx"];

/**
 * warden config for the example app: a Release simulator build (JS embedded, no Metro at test time,
 * `EXPO_PUBLIC_E2E=1` baked in) keyed on native + JS, and the `example` e2e suite of tester.army flows.
 *
 * ```bash
 * warden e2e example                 # every flow, 2 sims
 * warden affected example            # which flows this branch needs
 * warden e2e example --affected      # just those
 * warden dev ios                     # dev variant: cached Debug dev client + Metro
 * ```
 */
export default {
	projects: [
		{
			name: "example",
			bundleId: { ios: "nz.co.delacour.warden.example", android: "nz.co.delacour.warden.example" },
			build: {
				configuration: "Release",
				ios: "EXPO_PUBLIC_E2E=1 bunx expo run:ios --configuration Release --no-install --no-bundler",
				android: "EXPO_PUBLIC_E2E=1 bunx expo run:android --variant release --no-install --no-bundler",
			},
			fingerprint: {
				include: "native+js",
				jsInputs: ["src/**", "assets/**", "app.config.ts", "index.ts", "metro.config.js", "package.json"],
			},
			variants: {
				dev: { build: { configuration: "Debug" }, fingerprint: { include: "native" } },
			},
		},
	],
	e2e: {
		example: {
			project: "example",
			flowsDir: "e2e",
			platform: "ios",
			runner: ["bunx", "e2e", "run", "{flowPath}", "--retries", "0", "--output", ".e2e/{worker}-{seq}"],
			count: 2,
			app: { clean: true },
			slim: true,
			routerRoot: "src/app",
			maxDepth: 3,
			unmatched: "run-all",
			runAll: [
				"package.json",
				"app.config.ts",
				"metro.config.js",
				"e2e.config.ts",
				"src/components/ui/**",
				"src/styles/**",
				"src/lib/**",
				"src/hooks/**",
			],
			ignore: ["**/*.test.ts", "**/*.md", "warden.config.ts", "biome.jsonc", "tsconfig.json"],
			flows: {
				onboarding: { entries: ["src/app/welcome.tsx"] },
				"sign-in": { entries: SIGNED_IN },
				todos: { entries: [...SIGNED_IN, "src/app/(tabs)/todos.tsx"] },
				"todo-detail": { entries: [...SIGNED_IN, "src/app/(tabs)/todos.tsx", "src/app/todo/[id].tsx"] },
				settings: { entries: [...SIGNED_IN, "src/app/(tabs)/settings.tsx"] },
			},
		},
	},
} satisfies WardenConfig;

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A small RN-shaped monorepo on disk: tsconfig `paths`, an Expo Router tree with layouts, platform
 * files, require / dynamic import, an image, a workspace package (symlinked, built `.d.ts` present)
 * and an external package.
 */
export function makeFixtureRepo(): { dir: string; write: (path: string, text: string) => void } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-affected-")));
	const write = (path: string, text: string) => {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	write(
		"tsconfig.json",
		JSON.stringify({
			compilerOptions: {
				module: "esnext",
				moduleResolution: "bundler",
				jsx: "react-jsx",
				paths: { "@/*": ["./src/*"] },
			},
		})
	);
	write("src/app/_layout.tsx", 'import "@/providers";\n');
	write("src/providers.tsx", "export {};\n");
	write("src/app/(app)/_layout.tsx", "export {};\n");
	write("src/app/(app)/chats.tsx", 'import { List } from "@/chat/list";\nimport logo from "@/assets/logo.png";\n');
	write("src/app/(app)/settings.tsx", 'import "@/settings/form";\n');
	write("src/settings/form.tsx", "export {};\n");
	write("src/assets/logo.png", "png");
	write(
		"src/chat/list.tsx",
		'import type { Props } from "./types";\nimport React from "react";\nimport { Row } from "./row";\nimport { Button } from "@x/ui";\nconst legacy = require("./legacy");\nconst lazy = () => import("./lazy");\n'
	);
	write("src/chat/types.ts", "export type Props = { id: string };\n");
	write("src/chat/row.ios.tsx", "export const Row = 1;\n");
	write("src/chat/row.tsx", 'import "./android-only";\nexport const Row = 1;\n');
	write("src/chat/android-only.tsx", "export {};\n");
	write("src/chat/legacy.js", "module.exports = 1;\n");
	write("src/chat/lazy.tsx", "export {};\n");
	write("packages/ui/package.json", JSON.stringify({ name: "@x/ui", main: "src/index.ts", types: "dist/index.d.ts" }));
	write("packages/ui/src/index.ts", 'export { Button } from "./button";\n');
	write("packages/ui/src/button.tsx", "export const Button = 1;\n");
	write("packages/ui/dist/index.d.ts", "export declare const Button: number;\n");
	write("node_modules/react/package.json", JSON.stringify({ name: "react", main: "index.js" }));
	write("node_modules/react/index.js", "module.exports = {};\n");
	mkdirSync(join(dir, "node_modules/@x"), { recursive: true });
	symlinkSync(join(dir, "packages/ui"), join(dir, "node_modules/@x/ui"));
	return { dir, write };
}

/** Two flows + a `mobile` suite mapping them to screens, committed on `main`, checked out on `feature`. */
export async function makeSuiteRepo(
	suite: Record<string, unknown> = {},
	/** extra top-level `warden.config.json` keys (e.g. `projects`) */
	config: Record<string, unknown> = {}
): Promise<{ dir: string; write: (path: string, text: string) => void }> {
	const repo = makeFixtureRepo();
	const { dir, write } = repo;
	write("flows/chats.yaml", "steps:\n  - launch: com.x\n");
	write("flows/settings.yaml", "steps:\n  - launch: com.x\n");
	write(".gitignore", "node_modules\n");
	write(
		"warden.config.json",
		JSON.stringify({
			...config,
			e2e: {
				mobile: {
					flowsDir: "flows",
					runner: ["run-flow", "{flowPath}", "--device", "{udid}"],
					platform: "ios",
					flows: {
						chats: { entries: ["src/app/(app)/chats.tsx"] },
						settings: { entries: ["src/app/(app)/settings.tsx"], required: false },
					},
					...suite,
				},
			},
		})
	);
	for (const args of [
		["init", "-q", "-b", "main"],
		["config", "user.email", "t@t"],
		["config", "user.name", "t"],
		["add", "."],
		["commit", "-qm", "base"],
		["checkout", "-qb", "feature"],
	]) {
		const res = Bun.spawnSync(["git", ...args], { cwd: dir });
		if (res.exitCode !== 0) throw new Error(res.stderr.toString());
	}
	return repo;
}

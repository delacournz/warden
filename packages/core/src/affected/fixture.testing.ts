import {
	appendFileSync,
	copyFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImportGraph, type GraphOptions, type ImportGraph } from "./graph";

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
	symlinkSync("../../packages/ui", join(dir, "node_modules/@x/ui"));
	return { dir, write };
}

const templates = new Map<string, string>();
let templateRoot: string | undefined;

function templateDir(): string {
	if (templateRoot) return templateRoot;
	templateRoot = realpathSync(mkdtempSync(join(tmpdir(), "warden-affected-tpl-")));
	process.on("exit", () => {
		if (templateRoot) rmSync(templateRoot, { recursive: true, force: true });
	});
	return templateRoot;
}

function buildSuiteRepo(suite: Record<string, unknown>, config: Record<string, unknown>): string {
	const { dir, write } = makeFixtureRepo();
	write("specs/chats.e2e.ts", "export {};\n");
	write("specs/settings.e2e.ts", "export {};\n");
	write(".gitignore", "node_modules\n");
	write(
		"warden.config.json",
		JSON.stringify({
			...config,
			e2e: {
				mobile: {
					specsDir: "specs",
					platform: "ios",
					spec: { bundleId: "com.x" },
					specs: {
						chats: { entries: ["src/app/(app)/chats.tsx"] },
						settings: { entries: ["src/app/(app)/settings.tsx"], required: false },
					},
					...suite,
				},
			},
		})
	);
	const git = (...args: string[]) => {
		const res = Bun.spawnSync(["git", ...args], { cwd: dir });
		if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${res.exitCode}: ${res.stderr.toString()}`);
	};
	// Three git processes, the rest on disk: each spawn costs seconds on a loaded CI host.
	git("init", "-q", "-b", "main");
	// No auto-maintenance: `git commit` would detach a `maintenance run --auto` that creates and
	// deletes `.git/objects/maintenance.lock` while the cpSync below walks the tree (ENOENT on lstat).
	appendFileSync(
		join(dir, ".git/config"),
		"[user]\n\temail = t@t\n\tname = t\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n"
	);
	git("add", ".");
	git("commit", "-qm", "base");
	copyFileSync(join(dir, ".git/refs/heads/main"), join(dir, ".git/refs/heads/feature"));
	writeFileSync(join(dir, ".git/HEAD"), "ref: refs/heads/feature\n");
	return dir;
}

/**
 * Two specs + a `mobile` suite mapping them to screens, committed on `main`, checked out on `feature`.
 * Each (suite, config) is built once per process; every call gets a fresh, independent copy of it.
 */
export async function makeSuiteRepo(
	suite: Record<string, unknown> = {},
	/** extra top-level `warden.config.json` keys (e.g. `projects`) */
	config: Record<string, unknown> = {}
): Promise<{ dir: string; write: (path: string, text: string) => void }> {
	const key = JSON.stringify([suite, config], (_k, v: unknown) => (v === undefined ? "\u0000undefined" : v));
	let template = templates.get(key);
	if (!template) {
		const built = buildSuiteRepo(suite, config);
		template = join(templateDir(), String(templates.size));
		cpSync(built, template, { recursive: true, verbatimSymlinks: true });
		rmSync(built, { recursive: true, force: true });
		templates.set(key, template);
	}
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-affected-")));
	cpSync(template, dir, { recursive: true, verbatimSymlinks: true });
	const write = (path: string, text: string) => {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	return { dir, write };
}

/** `createImportGraph`, failing the test when it is an error. */
export async function graphOf(opts: GraphOptions): Promise<ImportGraph> {
	const res = await createImportGraph(opts);
	if (!res.success) throw new Error(res.error);
	return res.data;
}

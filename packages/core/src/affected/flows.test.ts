import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flowPlatforms, flowSettings, parseFlow, scanFlows } from "./flows";

let dir: string;

function write(path: string, text: string): void {
	mkdirSync(join(dir, path, ".."), { recursive: true });
	writeFileSync(join(dir, path), text);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-flows-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parseFlow", () => {
	test("e2e = first non-echo/script step is launch; run: refs resolve next to the file, nested ones too", () => {
		const flow = parseFlow(
			join(dir, "qa/login.yaml"),
			dir,
			[
				"steps:",
				"  - echo: hi",
				"  - launch: { ios: com.x, android: com.x }",
				"  - run: ../shared/sign-in.yaml",
				"  - when: { platform: ios }",
				"    steps:",
				"      - run: ./ios-only.yml",
			].join("\n")
		);
		expect(flow).toEqual({
			id: "qa/login",
			file: join(dir, "qa/login.yaml"),
			kind: "e2e",
			runs: [join(dir, "shared/sign-in.yaml"), join(dir, "qa/ios-only.yml")],
			launchPlatforms: ["ios", "android"],
		});
	});

	test("YAML the strict parser rejects (multi-line plain scalars) still yields launch + run: refs", () => {
		const text = [
			"steps:",
			"  - echo: Sending offline. `submit: false` — the send button commits,",
			"      not the return key.",
			"  - launch: { ios: com.x }",
			"  - run: ./shared/sign-in.yaml",
		].join("\n");
		const flow = parseFlow(join(dir, "x.yaml"), dir, text);
		expect(flow).toMatchObject({ kind: "e2e", runs: [join(dir, "shared/sign-in.yaml")], launchPlatforms: ["ios"] });
	});

	test("no launch → fragment", () => {
		const flow = parseFlow(join(dir, "f.yaml"), dir, "steps:\n  - tap: { id: x }\n");
		expect(flow.kind).toBe("fragment");
	});
});

describe("scanFlows", () => {
	test("recurses, skips baselines + dot dirs; unparseable YAML is line-scanned", () => {
		write("a.yaml", "steps:\n  - launch: x\n");
		write("sub/b.yml", "steps:\n  - launch: x\n");
		write("__baselines__/a/shot.yaml", "steps: []\n");
		write(".hidden/c.yaml", "steps: []\n");
		write("broken.yaml", "steps: [\n  - launch: x\n");
		const scan = scanFlows(dir);
		expect(scan.flows.map((f) => [f.id, f.kind])).toEqual([
			["a", "e2e"],
			["broken", "e2e"],
			["sub/b", "e2e"],
		]);
		expect(scan.warnings).toEqual([]);
	});
});

describe("TypeScript flows (*.e2e.ts)", () => {
	test("*.e2e.ts is an e2e flow; id drops `.e2e.ts`; relative imports resolve (extension / index) as runs", () => {
		write("helpers/app.ts", "export const x = 1;\n");
		write("helpers/index.ts", "export * from './app';\n");
		const file = join(dir, "auth/sign-in.e2e.ts");
		const text = [
			'import { test } from "@e2e-dev/mobile";',
			'import { expect } from "e2e";',
			'import type { Todo } from "../helpers/types";',
			'import { openApp } from "../helpers/app";',
			'import "../helpers";',
		].join("\n");
		expect(parseFlow(file, dir, text)).toEqual({
			id: "auth/sign-in",
			file,
			kind: "e2e",
			runs: [join(dir, "helpers/app.ts"), join(dir, "helpers/index.ts")],
		});
	});

	test("scanFlows: *.e2e.ts / .tsx are flows, other .ts files are fragments, YAML still works", () => {
		write("sign-in.e2e.ts", 'import { open } from "./helpers/app";\n');
		write("todos.e2e.tsx", "export {};\n");
		write("helpers/app.ts", 'import { ids } from "./ids";\n');
		write("helpers/ids.ts", "export const ids = {};\n");
		write("legacy.yaml", "steps:\n  - launch: x\n");
		const scan = scanFlows(dir);
		expect(scan.flows.map((f) => [f.id, f.kind])).toEqual([
			["helpers/app", "fragment"],
			["helpers/ids", "fragment"],
			["legacy", "e2e"],
			["sign-in", "e2e"],
			["todos", "e2e"],
		]);
		expect(scan.flows.find((f) => f.id === "helpers/app")?.runs).toEqual([join(dir, "helpers/ids.ts")]);
	});
});

describe("flowSettings / flowPlatforms", () => {
	const flows = {
		"store-*": { entries: ["src/app/_layout.tsx"], paths: [], required: false },
		"store-ios-02-chats": { entries: ["src/app/chats.tsx"], paths: ["src/chat/**"] },
	};

	test("exact key + globs merge; exact settings win", () => {
		expect(flowSettings("store-ios-02-chats", flows)).toEqual({
			entries: ["src/app/chats.tsx", "src/app/_layout.tsx"],
			paths: ["src/chat/**"],
			required: false,
		});
		expect(flowSettings("qa-x", flows)).toEqual({ entries: [], paths: [] });
	});

	test("platforms: config > id token > launch map > both", () => {
		const base = { file: "", kind: "e2e" as const, runs: [] };
		expect(flowPlatforms({ ...base, id: "store-ios-01" }, { entries: [], paths: [] })).toEqual(["ios"]);
		expect(flowPlatforms({ ...base, id: "android/login" }, { entries: [], paths: [] })).toEqual(["android"]);
		expect(flowPlatforms({ ...base, id: "biosphere" }, { entries: [], paths: [] })).toEqual(["ios", "android"]);
		expect(flowPlatforms({ ...base, id: "x", launchPlatforms: ["android"] }, { entries: [], paths: [] })).toEqual([
			"android",
		]);
		expect(flowPlatforms({ ...base, id: "store-ios-01" }, { entries: [], paths: [], platforms: ["android"] })).toEqual([
			"android",
		]);
	});
});

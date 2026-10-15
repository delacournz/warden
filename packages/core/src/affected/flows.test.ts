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

describe("parseFlow / scanFlows (*.e2e.ts)", () => {
	test("*.e2e.ts is an e2e flow; id drops `.e2e.ts`; relative imports resolve (extension / index) as runs", () => {
		write("helpers/app.ts", "export const x = 1;\n");
		write("helpers/index.ts", "export * from './app';\n");
		const file = join(dir, "auth/sign-in.e2e.ts");
		const text = [
			'import { expect, test } from "@delacour/warden-e2e";',
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

	test("scanFlows: *.e2e.ts / .tsx are flows, other .ts files are fragments, YAML and .d.ts files are ignored", () => {
		write("sign-in.e2e.ts", 'import { open } from "./helpers/app";\n');
		write("todos.e2e.tsx", "export {};\n");
		write("helpers/app.ts", 'import { ids } from "./ids";\n');
		write("helpers/ids.ts", "export const ids = {};\n");
		write("legacy.yaml", "steps:\n  - launch: x\n");
		write("types.d.ts", "export {};\n");
		write("__baselines__/a/shot.e2e.ts", "export {};\n");
		write(".hidden/c.e2e.ts", "export {};\n");
		const scan = scanFlows(dir);
		expect(scan.flows.map((f) => [f.id, f.kind])).toEqual([
			["helpers/app", "fragment"],
			["helpers/ids", "fragment"],
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

	test("platforms: config > id token > both", () => {
		const base = { file: "", kind: "e2e" as const, runs: [] };
		expect(flowPlatforms({ ...base, id: "store-ios-01" }, { entries: [], paths: [] })).toEqual(["ios"]);
		expect(flowPlatforms({ ...base, id: "android/login" }, { entries: [], paths: [] })).toEqual(["android"]);
		expect(flowPlatforms({ ...base, id: "biosphere" }, { entries: [], paths: [] })).toEqual(["ios", "android"]);
		expect(flowPlatforms({ ...base, id: "store-ios-01" }, { entries: [], paths: [], platforms: ["android"] })).toEqual([
			"android",
		]);
	});
});

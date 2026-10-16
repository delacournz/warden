import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeExec } from "../harness/exec";
import { cellarDir, footprintOf, sourceStats } from "./footprint";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bench-footprint-"));
	mkdirSync(join(root, "suites/maestro/artifacts"), { recursive: true });
	mkdirSync(join(root, "suites/maestro/node_modules/x"), { recursive: true });
	writeFileSync(join(root, "suites/maestro/a.yaml"), "appId: x\n\n- launchApp\n");
	writeFileSync(join(root, "suites/maestro/b.ts"), "export {}\n");
	writeFileSync(join(root, "suites/maestro/notes.md"), "ignored\n");
	writeFileSync(join(root, "suites/maestro/artifacts/c.yaml"), "ignored\n");
	writeFileSync(join(root, "suites/maestro/node_modules/x/d.js"), "ignored\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("sourceStats", () => {
	test("counts non-blank lines of ts/yaml/ad/js, skipping artifacts and node_modules", () => {
		expect(sourceStats(join(root, "suites/maestro"))).toEqual({ loc: 3, bytes: 21 + 11 });
	});

	test("a missing suite is zero", () => {
		expect(sourceStats(join(root, "suites/none"))).toEqual({ loc: 0, bytes: 0 });
	});
});

describe("cellarDir", () => {
	test("cuts at the version directory", () => {
		expect(cellarDir("/opt/homebrew/Cellar/maestro/2.0.0/libexec/bin/maestro")).toBe(
			"/opt/homebrew/Cellar/maestro/2.0.0"
		);
		expect(cellarDir("/usr/local/bin/maestro")).toBeUndefined();
	});
});

describe("footprintOf", () => {
	test("maestro: sources plus ~/.maestro and the cellar", async () => {
		const exec = fakeExec(
			[
				{ cmd: "readlink", result: { stdout: "/opt/homebrew/Cellar/maestro/2.0.0/libexec/bin/maestro\n" } },
				{
					cmd: "du",
					result: (args) => ({ stdout: `${args.at(-1)?.includes("Cellar") ? 100 : 40}\t${args.at(-1)}\n` }),
				},
			],
			{ which: ["maestro"] }
		);
		const f = await footprintOf({ packageRoot: root, framework: "maestro", exec, home: "/h" });
		expect(f).toEqual({ testSourceLoc: 3, testSourceBytes: 32, depsBytes: 0, binaryBytes: 140 * 1024, notes: [] });
		expect(exec.calls.find((c) => c.cmd === "du")?.args).toEqual(["-skL", "/h/.maestro"]);
	});

	test("tester-army: node_modules deps are counted, missing ones become notes", async () => {
		const exec = fakeExec([
			{
				cmd: "du",
				result: (args) =>
					args.at(-1)?.endsWith("/agent-device")
						? { code: 1, stderr: "No such file" }
						: { stdout: `10\t${args.at(-1)}\n` },
			},
		]);
		const f = await footprintOf({ packageRoot: root, framework: "tester-army", exec, home: "/h" });
		expect(f.depsBytes).toBe(20 * 1024);
		expect(f.binaryBytes).toBe(0);
		expect(f.notes).toEqual([`not found: ${join(root, "node_modules/agent-device")}`]);
	});

	test("detox looks in ~/Library/Detox", async () => {
		const exec = fakeExec([{ cmd: "du", result: (args) => ({ stdout: `5\t${args.at(-1)}\n` }) }]);
		const f = await footprintOf({ packageRoot: root, framework: "detox", exec, home: "/h" });
		const duPaths = exec.calls.map((c) => c.args.at(-1));
		expect(duPaths).toContain("/h/Library/Detox");
		expect(f.binaryBytes).toBe(5 * 1024);
	});
});

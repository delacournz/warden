import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeExec } from "../harness/exec";
import { footprintOf, sourceStats } from "./footprint";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bench-footprint-"));
	mkdirSync(join(root, "suites/agent-device/artifacts"), { recursive: true });
	mkdirSync(join(root, "suites/agent-device/node_modules/x"), { recursive: true });
	writeFileSync(join(root, "suites/agent-device/a.yaml"), "appId: x\n\n- launchApp\n");
	writeFileSync(join(root, "suites/agent-device/b.ts"), "export {}\n");
	writeFileSync(join(root, "suites/agent-device/notes.md"), "ignored\n");
	writeFileSync(join(root, "suites/agent-device/artifacts/c.yaml"), "ignored\n");
	writeFileSync(join(root, "suites/agent-device/node_modules/x/d.js"), "ignored\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("sourceStats", () => {
	test("counts non-blank lines of ts/yaml/ad/js, skipping artifacts and node_modules", () => {
		expect(sourceStats(join(root, "suites/agent-device"))).toEqual({ loc: 3, bytes: 21 + 11 });
	});

	test("a missing suite is zero", () => {
		expect(sourceStats(join(root, "suites/none"))).toEqual({ loc: 0, bytes: 0 });
	});
});

describe("footprintOf", () => {
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

	test("agent-device: sources plus its global install", async () => {
		const exec = fakeExec([
			{
				cmd: "du",
				result: (args) => ({
					stdout: `7	${args.at(-1)}
`,
				}),
			},
		]);
		const f = await footprintOf({ packageRoot: root, framework: "agent-device", exec, home: "/h" });
		expect(f).toEqual({ testSourceLoc: 3, testSourceBytes: 32, depsBytes: 0, binaryBytes: 7 * 1024, notes: [] });
		expect(exec.calls.map((c) => c.args.at(-1))).toContain("/h/.bun/install/global/node_modules/agent-device");
	});
});

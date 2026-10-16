import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeExec } from "../harness/exec";
import type { RunContext } from "./adapter.types";
import { argentAdapter, argentRunArgs, pidsMentioning, toTestResults } from "./argent";
import { parseArgentAggregate } from "./parse/argent-report";

const packageRoot = join(import.meta.dir, "../..");
const fixture = readFileSync(join(import.meta.dir, "fixtures/argent/flow-run-dir.json"), "utf8");

function ctx(exec: RunContext["exec"]): RunContext {
	return {
		platform: "ios",
		udid: "UDID-1",
		bundleId: "nz.co.delacour.warden.example",
		appPath: "/x.app",
		outDir: mkdtempSync(join(tmpdir(), "argent-")),
		cold: true,
		retries: 0,
		env: {},
		exec,
		log: () => undefined,
		packageRoot,
		repoRoot: join(packageRoot, "../.."),
	};
}

describe("argent adapter", () => {
	test("argv", () => {
		expect(argentRunArgs("/s", "U", "android")).toEqual([
			"flow",
			"run",
			"/s",
			"--device",
			"U",
			"--platform",
			"android",
			"--json",
		]);
	});
	test("fixture flows join the manifest with all 8 ids", () => {
		const flows = parseArgentAggregate(fixture);
		if (!flows.success) throw new Error(flows.error);
		const t = toTestResults(flows.data, packageRoot);
		if (!t.success) throw new Error(t.error);
		expect(t.data.map((x) => x.status)).toEqual(Array(8).fill("passed"));
	});
	test("unmapped flow name is a parity breach", () => {
		const t = toTestResults(
			[{ nativeName: "rogue", status: "passed", durationMs: 1, steps: [], error: undefined }],
			packageRoot
		);
		expect(t.success).toBe(false);
	});
	test("run parses stdout even when argent exits non-zero", async () => {
		const exec = fakeExec([{ cmd: "argent", result: { code: 1, stdout: fixture } }]);
		const r = await argentAdapter.run(ctx(exec));
		expect(r.success).toBe(true);
		expect(exec.calls[0]?.args).toContain("--json");
	});
	test("run fails on garbage output", async () => {
		const r = await argentAdapter.run(ctx(fakeExec([{ cmd: "argent", result: { code: 2, stdout: "boom" } }])));
		expect(r.success).toBe(false);
	});
	test("doctor reads the version", async () => {
		const d = await argentAdapter.doctor(ctx(fakeExec([{ cmd: "argent", result: { stdout: "0.27.0\n" } }])));
		expect(d).toMatchObject({ ok: true, version: "0.27.0" });
		const missing = await argentAdapter.doctor(ctx(fakeExec([])));
		expect(missing).toMatchObject({ ok: false, installHint: "bun add -g @swmansion/argent" });
	});
	test("prepare tolerates an already-running server", async () => {
		const exec = fakeExec([{ cmd: "argent", result: { code: 1, stderr: "tool-server is already running" } }]);
		expect((await argentAdapter.prepare(ctx(exec))).success).toBe(true);
	});
	test("teardown kills only this device's simulator-server and spares a shared tool-server", async () => {
		const exec = fakeExec([
			{
				cmd: "pgrep",
				match: (a) => a.includes("simulator-server"),
				result: { stdout: "11 /x/simulator-server ios --id UDID-1\n12 /x/simulator-server ios --id OTHER\n" },
			},
			{ cmd: "pgrep", result: { stdout: "99\n" } },
			{ cmd: "kill", result: {} },
		]);
		await argentAdapter.teardown(ctx(exec));
		expect(exec.calls.filter((c) => c.cmd === "kill").map((c) => c.args[0])).toEqual(["11"]);
		expect(exec.calls.some((c) => c.args[0] === "server")).toBe(false);
	});
	test("teardown stops the tool-server when no mcp session lives", async () => {
		const exec = fakeExec([
			{ cmd: "pgrep", result: { code: 1 } },
			{ cmd: "argent", result: {} },
		]);
		await argentAdapter.teardown(ctx(exec));
		expect(exec.calls.some((c) => c.cmd === "argent" && c.args[0] === "server")).toBe(true);
	});
	test("pidsMentioning", () => {
		expect(pidsMentioning("5 a UDID\n6 b\n", "UDID")).toEqual([5]);
	});
});

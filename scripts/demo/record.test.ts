import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DemoDefinition } from "./demo.types";
import { type Exec, type RecordDeps, record } from "./record";

const claim = JSON.stringify({ leases: [{ leaseId: "l_1", udid: "U1" }] });

type Call = { cmd: readonly string[]; cwd: string };

/** Fake deps: every command succeeds with `ok` output unless `fail` returns a non-zero code for it. */
function fakeDeps(fail: (cmd: readonly string[]) => boolean): { deps: RecordDeps; calls: Call[]; logs: string[] } {
	const calls: Call[] = [];
	const logs: string[] = [];
	let clock = 0;
	const exec: Exec = async (cmd, opts) => {
		calls.push({ cmd, cwd: opts.cwd });
		if (cmd.includes("claim")) return { code: 0, stdout: claim, stderr: "" };
		if (fail(cmd)) return { code: 1, stdout: "", stderr: "nope" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const deps: RecordDeps = {
		exec,
		now: () => clock,
		sleep: async (ms) => {
			clock += ms / 1000;
		},
		log: (line) => logs.push(line),
	};
	return { deps, calls, logs };
}

const base: DemoDefinition = {
	name: "t/t",
	title: "T",
	subtitle: "s",
	terminalTitle: "zsh",
	footer: { left: "l", right: "r" },
	platform: "ios",
	claim: {},
	app: { bundleId: "a.b", kind: "simulator", project: "." },
	ready: [],
	leadInMs: 0,
	tailHoldMs: 0,
	outro: "#",
	steps: [{ argv: ["ui", "wait", "id=x"], output: { kind: "ok", text: "ok" }, pauseAfterMs: 0 }],
};

async function outDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "demo-record-"));
}

const ran = (calls: readonly Call[], word: string) => calls.some((c) => c.cmd.includes(word));

describe("setup steps", () => {
	test("a plain argv failing aborts the take", async () => {
		const { deps } = fakeDeps((cmd) => cmd.includes("boom"));
		const def = { ...base, setup: [["ui", "press", "boom"]] };
		await expect(record(def, "/repo", await outDir(), "l", deps)).rejects.toThrow(/boom/);
	});

	test("an optional step failing is logged, not thrown, and the take goes on", async () => {
		const { deps, calls, logs } = fakeDeps((cmd) => cmd.includes("id=camera-allow"));
		const def: DemoDefinition = {
			...base,
			setup: [{ argv: ["ui", "press", "id=camera-allow"], optional: true }, ["ui", "alert", "get"]],
		};
		const take = await record(def, "/repo", await outDir(), "l", deps);
		expect(take.steps).toHaveLength(1);
		expect(ran(calls, "alert")).toBe(true);
		expect(logs.some((l) => l.includes("optional") && l.includes("camera-allow"))).toBe(true);
	});

	test("an optional step that succeeds runs like any other and a non-optional object step still throws", async () => {
		const { deps } = fakeDeps((cmd) => cmd.includes("boom"));
		const def: DemoDefinition = { ...base, setup: [{ argv: ["ui", "press", "boom"] }] };
		await expect(record(def, "/repo", await outDir(), "l", deps)).rejects.toThrow(/boom/);
	});
});

describe("{udid} in setup argv", () => {
	test("is replaced by the leased udid and --udid is not appended", async () => {
		const { deps, calls } = fakeDeps(() => false);
		const def: DemoDefinition = { ...base, setup: [["sim", "slim", "{udid}", "--restore"]] };
		await record(def, "/repo", await outDir(), "l", deps);
		const call = calls.find((c) => c.cmd.includes("slim"));
		expect(call?.cmd.slice(-4)).toEqual(["sim", "slim", "U1", "--restore"]);
	});
});

describe("quoted file lines", () => {
	test("every quoted line must be in the file the step wrote", async () => {
		const dir = await outDir();
		const project = join(dir, "proj");
		await mkdir(join(project, "e2e"), { recursive: true });
		await writeFile(join(project, "e2e/a.e2e.ts"), 'await app.open({ wait: "quiet" });\n\tawait x.tap();\n');
		const { deps } = fakeDeps(() => false);
		const make = (lines: string[]): DemoDefinition => ({
			...base,
			app: { ...base.app, project: "proj" },
			steps: [
				{
					argv: ["ui", "record", "stop"],
					output: { kind: "lines", text: lines },
					quote: { file: "e2e/a.e2e.ts" },
					pauseAfterMs: 0,
				},
			],
		});
		await record(make(['await app.open({ wait: "quiet" });', "await x.tap();"]), dir, await outDir(), "l", deps);
		await expect(record(make(["await y.tap();"]), dir, await outDir(), "l", deps)).rejects.toThrow(/await y\.tap/);
	});
});

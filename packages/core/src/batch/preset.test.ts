import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, parseWardenConfig } from "../builds/config";
import { findBatchPreset } from "./preset";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-preset-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(path: string, data: unknown): void {
	mkdirSync(join(dir, path, ".."), { recursive: true });
	writeFileSync(join(dir, path), typeof data === "string" ? data : JSON.stringify(data));
}

const salientPreset = {
	project: "salient",
	platform: "ios",
	count: 5,
	max: 5,
	profile: "iphone-17",
	ports: ["8091:20"],
	app: true,
	retry: 1,
	env: { E2E_SESSION_FILE: "e2e-artifacts/batch/session.json" },
	serve: "bun scripts/e2e/run-ios.ts --session",
	serveReady: "file:e2e-artifacts/batch/session.json",
	serveTimeout: "20m",
	jobsFrom: { command: "bun scripts/e2e/select-flows.ts --list --offline" },
	cmd: ["bun", "scripts/e2e/run-ios.ts", "--attach", "{job}", "--device", "{udid}"],
};

const salientProject = { name: "salient", root: "apps/salient/app", bundleId: { ios: "nz.x.salient" } };

describe("batches in parseWardenConfig", () => {
	test("accepts the salient preset as-is", () => {
		const res = parseWardenConfig({ projects: [salientProject], batches: { e2e: salientPreset } });
		if (!res.success) throw new Error(res.error);
		expect(res.data.batches?.e2e).toEqual({ ...salientPreset, platform: "ios" });
	});

	test("label + projects[].eas.trigger: true (salient's real config)", () => {
		const res = parseWardenConfig({
			projects: [{ ...salientProject, eas: { profile: "development-simulator", workflow: "w.yml", trigger: true } }],
			batches: { "salient-e2e": { ...salientPreset, label: "salient-e2e" } },
		});
		if (!res.success) throw new Error(res.error);
		expect(res.data.batches?.["salient-e2e"]?.label).toBe("salient-e2e");
		expect(res.data.projects?.[0]?.eas?.trigger).toBe(true);
	});

	test("batches without projects is a valid config", () => {
		expect(parseWardenConfig({ batches: { smoke: { platform: "android", cmd: ["true"] } } }).success).toBe(true);
	});

	test("rejects bad presets with a path", () => {
		const base = { platform: "ios", cmd: ["x"] };
		const cases: Array<[unknown, string]> = [
			[{ batches: { a: { cmd: ["x"] } } }, "batches.a.platform"],
			[{ batches: { a: { platform: "tvos", cmd: ["x"] } } }, "batches.a.platform"],
			[{ batches: { a: { platform: "ios" } } }, "batches.a.cmd"],
			[{ batches: { a: { ...base, cmd: [] } } }, "batches.a.cmd"],
			[{ batches: { a: { ...base, count: 0 } } }, "batches.a.count"],
			[{ batches: { a: { ...base, retry: -1 } } }, "batches.a.retry"],
			[{ batches: { a: { ...base, ttl: "soon" } } }, "batches.a.ttl"],
			[{ batches: { a: { ...base, serveTimeout: "never" } } }, "batches.a.serveTimeout"],
			[{ batches: { a: { ...base, ports: ["x"] } } }, "batches.a.ports.0"],
			[{ batches: { a: { ...base, env: { A: 1 } } } }, "batches.a.env.A"],
			[{ batches: { a: { ...base, jobs: ["j"], jobsFrom: "f" } } }, "batches.a.jobs"],
			[{ batches: { a: { ...base, jobsFrom: { command: "" } } } }, "batches.a.jobsFrom"],
			[{ batches: { a: { ...base, nope: 1 } } }, "batches.a"],
			[{ batches: { a: { ...base, project: "ghost" } } }, "batches.a.project"],
			[{ batches: { ios: base } }, "batches.ios"],
			[{}, "(root)"],
		];
		for (const [raw, path] of cases) {
			const res = parseWardenConfig(raw);
			expect(res.success).toBe(false);
			if (!res.success) expect(res.error).toContain(`${CONFIG_FILE}: ${path}`);
		}
	});
});

describe("findBatchPreset", () => {
	test("no config → no preset, no names", () => {
		expect(findBatchPreset({ start: dir, stopAt: dir, name: "e2e" })).toEqual({
			success: true,
			data: { names: [] },
		});
	});

	test("unknown name → no preset, lists the names", () => {
		write(CONFIG_FILE, { batches: { b: { platform: "ios", cmd: ["x"] }, a: { platform: "ios", cmd: ["x"] } } });
		expect(findBatchPreset({ start: dir, name: "nope" })).toEqual({ success: true, data: { names: ["a", "b"] } });
	});

	test("invalid config → error", () => {
		write(CONFIG_FILE, { batches: { a: { platform: "ios" } } });
		const res = findBatchPreset({ start: dir, name: "a" });
		expect(res.success).toBe(false);
	});

	test("salient: walks up to the config; cwd = project root; paths resolve against it; label = name", () => {
		write(CONFIG_FILE, { projects: [salientProject], batches: { e2e: salientPreset } });
		const root = join(dir, "apps/salient/app");
		mkdirSync(join(root, "src"), { recursive: true });
		const res = findBatchPreset({ start: join(root, "src"), stopAt: dir, name: "e2e" });
		if (!res.success) throw new Error(res.error);
		expect(res.data.preset).toEqual({
			name: "e2e",
			cwd: root,
			projectRoot: root,
			platform: "ios",
			count: 5,
			max: 5,
			profile: "iphone-17",
			label: "e2e",
			ports: ["8091:20"],
			app: true,
			retry: 1,
			env: { E2E_SESSION_FILE: "e2e-artifacts/batch/session.json" },
			serve: "bun scripts/e2e/run-ios.ts --session",
			serveReady: `file:${join(root, "e2e-artifacts/batch/session.json")}`,
			serveTimeout: "20m",
			jobs: { kind: "command", command: "bun scripts/e2e/select-flows.ts --list --offline" },
			cmd: ["bun", "scripts/e2e/run-ios.ts", "--attach", "{job}", "--device", "{udid}"],
		});
	});

	test("no project: cwd = config dir; record/logs/jobsFrom file resolve; absolute + non-file ready kept", () => {
		write(CONFIG_FILE, {
			batches: {
				a: {
					platform: "android",
					label: "mine",
					jobsFrom: "jobs.txt",
					record: "rec",
					logs: "/abs/logs",
					serve: "s",
					serveReady: "tcp:8081",
					cmd: ["x"],
				},
				b: { platform: "ios", jobsFrom: "-", serve: "s", serveReady: "file:/abs/ready", cmd: ["x"] },
				c: { platform: "ios", jobs: ["j1", "j2"], cmd: ["x"] },
			},
		});
		mkdirSync(join(dir, "sub"));
		const a = findBatchPreset({ start: join(dir, "sub"), name: "a" });
		if (!a.success) throw new Error(a.error);
		expect(a.data.preset).toMatchObject({
			cwd: dir,
			label: "mine",
			jobs: { kind: "file", path: join(dir, "jobs.txt") },
			record: join(dir, "rec"),
			logs: "/abs/logs",
			serveReady: "tcp:8081",
		});
		expect(a.data.preset?.projectRoot).toBeUndefined();
		const b = findBatchPreset({ start: dir, name: "b" });
		expect(b.success && b.data.preset).toMatchObject({ jobs: { kind: "stdin" }, serveReady: "file:/abs/ready" });
		const c = findBatchPreset({ start: dir, name: "c" });
		expect(c.success && c.data.preset?.jobs).toEqual({ kind: "list", jobs: ["j1", "j2"] });
	});
});

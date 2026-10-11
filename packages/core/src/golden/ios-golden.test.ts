import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store";
import { goldenKey, goldenName, wipName } from "./golden";
import { fakeHost, IPHONE_17, RUNTIME_BUILD, RUNTIME_ID } from "./golden.testing";
import { cloneFromGolden, ensureGolden, type GoldenDeps, pruneGoldens } from "./ios-golden";

let dir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-golden-"));
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const KEY = goldenKey({
	xcodeBuild: "17F113",
	runtimeId: RUNTIME_ID,
	runtimeBuild: RUNTIME_BUILD,
	deviceType: IPHONE_17,
});
const GOLDEN = goldenName("iphone-17", KEY);

function deps(host: ReturnType<typeof fakeHost>, logs: string[] = []): GoldenDeps {
	let clock = 0;
	return {
		exec: host.exec,
		store,
		owner: { kind: "agent", sessionId: "s", cwd: "/" },
		pid: process.pid,
		env: { HOME: "/Users/me" },
		now: () => clock,
		pidAlive: () => true,
		sleep: async (ms) => {
			clock += ms;
		},
		log: (line) => logs.push(line),
	};
}

describe("ensureGolden", () => {
	test("no golden → create wip, boot, wait for migration + settle, shut down, rename", async () => {
		const host = fakeHost({ migrationPolls: 2, cpu: [300, 80, 20, 10, 5] });
		const result = await ensureGolden(deps(host), "iphone-17");
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toMatchObject({ name: GOLDEN, built: true });
		expect(host.sims).toEqual([{ udid: result.data.udid, name: GOLDEN, state: "Shutdown" }]);
		const verbs = host.calls.filter((c) => c[1] === "simctl").map((c) => c[2]);
		expect(verbs).toEqual(["list", "list", "list", "create", "boot", "bootstatus", "shutdown", "rename"]);
		expect(host.calls.find((c) => c[2] === "create")).toEqual([
			"xcrun",
			"simctl",
			"create",
			wipName("iphone-17", KEY),
			IPHONE_17,
			RUNTIME_ID,
		]);
		expect(store.listLeases()).toEqual([]);
	});

	test("finished golden → reused, stale goldens of this profile deleted", async () => {
		const host = fakeHost({
			sims: [
				{ udid: "G", name: GOLDEN, state: "Shutdown" },
				{ udid: "OLD", name: goldenName("iphone-17", "0000000000"), state: "Shutdown" },
				{ udid: "POOL", name: "warden-iphone-17-1", state: "Booted" },
			],
			migrationPolls: 0,
		});
		const result = await ensureGolden(deps(host), "iphone-17");
		expect(result).toEqual({ success: true, data: { udid: "G", name: GOLDEN, built: false } });
		expect(host.sims.map((s) => s.udid)).toEqual(["G", "POOL"]);
		expect(host.calls.some((c) => c[2] === "create")).toBe(false);
	});

	test("golden without a migration record → deleted and rebuilt", async () => {
		const host = fakeHost({ sims: [{ udid: "G", name: GOLDEN, state: "Shutdown" }], migrationPolls: 1 });
		const result = await ensureGolden(deps(host), "iphone-17");
		expect(result.success && result.data.built).toBe(true);
		expect(host.sims.some((s) => s.udid === "G")).toBe(false);
	});

	test("migration never finishes → error, wip deleted", async () => {
		const host = fakeHost({ migrationPolls: Number.POSITIVE_INFINITY });
		const result = await ensureGolden(deps(host), "iphone-17");
		expect(result.success).toBe(false);
		expect(host.sims).toEqual([]);
		expect(store.listLeases()).toEqual([]);
	});

	test("never settles → logged, golden still promoted", async () => {
		const logs: string[] = [];
		const host = fakeHost({ migrationPolls: 0, cpu: [300] });
		const result = await ensureGolden(deps(host, logs), "iphone-17");
		expect(result.success).toBe(true);
		expect(logs.join("\n")).toContain("not settled");
	});

	test("claim path (prewarmHint) says how to prewarm before the multi-minute build; ensure itself stays quiet", async () => {
		const logs: string[] = [];
		await ensureGolden({ ...deps(fakeHost({ migrationPolls: 0 }), logs), prewarmHint: true }, "iphone-17");
		expect(logs[0]).toBe(
			"golden: building golden for iphone-17 (first claim of this profile, ~5 min); prewarm with: warden golden ensure --profile iphone-17"
		);
		const quiet: string[] = [];
		await ensureGolden(deps(fakeHost({ migrationPolls: 0 }), quiet), "iphone-17");
		expect(quiet.some((l) => l.includes("prewarm"))).toBe(false);
	});

	test("unknown profile → error", async () => {
		const result = await ensureGolden(deps(fakeHost()), "nokia-3310");
		expect(result.success).toBe(false);
	});
});

describe("cloneFromGolden", () => {
	test("clones the golden (building it once) to each name", async () => {
		const host = fakeHost({ migrationPolls: 0 });
		const d = deps(host);
		const a = await cloneFromGolden(d, "iphone-17", undefined, "warden-iphone-17-1");
		const b = await cloneFromGolden(d, "iphone-17", undefined, "warden-iphone-17-2");
		expect(a.success && b.success).toBe(true);
		expect(host.calls.filter((c) => c[2] === "create")).toHaveLength(1);
		expect(host.sims.map((s) => s.name)).toEqual([GOLDEN, "warden-iphone-17-1", "warden-iphone-17-2"]);
		if (a.success) expect(a.data).toMatchObject({ runtimeId: RUNTIME_ID, golden: GOLDEN });
	});

	test("booted golden is shut down before cloning", async () => {
		const host = fakeHost({ sims: [{ udid: "G", name: GOLDEN, state: "Booted" }], migrationPolls: 0 });
		const result = await cloneFromGolden(deps(host), "iphone-17", undefined, "warden-iphone-17-1");
		expect(result.success).toBe(true);
	});
});

describe("pruneGoldens", () => {
	test("default: stale only; --all: every golden; never pool devices", async () => {
		const sims = () => [
			{ udid: "G", name: GOLDEN, state: "Shutdown" as const },
			{ udid: "OLD", name: goldenName("iphone-17", "0000000000"), state: "Shutdown" as const },
			{ udid: "POOL", name: "warden-iphone-17-1", state: "Shutdown" as const },
		];
		const host = fakeHost({ sims: sims(), migrationPolls: 0 });
		const stale = await pruneGoldens(deps(host), { all: false });
		expect(stale.success && stale.data.map((s) => s.udid)).toEqual(["OLD"]);
		const all = await pruneGoldens(deps(host), { all: true });
		expect(all.success && all.data.map((s) => s.udid)).toEqual(["G"]);
		expect(host.sims.map((s) => s.udid)).toEqual(["POOL"]);
	});
});

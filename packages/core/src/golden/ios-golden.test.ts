import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { openStore, type Store } from "../store";
import { GOLDEN_RECIPE, goldenKey, goldenName, wipName } from "./golden";
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
		expect(verbs).toEqual(["list", "list", "list", "create", "boot", "bootstatus", "spawn", "shutdown", "rename"]);
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

	test("a profile whose target cannot be read: its older goldens are pruned, a newer recipe's is kept (ios-claim-path-S3)", async () => {
		const next = GOLDEN_RECIPE + 1;
		const host = fakeHost({
			sims: [
				{ udid: "OLD", name: goldenName("no-such-device", "0000000000"), state: "Shutdown" },
				{ udid: "NEW", name: goldenName("no-such-device", "1111111111", next), state: "Shutdown" },
				{ udid: "NEWWIP", name: wipName("no-such-device", "2222222222", next), state: "Shutdown" },
			],
			migrationPolls: 0,
		});
		const pruned = await pruneGoldens(deps(host), { all: false });
		expect(pruned.success && pruned.data.map((s) => s.udid)).toEqual(["OLD"]);
		expect(host.sims.map((s) => s.udid)).toEqual(["NEW", "NEWWIP"]);
	});
});

const AUTOMATION = ["defaults", "write", "com.apple.Accessibility", "AutomationEnabled", "-bool", "true"];

describe("golden recipe 2: AutomationEnabled baked in (16-7)", () => {
	test("the build writes AutomationEnabled in the sim after the migration, before it settles and shuts down", async () => {
		const host = fakeHost({ migrationPolls: 0 });
		const result = await ensureGolden(deps(host), "iphone-17");
		expect(result.success).toBe(true);
		if (!result.success) return;
		const at = (pred: (c: string[]) => boolean) => host.calls.findIndex(pred);
		const write = at((c) => c[2] === "spawn");
		expect(host.calls[write]).toEqual(["xcrun", "simctl", "spawn", result.data.udid, ...AUTOMATION]);
		expect(write).toBeGreaterThan(at((c) => c[2] === "bootstatus"));
		expect(write).toBeLessThan(at((c) => c[0] === "launchctl"));
		expect(write).toBeLessThan(at((c) => c[2] === "shutdown"));
	});

	test("the recipe is part of the key: a recipe-2 golden is built next to the recipe-1 one, which a claim keeps (ios-claim-path-R4)", async () => {
		expect(GOLDEN_RECIPE).toBe(2);
		const inputs = { xcodeBuild: "17F113", runtimeId: RUNTIME_ID, runtimeBuild: RUNTIME_BUILD, deviceType: IPHONE_17 };
		expect(goldenKey(inputs, 1)).not.toBe(KEY);
		const old = goldenName("iphone-17", goldenKey(inputs, 1), 1);
		const host = fakeHost({ sims: [{ udid: "OLD", name: old, state: "Shutdown" }], migrationPolls: 0 });
		const result = await ensureGolden(deps(host), "iphone-17");
		expect(result.success && result.data).toMatchObject({ name: GOLDEN, built: true });
		// an older warden (recipe 1) on this machine keeps its golden instead of rebuilding it on every claim
		expect(host.sims.some((s) => s.udid === "OLD")).toBe(true);
		const again = await ensureGolden(deps(host), "iphone-17");
		expect(again.success && again.data).toMatchObject({ name: GOLDEN, built: false });
		expect(host.sims.some((s) => s.udid === "OLD")).toBe(true);
	});

	test("a newer warden's golden (higher recipe) is never deleted by this one (ios-claim-path-R4)", async () => {
		const inputs = { xcodeBuild: "17F113", runtimeId: RUNTIME_ID, runtimeBuild: RUNTIME_BUILD, deviceType: IPHONE_17 };
		const next = GOLDEN_RECIPE + 1;
		const newer = goldenName("iphone-17", goldenKey(inputs, next), next);
		const host = fakeHost({
			sims: [
				{ udid: "G", name: GOLDEN, state: "Shutdown" },
				{ udid: "NEW", name: newer, state: "Shutdown" },
			],
			migrationPolls: 0,
		});
		expect((await ensureGolden(deps(host), "iphone-17")).success).toBe(true);
		expect((await pruneGoldens(deps(host), { all: false })).success).toBe(true);
		expect(host.sims.some((s) => s.udid === "NEW")).toBe(true);
	});

	test("warden golden prune deletes the older recipe's golden", async () => {
		const inputs = { xcodeBuild: "17F113", runtimeId: RUNTIME_ID, runtimeBuild: RUNTIME_BUILD, deviceType: IPHONE_17 };
		const old = goldenName("iphone-17", goldenKey(inputs, 1), 1);
		const host = fakeHost({
			sims: [
				{ udid: "G", name: GOLDEN, state: "Shutdown" },
				{ udid: "OLD", name: old, state: "Shutdown" },
			],
			migrationPolls: 0,
		});
		const pruned = await pruneGoldens(deps(host), { all: false });
		expect(pruned.success && pruned.data.map((s) => s.udid)).toEqual(["OLD"]);
	});
});

describe("golden target read (16-6)", () => {
	const targetCalls = (host: ReturnType<typeof fakeHost>) =>
		host.calls.filter(
			(c) =>
				c[3] === "devicetypes" || c[3] === "runtimes" || c[0]?.startsWith("xcode") || c.includes("ProductBuildVersion")
		);

	test("Xcode build from version.plist via xcode-select + plutil, never xcodebuild", async () => {
		const host = fakeHost({ sims: [{ udid: "G", name: GOLDEN, state: "Shutdown" }], migrationPolls: 0 });
		expect((await ensureGolden(deps(host), "iphone-17")).success).toBe(true);
		expect(targetCalls(host)).toEqual([
			["xcrun", "simctl", "list", "devicetypes", "-j"],
			["xcrun", "simctl", "list", "runtimes", "-j"],
			["xcode-select", "-p"],
			["plutil", "-extract", "ProductBuildVersion", "raw", "-o", "-", "/Applications/Xcode.app/Contents/version.plist"],
		]);
	});

	test("no readable version.plist → falls back to xcodebuild -version, same key", async () => {
		const host = fakeHost({
			sims: [{ udid: "G", name: GOLDEN, state: "Shutdown" }],
			migrationPolls: 0,
			xcodePlist: false,
		});
		const result = await ensureGolden(deps(host), "iphone-17");
		expect(result).toEqual({ success: true, data: { udid: "G", name: GOLDEN, built: false } });
		expect(host.calls.some((c) => c[0] === "xcodebuild")).toBe(true);
	});

	test("the three reads run at the same time, not one after another", async () => {
		const host = fakeHost({ sims: [{ udid: "G", name: GOLDEN, state: "Shutdown" }], migrationPolls: 0 });
		let running = 0;
		let peak = 0;
		const slow: Exec = async (cmd, opts) => {
			running++;
			peak = Math.max(peak, running);
			await Bun.sleep(5);
			running--;
			return host.exec(cmd, opts);
		};
		expect((await ensureGolden({ ...deps(host), exec: slow }, "iphone-17")).success).toBe(true);
		expect(peak).toBeGreaterThanOrEqual(3);
	});

	test("concurrent clones of one claim read the target once; the lock waiter retries every 200 ms", async () => {
		const host = fakeHost({ sims: [{ udid: "G", name: GOLDEN, state: "Shutdown" }], migrationPolls: 0 });
		const d = deps(host);
		const slept: number[] = [];
		const sleepy: GoldenDeps = {
			...d,
			sleep: async (ms) => {
				slept.push(ms);
				await d.sleep(ms);
				await Bun.sleep(1);
			},
		};
		const results = await Promise.all(
			["warden-iphone-17-1", "warden-iphone-17-2", "warden-iphone-17-3"].map((name) =>
				cloneFromGolden(sleepy, "iphone-17", undefined, name)
			)
		);
		expect(results.every((r) => r.success)).toBe(true);
		expect(targetCalls(host)).toHaveLength(4);
		expect(slept.length).toBeGreaterThan(0);
		expect(new Set(slept)).toEqual(new Set([200]));
	});
});

describe("golden simctl timeouts (16-11)", () => {
	test("clone, create, boot, shutdown, rename, list and the Xcode read each carry a timeout", async () => {
		const host = fakeHost({ migrationPolls: 0 });
		const timeouts = new Map<string, number | undefined>();
		const exec: Exec = (cmd, opts) => {
			const key = cmd[0] === "xcrun" ? `simctl ${cmd[2]}${cmd[2] === "list" ? ` ${cmd[3]}` : ""}` : (cmd[0] ?? "");
			if (key !== "plutil" && key !== "launchctl" && key !== "ps") timeouts.set(key, opts?.timeoutMs);
			return host.exec(cmd, opts);
		};
		const result = await cloneFromGolden({ ...deps(host), exec }, "iphone-17", undefined, "warden-iphone-17-1");
		expect(result.success).toBe(true);
		expect(Object.fromEntries(timeouts)).toEqual({
			"simctl list devicetypes": 30_000,
			"simctl list runtimes": 30_000,
			"xcode-select": 30_000,
			"simctl list devices": 30_000,
			"simctl create": 120_000,
			"simctl boot": 120_000,
			"simctl bootstatus": 15 * 60_000,
			"simctl spawn": 30_000,
			"simctl shutdown": 60_000,
			"simctl rename": 60_000,
			"simctl clone": 120_000,
		});
	});

	test("a clone that never returns ends in an error and frees the golden lock for other claimers", async () => {
		const host = fakeHost({ sims: [{ udid: "G", name: GOLDEN, state: "Shutdown" }], migrationPolls: 0 });
		const exec: Exec = (cmd, opts) => (cmd[2] === "clone" ? new Promise<ExecResult>(() => {}) : host.exec(cmd, opts));
		const result = await cloneFromGolden(
			{
				...deps(host),
				exec,
				timer: (ms) => ({
					promise: ms === 120_000 ? Promise.resolve() : new Promise<void>(() => {}),
					cancel: () => {},
				}),
			},
			"iphone-17",
			undefined,
			"warden-iphone-17-1"
		);
		expect(result).toEqual({
			success: false,
			error: "`xcrun simctl clone G warden-iphone-17-1` did not finish within 120s",
		});
		expect(store.listLeases()).toEqual([]);
	});
});

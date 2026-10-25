import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult } from "@delacour/warden-core/exec";
import { type TestContext, testContext } from "../testing";
import { launchApp, type RelaunchIo, resetAppData, resolveLauncher, terminateApp } from "./relaunch";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const fx = (name: string) =>
	readFileSync(join(import.meta.dir, "..", "..", "..", "..", "packages", "perf", "fixtures", name), "utf8");

type Rule = [needle: string, result: Partial<ExecResult>];

/** exec that answers the first rule whose needle appears in the joined command; every call is recorded. */
function setup(rules: Rule[]): { c: TestContext; calls: string[] } {
	const calls: string[] = [];
	ctx = testContext([], {
		exec: async (cmd) => {
			const line = cmd.join(" ");
			calls.push(line);
			const hit = rules.find(([needle]) => line.includes(needle));
			return { exitCode: 0, stdout: "", stderr: "", ...(hit ? hit[1] : { exitCode: 127, stderr: `no rule: ${line}` }) };
		},
	});
	return { c: ctx, calls };
}

const droid = { platform: "android", id: "emulator-5554" } as const;
const sim = { platform: "ios", id: "U1" } as const;

function io(): RelaunchIo & { removed: string[] } {
	let t = 0;
	const removed: string[] = [];
	return { monotonicMs: () => (t += 120), mkdtemp: () => "/scratch", rm: (p) => removed.push(p), removed };
}

describe("terminateApp", () => {
	test("android force-stops", async () => {
		const { c, calls } = setup([["am force-stop", {}]]);
		expect((await terminateApp(c, droid, "com.acme.shop")).success).toBe(true);
		expect(calls[0]).toContain("-s emulator-5554 shell am force-stop com.acme.shop");
	});

	test("ios: an app that was not running is fine", async () => {
		const { c } = setup([["simctl terminate", { exitCode: 3, stderr: "found nothing to terminate" }]]);
		expect((await terminateApp(c, sim, "com.acme.shop")).success).toBe(true);
	});

	test("ios: any other failure is reported", async () => {
		const { c } = setup([["simctl terminate", { exitCode: 1, stderr: "Invalid device" }]]);
		const r = await terminateApp(c, sim, "com.acme.shop");
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.message).toContain("Invalid device");
	});
});

describe("resolveLauncher", () => {
	test("component from the last line", async () => {
		const { c } = setup([["resolve-activity", { stdout: fx("resolve-activity.txt") }]]);
		expect(await resolveLauncher(c, droid, "com.acme.shop")).toEqual({
			success: true,
			data: "com.acme.shop/.MainActivity",
		});
	});

	test("no launcher: app_not_found", async () => {
		const { c } = setup([["resolve-activity", { stdout: fx("resolve-activity-none.txt") }]]);
		const r = await resolveLauncher(c, droid, "com.acme.shop");
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.code).toBe("app_not_found");
	});
});

describe("launchApp", () => {
	test("android cold: resolves, starts with -W -S, returns the system timing and wall time", async () => {
		const { c, calls } = setup([
			["resolve-activity", { stdout: fx("resolve-activity.txt") }],
			["am start", { stdout: fx("am-start-cold.txt") }],
		]);
		const r = await launchApp(c, droid, "com.acme.shop", { cold: true }, io());
		expect(r).toMatchObject({
			kind: "launched",
			wallMs: 120,
			component: "com.acme.shop/.MainActivity",
			am: { totalMs: 1834, launchState: "COLD" },
		});
		expect(calls[1]).toContain("shell am start -W -S -n com.acme.shop/.MainActivity");
	});

	test("android: a given component skips the resolve", async () => {
		const { c, calls } = setup([["am start", { stdout: fx("am-start-warm.txt") }]]);
		await launchApp(c, droid, "com.acme.shop", { cold: false, component: "com.acme.shop/.MainActivity" }, io());
		expect(calls).toHaveLength(1);
		expect(calls[0]).not.toContain("-S");
	});

	test("android: an activity that does not exist fails", async () => {
		const { c } = setup([["am start", { stdout: fx("am-start-error.txt") }]]);
		const r = await launchApp(c, droid, "com.acme.shop", { cold: true, component: "x/.Y" }, io());
		expect(r).toMatchObject({ kind: "failed", reason: "launch_failed" });
	});

	test("android: no launcher activity", async () => {
		const { c } = setup([["resolve-activity", { stdout: fx("resolve-activity-none.txt") }]]);
		expect(await launchApp(c, droid, "com.acme.shop", { cold: true }, io())).toMatchObject({
			kind: "failed",
			reason: "no_launcher",
		});
	});

	test("ios cold: --terminate-running-process, pid parsed", async () => {
		const { c, calls } = setup([["simctl launch", { stdout: "com.acme.shop: 4242\n" }]]);
		const r = await launchApp(c, sim, "com.acme.shop", { cold: true }, io());
		expect(r).toEqual({ kind: "launched", wallMs: 120, pid: 4242 });
		expect(calls[0]).toBe("xcrun simctl launch --terminate-running-process U1 com.acme.shop");
	});

	test("ios: launch failure", async () => {
		const { c } = setup([["simctl launch", { exitCode: 1, stderr: "The request was denied" }]]);
		const r = await launchApp(c, sim, "com.acme.shop", { cold: false }, io());
		expect(r).toMatchObject({ kind: "failed", reason: "launch_failed" });
	});
});

describe("resetAppData", () => {
	test("android: pm clear", async () => {
		const { c, calls } = setup([["pm clear", { stdout: "Success\n" }]]);
		expect((await resetAppData(c, droid, "com.acme.shop", io())).success).toBe(true);
		expect(calls[0]).toContain("shell pm clear com.acme.shop");
	});

	test("android: pm clear failure", async () => {
		const { c } = setup([["pm clear", { stdout: "Failed\n" }]]);
		expect((await resetAppData(c, droid, "com.acme.shop", io())).success).toBe(false);
	});

	const bundle: Rule[] = [
		["simctl get_app_container", { stdout: "/Dev/U1/Bundle/Shop.app\n" }],
		["plutil", { stdout: "Shop\n" }],
	];

	test("ios: copies the .app aside BEFORE uninstalling, reinstalls from the copy, cleans up", async () => {
		const { c, calls } = setup([...bundle, ["cp -R", {}], ["simctl uninstall", {}], ["simctl install", {}]]);
		const fake = io();
		expect((await resetAppData(c, sim, "com.acme.shop", fake)).success).toBe(true);
		const order = calls.map((l) => l.split(" ").slice(0, 3).join(" "));
		expect(order.indexOf("cp -R /Dev/U1/Bundle/Shop.app")).toBeGreaterThan(-1);
		expect(order.indexOf("cp -R /Dev/U1/Bundle/Shop.app")).toBeLessThan(order.indexOf("xcrun simctl uninstall"));
		expect(calls.at(-1)).toBe("xcrun simctl install U1 /scratch/Shop.app");
		expect(fake.removed).toEqual(["/scratch"]);
	});

	test("ios: copy failure never uninstalls", async () => {
		const { c, calls } = setup([...bundle, ["cp -R", { exitCode: 1, stderr: "no space" }]]);
		const r = await resetAppData(c, sim, "com.acme.shop", io());
		expect(r.success).toBe(false);
		expect(calls.some((l) => l.includes("uninstall"))).toBe(false);
	});

	test("ios: failed reinstall keeps the copy and says where it is", async () => {
		const { c } = setup([
			...bundle,
			["cp -R", {}],
			["simctl uninstall", {}],
			["simctl install", { exitCode: 1, stderr: "bad" }],
		]);
		const fake = io();
		const r = await resetAppData(c, sim, "com.acme.shop", fake);
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.hint).toContain("/scratch/Shop.app");
		expect(fake.removed).toEqual([]);
	});

	test("ios: not installed", async () => {
		const { c } = setup([["simctl get_app_container", { exitCode: 2 }]]);
		const r = await resetAppData(c, sim, "com.acme.shop", io());
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.code).toBe("app_not_found");
	});
});

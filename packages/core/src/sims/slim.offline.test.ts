import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { disabledLabels, readDisabledStore, writeDisabledStore } from "./disabled-store";
import { prepareOfflineSlim, runtimeSupportsPersistentOverrides, verifyOfflineSlim } from "./slim.offline";
import { DEFAULT_SLIM_PROFILE, desiredLabels, managedSet } from "./slim.profile";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "warden-offline-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("runtimeSupportsPersistentOverrides", () => {
	test.each([
		["iOS-26-5", true],
		["iOS-18-5", true],
		["iOS-18-4", false],
		["iOS-17-5", false],
		["iOS-19-0", true],
		["iOS 18.5", true],
		["watchOS-11-0", false],
		["garbage", false],
	])("%s → %p", (runtime, expected) => {
		expect(runtimeSupportsPersistentOverrides(runtime)).toBe(expected);
	});
});

describe("prepareOfflineSlim", () => {
	test("writes every desired label on a fresh sim", async () => {
		const res = await prepareOfflineSlim("U1", DEFAULT_SLIM_PROFILE, { root });
		expect(res.success).toBe(true);
		if (!res.success || !("path" in res.data)) throw new Error("expected a write");
		expect(res.data.written).toBe(desiredLabels(DEFAULT_SLIM_PROFILE).size);
		const store = await readDisabledStore("U1", root);
		expect(store.success && disabledLabels(store.data)).toEqual(desiredLabels(DEFAULT_SLIM_PROFILE));
	});

	test("second run is already-slim and writes nothing", async () => {
		await prepareOfflineSlim("U1", DEFAULT_SLIM_PROFILE, { root });
		const again = await prepareOfflineSlim("U1", DEFAULT_SLIM_PROFILE, { root });
		expect(again).toEqual({ success: true, data: { written: 0, skipped: "already-slim" } });
	});

	test("re-enables managed labels disabled beyond the profile", async () => {
		const desired = desiredLabels(DEFAULT_SLIM_PROFILE);
		const extra = [...managedSet()].find((l) => !desired.has(l)) ?? "com.apple.gamed";
		await writeDisabledStore("U1", { disable: [...desired, extra], enable: [] }, root);
		const res = await prepareOfflineSlim("U1", DEFAULT_SLIM_PROFILE, { root });
		expect(res.success && "path" in res.data && res.data.written).toBe(1);
		const store = await readDisabledStore("U1", root);
		expect(store.success && disabledLabels(store.data).has(extra)).toBe(false);
	});

	test("leaves unmanaged disabled labels alone", async () => {
		await writeDisabledStore("U1", { disable: ["com.example.foreign"], enable: [] }, root);
		await prepareOfflineSlim("U1", DEFAULT_SLIM_PROFILE, { root });
		const store = await readDisabledStore("U1", root);
		expect(store.success && disabledLabels(store.data).has("com.example.foreign")).toBe(true);
	});
});

function execOf(results: Partial<ExecResult>[], calls: string[][] = []): Exec {
	let i = 0;
	return async (cmd) => {
		calls.push([...cmd]);
		const r = results[Math.min(i++, results.length - 1)] ?? {};
		return { exitCode: 0, stdout: "", stderr: "", ...r };
	};
}

const printed = (labels: Iterable<string>): string =>
	`disabled services = {\n${[...labels].map((l) => `\t"${l}" => disabled`).join("\n")}\n}\n`;

describe("verifyOfflineSlim", () => {
	test("reports no missing labels when all desired are disabled", async () => {
		const calls: string[][] = [];
		const res = await verifyOfflineSlim(
			execOf([{ stdout: printed(desiredLabels(DEFAULT_SLIM_PROFILE)) }], calls),
			"U1",
			DEFAULT_SLIM_PROFILE
		);
		expect(res).toEqual({ success: true, data: { missing: [] } });
		expect(calls).toEqual([["xcrun", "simctl", "spawn", "U1", "launchctl", "print-disabled", "system"]]);
	});

	test("lists desired labels that are not disabled", async () => {
		const desired = [...desiredLabels(DEFAULT_SLIM_PROFILE)].sort();
		const res = await verifyOfflineSlim(execOf([{ stdout: printed(desired.slice(2)) }]), "U1", DEFAULT_SLIM_PROFILE);
		expect(res.success && res.data.missing).toEqual(desired.slice(0, 2));
	});

	test("retries a tearing-down domain with 1/2/4/8 s backoff", async () => {
		const sleeps: number[] = [];
		const calls: string[][] = [];
		const res = await verifyOfflineSlim(
			execOf(
				[
					{ exitCode: 124, stderr: "" },
					{ exitCode: 1, stderr: "Domain is tearing down" },
					{ exitCode: 1, stdout: "code=124" },
					{ stdout: printed(desiredLabels(DEFAULT_SLIM_PROFILE)) },
				],
				calls
			),
			"U1",
			DEFAULT_SLIM_PROFILE,
			{ sleep: async (ms) => void sleeps.push(ms) }
		);
		expect(res).toEqual({ success: true, data: { missing: [] } });
		expect(sleeps).toEqual([1000, 2000, 4000]);
		expect(calls).toHaveLength(4);
	});

	test("gives up after 4 retries", async () => {
		const sleeps: number[] = [];
		const res = await verifyOfflineSlim(execOf([{ exitCode: 124 }]), "U1", DEFAULT_SLIM_PROFILE, {
			sleep: async (ms) => void sleeps.push(ms),
		});
		expect(res.success).toBe(false);
		expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
	});

	test("other failures are not retried", async () => {
		const sleeps: number[] = [];
		const res = await verifyOfflineSlim(execOf([{ exitCode: 1, stderr: "boom" }]), "U1", DEFAULT_SLIM_PROFILE, {
			sleep: async (ms) => void sleeps.push(ms),
		});
		expect(res.success).toBe(false);
		expect(sleeps).toEqual([]);
	});
});

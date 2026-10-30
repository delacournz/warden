import { afterEach, describe, expect, test } from "bun:test";
import type { Exec } from "@delacour/warden-core/exec";
import {
	DEVICECTL_LOCKSTATE_LOCKED,
	DEVICECTL_LOCKSTATE_UNLOCKED,
	devicectlEntry,
	devicectlJson,
	FAKE_IPHONE_UDID,
} from "@delacour/warden-core/providers/devicectl.fixtures";
import { UNLOCK_POLL_MS, UNLOCK_WAIT_MS } from "@delacour/warden-core/providers/unlock-wait";
import { claimWithFlags, parseClaimFlags, resolveOwner } from "./claim-flags";
import { isLockedClaimError, reportClaimFailure } from "./physical-lock";
import { fakeSimctl, OWNER_ENV } from "./simctl.testing";
import { type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const LIST = devicectlJson([
	devicectlEntry({
		udid: FAKE_IPHONE_UDID,
		name: "Test iPhone",
		deviceType: "iPhone",
		osVersion: "27.2",
		transportType: "wired",
	}),
]);

/** A wired, ready phone whose lockState answers `locked` for the first `lockedReads` reads, then unlocked. */
function setup(lockedReads: number) {
	let reads = 0;
	const base = fakeSimctl([], [], [["xcrun devicectl list devices", { stdout: LIST }]]);
	const exec: Exec = async (cmd, opts) => {
		if (cmd.join(" ").startsWith("xcrun devicectl device info lockState")) {
			reads++;
			const locked = reads <= lockedReads;
			return { exitCode: 0, stdout: locked ? DEVICECTL_LOCKSTATE_LOCKED : DEVICECTL_LOCKSTATE_UNLOCKED, stderr: "" };
		}
		return base(cmd, opts);
	};
	ctx = testContext([], { exec });
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	return { c: ctx, reads: () => reads };
}

function flags(values: Parameters<typeof parseClaimFlags>[1]) {
	const parsed = parseClaimFlags("ios", values, 16);
	if (!parsed.success) throw new Error(parsed.error);
	return parsed.data;
}

describe("claimWithFlags on a locked iPhone", () => {
	test("unlocked on the 3rd poll: the claim goes on, the person was told once, and no lease existed while waiting", async () => {
		const { c } = setup(3);
		const leasesWhileWaiting: number[] = [];
		const slept: number[] = [];
		const outcome = await claimWithFlags(c, resolveOwner(c), flags({ physicalUdid: [FAKE_IPHONE_UDID] }), undefined, {
			unlockSleep: async (ms) => {
				slept.push(ms);
				leasesWhileWaiting.push(c.db.listLeases().length);
			},
		});
		expect(outcome.success).toBe(true);
		expect(slept).toEqual([UNLOCK_POLL_MS, UNLOCK_POLL_MS, UNLOCK_POLL_MS]);
		expect(leasesWhileWaiting).toEqual([0, 0, 0]);
		const said = c.stderr.filter((l) => l.includes("is locked"));
		expect(said).toEqual(["warden: Test iPhone is locked: unlock it to continue (waiting up to 2m)"]);
		expect(c.db.listLeases()).toHaveLength(1);
	});

	test("locked the whole 2 minutes: device_locked, nothing leased", async () => {
		const { c } = setup(Number.POSITIVE_INFINITY);
		let at = 1_000_000;
		c.now = () => at;
		const outcome = await claimWithFlags(c, resolveOwner(c), flags({ physicalUdid: [FAKE_IPHONE_UDID] }), undefined, {
			unlockSleep: async (ms) => {
				at += ms;
			},
		});
		expect(outcome.success).toBe(false);
		if (outcome.success) return;
		expect(isLockedClaimError(outcome.error)).toBe(true);
		expect(outcome.error).toContain("Test iPhone is locked");
		expect(at - 1_000_000).toBe(UNLOCK_WAIT_MS);
		expect(c.stderr.filter((l) => l.includes("still locked"))).toHaveLength(3);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("--no-wait fails at once, without sleeping or printing", async () => {
		const { c } = setup(Number.POSITIVE_INFINITY);
		let slept = 0;
		const outcome = await claimWithFlags(
			c,
			resolveOwner(c),
			flags({ physicalUdid: [FAKE_IPHONE_UDID], wait: false }),
			undefined,
			{
				unlockSleep: async () => {
					slept++;
				},
			}
		);
		expect(!outcome.success && isLockedClaimError(outcome.error)).toBe(true);
		expect(slept).toBe(0);
		expect(c.stderr).toEqual([]);
	});

	test("an unlocked phone prints nothing about locks and claims", async () => {
		const { c } = setup(0);
		const outcome = await claimWithFlags(
			c,
			resolveOwner(c),
			flags({ physicalUdid: [FAKE_IPHONE_UDID] }),
			undefined,
			{}
		);
		expect(outcome.success).toBe(true);
		expect(c.stderr.join("\n")).not.toContain("locked");
	});

	test("an id-less physical claim of the only ready phone waits for it too", async () => {
		const { c } = setup(1);
		const outcome = await claimWithFlags(c, resolveOwner(c), flags({ physical: true }), undefined, {
			unlockSleep: async () => {},
		});
		expect(outcome.success).toBe(true);
		expect(c.stderr.join("\n")).toContain("Test iPhone is locked");
	});

	test("a simulator claim never asks devicectl", async () => {
		const { c, reads } = setup(Number.POSITIVE_INFINITY);
		await claimWithFlags(c, resolveOwner(c), { ...flags({}), waitMs: 0 }, undefined, {});
		expect(reads()).toBe(0);
	});
});

describe("reportClaimFailure", () => {
	test("a locked phone is exit 2 with the device_locked code and hint on the failure sink", () => {
		const c = testContext([]);
		ctx = c;
		const recorded: unknown[] = [];
		c.failure = { record: (message, extra) => recorded.push([message, extra]) };
		expect(reportClaimFailure(c, "claim", "device_locked: Test iPhone is locked")).toBe(2);
		expect(recorded).toEqual([
			["Test iPhone is locked", { code: "device_locked", hint: "unlock the phone, then retry" }],
		]);
		expect(c.stderr.join("\n")).toContain("unlock the phone, then retry");
	});

	test("any other failure is exit 1", () => {
		const c = testContext([]);
		ctx = c;
		expect(reportClaimFailure(c, "claim", "no free device")).toBe(1);
	});
});

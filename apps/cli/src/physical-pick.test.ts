import { afterEach, describe, expect, test } from "bun:test";
import { PHONE_PROBE_SCRIPT } from "@delacour/warden-core/providers/android";
import { PHONE_PROPS } from "@delacour/warden-core/providers/android.fixtures";
import {
	DEVICECTL_LOCKSTATE_UNLOCKED,
	devicectlEntry,
	devicectlJson,
	FAKE_IPAD_UDID,
	FAKE_IPHONE_UDID,
} from "@delacour/warden-core/providers/devicectl.fixtures";
import type { Owner } from "@delacour/warden-core/types";
import { type ClaimFlags, parseClaimFlags } from "./claim-flags";
import { pickPhysical } from "./physical-pick";
import { OWNER_ENV } from "./simctl.testing";
import { fakeExec, type ScriptedUi, scriptedUi, type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const USB = "R5CT1234ABC";
const WIFI = "192.168.1.20:5555";
const ADB_TWO = `List of devices attached
${USB}            device usb:1-1 product:a54xnaeea model:SM_A546E device:a54x transport_id:2
${WIFI}      device product:husky model:Pixel_8_Pro device:husky transport_id:5

`;
const PIXEL_PROPS = "\n\nHW2\nPixel 8 Pro\n35\n";
const owner: Owner = { kind: "agent", sessionId: "me", cwd: "/" };
const other: Owner = { kind: "agent", sessionId: "someone-else", cwd: "/" };

function androidSetup(ui: ScriptedUi, env: Record<string, string> = {}): TestContext {
	ctx = testContext([], {
		ui,
		exec: fakeExec([
			["adb devices -l", { stdout: ADB_TWO }],
			[`adb -s ${USB} shell ${PHONE_PROBE_SCRIPT}`, { stdout: PHONE_PROPS }],
			[`adb -s ${WIFI} shell ${PHONE_PROBE_SCRIPT}`, { stdout: PIXEL_PROPS }],
		]),
	});
	ctx.env = { ...ctx.env, ...OWNER_ENV, ...env };
	return ctx;
}

function flagsOf(platform: "android" | "ios", values: Parameters<typeof parseClaimFlags>[1] = { physical: true }) {
	const parsed = parseClaimFlags(platform, values);
	if (!parsed.success) throw new Error(parsed.error);
	return parsed.data;
}

const idsOf = (flags: ClaimFlags) => flags.request.physical?.ids;

describe("pickPhysical", () => {
	test("two candidates in a terminal: asks, labelled by name / model / OS / transport, and names the chosen one", async () => {
		const ui = scriptedUi({ interactive: true, select: [WIFI] });
		const c = androidSetup(ui);
		const picked = await pickPhysical(c, owner, [flagsOf("android")], { prompt: true });
		expect(picked.kind).toBe("ok");
		if (picked.kind === "ok") expect(picked.flags.map(idsOf)).toEqual([[WIFI]]);
		expect(ui.events.filter((e) => e.startsWith("select:"))).toHaveLength(1);
		expect(c.db.listLeases()).toEqual([]);
	});

	test("the picker labels carry name, model, OS version and transport", async () => {
		const labels: string[] = [];
		const ui = scriptedUi({ interactive: true });
		ui.select = async (_message, choices) => {
			labels.push(...choices.map((choice) => choice.label ?? ""));
			return choices[0]?.value;
		};
		const c = androidSetup(ui);
		await pickPhysical(c, owner, [flagsOf("android")], { prompt: true });
		expect(labels).toHaveLength(2);
		expect(labels[0]).toContain("SM-A546E");
		expect(labels[0]).toContain("API 34");
		expect(labels[0]).toContain("USB");
		expect(labels[1]).toContain("Pixel 8 Pro");
		expect(labels[1]).toContain("Wi-Fi");
	});

	test("cancelling the picker is cancelled, with the usual Aborted.", async () => {
		const ui = scriptedUi({ interactive: true, select: [undefined] });
		const c = androidSetup(ui);
		const picked = await pickPhysical(c, owner, [flagsOf("android")], { prompt: true });
		expect(picked.kind).toBe("cancelled");
		expect(ui.events).toContain("cancelled: Aborted.");
	});

	test("two candidates and no prompt: ambiguous, listing both with the fields the JSON error carries", async () => {
		const ui = scriptedUi({ interactive: true });
		const c = androidSetup(ui);
		const picked = await pickPhysical(c, owner, [flagsOf("android")], { prompt: false });
		expect(picked).toMatchObject({ kind: "ambiguous", platform: "android" });
		if (picked.kind !== "ambiguous") return;
		expect(picked.candidates).toEqual([
			{
				id: USB,
				name: "SM-A546E",
				platform: "android",
				model: "SM-A546E",
				osVersion: "API 34",
				transport: "usb",
			},
			{
				id: WIFI,
				name: "Pixel 8 Pro",
				platform: "android",
				model: "Pixel 8 Pro",
				osVersion: "API 35",
				transport: "wifi",
			},
		]);
		expect(ui.events.filter((e) => e.startsWith("select:"))).toEqual([]);
	});

	test("one candidate is used as today: no prompt, request untouched", async () => {
		const ui = scriptedUi({ interactive: true });
		const c = androidSetup(ui);
		c.db.insertLease(
			{ resource: { kind: "device", platform: "android", id: WIFI, name: "Pixel 8 Pro" }, owner: other, ttlMs: 60_000 },
			c.now()
		);
		const flags = flagsOf("android");
		const picked = await pickPhysical(c, owner, [flags], { prompt: true });
		expect(picked).toEqual({ kind: "ok", flags: [flags] });
		expect(ui.events).toEqual([]);
	});

	test("the allowlist narrows two to one and never prompts", async () => {
		const ui = scriptedUi({ interactive: true });
		const c = androidSetup(ui, { WARDEN_PHYSICAL_IDS: USB });
		const picked = await pickPhysical(c, owner, [flagsOf("android")], { prompt: true });
		expect(picked.kind).toBe("ok");
		if (picked.kind === "ok") expect(picked.flags[0]?.request.physical).toEqual({ allow: [USB] });
		expect(ui.events).toEqual([]);
	});

	test("a device that is not ready is no candidate", async () => {
		const ui = scriptedUi({ interactive: true });
		const c = androidSetup(ui);
		c.exec = fakeExec([
			["adb devices -l", { stdout: ADB_TWO.replace(`${WIFI}      device`, `${WIFI}      offline`) }],
			[`adb -s ${USB} shell ${PHONE_PROBE_SCRIPT}`, { stdout: PHONE_PROPS }],
		]);
		const picked = await pickPhysical(c, owner, [flagsOf("android")], { prompt: true });
		expect(picked.kind).toBe("ok");
		expect(ui.events).toEqual([]);
	});

	test("naming devices skips the choice (and never lists the inventory)", async () => {
		const calls: string[][] = [];
		const ui = scriptedUi({ interactive: true });
		const c = androidSetup(ui);
		c.exec = fakeExec([], calls);
		const flags = flagsOf("android", { physicalSerial: [USB] });
		expect(await pickPhysical(c, owner, [flags], { prompt: true })).toEqual({ kind: "ok", flags: [flags] });
		expect(calls).toEqual([]);
	});

	test("a claim that is not physical is passed through", async () => {
		const c = androidSetup(scriptedUi({ interactive: true }));
		const flags = flagsOf("android", {});
		expect(await pickPhysical(c, owner, [flags], { prompt: true })).toEqual({ kind: "ok", flags: [flags] });
	});

	test("several id-less legs: each takes its own device, the last one is named too", async () => {
		const ui = scriptedUi({ interactive: true, select: [WIFI] });
		const c = androidSetup(ui);
		const picked = await pickPhysical(c, owner, [flagsOf("android"), flagsOf("android")], { prompt: true });
		expect(picked.kind).toBe("ok");
		if (picked.kind === "ok") expect(picked.flags.map(idsOf)).toEqual([[WIFI], [USB]]);
		expect(ui.events.filter((e) => e.startsWith("select:"))).toHaveLength(1);
	});

	test("iOS: names the iPhone and iPad with model, OS and transport", async () => {
		const list = devicectlJson([
			devicectlEntry({
				udid: FAKE_IPHONE_UDID,
				name: "Test iPhone",
				deviceType: "iPhone",
				osVersion: "27.2",
				transportType: "wired",
			}),
			devicectlEntry({
				udid: FAKE_IPAD_UDID,
				name: "Test iPad",
				deviceType: "iPad",
				osVersion: "18.7.8",
				transportType: "localNetwork",
				tunnelState: "connected",
			}),
		]);
		ctx = testContext([], {
			ui: scriptedUi({ interactive: true }),
			exec: fakeExec([
				["xcrun simctl list devices available -j", { stdout: '{"devices":{}}' }],
				["xcrun devicectl list devices", { stdout: list }],
				["xcrun devicectl device info lockState", { stdout: DEVICECTL_LOCKSTATE_UNLOCKED }],
			]),
		});
		const picked = await pickPhysical(ctx, owner, [flagsOf("ios")], { prompt: false });
		expect(picked.kind).toBe("ambiguous");
		if (picked.kind !== "ambiguous") return;
		expect(picked.candidates).toEqual([
			{
				id: FAKE_IPHONE_UDID,
				name: "Test iPhone",
				platform: "ios",
				model: "iPhone",
				osVersion: "27.2",
				transport: "wired",
			},
			{
				id: FAKE_IPAD_UDID,
				name: "Test iPad",
				platform: "ios",
				model: "iPad",
				osVersion: "18.7.8",
				transport: "localNetwork",
			},
		]);
	});
});

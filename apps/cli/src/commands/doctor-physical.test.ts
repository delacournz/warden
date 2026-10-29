import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { certificatesFromPem, sha1Hex } from "@delacour/warden-core/ios-runner/signing";
import { CERT_TEAM_A, CERT_TEAM_B } from "@delacour/warden-core/ios-runner/signing.testing";
import {
	DEVICECTL_LOCKSTATE_LOCKED,
	devicectlEntry,
	devicectlJson,
	FAKE_IPAD_UDID,
	FAKE_IPHONE_UDID,
} from "@delacour/warden-core/providers/devicectl.fixtures";
import { fakeExec, type TestContext, testContext } from "../testing";
import { physicalChecks } from "./doctor-physical";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const TEAM = "ABCDE12345";
const NOW = 1_000_000;

const LIST = devicectlJson([
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
		tunnelState: "disconnected",
	}),
]);

type Handlers = Array<[string, { stdout?: string; exitCode?: number; stderr?: string }]>;

function setup(handlers: Handlers, env: Record<string, string> = {}): TestContext {
	ctx = testContext([], { exec: fakeExec(handlers) });
	ctx.env = { ...ctx.env, ...env };
	return ctx;
}

const IOS_HANDLERS: Handlers = [
	["xcrun devicectl list devices", { stdout: LIST }],
	[`xcrun devicectl device info lockState --device ${FAKE_IPHONE_UDID}`, { stdout: DEVICECTL_LOCKSTATE_LOCKED }],
	["xcrun devicectl device info lockState", { exitCode: 1, stderr: "The device is not connected" }],
];

describe("physicalChecks", () => {
	test("silent with no phones and no team", async () => {
		const c = setup([]);
		expect(await physicalChecks(c)).toEqual([]);
		c.cleanup();
		const quiet = setup([["security find-identity", { stdout: "     0 valid identities found\n" }]]);
		expect(await physicalChecks(quiet)).toEqual([]);
	});

	test("ios-team names the team and where it came from", async () => {
		const rows = await physicalChecks(setup(IOS_HANDLERS, { WARDEN_IOS_TEAM_ID: TEAM }));
		expect(rows.find((r) => r.name === "ios-team")).toEqual({
			name: "ios-team",
			level: "optional",
			status: "ok",
			detail: `${TEAM} (WARDEN_IOS_TEAM_ID)`,
		});
	});

	test("ios-team: several teams in the keychain is ambiguous and says what to set", async () => {
		const derA = certificatesFromPem(CERT_TEAM_A)[0] as Uint8Array;
		const derB = certificatesFromPem(CERT_TEAM_B)[0] as Uint8Array;
		const identities = `  1) ${sha1Hex(derA)} "Apple Development: Test A"\n  2) ${sha1Hex(derB)} "Apple Development: Test B"\n     2 valid identities found\n`;
		const rows = await physicalChecks(
			setup([
				...IOS_HANDLERS,
				["security find-identity", { stdout: identities }],
				["security find-certificate", { stdout: `${CERT_TEAM_A}\n${CERT_TEAM_B}` }],
			])
		);
		const team = rows.find((r) => r.name === "ios-team");
		expect(team?.status).toBe("warn");
		expect(team?.detail).toBe("ambiguous: 2 teams, set WARDEN_IOS_TEAM_ID");
	});

	test("ios-devices: pairing, transport, Developer Mode, DDI, reachability and lock state per device", async () => {
		const rows = await physicalChecks(setup(IOS_HANDLERS, { WARDEN_IOS_TEAM_ID: TEAM }));
		const devices = rows.find((r) => r.name === "ios-devices");
		expect(devices?.status).toBe("ok");
		expect(devices?.detail).toContain(`${FAKE_IPHONE_UDID} iPhone 27.2`);
		expect(devices?.detail).toContain("wired");
		expect(devices?.detail).toContain("paired");
		expect(devices?.detail).toContain("Developer Mode on");
		expect(devices?.detail).toContain("DDI yes");
		expect(devices?.detail).toContain("reachable");
		expect(devices?.detail).toContain("locked");
		expect(devices?.detail).toContain(`${FAKE_IPAD_UDID} iPad 18.7.8`);
		expect(devices?.detail).toContain("offline");
	});

	test("ios-devices warns when no phone is usable", async () => {
		const only = devicectlJson([
			devicectlEntry({
				udid: FAKE_IPAD_UDID,
				name: "Test iPad",
				deviceType: "iPad",
				osVersion: "18.7.8",
				developerMode: "disabled",
			}),
		]);
		const rows = await physicalChecks(setup([["xcrun devicectl list devices", { stdout: only }]]));
		const devices = rows.find((r) => r.name === "ios-devices");
		expect(devices?.status).toBe("warn");
		expect(devices?.detail).toContain("Developer Mode off");
	});

	test("ios-runner: no cached build yet", async () => {
		const rows = await physicalChecks(setup(IOS_HANDLERS, { WARDEN_IOS_TEAM_ID: TEAM }));
		const runner = rows.find((r) => r.name === "ios-runner");
		expect(runner?.status).toBe("ok");
		expect(runner?.detail).toContain("no cached build");
	});

	test("ios-runner: cached build, profile expiry and the last failure", async () => {
		const c = setup(IOS_HANDLERS, { WARDEN_IOS_TEAM_ID: TEAM });
		const dir = join(c.cwd, "ios-runner", TEAM, "17F113-abc123");
		mkdirSync(dir, { recursive: true });
		const expires = NOW + 3 * 24 * 60 * 60 * 1000;
		writeFileSync(
			join(dir, "meta.json"),
			JSON.stringify({
				udids: [FAKE_IPHONE_UDID],
				profileExpires: expires,
				builtAt: NOW - 1000,
				bundleId: "com.example.runner",
			})
		);
		writeFileSync(
			join(c.cwd, "ios-runner", `${FAKE_IPHONE_UDID}.json`),
			JSON.stringify({ code: "device_locked", message: "unlock the phone", at: NOW - 5000 })
		);
		const runner = (await physicalChecks(c)).find((r) => r.name === "ios-runner");
		expect(runner?.status).toBe("warn");
		expect(runner?.detail).toContain("profile expires in 3d");
		expect(runner?.detail).toContain("last failure: device_locked");
	});

	test("ios-runner: an expired profile warns", async () => {
		const c = setup(IOS_HANDLERS, { WARDEN_IOS_TEAM_ID: TEAM });
		const dir = join(c.cwd, "ios-runner", TEAM, "17F113-abc123");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "meta.json"),
			JSON.stringify({ udids: [], profileExpires: NOW - 1000, builtAt: NOW - 9999, bundleId: "com.example.runner" })
		);
		const runner = (await physicalChecks(c)).find((r) => r.name === "ios-runner");
		expect(runner?.status).toBe("warn");
		expect(runner?.detail).toContain("profile expired");
	});

	test("android-devices: unauthorized phones and a second adb server", async () => {
		const rows = await physicalChecks(
			setup([
				[
					"adb devices -l",
					{
						stdout:
							"List of devices attached\nR5CT1234ABC unauthorized usb:1-1 transport_id:1\nR5CT9999XYZ device usb:1-2 model:SM_A546E\n\n",
					},
				],
				["adb -s R5CT9999XYZ shell getprop ro.boot.qemu", { stdout: "\n\nR5CT9999XYZ\nSM-A546E\n34\n" }],
				[
					"ps -axo",
					{
						stdout:
							" 101 /sdk/platform-tools/adb -L tcp:5037 fork-server server --reply-fd 4\n 202 /other/adb -L tcp:5038 fork-server server --reply-fd 4\n",
					},
				],
			])
		);
		const android = rows.find((r) => r.name === "android-devices");
		expect(android?.status).toBe("warn");
		expect(android?.detail).toContain("2 phones, 1 unauthorized");
		expect(android?.detail).toContain("2 adb servers");
		expect(rows.find((r) => r.name === "ios-devices")).toBeUndefined();
	});

	test("android-devices stays silent with no phones and one adb server", async () => {
		const rows = await physicalChecks(
			setup([
				["adb devices -l", { stdout: "List of devices attached\n\n" }],
				["ps -axo", { stdout: " 101 /sdk/platform-tools/adb -L tcp:5037 fork-server server --reply-fd 4\n" }],
			])
		);
		expect(rows).toEqual([]);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "../driver.types";
import { openAndroidDriver } from "./android-driver";
import { fakeAndroidHost, type ShellRule } from "./android-host.testing";
import { PASSKEYS_APK } from "./passkeys-apk.generated";
import { SYNTHETIC_FORM_DUMP } from "./uiautomator.fixture";

/** The driver's passkeys op and the sheet it answers while any look at the screen is taken. */

const PKG = "nz.co.delacour.warden.passkeys";
const COMPONENT = `${PKG}/${PKG}.WardenPasskeyService`;

const node = (text: string, bounds: string, desc = ""): string =>
	`<node index="0" text="${text}" resource-id="" class="android.view.View" package="com.google.android.gms" content-desc="${desc}" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="${bounds}" />`;

const SHEET = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="android" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">${node("Create passkey to sign in to Example?", "[60,1200][1020,1280]")}${node("Save another way", "[60,1900][500,1980]")}${node("Continue", "[540,1900][1020,1980]")}</node></hierarchy>UI hierarchy dumped to: /dev/stdout\n`;

const dirs: string[] = [];
const open: Driver[] = [];
afterEach(async () => {
	await Promise.all(open.splice(0).map((d) => d.close()));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function world(sdk: number) {
	const state = { installed: false, settings: new Map<string, string>(), sheet: true, mode: "auto" };
	const rules: ShellRule[] = [
		{ match: "getprop sys.boot_completed", reply: `1\n${sdk}\nPhysical size: 1080x2400\nPhysical density: 420\n` },
		{ match: "uiautomator dump /dev/stdout", reply: () => (state.sheet ? SHEET : SYNTHETIC_FORM_DUMP) },
		{
			match: "input tap",
			reply: () => {
				state.sheet = false;
				return "";
			},
		},
		{
			match: "dumpsys package",
			reply: () => (state.installed ? `  versionName=${PASSKEYS_APK.versionName}\n` : "Unable to find package\n"),
		},
		{
			match: /^settings (get|put) secure/,
			reply: (cmd) => {
				const [, op, , key, value] = cmd.split(" ");
				if (op === "put") state.settings.set(key ?? "", value ?? "");
				return op === "get" ? `${state.settings.get(key ?? "") ?? "null"}\n` : "";
			},
		},
		{
			match: "content call",
			reply: () => `Result: Bundle[{result={"mode":"${state.mode}","uv":"match","credentials":[]}}]\n`,
		},
	];
	return { state, rules };
}

async function openDriver(sdk: number) {
	const w = world(sdk);
	const home = mkdtempSync(join(tmpdir(), "warden-pk-drv-"));
	dirs.push(home);
	const host = fakeAndroidHost({
		shell: w.rules,
		host: [
			{
				match: /install -r/,
				reply: () => {
					w.state.installed = true;
					return "Success\n";
				},
			},
		],
	});
	const res = await openAndroidDriver({
		serial: "emulator-5554",
		adb: "adb",
		exec: host.exec,
		spawn: host.spawn,
		execBinary: host.execBinary,
		wardenHome: home,
		clock: { now: () => 0, sleep: async () => {} },
	});
	if (!res.success) throw new Error(res.error.message);
	open.push(res.data);
	return { driver: res.data, host, ...w };
}

describe("android driver passkeys", () => {
	test("API 33 is E_PASSKEY_API", async () => {
		const { driver } = await openDriver(33);
		const r = await driver.passkeys({ kind: "set" });
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.code).toBe("E_PASSKEY_API");
	});

	test("set installs and enables the provider and returns the previous settings", async () => {
		const { driver, host, state } = await openDriver(34);
		const r = await driver.passkeys({ kind: "set", mode: "auto" });
		expect(r.success && r.data.enabled).toBe(true);
		expect(host.host.some((argv) => argv.includes("install"))).toBe(true);
		expect(state.settings.get("credential_service")).toBe(COMPONENT);
	});

	test("a look at the screen with the sheet up taps Continue and returns the app underneath", async () => {
		const { driver, host, state } = await openDriver(34);
		await driver.passkeys({ kind: "set" });
		expect(state.sheet).toBe(true);
		const shot = await driver.snapshot();
		expect(host.shell.some((c) => c.startsWith("input tap 780 1940"))).toBe(true);
		expect(shot.success && shot.data.flat.some((e) => e.identifier === "login-button")).toBe(true);
	});

	test("without the authenticator the sheet is the spec's to see", async () => {
		const { driver, host } = await openDriver(34);
		const shot = await driver.snapshot();
		expect(host.shell.some((c) => c.startsWith("input tap"))).toBe(false);
		expect(shot.success && shot.data.flat.some((e) => e.text === "Continue")).toBe(true);
	});
});

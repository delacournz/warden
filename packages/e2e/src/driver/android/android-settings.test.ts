import { describe, expect, test } from "bun:test";
import { openAdbSession } from "./adb-session";
import { fakeAndroidHost, type ShellRule } from "./android-host.testing";
import { batteryArgvs, createAndroidSettings, permissionArgv, setAppLocaleArgv } from "./android-settings";

const PKG = "com.example.app";

function harness(rules: ShellRule[] = [], serial = "emulator-5554") {
	const host = fakeAndroidHost({ shell: rules });
	const session = openAdbSession({ adb: "adb", serial, spawn: host.spawn });
	const settings = createAndroidSettings({
		session,
		serial,
		appPackage: PKG,
		hostTimezone: () => "Europe/London",
		sleep: async () => undefined,
	});
	return { settings, host };
}

const declared = (...perms: string[]): ShellRule => ({
	match: /^pm (grant|revoke)/,
	reply: (cmd) => {
		const perm = cmd.split(" ").pop() ?? "";
		return perms.includes(perm)
			? ""
			: { stdout: `Exception: Package ${PKG} has not requested permission ${perm}\n`, exitCode: 1 };
	},
});

describe("android argv", () => {
	test("permission and locale argv", () => {
		expect(permissionArgv("granted", PKG, "android.permission.CAMERA")).toEqual([
			"pm",
			"grant",
			PKG,
			"android.permission.CAMERA",
		]);
		expect(permissionArgv("denied", PKG, "p").slice(0, 2)).toEqual(["pm", "revoke"]);
		expect(setAppLocaleArgv(PKG, "fr-FR")).toEqual(["cmd", "locale", "set-app-locales", PKG, "--locales", "fr-FR"]);
		expect(setAppLocaleArgv(PKG, null).at(-1)).toBe("");
	});
	test("battery argv: charging, unplug and level", () => {
		expect(batteryArgvs({ charging: true, level: 80 })).toEqual([
			["dumpsys", "battery", "set", "ac", "1"],
			["dumpsys", "battery", "set", "status", "2"],
			["dumpsys", "battery", "set", "level", "80"],
		]);
		expect(batteryArgvs({ charging: false })).toEqual([
			["dumpsys", "battery", "unplug"],
			["dumpsys", "battery", "set", "status", "3"],
		]);
	});
});

describe("android permissions", () => {
	test("location covers fine and coarse; granted and denied", async () => {
		const h = harness([
			declared("android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"),
		]);
		const r = await h.settings.permissions({ location: "denied" });
		expect(r.success && r.data.applied).toEqual([{ permission: "location", state: "denied" }]);
		expect(h.host.shell).toEqual([
			`pm revoke ${PKG} android.permission.ACCESS_FINE_LOCATION`,
			`pm revoke ${PKG} android.permission.ACCESS_COARSE_LOCATION`,
		]);
	});
	test("unset revokes and clears the user flags so the app is asked again", async () => {
		const h = harness([declared("android.permission.CAMERA")]);
		await h.settings.permissions({ camera: "unset" });
		expect(h.host.shell).toEqual([
			`pm revoke ${PKG} android.permission.CAMERA`,
			`pm clear-permission-flags ${PKG} android.permission.CAMERA user-set user-fixed`,
		]);
	});
	test("a permission the app does not declare is skipped for that one only", async () => {
		const h = harness([declared("android.permission.POST_NOTIFICATIONS")]);
		const r = await h.settings.permissions({ notifications: "granted", camera: "granted", reminders: "granted" });
		expect(r.success && r.data.applied.map((a) => a.permission)).toEqual(["notifications"]);
		expect(r.success && r.data.skipped.map((s) => s.permission)).toEqual(["camera", "reminders"]);
	});
	test("nothing applicable is E_UNSUPPORTED", async () => {
		const h = harness([declared()]);
		const r = await h.settings.permissions({ camera: "granted" });
		expect(!r.success && r.error.code).toBe("E_UNSUPPORTED");
		expect(!r.success && r.error.message).toContain("does not declare");
	});
	test("another failure is E_IO", async () => {
		const h = harness([{ match: "pm grant", reply: { stdout: "Security exception\n", exitCode: 1 } }]);
		const r = await h.settings.permissions({ camera: "granted" });
		expect(!r.success && r.error.code).toBe("E_IO");
	});
});

describe("android timezone", () => {
	function tzDevice(initial = "Europe/London") {
		let tz = initial;
		return [
			{ match: "getprop persist.sys.timezone", reply: () => `${tz}\n` },
			{
				match: "cmd alarm set-timezone",
				reply: (cmd: string) => {
					tz = cmd.split(" ").pop() ?? tz;
					return "";
				},
			},
		] satisfies ShellRule[];
	}
	test("sets, verifies and reports the previous timezone", async () => {
		const h = harness(tzDevice());
		const r = await h.settings.timezone("Asia/Tokyo");
		expect(r.success && r.data).toEqual({ timezone: "Asia/Tokyo", previous: "Europe/London" });
	});
	test("null restores the given previous timezone, else the host's", async () => {
		const a = harness(tzDevice("Asia/Tokyo"));
		await a.settings.timezone(null, { previous: "America/New_York" });
		expect(a.host.shell.at(-2)).toBe("cmd alarm set-timezone America/New_York");
		const b = harness(tzDevice("Asia/Tokyo"));
		await b.settings.timezone(null);
		expect(b.host.shell.some((c) => c === "cmd alarm set-timezone Europe/London")).toBe(true);
	});
	test("fails with E_IO when the property did not change", async () => {
		const h = harness([{ match: "getprop persist.sys.timezone", reply: "Europe/London\n" }]);
		const r = await h.settings.timezone("Asia/Tokyo");
		expect(!r.success && r.error.code).toBe("E_IO");
	});
	test("a physical device is E_UNSUPPORTED, a bad zone E_BAD_REQUEST", async () => {
		const phys = await harness([], "R5CT1234").settings.timezone("Asia/Tokyo");
		expect(!phys.success && phys.error.code).toBe("E_UNSUPPORTED");
		const bad = await harness().settings.timezone("Mars/Olympus");
		expect(!bad.success && bad.error.code).toBe("E_BAD_REQUEST");
	});
});

describe("android locale", () => {
	const api = (level: number, locales = "fr-FR"): ShellRule[] => [
		{ match: "getprop ro.build.version.sdk", reply: `${level}\n` },
		{ match: "cmd locale get-app-locales", reply: `Locales for ${PKG} for user 0 are [${locales}]\n` },
	];
	test("sets the app's locale and reads it back", async () => {
		const h = harness(api(36));
		const r = await h.settings.locale("fr-FR");
		expect(r.success && r.data).toEqual({ locale: "fr-FR", bundleId: PKG });
		expect(h.host.shell).toContain(`cmd locale set-app-locales ${PKG} --locales fr-FR`);
	});
	test("null clears with an empty list", async () => {
		const h = harness(api(36, ""));
		await h.settings.locale(null);
		expect(h.host.shell).toContain(`cmd locale set-app-locales ${PKG} --locales ''`);
	});
	test("below API 33 is E_UNSUPPORTED; a read-back mismatch is E_IO", async () => {
		const old = await harness(api(32)).settings.locale("fr-FR");
		expect(!old.success && old.error.code).toBe("E_UNSUPPORTED");
		const stuck = await harness(api(36, "en-US")).settings.locale("fr-FR");
		expect(!stuck.success && stuck.error.code).toBe("E_IO");
	});
});

describe("android a11y", () => {
	test("text size becomes font_scale (clamped), bold becomes font_weight_adjustment", async () => {
		const h = harness();
		const r = await h.settings.a11y({ textSize: "accessibility-extra-large", boldText: true });
		expect(h.host.shell.filter((c) => c.startsWith("settings put"))).toEqual([
			"settings put system font_scale 2",
			"settings put secure font_weight_adjustment 300",
		]);
		expect(r.success && r.data.notes[0]).toContain("clamped to 2");
	});
	test("contrast and reduce motion are skipped; only those is E_UNSUPPORTED", async () => {
		const h = harness();
		const mixed = await h.settings.a11y({ textSize: 1.3, contrast: "increased", reduceMotion: true });
		expect(mixed.success && mixed.data.skipped.map((s) => s.setting)).toEqual(["contrast", "reduceMotion"]);
		const only = await h.settings.a11y({ contrast: "increased" });
		expect(!only.success && only.error.code).toBe("E_UNSUPPORTED");
	});
	test("null puts both back", async () => {
		const h = harness();
		await h.settings.a11y(null);
		expect(h.host.shell.filter((c) => c.startsWith("settings put"))).toEqual([
			"settings put system font_scale 1",
			"settings put secure font_weight_adjustment 0",
		]);
	});
});

describe("android a11y write-back", () => {
	test("a put the system overwrites is repeated until it holds", async () => {
		let stored = "1.0";
		let puts = 0;
		const h = harness([
			{
				match: "settings put system font_scale",
				reply: (cmd) => {
					puts++;
					// the first write is overwritten by the system's own persisted value
					if (puts > 1) stored = cmd.split(" ").pop() ?? stored;
					return "";
				},
			},
			{ match: "settings get system font_scale", reply: () => `${stored}\n` },
		]);
		const r = await h.settings.a11y({ textSize: 1.5 });
		expect(r.success).toBe(true);
		expect(puts).toBe(2);
	});
	test("a value that never sticks is E_IO", async () => {
		const h = harness([{ match: "settings get system font_scale", reply: "1.0\n" }]);
		const r = await h.settings.a11y({ textSize: 1.5 });
		expect(!r.success && r.error.code).toBe("E_IO");
	});
});

describe("android battery, memory warning, push", () => {
	test("battery is real; null resets", async () => {
		const h = harness();
		const r = await h.settings.battery({ level: 15, charging: false });
		expect(r.success && r.data).toEqual({ level: 15, charging: false, cosmetic: false });
		await h.settings.battery(null);
		expect(h.host.shell.at(-1)).toBe("dumpsys battery reset");
	});
	test("memory warning sends RUNNING_CRITICAL to the app; a stopped app is E_APP_UNAVAILABLE", async () => {
		const ok = harness();
		expect((await ok.settings.memoryWarning()).success).toBe(true);
		expect(ok.host.shell).toEqual([`am send-trim-memory ${PKG} RUNNING_CRITICAL`]);
		const stopped = harness([
			{
				match: "am send-trim-memory",
				reply: { stdout: "java.lang.IllegalArgumentException: Unknown process: x\n", exitCode: 255 },
			},
		]);
		const r = await stopped.settings.memoryWarning();
		expect(!r.success && r.error.code).toBe("E_APP_UNAVAILABLE");
	});
	test("push is E_UNSUPPORTED", async () => {
		const r = await harness().settings.push({ aps: {} });
		expect(!r.success && r.error.code).toBe("E_UNSUPPORTED");
	});
});

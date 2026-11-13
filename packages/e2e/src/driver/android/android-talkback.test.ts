import { describe, expect, test } from "bun:test";
import { openAdbSession } from "./adb-session";
import { fakeAndroidHost, type ShellRule } from "./android-host.testing";
import { createAndroidSettings } from "./android-settings";
import { settingValue, TALKBACK_SERVICE, talkbackBound, withTalkBack } from "./android-talkback";

const BOUND = `ACCESSIBILITY MANAGER\n  Bound services:{Service[label=TalkBack, feedbackType[FEEDBACK_SPOKEN], capabilities=3]}\n  Enabled services:{{com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService}}`;
const UNBOUND =
	"ACCESSIBILITY MANAGER\n  Bound services:{}\n  Enabled services:{{com.google.android.marvin.talkback/x}}";

/** A device whose secure settings are a map and whose `dumpsys accessibility` follows the services setting. */
function device(initial: { services?: string; enabled?: string; talkback?: boolean; bindAfter?: number } = {}) {
	const store = new Map<string, string>();
	if (initial.services !== undefined) store.set("enabled_accessibility_services", initial.services);
	if (initial.enabled !== undefined) store.set("accessibility_enabled", initial.enabled);
	let dumps = 0;
	const bindAfter = initial.bindAfter ?? 0;
	const rules: ShellRule[] = [
		{
			match: "pm path",
			reply: initial.talkback === false ? { stdout: "", exitCode: 1 } : "package:/product/app/talkback/talkback.apk\n",
		},
		{ match: "pm grant", reply: "" },
		{
			match: /^settings get secure/,
			reply: (cmd) => `${store.get(cmd.trim().split(" ").pop() ?? "") ?? "null"}\n`,
		},
		{
			match: /^settings (put|delete) secure/,
			reply: (cmd) => {
				const parts = cmd.trim().split(" ");
				const key = parts[3] ?? "";
				if (parts[1] === "delete") store.delete(key);
				else store.set(key, (parts[4] ?? "").replace(/^'|'$/g, ""));
				return "";
			},
		},
		{
			match: "dumpsys accessibility",
			reply: () => {
				dumps++;
				const on = (store.get("enabled_accessibility_services") ?? "").includes("TalkBackService");
				return on && dumps > bindAfter ? BOUND : UNBOUND;
			},
		},
	];
	const host = fakeAndroidHost({ shell: rules });
	const session = openAdbSession({ adb: "adb", serial: "emulator-5554", spawn: host.spawn });
	return { host, store, session };
}

function settingsFor(d: ReturnType<typeof device>, uiad = true) {
	return createAndroidSettings({
		session: d.session,
		serial: "emulator-5554",
		sleep: async () => undefined,
		uiadAvailable: () => uiad,
	});
}

describe("talkback parsing", () => {
	test("settings get null means unset", () => {
		expect(settingValue("null\n")).toBeNull();
		expect(settingValue("")).toBeNull();
		expect(settingValue("a/b:c/d\n")).toBe("a/b:c/d");
	});
	test("TalkBack is appended after the other services, once", () => {
		expect(withTalkBack(null)).toBe(TALKBACK_SERVICE);
		expect(withTalkBack("a/b")).toBe(`a/b:${TALKBACK_SERVICE}`);
		expect(withTalkBack(`a/b:${TALKBACK_SERVICE}`)).toBe(`a/b:${TALKBACK_SERVICE}`);
	});
	test("bound only when the Bound services line names TalkBack", () => {
		expect(talkbackBound(BOUND)).toBe(true);
		expect(talkbackBound(UNBOUND)).toBe(false);
		expect(talkbackBound("")).toBe(false);
	});
});

describe("a11y({ screenReader })", () => {
	test("on: grants notifications, appends the service, switches accessibility on and waits for the bind", async () => {
		const d = device({ services: "com.other/com.other.Svc", enabled: "0", bindAfter: 2 });
		const settings = settingsFor(d);
		const r = await settings.a11y({ screenReader: true });
		expect(r.success && r.data.screenReader).toEqual({ mode: "real", engine: "talkback" });
		expect(r.success && r.data.applied).toContain("screenReader");
		expect(r.success && r.data.screenReaderPrevious).toEqual({ services: "com.other/com.other.Svc", enabled: "0" });
		expect(d.host.shell).toContain("pm grant com.google.android.marvin.talkback android.permission.POST_NOTIFICATIONS");
		expect(d.store.get("enabled_accessibility_services")).toBe(`com.other/com.other.Svc:${TALKBACK_SERVICE}`);
		expect(d.store.get("accessibility_enabled")).toBe("1");
		expect(d.host.shell.filter((c) => c === "dumpsys accessibility").length).toBe(3);
	});
	test("off restores the exact previous values, services we did not add stay", async () => {
		const d = device({ services: "com.other/com.other.Svc$Inner", enabled: "1" });
		const settings = settingsFor(d);
		await settings.a11y({ screenReader: true });
		const r = await settings.a11y({ screenReader: false });
		expect(r.success && r.data.screenReader).toEqual({ mode: "off" });
		expect(d.store.get("enabled_accessibility_services")).toBe("com.other/com.other.Svc$Inner");
		expect(d.store.get("accessibility_enabled")).toBe("1");
	});
	test("off deletes keys that were unset before", async () => {
		const d = device();
		const settings = settingsFor(d);
		await settings.a11y({ screenReader: true });
		await settings.a11y(null);
		expect(d.store.has("enabled_accessibility_services")).toBe(false);
		expect(d.store.has("accessibility_enabled")).toBe(false);
		expect(d.host.shell).toContain("settings delete secure enabled_accessibility_services");
	});
	test("a11y(null) with TalkBack never turned on by warden touches no accessibility setting", async () => {
		const d = device({ services: "x/y", enabled: "1" });
		await settingsFor(d).a11y(null);
		expect(
			d.host.shell.filter((c) => c.includes("enabled_accessibility_services") || c.includes("accessibility_enabled"))
		).toEqual([]);
	});
	test("turning it on twice keeps the first previous values", async () => {
		const d = device({ services: "x/y", enabled: "1" });
		const settings = settingsFor(d);
		await settings.a11y({ screenReader: true });
		const again = await settings.a11y({ screenReader: true });
		expect(again.success && again.data.screenReaderPrevious).toEqual({ services: "x/y", enabled: "1" });
		await settings.a11y({ screenReader: false });
		expect(d.store.get("enabled_accessibility_services")).toBe("x/y");
	});
	test("no TalkBack package is E_UNSUPPORTED naming a Play image, and nothing is written", async () => {
		const d = device({ talkback: false });
		const r = await settingsFor(d).a11y({ screenReader: true });
		expect(!r.success && r.error.code).toBe("E_UNSUPPORTED");
		expect(!r.success && r.error.message).toContain("Google Play system image");
		expect(d.host.shell.some((c) => c.startsWith("settings put"))).toBe(false);
	});
	test("without the uiad server it is E_UNSUPPORTED, since the dump unbinds TalkBack", async () => {
		const d = device();
		const r = await settingsFor(d, false).a11y({ screenReader: true });
		expect(!r.success && r.error.code).toBe("E_UNSUPPORTED");
		expect(!r.success && r.error.message).toContain("warden-uiad");
		expect(d.host.shell.some((c) => c.startsWith("settings put"))).toBe(false);
	});
	test("a service that never binds restores the settings and is E_IO", async () => {
		const d = device({ services: "x/y", enabled: "0", bindAfter: 10_000 });
		const r = await settingsFor(d).a11y({ screenReader: true });
		expect(!r.success && r.error.code).toBe("E_IO");
		expect(d.store.get("enabled_accessibility_services")).toBe("x/y");
		expect(d.store.get("accessibility_enabled")).toBe("0");
	});
	test("detect finds a TalkBack that was already on and bound, and does not claim to own it", async () => {
		const d = device({ services: TALKBACK_SERVICE, enabled: "1" });
		const s = settingsFor(d);
		expect(await s.talkback.detect()).toBe(true);
		expect(s.talkback.on()).toBe(true);
		expect(s.talkback.active()).toBe(false);
		await s.a11y(null);
		expect(d.store.get("enabled_accessibility_services")).toBe(TALKBACK_SERVICE);
	});
});

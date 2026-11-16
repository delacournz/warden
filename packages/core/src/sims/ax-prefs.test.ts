import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { realTimer } from "../providers/health";
import { accessibilityPlistPath, axPrefsEnabled, PREBOOT_AX_KEYS, writePrebootAxPrefs } from "./ax-prefs";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "warden-ax-prefs-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function fake(answer: (joined: string) => Partial<ExecResult>, calls: string[]): Exec {
	return async (cmd) => {
		const joined = cmd.join(" ");
		calls.push(joined);
		return { exitCode: 0, stdout: "", stderr: "", ...answer(joined) };
	};
}

const prefsDir = (udid: string): string =>
	join(home, "Library/Developer/CoreSimulator/Devices", udid, "data/Library/Preferences");

describe("axPrefsEnabled", () => {
	test("on unless WARDEN_AX_PREFS=0", () => {
		expect(axPrefsEnabled({})).toBe(true);
		expect(axPrefsEnabled({ WARDEN_AX_PREFS: "1" })).toBe(true);
		expect(axPrefsEnabled({ WARDEN_AX_PREFS: "0" })).toBe(false);
	});
});

describe("writePrebootAxPrefs", () => {
	test("writes both keys as booleans into the device's Accessibility plist", async () => {
		mkdirSync(prefsDir("U1"), { recursive: true });
		const calls: string[] = [];
		const plist = accessibilityPlistPath({ HOME: home }, "U1");
		const out = await writePrebootAxPrefs({ exec: fake(() => ({}), calls), timer: realTimer }, { HOME: home }, "U1");
		expect(out).toEqual({ success: true, data: "written" });
		expect(PREBOOT_AX_KEYS).toEqual(["AutomationEnabled", "IgnoreAXServerEntitlements"]);
		expect(calls).toEqual([
			`plutil -replace AutomationEnabled -bool true ${plist}`,
			`plutil -replace IgnoreAXServerEntitlements -bool true ${plist}`,
		]);
	});

	test("creates a missing plist, then writes", async () => {
		mkdirSync(prefsDir("U1"), { recursive: true });
		const calls: string[] = [];
		let created = false;
		const exec = fake((joined) => {
			if (joined.startsWith("plutil -create")) {
				created = true;
				return {};
			}
			return created ? {} : { exitCode: 1, stderr: "file does not exist" };
		}, calls);
		const plist = accessibilityPlistPath({ HOME: home }, "U1");
		const out = await writePrebootAxPrefs({ exec, timer: realTimer }, { HOME: home }, "U1");
		expect(out).toEqual({ success: true, data: "written" });
		expect(calls).toEqual([
			`plutil -replace AutomationEnabled -bool true ${plist}`,
			`plutil -create binary1 ${plist}`,
			`plutil -replace AutomationEnabled -bool true ${plist}`,
			`plutil -replace IgnoreAXServerEntitlements -bool true ${plist}`,
		]);
	});

	test("a device never booted (no Preferences dir yet) is left for its first boot", async () => {
		const calls: string[] = [];
		const out = await writePrebootAxPrefs({ exec: fake(() => ({}), calls), timer: realTimer }, { HOME: home }, "U1");
		expect(out).toEqual({ success: true, data: "not-booted-yet" });
		expect(calls).toEqual([]);
	});

	test("a plist that cannot be created is an error naming the command", async () => {
		mkdirSync(prefsDir("U1"), { recursive: true });
		const calls: string[] = [];
		const exec = fake(() => ({ exitCode: 1, stderr: "permission denied" }), calls);
		const out = await writePrebootAxPrefs({ exec, timer: realTimer }, { HOME: home }, "U1");
		expect(out.success).toBe(false);
		if (!out.success) expect(out.error).toContain("plutil -create");
	});
});

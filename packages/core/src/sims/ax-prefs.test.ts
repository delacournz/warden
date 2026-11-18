import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** What `simctl create` leaves on iOS 27: a Preferences dir already, but no first-boot migration record. */
function justCreated(udid: string): void {
	mkdirSync(join(prefsDir(udid), "Logging"), { recursive: true });
	writeFileSync(join(prefsDir(udid), "com.apple.UIAutomation.plist"), "");
}

/** A device whose first boot ran Data Migration (its record exists), with no Accessibility plist yet. */
function migrated(udid: string): void {
	justCreated(udid);
	writeFileSync(join(prefsDir(udid), "com.apple.migration.plist"), "");
}

/** A device that has booted before: its migration record and Accessibility plist exist on disk. */
function bootedBefore(udid: string): string {
	migrated(udid);
	const plist = accessibilityPlistPath({ HOME: home }, udid);
	writeFileSync(plist, "");
	return plist;
}

describe("axPrefsEnabled", () => {
	test("on unless WARDEN_AX_PREFS=0", () => {
		expect(axPrefsEnabled({})).toBe(true);
		expect(axPrefsEnabled({ WARDEN_AX_PREFS: "1" })).toBe(true);
		expect(axPrefsEnabled({ WARDEN_AX_PREFS: "0" })).toBe(false);
	});
});

describe("writePrebootAxPrefs", () => {
	test("writes both keys as booleans into the device's Accessibility plist", async () => {
		const plist = bootedBefore("U1");
		const calls: string[] = [];
		const out = await writePrebootAxPrefs({ exec: fake(() => ({}), calls), timer: realTimer }, { HOME: home }, "U1");
		expect(out).toEqual({ success: true, data: "written" });
		expect(PREBOOT_AX_KEYS).toEqual(["AutomationEnabled", "IgnoreAXServerEntitlements"]);
		expect(calls).toEqual([
			`plutil -replace AutomationEnabled -bool true ${plist}`,
			`plutil -replace IgnoreAXServerEntitlements -bool true ${plist}`,
		]);
	});

	test("creates the plist only when it is missing on disk, then writes", async () => {
		migrated("U1");
		const calls: string[] = [];
		const plist = accessibilityPlistPath({ HOME: home }, "U1");
		const out = await writePrebootAxPrefs({ exec: fake(() => ({}), calls), timer: realTimer }, { HOME: home }, "U1");
		expect(out).toEqual({ success: true, data: "written" });
		expect(calls).toEqual([
			`plutil -create binary1 ${plist}`,
			`plutil -replace AutomationEnabled -bool true ${plist}`,
			`plutil -replace IgnoreAXServerEntitlements -bool true ${plist}`,
		]);
	});

	test("an existing plist whose write fails is an error, never re-created empty", async () => {
		const plist = bootedBefore("U1");
		const calls: string[] = [];
		const exec = fake(() => ({ exitCode: 1, stderr: "could not read" }), calls);
		const out = await writePrebootAxPrefs({ exec, timer: realTimer }, { HOME: home }, "U1");
		expect(out.success).toBe(false);
		if (!out.success) expect(out.error).toContain("plutil -replace AutomationEnabled");
		expect(calls).toEqual([`plutil -replace AutomationEnabled -bool true ${plist}`]);
	});

	test("a device never booted (no Preferences dir yet) is left for its first boot", async () => {
		const calls: string[] = [];
		const out = await writePrebootAxPrefs({ exec: fake(() => ({}), calls), timer: realTimer }, { HOME: home }, "U1");
		expect(out).toEqual({ success: true, data: "not-booted-yet" });
		expect(calls).toEqual([]);
	});

	test("a device simctl just created (Preferences dir, no migration record) is left for its first boot", async () => {
		justCreated("U1");
		const calls: string[] = [];
		const out = await writePrebootAxPrefs({ exec: fake(() => ({}), calls), timer: realTimer }, { HOME: home }, "U1");
		expect(out).toEqual({ success: true, data: "not-booted-yet" });
		expect(calls).toEqual([]);
	});

	test("a plist that cannot be created is an error naming the command", async () => {
		migrated("U1");
		const calls: string[] = [];
		const exec = fake(() => ({ exitCode: 1, stderr: "permission denied" }), calls);
		const out = await writePrebootAxPrefs({ exec, timer: realTimer }, { HOME: home }, "U1");
		expect(out.success).toBe(false);
		if (!out.success) expect(out.error).toContain("plutil -create");
	});
});

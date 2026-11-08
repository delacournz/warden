import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchSettingsPath, readLaunchSettings, writeLaunchSettings } from "./launch-settings";

const dirs: string[] = [];
const home = () => {
	const d = mkdtempSync(join(tmpdir(), "wdn-launch-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("launch settings", () => {
	test("path is per device", () => {
		expect(launchSettingsPath("/h", "U1")).toBe("/h/launch-settings/U1.json");
	});
	test("round-trips and an empty write removes the file", () => {
		const path = launchSettingsPath(home(), "U1");
		expect(readLaunchSettings(path)).toEqual({});
		expect(writeLaunchSettings(path, { timezone: "Asia/Tokyo", locale: "fr-FR" })).toBeUndefined();
		expect(readLaunchSettings(path)).toEqual({ timezone: "Asia/Tokyo", locale: "fr-FR" });
		expect(writeLaunchSettings(path, {})).toBeUndefined();
		expect(existsSync(path)).toBe(false);
	});
	test("an unreadable file reads as none", () => {
		const path = launchSettingsPath(home(), "U1");
		expect(writeLaunchSettings(path, { locale: "de" })).toBeUndefined();
		writeFileSync(path, "{nope");
		expect(readLaunchSettings(path)).toEqual({});
	});
});

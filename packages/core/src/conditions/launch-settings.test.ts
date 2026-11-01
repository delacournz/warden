import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchSettingsFile } from "./launch-settings";

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
		expect(launchSettingsFile.path("/h", "U1")).toBe("/h/launch-settings/U1.json");
	});
	test("round-trips and an empty write removes the file", () => {
		const path = launchSettingsFile.path(home(), "U1");
		expect(launchSettingsFile.read(path)).toEqual({});
		expect(launchSettingsFile.write(path, { timezone: "Asia/Tokyo", locale: "fr-FR" })).toBeUndefined();
		expect(launchSettingsFile.read(path)).toEqual({ timezone: "Asia/Tokyo", locale: "fr-FR" });
		expect(launchSettingsFile.write(path, {})).toBeUndefined();
		expect(existsSync(path)).toBe(false);
	});
	test("an unreadable file reads as none", () => {
		const path = launchSettingsFile.path(home(), "U1");
		expect(launchSettingsFile.write(path, { locale: "de" })).toBeUndefined();
		writeFileSync(path, "{nope");
		expect(launchSettingsFile.read(path)).toEqual({});
	});
});

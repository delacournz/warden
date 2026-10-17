import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingPackages } from "./expo-app";

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("missingPackages", () => {
	test("names listed in neither dependencies nor devDependencies", () => {
		dir = mkdtempSync(join(tmpdir(), "warden-expo-app-"));
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ dependencies: { expo: "~57.0.0" }, devDependencies: { e2e: "0.19.0" } })
		);
		expect(missingPackages(dir, ["expo", "expo-dev-client", "e2e"])).toEqual(["expo-dev-client"]);
	});

	test("no readable package.json → nothing reported", () => {
		dir = mkdtempSync(join(tmpdir(), "warden-expo-app-"));
		expect(missingPackages(dir, ["expo-dev-client"])).toEqual([]);
		writeFileSync(join(dir, "package.json"), "{ nope");
		expect(missingPackages(dir, ["expo-dev-client"])).toEqual([]);
	});
});

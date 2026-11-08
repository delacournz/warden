import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expoInstallCommand, missingPackages } from "./expo-app";

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

describe("expoInstallCommand", () => {
	test("picks the package manager from the nearest lockfile, walking up", () => {
		dir = mkdtempSync(join(tmpdir(), "warden-expo-app-"));
		const app = join(dir, "apps", "mobile");
		mkdirSync(app, { recursive: true });
		expect(expoInstallCommand(app, ["expo-dev-client"])).toEqual(["bunx", "expo", "install", "expo-dev-client"]);
		writeFileSync(join(dir, "yarn.lock"), "");
		expect(expoInstallCommand(app, ["expo-dev-client"])).toEqual(["yarn", "expo", "install", "expo-dev-client"]);
		writeFileSync(join(app, "pnpm-lock.yaml"), "");
		expect(expoInstallCommand(app, ["a", "b"])).toEqual(["pnpm", "expo", "install", "a", "b"]);
		rmSync(join(app, "pnpm-lock.yaml"));
		writeFileSync(join(app, "package-lock.json"), "");
		expect(expoInstallCommand(app, ["a"])).toEqual(["npx", "expo", "install", "a"]);
		writeFileSync(join(app, "bun.lock"), "");
		expect(expoInstallCommand(app, ["a"])).toEqual(["bunx", "expo", "install", "a"]);
	});
});

import { describe, expect, test } from "bun:test";
import { describePackageInstall, detectPackageInstall, upgradeCommand } from "./package-install";

const bin = (prefix: string) => `${prefix}/node_modules/@delacour/warden-darwin-arm64/bin/warden`;

describe("detectPackageInstall", () => {
	test("standalone binaries aren't package installs", () => {
		expect(detectPackageInstall("/Users/me/.local/bin/warden")).toBeUndefined();
		expect(detectPackageInstall("/repo/apps/cli/dist/warden")).toBeUndefined();
	});

	test("npm global (deps nested under the main package)", () => {
		expect(detectPackageInstall(bin("/opt/homebrew/lib/node_modules/@delacour/warden"))).toEqual({
			kind: "npm-global",
		});
		expect(detectPackageInstall(bin("/usr/local/lib/node_modules"))).toEqual({ kind: "npm-global" });
	});

	test("bun global", () => {
		expect(detectPackageInstall(bin("/Users/me/.bun/install/global"))).toEqual({ kind: "bun-global" });
	});

	test("pnpm global", () => {
		expect(
			detectPackageInstall(bin("/Users/me/Library/pnpm/global/5/.pnpm/@delacour+warden-darwin-arm64@0.3.0"))
		).toEqual({ kind: "pnpm-global" });
	});

	test("npx cache", () => {
		expect(detectPackageInstall(bin("/Users/me/.npm/_npx/0123abcd"))).toEqual({ kind: "npx" });
	});

	test("bunx cache", () => {
		expect(detectPackageInstall(bin("/private/tmp/bunx-501-@delacour/warden@latest"))).toEqual({ kind: "bunx" });
	});

	test("project dependency → its root", () => {
		expect(detectPackageInstall(bin("/work/app"))).toEqual({ kind: "project", root: "/work/app" });
	});
});

describe("upgradeCommand", () => {
	test("global installs upgrade through their package manager", () => {
		expect(upgradeCommand({ kind: "npm-global" })).toBe("npm i -g @delacour/warden@latest");
		expect(upgradeCommand({ kind: "bun-global" })).toBe("bun add -g @delacour/warden@latest");
		expect(upgradeCommand({ kind: "pnpm-global" })).toBe("pnpm add -g @delacour/warden@latest");
	});

	test("one-shot runs re-run install from the latest package", () => {
		expect(upgradeCommand({ kind: "npx" })).toBe("npx @delacour/warden@latest install");
		expect(upgradeCommand({ kind: "bunx" })).toBe("bunx @delacour/warden@latest install");
	});

	test("project dependency → bump it in that project", () => {
		expect(upgradeCommand({ kind: "project", root: "/work/app" })).toContain("/work/app");
	});
});

test("describePackageInstall", () => {
	expect(describePackageInstall({ kind: "npm-global" })).toBe("npm global install of @delacour/warden");
	expect(describePackageInstall({ kind: "project", root: "/w" })).toBe("@delacour/warden dependency of /w");
});

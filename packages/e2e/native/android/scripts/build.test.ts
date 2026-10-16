import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compareVersions,
	findToolchain,
	pickBuildTools,
	pickPlatform,
	readConstants,
	sdkRoots,
	sourceHash,
} from "./build";

describe("compareVersions", () => {
	test("compares numerically, not lexically", () => {
		expect(compareVersions("36.0.0", "34.0.0")).toBeGreaterThan(0);
		expect(compareVersions("9.0.0", "10.0.0")).toBeLessThan(0);
		expect(compareVersions("37.1", "37")).toBeGreaterThan(0);
		expect(compareVersions("36.0.0", "36")).toBe(0);
	});
});

describe("pickBuildTools", () => {
	test("prefers the newest stable directory over a newer preview", () => {
		expect(pickBuildTools(["29.0.2", "36.0.0", "36.0.0-rc5", "34.0.0"])).toBe("36.0.0");
		expect(pickBuildTools(["37.0.0", "36.0.0-rc1"])).toBe("37.0.0");
	});

	test("falls back to a preview when nothing else exists", () => {
		expect(pickBuildTools(["36.0.0-rc1", "36.0.0-rc5"])).toBeDefined();
		expect(pickBuildTools([])).toBeUndefined();
	});
});

describe("pickPlatform", () => {
	test("takes the newest android-N at or above the minimum, minor releases included", () => {
		expect(pickPlatform(["android-28", "android-30", "android-36", "android-37.1"])).toBe("android-37.1");
		expect(pickPlatform(["android-28", "android-30"])).toBe("android-30");
	});

	test("ignores platforms below the minimum and odd directory names", () => {
		expect(pickPlatform(["android-28", "android-Baklava", "sources"])).toBeUndefined();
	});
});

describe("sdkRoots", () => {
	test("orders the override, ANDROID_HOME, ANDROID_SDK_ROOT, then the usual homes", () => {
		const roots = sdkRoots({ WARDEN_ANDROID_SDK: "/a", ANDROID_HOME: "/b", ANDROID_SDK_ROOT: "/c" }, "/home/u");
		expect(roots).toEqual(["/a", "/b", "/c", "/home/u/Library/Android/sdk", "/home/u/Android/Sdk"]);
	});

	test("skips unset variables", () => {
		expect(sdkRoots({}, "/h")).toEqual(["/h/Library/Android/sdk", "/h/Android/Sdk"]);
	});
});

describe("findToolchain", () => {
	function fakeSdk(parts: { tools?: string[]; platforms?: string[] }): string {
		const root = mkdtempSync(join(tmpdir(), "uiad-sdk-"));
		for (const tools of parts.tools ?? []) {
			mkdirSync(join(root, "build-tools", tools), { recursive: true });
			writeFileSync(join(root, "build-tools", tools, "d8"), "");
		}
		for (const platform of parts.platforms ?? []) {
			mkdirSync(join(root, "platforms", platform), { recursive: true });
			writeFileSync(join(root, "platforms", platform, "android.jar"), "");
		}
		return root;
	}

	test("finds d8 and android.jar in the SDK named by ANDROID_HOME", () => {
		const root = fakeSdk({ tools: ["34.0.0", "36.0.0"], platforms: ["android-34", "android-36"] });
		try {
			const found = findToolchain({ ANDROID_HOME: root }, "/nowhere");
			expect(found.ok).toBe(true);
			if (!found.ok) return;
			expect(found.toolchain.d8).toBe(join(root, "build-tools", "36.0.0", "d8"));
			expect(found.toolchain.androidJar).toBe(join(root, "platforms", "android-36", "android.jar"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("names what is missing when the SDK has no build-tools", () => {
		const root = fakeSdk({ platforms: ["android-36"] });
		try {
			const found = findToolchain({ ANDROID_HOME: root }, "/nowhere");
			expect(found.ok).toBe(false);
			if (found.ok) return;
			expect(found.missing.join("\n")).toContain("no build-tools with d8");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("reports a missing SDK", () => {
		const found = findToolchain({}, "/definitely/not/a/home");
		expect(found.ok).toBe(false);
	});
});

describe("readConstants", () => {
	test("reads the protocol and version the Java side declares", () => {
		const java = 'static final int PROTOCOL = 1;\n\tstatic final String VERSION = "0.1.0";';
		expect(readConstants(java)).toEqual({ protocol: 1, version: "0.1.0" });
	});

	test("refuses a Main.java without them", () => {
		expect(() => readConstants("class Main {}")).toThrow("PROTOCOL / VERSION");
	});
});

describe("sourceHash", () => {
	test("changes with a file's content and with its path, not with the build date", () => {
		const dir = mkdtempSync(join(tmpdir(), "uiad-src-"));
		try {
			const a = join(dir, "A.java");
			const b = join(dir, "B.java");
			writeFileSync(a, "class A {}");
			writeFileSync(b, "class B {}");
			const first = sourceHash(dir, [a, b]);
			expect(sourceHash(dir, [a, b])).toBe(first);
			writeFileSync(b, "class B { int x; }");
			expect(sourceHash(dir, [a, b])).not.toBe(first);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

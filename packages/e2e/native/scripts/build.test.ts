import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, checkIdbConstant, checkRpath, parseXcodeVersion, stageSteps } from "./build";

const lock = { version: "v1.7.2", tarball: "idb-libraries.macos-arm64.tar.gz", sha256: "a".repeat(64) };

describe("checkIdbConstant", () => {
	test("accepts a Wire.swift whose BuildInfo.idb matches the lock", () => {
		expect(() => checkIdbConstant('  static let idb = "v1.7.2"\n', lock)).not.toThrow();
	});

	test("names both versions when they differ", () => {
		expect(() => checkIdbConstant('  static let idb = "v1.6.0"\n', lock)).toThrow(/v1\.6\.0.*v1\.7\.2/);
	});

	test("fails when the constant is missing", () => {
		expect(() => checkIdbConstant("enum BuildInfo {}", lock)).toThrow(/BuildInfo\.idb/);
	});

	test("the checked-in Wire.swift matches the checked-in lock", () => {
		const wire = readFileSync(join(import.meta.dir, "../ios/Sources/warden-simd/Protocol/Wire.swift"), "utf8");
		const checkedIn = JSON.parse(readFileSync(join(import.meta.dir, "../idb.lock.json"), "utf8"));
		expect(() => checkIdbConstant(wire, checkedIn)).not.toThrow();
	});
});

describe("parseXcodeVersion", () => {
	test("joins version and build", () => {
		expect(parseXcodeVersion("Xcode 26.6\nBuild version 17F113\n")).toBe("26.6 (17F113)");
	});

	test("falls back to unknown", () => {
		expect(parseXcodeVersion("")).toBe("unknown");
	});
});

describe("buildManifest", () => {
	test("records version, idb, xcode and a build timestamp", () => {
		const manifest = buildManifest({
			version: "0.1.0",
			lock,
			xcode: "26.6 (17F113)",
			now: new Date("2026-10-16T00:00:00Z"),
		});
		expect(manifest).toEqual({
			version: "0.1.0",
			idb: "v1.7.2",
			xcode: "26.6 (17F113)",
			builtAt: "2026-10-16T00:00:00.000Z",
		});
	});
});

describe("stageSteps", () => {
	test("stages the binary, guest resource and stub frameworks, signs everything after stripping", () => {
		const steps = stageSteps({ binDir: "/b", libraries: "/l", dist: "/d", frameworks: ["A.framework", "B.framework"] });
		expect(steps.copies).toEqual([
			{ from: "/b/warden-simd", to: "/d/warden-simd" },
			{ from: "/l/Resources/SimulatorFrameworkBridge-iOS", to: "/d/Resources/SimulatorFrameworkBridge-iOS" },
			{ from: "/b/A.framework", to: "/d/A.framework" },
			{ from: "/b/B.framework", to: "/d/B.framework" },
		]);
		expect(steps.strip).toEqual(["/d/warden-simd"]);
		expect(steps.sign).toEqual(["/d/A.framework", "/d/B.framework", "/d/warden-simd"]);
		// The prebuilt in-sim guest is ad-hoc signed upstream and must never be re-signed.
		expect(steps.sign.some((path) => path.includes("SimulatorFrameworkBridge"))).toBe(false);
	});
});

const LOAD_COMMANDS = (rpaths: string[]) =>
	rpaths
		.map((path) => `Load command 20\n          cmd LC_RPATH\n      cmdsize 32\n         path ${path} (offset 12)`)
		.join("\n");

describe("checkRpath", () => {
	test("accepts a binary that searches its own directory for the stub frameworks", () => {
		expect(() => checkRpath(LOAD_COMMANDS(["/usr/lib/swift", "@executable_path"]))).not.toThrow();
		expect(() => checkRpath(LOAD_COMMANDS(["@loader_path"]))).not.toThrow();
	});
	test("rejects the Xcode 27 default (system and toolchain paths only): dyld cannot find the frameworks", () => {
		expect(() => checkRpath(LOAD_COMMANDS(["/usr/lib/swift", "/Applications/Xcode.app/x/swift-6.2/macosx"]))).toThrow(
			/@executable_path/
		);
		expect(() => checkRpath("")).toThrow(/@executable_path/);
	});
});

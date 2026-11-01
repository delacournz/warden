import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appDetector } from "./app-detect";

const fx = (name: string) => readFileSync(join(import.meta.dir, "..", "..", "fixtures", name), "utf8");

describe("iOS app detection", () => {
	test("lists running UIKitApplication jobs (pid present), skipping loaded-but-idle ones", () => {
		expect(appDetector.parseIosRunningApps(fx("launchctl-list.txt"))).toEqual([
			{ bundleId: "com.apple.springboard", pid: 412 },
			{ bundleId: "nz.co.delacour.warden.example", pid: 880 },
		]);
	});

	test("picks the single non-system app", () => {
		const apps = appDetector.parseIosRunningApps(fx("launchctl-list.txt"));
		expect(appDetector.pickIosApp(apps)).toEqual({ kind: "app", bundleId: "nz.co.delacour.warden.example", pid: 880 });
	});

	test("several user apps are ambiguous", () => {
		const apps = appDetector.parseIosRunningApps(fx("launchctl-list-two-apps.txt"));
		expect(appDetector.pickIosApp(apps)).toEqual({
			kind: "ambiguous",
			candidates: ["nz.co.delacour.warden.example", "com.acme.other"],
		});
	});

	test("only system apps means none", () => {
		expect(appDetector.pickIosApp([{ bundleId: "com.apple.springboard", pid: 1 }])).toEqual({ kind: "none" });
	});
});

describe("Android app detection", () => {
	test("reads the resumed activity", () => {
		expect(appDetector.parseResumedActivity(fx("dumpsys-resumed.txt"))).toEqual({
			package: "nz.co.delacour.warden.example",
			activity: ".MainActivity",
		});
		expect(appDetector.parseResumedActivity("nothing here")).toBeUndefined();
	});

	test("reads topResumedActivity too", () => {
		const text = "  topResumedActivity=ActivityRecord{abc u0 com.acme.shop/com.acme.shop.Main t3}\n";
		expect(appDetector.parseResumedActivity(text)).toEqual({
			package: "com.acme.shop",
			activity: "com.acme.shop.Main",
		});
	});

	test("debuggable comes from the package flags", () => {
		expect(appDetector.parsePackageFlags(fx("dumpsys-package-debuggable.txt"))).toEqual({
			debuggable: true,
			profileable: false,
		});
		expect(appDetector.parsePackageFlags(fx("dumpsys-package-release.txt"))).toEqual({
			debuggable: false,
			profileable: false,
		});
		expect(appDetector.parsePackageFlags("flags=[ HAS_CODE PROFILEABLE_BY_SHELL ]")).toEqual({
			debuggable: false,
			profileable: true,
		});
	});
});

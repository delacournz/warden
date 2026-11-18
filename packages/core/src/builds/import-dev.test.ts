import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../exec";
import { fakeApp } from "./builds.testing";
import { checkDevBuild } from "./import-dev";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-import-dev-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function execWith(plist: Record<string, string>, archs = "arm64"): Exec {
	return async (argv) => {
		const key = argv[0] === "plutil" ? argv[2] : undefined;
		if (key !== undefined && plist[key] !== undefined) return { stdout: `${plist[key]}\n`, stderr: "", exitCode: 0 };
		if (argv[0] === "lipo") return { stdout: `${archs}\n`, stderr: "", exitCode: 0 };
		return { stdout: "", stderr: "", exitCode: 1 };
	};
}

const PLIST = { CFBundleIdentifier: "com.demo", CFBundleExecutable: "App", DTPlatformName: "iphonesimulator" };
const CHECK = { bundleId: "com.demo", arch: "arm64" } as const;

function app(): string {
	const a = fakeApp(dir);
	chmodSync(join(a, "App"), 0o755);
	return a;
}

describe("checkDevBuild", () => {
	test("a Debug simulator build of the project is accepted", async () => {
		expect(await checkDevBuild(execWith(PLIST), app(), CHECK)).toEqual({
			success: true,
			data: { bundleId: "com.demo", archs: ["arm64"] },
		});
	});

	test("another app, a device build, a missing slice or an embedded bundle is refused", async () => {
		const a = app();
		const other = await checkDevBuild(execWith({ ...PLIST, CFBundleIdentifier: "com.other" }), a, CHECK);
		expect(other.success ? "" : other.error).toContain("com.other");
		const device = await checkDevBuild(execWith({ ...PLIST, DTPlatformName: "iphoneos" }), a, CHECK);
		expect(device.success ? "" : device.error).toContain("iphoneos");
		const slice = await checkDevBuild(execWith(PLIST, "x86_64"), a, CHECK);
		expect(slice.success ? "" : slice.error).toContain("no arm64 slice");
		writeFileSync(join(a, "main.jsbundle"), "js");
		const release = await checkDevBuild(execWith(PLIST), a, CHECK);
		expect(release.success ? "" : release.error).toContain("main.jsbundle");
	});
});

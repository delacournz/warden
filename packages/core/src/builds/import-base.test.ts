import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import { checkSimulatorBase, hostSimulatorArch } from "./import-base";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-import-base-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

type Plist = { CFBundleIdentifier?: string; CFBundleExecutable?: string; DTPlatformName?: string };

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
const missing: ExecResult = { exitCode: 1, stdout: "", stderr: "Could not extract value" };

/** `plutil -extract <key> raw` over `plist`, `lipo -archs` answering `archs`. */
function fakeExec(plist: Plist, archs = "arm64"): Exec {
	return async (cmd) => {
		if (cmd[0] === "plutil" && cmd[1] === "-extract") {
			const value = plist[cmd[2] as keyof Plist];
			return value === undefined ? missing : ok(`${value}\n`);
		}
		if (cmd[0] === "lipo") return ok(`${archs}\n`);
		return { exitCode: 1, stdout: "", stderr: `unexpected ${cmd.join(" ")}` };
	};
}

const RELEASE: Plist = {
	CFBundleIdentifier: "com.example.app",
	CFBundleExecutable: "Example",
	DTPlatformName: "iphonesimulator",
};

function app(files: string[] = []): string {
	const path = join(dir, "Example.app");
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "Info.plist"), "");
	writeFileSync(join(path, "Example"), "", { mode: 0o755 });
	for (const file of files) {
		mkdirSync(join(path, file, ".."), { recursive: true });
		if (file.endsWith(".bundle") || file.endsWith(".framework")) mkdirSync(join(path, file), { recursive: true });
		else writeFileSync(join(path, file), "x");
	}
	return path;
}

const opts = { bundleId: "com.example.app", arch: "arm64" } as const;

describe("checkSimulatorBase", () => {
	test("a Release simulator build of the project → its facts", async () => {
		const result = await checkSimulatorBase(fakeExec(RELEASE, "x86_64 arm64"), app(), opts);
		expect(result).toEqual({
			success: true,
			data: { bundleId: "com.example.app", archs: ["x86_64", "arm64"], embeddedBundle: false },
		});
	});

	test("an embedded main.jsbundle is reported (the import strips it)", async () => {
		const result = await checkSimulatorBase(fakeExec(RELEASE), app(["main.jsbundle"]), opts);
		expect(result.success && result.data.embeddedBundle).toBe(true);
	});

	test("a device build (iphoneos) is refused", async () => {
		const result = await checkSimulatorBase(fakeExec({ ...RELEASE, DTPlatformName: "iphoneos" }), app(), opts);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("iphoneos");
	});

	test("no slice for this Mac's simulators is refused", async () => {
		const result = await checkSimulatorBase(fakeExec(RELEASE, "x86_64"), app(), opts);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("arm64");
	});

	test("another bundle id is refused (pass --bundle-id or fix the build)", async () => {
		const result = await checkSimulatorBase(fakeExec({ ...RELEASE, CFBundleIdentifier: "com.other" }), app(), opts);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("com.other");
	});

	test.each([
		["Example.debug.dylib"],
		["__preview.dylib"],
		["EXDevLauncher.bundle"],
		["EXDevMenu.bundle"],
		["Frameworks/EXDevLauncher.framework"],
		["Frameworks/EXDevMenu.framework"],
	])("a Debug / dev-client build (%s) is refused", async (marker) => {
		const result = await checkSimulatorBase(fakeExec(RELEASE), app([marker]), opts);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain(marker.split("/").pop() ?? marker);
	});

	test("an executable that lost its +x (an upload-artifact zip) is refused with the fix", async () => {
		const path = app();
		chmodSync(join(path, "Example"), 0o644);
		const result = await checkSimulatorBase(fakeExec(RELEASE), path, opts);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("tar");
	});

	test("an unreadable Info.plist is refused", async () => {
		const result = await checkSimulatorBase(fakeExec({}), app(), opts);
		expect(result.success).toBe(false);
	});
});

describe("hostSimulatorArch", () => {
	test("Apple silicon runs arm64 simulators, an Intel Mac x86_64", () => {
		expect(hostSimulatorArch("arm64")).toBe("arm64");
		expect(hostSimulatorArch("x64")).toBe("x86_64");
	});
});

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

/**
 * What `codesign -d --entitlements :-` answers: a signed app's plist, the empty plist of an ad-hoc simulator build
 * (its entitlements are in the linker section), a refusal, or nothing it can read.
 */
type Signature = "entitled" | "empty" | "no-identifier" | "unsigned" | "unreadable";

/** What `otool -X -s __TEXT __entitlements` answers: the section with the identifier, no section, or a failure. */
type Section = "entitled" | "none" | "unreadable";

const ENTITLEMENTS = (body: string) =>
	`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${body}</dict></plist>`;

function codesignAnswer(signature: Signature): ExecResult {
	if (signature === "entitled")
		return ok(ENTITLEMENTS("<key>application-identifier</key><string>X.com.example.app</string>"));
	if (signature === "empty") return ok(ENTITLEMENTS(""));
	if (signature === "no-identifier") return ok(ENTITLEMENTS("<key>get-task-allow</key><true/>"));
	if (signature === "unsigned")
		return { exitCode: 1, stdout: "", stderr: "Example.app: code object is not signed at all" };
	return { exitCode: 1, stdout: "", stderr: "codesign: not found" };
}

/** `text` as otool prints a section on arm64: an address, then little-endian 32-bit words. */
function otoolDump(text: string): string {
	const bytes = Buffer.from(text, "utf8");
	const lines: string[] = [];
	for (let line = 0; line < bytes.length; line += 16) {
		const words: string[] = [];
		for (let word = line; word < Math.min(line + 16, bytes.length); word += 4) {
			const chunk = [...bytes.subarray(word, word + 4)].reverse();
			words.push(chunk.map((b) => b.toString(16).padStart(2, "0")).join(""));
		}
		lines.push(`${(0x100000000 + line).toString(16).padStart(16, "0")}\t${words.join(" ")} `);
	}
	return `${lines.join("\n")}\n`;
}

const SECTION_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>application-identifier</key>
\t<string>FAKETEAMID.com.example.app</string>
</dict>
</plist>
`;

function otoolAnswer(section: Section): ExecResult {
	if (section === "entitled") return ok(otoolDump(SECTION_PLIST));
	if (section === "none") return ok("");
	return { exitCode: 1, stdout: "", stderr: "otool: not found" };
}

/**
 * `plutil -extract <key> raw` over `plist`, `lipo -archs` answering `archs`, `codesign` answering `signature`,
 * `otool` answering `section`.
 */
function fakeExec(plist: Plist, archs = "arm64", signature: Signature = "entitled", section: Section = "none"): Exec {
	return async (cmd) => {
		if (cmd[0] === "codesign") return codesignAnswer(signature);
		if (cmd[0] === "otool") return otoolAnswer(section);

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
			data: {
				bundleId: "com.example.app",
				archs: ["x86_64", "arm64"],
				embeddedBundle: false,
				applicationIdentifier: true,
			},
		});
	});

	test("an embedded main.jsbundle is reported (the import strips it)", async () => {
		const result = await checkSimulatorBase(fakeExec(RELEASE), app(["main.jsbundle"]), opts);
		expect(result.success && result.data.embeddedBundle).toBe(true);
	});

	test.each([
		["unsigned, no section", "unsigned", "none", false],
		["signed without an application-identifier, no section", "no-identifier", "none", false],
		["signed with one", "entitled", "none", true],
		["ad-hoc simulator build: empty signature, identifier in the linker section", "empty", "entitled", true],
		["empty signature, no section", "empty", "none", false],
		["signed without one, otool unreadable", "no-identifier", "unreadable", false],
		["codesign unreadable, identifier in the linker section", "unreadable", "entitled", true],
		["codesign and otool unreadable", "unreadable", "unreadable", undefined],
	] as const)("entitlements: %s → applicationIdentifier %p", async (_name, signature, section, expected) => {
		const result = await checkSimulatorBase(fakeExec(RELEASE, "arm64", signature, section), app(), opts);
		expect(result.success && result.data.applicationIdentifier).toBe(expected);
	});

	test("reads the linker section of the main executable", async () => {
		const calls: (readonly string[])[] = [];
		const exec = fakeExec(RELEASE, "arm64", "empty", "entitled");
		const path = app();
		await checkSimulatorBase(
			async (cmd, o) => {
				calls.push(cmd);
				return exec(cmd, o);
			},
			path,
			opts
		);
		expect(calls).toContainEqual(["otool", "-X", "-s", "__TEXT", "__entitlements", join(path, "Example")]);
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

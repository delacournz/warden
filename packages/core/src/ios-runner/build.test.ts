import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ok } from "@delacour/warden-types/result";
import type { BuildLockDeps } from "../builds/lock";
import type { Exec, ExecOptions, ExecResult } from "../exec";
import { openStore, type Store } from "../store";
import type { Owner } from "../types";
import { buildRunnerArgv, ensureRunnerBuild, expectedRunnerDerivedData } from "./build";
import { readRunnerMeta } from "./cache";
import type { EnsureRunnerBuildInput, RunnerBuildError } from "./runner-build.types";
import { certificatesFromPem, sha1Hex } from "./signing";
import { CERT_TEAM_A, CERT_TEAM_B } from "./signing.testing";

const UDID = "00008140-000A0B0C0D0E0F10";
const TEAM = "LN69P7N673";
const DAY = 24 * 60 * 60 * 1000;
const me: Owner = { kind: "agent", sessionId: "me", cwd: "/" };
const SOURCES = { "ios-runner/WardenRunner.xcodeproj/project.pbxproj": "pbx", "ios-runner/Host/App.swift": "app" };

let dir: string;
let store: Store;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-runner-build-"));
	store = openStore(join(dir, "warden.db"));
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

type XcodebuildBehaviour = (opts: ExecOptions, argv: readonly string[]) => Promise<ExecResult>;

/** Everything the build touches, faked: Xcode's version probes, `security`, and `xcodebuild` (writes products). */
function fakeTools(over: { xcodebuild?: XcodebuildBehaviour; identities?: string; certs?: string } = {}) {
	const calls: string[][] = [];
	const success: XcodebuildBehaviour = async (_opts, argv) => {
		const dd = argv[argv.indexOf("-derivedDataPath") + 1] ?? "";
		const products = join(dd, "Build", "Products");
		mkdirSync(join(products, "Debug-iphoneos", "WardenRunnerHost.app"), { recursive: true });
		writeFileSync(join(products, "Debug-iphoneos", "WardenRunnerHost.app", "embedded.mobileprovision"), "p");
		writeFileSync(join(products, "WardenRunner_iphoneos27.2-arm64.xctestrun"), "<plist/>");
		return { exitCode: 0, stdout: "** TEST BUILD SUCCEEDED **", stderr: "" };
	};
	const text = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
	const respond = (cmd: readonly string[], opts: ExecOptions): Promise<ExecResult> | ExecResult => {
		const key =
			cmd[0] === "security" || cmd[0] === "plutil" ? `${cmd[0]} ${cmd[0] === "plutil" ? cmd[2] : cmd[1]}` : cmd[0];
		switch (key) {
			case "plutil ProductBuildVersion":
				return text("27A9275");
			case "plutil CFBundleShortVersionString":
				return text("27.1");
			case "security find-identity":
				return text(over.identities ?? "");
			case "security find-certificate":
				return text(over.certs ?? "");
			case "security cms":
				return text(`<key>ExpirationDate</key><date>${new Date(clock + 7 * DAY).toISOString()}</date>`);
			case "xcodebuild":
				return (over.xcodebuild ?? success)(opts, cmd);
			default:
				return { exitCode: 127, stdout: "", stderr: `unexpected ${cmd.join(" ")}` };
		}
	};
	const exec: Exec = async (cmd, opts = {}) => {
		calls.push([...cmd]);
		return respond(cmd, opts);
	};
	return { exec, calls, builds: () => calls.filter((c) => c[0] === "xcodebuild") };
}

let clock = 1_800_000_000_000;

function input(
	tools: ReturnType<typeof fakeTools>,
	over: Partial<EnsureRunnerBuildInput> = {}
): EnsureRunnerBuildInput {
	const lock: BuildLockDeps = {
		store,
		owner: me,
		pid: 4242,
		now: () => clock,
		pidAlive: () => false,
		sleep: async (ms) => {
			clock += ms;
		},
	};
	return {
		udid: UDID,
		env: { DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer", WARDEN_IOS_TEAM_ID: TEAM },
		home: dir,
		exec: tools.exec,
		version: "0.7.0",
		loadSources: async () => ok(SOURCES),
		lock,
		now: () => clock,
		lockGraceMs: 10,
		...over,
	};
}

async function failure(p: ReturnType<typeof ensureRunnerBuild>): Promise<RunnerBuildError> {
	const res = await p;
	if (res.success) throw new Error("expected a failure");
	return res.error;
}

describe("buildRunnerArgv", () => {
	test("golden: -destination id= registers the phone; the bundle id goes through WARDEN_RUNNER_BUNDLE_ID", () => {
		expect(
			buildRunnerArgv({
				project: "/h/ios-runner/src/k/ios-runner/WardenRunner.xcodeproj",
				derivedData: "/h/ios-runner/T/B-h/dd",
				udid: UDID,
				team: TEAM,
				bundleId: "nz.co.delacour.warden.runner.ln69p7n673",
			})
		).toEqual([
			"xcodebuild",
			"build-for-testing",
			"-project",
			"/h/ios-runner/src/k/ios-runner/WardenRunner.xcodeproj",
			"-scheme",
			"WardenRunner",
			"-destination",
			`id=${UDID}`,
			"-derivedDataPath",
			"/h/ios-runner/T/B-h/dd",
			"-allowProvisioningUpdates",
			"CODE_SIGN_STYLE=Automatic",
			`DEVELOPMENT_TEAM=${TEAM}`,
			"WARDEN_RUNNER_BUNDLE_ID=nz.co.delacour.warden.runner.ln69p7n673",
		]);
		expect(
			buildRunnerArgv({ project: "p", derivedData: "d", udid: "u", team: TEAM, bundleId: "x" }).some((a) =>
				a.startsWith("PRODUCT_BUNDLE_IDENTIFIER")
			)
		).toBe(false);
	});
});

describe("ensureRunnerBuild", () => {
	test("cold: stages, builds once with the golden argv, records the phone and the profile expiry", async () => {
		const tools = fakeTools();
		const res = await ensureRunnerBuild(input(tools));
		if (!res.success) throw new Error(JSON.stringify(res.error));
		expect(res.data).toMatchObject({
			bundleId: "nz.co.delacour.warden.runner.ln69p7n673",
			team: TEAM,
			teamSource: "env",
			cached: false,
			rebuiltBecause: "none",
		});
		expect(res.data.derivedData).toBe(join(dir, "ios-runner", TEAM, basename(dirname(res.data.derivedData)), "dd"));
		expect(basename(dirname(res.data.derivedData))).toMatch(/^27A9275-[0-9a-f]{10}$/);
		expect(res.data.xctestrun).toBe(
			join(res.data.derivedData, "Build", "Products", "WardenRunner_iphoneos27.2-arm64.xctestrun")
		);
		const argv = tools.builds()[0] ?? [];
		expect(tools.builds()).toHaveLength(1);
		expect(argv.slice(0, 2)).toEqual(["xcodebuild", "build-for-testing"]);
		expect(argv).toContain(`id=${UDID}`);
		expect(argv).toContain(`DEVELOPMENT_TEAM=${TEAM}`);
		expect(argv.find((a) => a.endsWith("WardenRunner.xcodeproj"))).toContain(join(dir, "ios-runner", "src", "0.7.0-"));
		const meta = readRunnerMeta(join(res.data.derivedData, ".."));
		expect(meta).toEqual({
			udids: [UDID],
			profileExpires: clock + 7 * DAY,
			builtAt: clock,
			bundleId: res.data.bundleId,
		});
	});

	test("warm: same phone reuses the build without running xcodebuild", async () => {
		const tools = fakeTools();
		await ensureRunnerBuild(input(tools));
		const again = await ensureRunnerBuild(input(tools));
		expect(again.success && again.data.cached).toBe(true);
		expect(tools.builds()).toHaveLength(1);
	});

	test("a new UDID rebuilds and keeps the earlier phone in the profile list", async () => {
		const tools = fakeTools();
		await ensureRunnerBuild(input(tools));
		const second = await ensureRunnerBuild(input(tools, { udid: "00008110-000A11111111801E" }));
		expect(second.success && second.data.rebuiltBecause).toBe("new_udid");
		expect(tools.builds()).toHaveLength(2);
		const cache = second.success ? join(second.data.derivedData, "..") : "";
		expect(readRunnerMeta(cache)?.udids).toEqual([UDID, "00008110-000A11111111801E"]);
	});

	test("a profile ending within 24 h rebuilds", async () => {
		const tools = fakeTools();
		await ensureRunnerBuild(input(tools));
		clock += 6.5 * DAY;
		const again = await ensureRunnerBuild(input(tools));
		expect(again.success && again.data.rebuiltBecause).toBe("profile_expiring");
		expect(tools.builds()).toHaveLength(2);
	});

	test("changed runner sources get their own cache (no rebuild of the old one)", async () => {
		const tools = fakeTools();
		const a = await ensureRunnerBuild(input(tools));
		const b = await ensureRunnerBuild(
			input(tools, { loadSources: async () => ok({ ...SOURCES, "ios-runner/Host/App.swift": "v2" }) })
		);
		expect(a.success && b.success && a.data.derivedData !== b.data.derivedData).toBe(true);
	});

	test("the configured bundle id is used", async () => {
		const tools = fakeTools();
		const res = await ensureRunnerBuild(input(tools, { configBundleId: "com.me.runner" }));
		expect(res.success && res.data.bundleId).toBe("com.me.runner");
		expect(tools.builds()[0]).toContain("WARDEN_RUNNER_BUNDLE_ID=com.me.runner");
	});

	test("releases the build lease", async () => {
		await ensureRunnerBuild(input(fakeTools()));
		expect(store.listLeases()).toEqual([]);
	});

	test("two teams in the keychain and none chosen: ios_team_ambiguous, nothing built", async () => {
		const [derA, derB] = [certificatesFromPem(CERT_TEAM_A)[0], certificatesFromPem(CERT_TEAM_B)[0]];
		if (!derA || !derB) throw new Error("fixtures");
		const tools = fakeTools({
			identities: `  1) ${sha1Hex(derA)} "Apple Development: A (UA)"\n  2) ${sha1Hex(derB)} "Apple Development: B (UB)"\n`,
			certs: CERT_TEAM_A + CERT_TEAM_B,
		});
		const error = await failure(ensureRunnerBuild(input(tools, { env: { DEVELOPER_DIR: "/x/Contents/Developer" } })));
		expect(error.code).toBe("ios_team_ambiguous");
		expect(tools.builds()).toHaveLength(0);
	});

	test("xcodebuild output is classified; no meta is written", async () => {
		const tools = fakeTools({
			xcodebuild: async () => ({
				exitCode: 65,
				stdout: "",
				stderr: `error: No Account for Team "${TEAM}". Add a new account in Accounts settings.`,
			}),
		});
		const error = await failure(ensureRunnerBuild(input(tools)));
		expect(error.code).toBe("no_account");
		expect(store.listLeases()).toEqual([]);
		expect(await ensureRunnerBuild(input(fakeTools()))).toMatchObject({ success: true });
	});

	test("an unknown failure is build_failed with the output tail", async () => {
		const tools = fakeTools({
			xcodebuild: async () => ({ exitCode: 65, stdout: "line1\nld: symbol(s) not found", stderr: "" }),
		});
		const error = await failure(ensureRunnerBuild(input(tools)));
		expect(error.code).toBe("build_failed");
		expect(error.code === "build_failed" && error.output).toContain("symbol(s) not found");
	});

	test("a phone that stays locked past the grace period stops the build with device_locked", async () => {
		const tools = fakeTools({
			xcodebuild: (opts) =>
				new Promise<ExecResult>((resolve) => {
					opts.onLine?.("Unlock Chris's iPhone to Continue");
					opts.signal?.addEventListener("abort", () => resolve({ exitCode: 143, stdout: "", stderr: "" }));
				}),
		});
		const error = await failure(ensureRunnerBuild(input(tools, { lockGraceMs: 5 })));
		expect(error.code).toBe("device_locked");
		expect(error.message).toContain("Unlock");
	});

	test("a phone unlocked within the grace period builds normally", async () => {
		const base = fakeTools();
		const tools = fakeTools({
			xcodebuild: async (opts, argv) => {
				opts.onLine?.("Unlock Chris's iPhone to Continue");
				return base.exec(argv, opts);
			},
		});
		const res = await ensureRunnerBuild(input(tools, { lockGraceMs: 60_000 }));
		expect(res.success).toBe(true);
	});

	test("success without an xctestrun is build_failed", async () => {
		const tools = fakeTools({ xcodebuild: async () => ({ exitCode: 0, stdout: "", stderr: "" }) });
		expect((await failure(ensureRunnerBuild(input(tools)))).code).toBe("build_failed");
	});

	test("unreadable sources are build_failed", async () => {
		const { err } = await import("@delacour/warden-types/result");
		const error = await failure(ensureRunnerBuild(input(fakeTools(), { loadSources: async () => err("no blob") })));
		expect(error).toMatchObject({ code: "build_failed", message: "no blob" });
	});

	test("readFileSync of the staged project is the embedded text", async () => {
		const res = await ensureRunnerBuild(input(fakeTools()));
		if (!res.success) throw new Error("build");
		const staged = join(dir, "ios-runner", "src");
		const hash = basename(dirname(res.data.derivedData)).split("-")[1];
		expect(readFileSync(join(staged, `0.7.0-${hash}`, "ios-runner/Host/App.swift"), "utf8")).toBe("app");
	});
});

describe("expectedRunnerDerivedData", () => {
	test("names the derived data ensureRunnerBuild uses, without building or staging", async () => {
		const tools = fakeTools();
		const expected = await expectedRunnerDerivedData(input(tools));
		const built = await ensureRunnerBuild(input(tools));
		if (!expected.success || !built.success) throw new Error("expected both to succeed");
		expect(expected.data).toBe(built.data.derivedData);
	});

	test("runs no xcodebuild and writes nothing", async () => {
		const tools = fakeTools();
		const expected = await expectedRunnerDerivedData(input(tools));
		expect(expected.success).toBe(true);
		expect(tools.builds()).toHaveLength(0);
		expect(existsSync(join(dir, "ios-runner", "src"))).toBe(false);
	});

	test("changes with the runner sources, the Xcode build and the team", async () => {
		const tools = fakeTools();
		const base = await expectedRunnerDerivedData(input(tools));
		const edited = await expectedRunnerDerivedData(
			input(tools, { loadSources: async () => ok({ ...SOURCES, "ios-runner/Host/App.swift": "app2" }) })
		);
		const otherTeam = await expectedRunnerDerivedData(
			input(tools, { env: { DEVELOPER_DIR: "/x", WARDEN_IOS_TEAM_ID: "ABCDE12345" } })
		);
		if (!base.success || !edited.success || !otherTeam.success) throw new Error("expected success");
		expect(edited.data).not.toBe(base.data);
		expect(otherTeam.data).not.toBe(base.data);
	});

	test("a source set without the project fails like the build", async () => {
		const res = await expectedRunnerDerivedData(input(fakeTools(), { loadSources: async () => ok({ a: "b" }) }));
		expect(res.success).toBe(false);
	});
});

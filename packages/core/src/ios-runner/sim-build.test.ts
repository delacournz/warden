import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@delacour/warden-types/result";
import type { Exec, ExecResult } from "../exec";
import { buildSimRunnerArgv, ensureSimRunnerBuild } from "./sim-build";

const SOURCES = { "ios-runner/WardenRunner.xcodeproj/project.pbxproj": "pbx", "ios-runner/Host/App.swift": "app" };
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-sim-runner-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function tools(options: { fail?: boolean; noXctestrun?: boolean } = {}) {
	const calls: string[][] = [];
	const text = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
	const exec: Exec = async (cmd) => {
		calls.push([...cmd]);
		if (cmd[0] === "plutil") return text(cmd[2] === "ProductBuildVersion" ? "27A9275" : "27.1");
		if (cmd[0] === "xcodebuild") {
			if (options.fail) return { exitCode: 65, stdout: "", stderr: "error: boom" };
			if (!options.noXctestrun) {
				const products = join(cmd[cmd.indexOf("-derivedDataPath") + 1] ?? "", "Build", "Products");
				mkdirSync(products, { recursive: true });
				writeFileSync(join(products, "WardenRunner_iphonesimulator27.2-arm64.xctestrun"), "<plist/>");
			}
			return text("** TEST BUILD SUCCEEDED **");
		}
		return { exitCode: 127, stdout: "", stderr: `unexpected ${cmd.join(" ")}` };
	};
	return { exec, builds: () => calls.filter((c) => c[0] === "xcodebuild") };
}

const input = (exec: Exec) => ({
	env: { DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
	exec,
	version: "9.9.9",
	home: dir,
	loadSources: async () => ok(SOURCES),
});

describe("buildSimRunnerArgv", () => {
	test("builds for the generic simulator destination without signing or a team", () => {
		const argv = buildSimRunnerArgv({ project: "/p/WardenRunner.xcodeproj", derivedData: "/dd" });
		expect(argv).toContain("generic/platform=iOS Simulator");
		expect(argv).toContain("CODE_SIGNING_ALLOWED=NO");
		expect(argv).toContain("DEVELOPMENT_TEAM=");
		expect(argv.join(" ")).not.toContain("allowProvisioningUpdates");
	});
});

describe("ensureSimRunnerBuild", () => {
	test("builds once, then serves the cache for the same Xcode and sources", async () => {
		const t = tools();
		const first = await ensureSimRunnerBuild(input(t.exec));
		expect(first.success && first.data.cached).toBe(false);
		const second = await ensureSimRunnerBuild(input(t.exec));
		expect(second.success && second.data.cached).toBe(true);
		expect(t.builds()).toHaveLength(1);
		if (first.success && second.success) expect(second.data.xctestrun).toBe(first.data.xctestrun);
	});

	test("a changed runner source is a new cache directory and a rebuild", async () => {
		const t = tools();
		await ensureSimRunnerBuild(input(t.exec));
		await ensureSimRunnerBuild({
			...input(t.exec),
			loadSources: async () => ok({ ...SOURCES, "ios-runner/Host/App.swift": "app2" }),
		});
		expect(t.builds()).toHaveLength(2);
	});

	test("a failed build is an error carrying the output, and leaves no cache hit", async () => {
		const failing = await ensureSimRunnerBuild(input(tools({ fail: true }).exec));
		expect(failing.success).toBe(false);
		if (!failing.success) expect(failing.error).toContain("boom");
		const t = tools();
		const after = await ensureSimRunnerBuild(input(t.exec));
		expect(after.success && after.data.cached).toBe(false);
	});

	test("a build that wrote no xctestrun is an error", async () => {
		const res = await ensureSimRunnerBuild(input(tools({ noXctestrun: true }).exec));
		expect(res.success).toBe(false);
	});
});

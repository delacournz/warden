import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Exec, ExecOptions } from "@delacour/warden-core/exec";
import { cacheGroups, DEFAULT_JS_INPUTS, jsInputsHash, runnerTag } from "./ci-cache";

describe("runnerTag", () => {
	test("GitHub's RUNNER_OS-RUNNER_ARCH when both are set", () => {
		expect(runnerTag({ RUNNER_OS: "macOS", RUNNER_ARCH: "ARM64" }, "darwin", "arm64")).toBe("macOS-ARM64");
	});

	test("else the host, spelled the way GitHub spells it", () => {
		expect(runnerTag({}, "darwin", "arm64")).toBe("macOS-ARM64");
		expect(runnerTag({}, "darwin", "x64")).toBe("macOS-X64");
		expect(runnerTag({ RUNNER_OS: "macOS" }, "linux", "x64")).toBe("Linux-X64");
	});
});

describe("jsInputsHash", () => {
	const listing = "100644 abc 0\tsrc/app.tsx\n100644 def 0\tpackage.json\n";

	test("sha256 of `git ls-files -s -- <specs>` in the project, first 16 hex chars", async () => {
		const calls: { cmd: readonly string[]; opts: ExecOptions | undefined }[] = [];
		const exec: Exec = async (cmd, opts) => {
			calls.push({ cmd, opts });
			return { exitCode: 0, stdout: listing, stderr: "" };
		};
		const hash = await jsInputsHash(exec, "/repo/app", ["src", "package.json"]);
		expect(hash).toEqual({ success: true, data: createHash("sha256").update(listing).digest("hex").slice(0, 16) });
		expect(calls).toEqual([
			{ cmd: ["git", "ls-files", "-s", "--", "src", "package.json"], opts: { cwd: "/repo/app" } },
		]);
	});

	test("a failed git is an error naming it", async () => {
		const exec: Exec = async () => ({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository" });
		const hash = await jsInputsHash(exec, "/tmp/x", DEFAULT_JS_INPUTS);
		expect(hash.success).toBe(false);
		if (!hash.success) expect(hash.error).toContain("not a git repository");
	});
});

describe("cacheGroups", () => {
	const groups = cacheGroups({
		prefix: "warden-e2e-v1",
		runner: "macOS-ARM64",
		nativeFingerprint: "f1b4",
		js: "0647",
		golden: "warden-golden-iphone-17-645b28cbef-r2",
		wardenHome: "/Users/runner/.warden",
		goldenDir: "/Users/runner/warden-goldens",
	});

	test("ccache: warden's shared compiler cache, keyed by the native fingerprint, restorable from any older one", () => {
		expect(groups.ccache).toEqual({
			kind: "paths",
			key: "warden-e2e-v1-ccache-macOS-ARM64-f1b4",
			restoreKeys: ["warden-e2e-v1-ccache-macOS-ARM64-"],
			paths: ["/Users/runner/.warden/ccache"],
		});
	});

	test("builds: the builds dir minus the repacks, keyed by the native fingerprint", () => {
		expect(groups.builds).toEqual({
			kind: "paths",
			key: "warden-e2e-v1-builds-macOS-ARM64-f1b4",
			paths: ["/Users/runner/.warden/builds", "!/Users/runner/.warden/builds/*/ios/*/simulator/repacks"],
		});
	});

	test("repack: only the repacks, keyed by the native fingerprint and the JS inputs", () => {
		expect(groups.repack).toEqual({
			kind: "paths",
			key: "warden-e2e-v1-repack-macOS-ARM64-f1b4-0647",
			paths: ["/Users/runner/.warden/builds/*/ios/*/simulator/repacks"],
		});
	});

	test("golden: an archive dir with the commands to run around it", () => {
		expect(groups.golden).toEqual({
			kind: "archive",
			key: "warden-e2e-v1-macOS-ARM64-warden-golden-iphone-17-645b28cbef-r2",
			paths: ["/Users/runner/warden-goldens"],
			afterRestore: "warden golden import /Users/runner/warden-goldens",
			beforeSave: "warden golden export /Users/runner/warden-goldens --allow-unsettled",
		});
	});

	test("a profile is carried into the export command", () => {
		const withProfile = cacheGroups({
			prefix: "p",
			runner: "r",
			nativeFingerprint: "f",
			js: "j",
			golden: "g",
			wardenHome: "/h",
			goldenDir: "/g dir",
			profile: "ipad-air",
		});
		expect(withProfile.golden.beforeSave).toBe("warden golden export '/g dir' --allow-unsettled --profile ipad-air");
		expect(withProfile.golden.afterRestore).toBe("warden golden import '/g dir'");
	});
});

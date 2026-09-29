import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../exec";
import { fakeApp, testProject } from "./builds.testing";
import { artifactCandidates, locateArtifact, runLocalBuild } from "./local";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-local-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SIM = join("Build", "Products", "Debug-iphonesimulator");

function age(path: string, secondsAgo: number): void {
	const t = Date.now() / 1000 - secondsAgo;
	utimesSync(path, t, t);
}

describe("locateArtifact", () => {
	test("iOS: newest .app across ios/build and DerivedData, after the build start", () => {
		const root = join(dir, "app");
		const dd = join(dir, "DerivedData");
		const old = fakeApp(join(dd, "Other-abc", SIM), "Other.app");
		const fresh = fakeApp(join(dd, "App-xyz", SIM), "App.app");
		const local = fakeApp(join(root, "ios", "build", SIM), "Local.app");
		age(old, 3600);
		age(local, 60);
		age(fresh, 5);
		expect(artifactCandidates(root, "ios", dd).sort()).toEqual([fresh, local, old].sort());
		expect(locateArtifact(root, "ios", dd, Date.now() - 120_000)).toBe(fresh);
		expect(locateArtifact(root, "ios", dd, Date.now() + 60_000)).toBeUndefined();
	});

	test("Android: .apk under android/app/build/outputs/apk", () => {
		const out = join(dir, "android", "app", "build", "outputs", "apk", "debug");
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, "app-debug.apk"), "apk");
		expect(locateArtifact(dir, "android", join(dir, "dd"), 0)).toBe(join(out, "app-debug.apk"));
	});
});

describe("runLocalBuild", () => {
	function setup(fingerprints: string[]) {
		const root = join(dir, "app");
		const out = join(root, "android", "app", "build", "outputs", "apk", "debug");
		const calls: string[] = [];
		const exec: Exec = async (cmd, opts) => {
			calls.push(`${opts?.cwd} ${cmd.join(" ")}`);
			if (cmd[2] === "gradle-build") {
				mkdirSync(out, { recursive: true });
				writeFileSync(join(out, "app-debug.apk"), "apk");
				return { exitCode: 0, stdout: "", stderr: "" };
			}
			if (cmd[2] === "fp") return { exitCode: 0, stdout: `{"hash":"${fingerprints.shift()}"}`, stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "BUILD FAILED" };
		};
		const project = testProject({
			root,
			fingerprintCommand: "fp",
			build: { ios: "xcode-fail", android: "gradle-build" },
		});
		return { root, out, calls, exec, project };
	}
	const base = { env: { HOME: "/nope" }, now: () => Date.now(), log: () => {} };

	test("builds, locates, verifies the fingerprint", async () => {
		const s = setup(["h1"]);
		const res = await runLocalBuild({ ...base, exec: s.exec, project: s.project, platform: "android", hash: "h1" });
		expect(res).toEqual({ success: true, data: join(s.out, "app-debug.apk") });
		expect(s.calls[0]).toBe(`${s.root} sh -c gradle-build`);
	});

	test("fingerprint changed during build → error", async () => {
		const s = setup(["h2"]);
		const res = await runLocalBuild({ ...base, exec: s.exec, project: s.project, platform: "android", hash: "h1" });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("fingerprint changed");
	});

	test("build command fails → error", async () => {
		const s = setup([]);
		const res = await runLocalBuild({ ...base, exec: s.exec, project: s.project, platform: "ios", hash: "h1" });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("BUILD FAILED");
	});
});

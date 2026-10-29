import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@delacour/warden-types/result";
import { collectRunnerSources, isSafeSourcePath, loadEmbeddedRunnerSources, parseRunnerBlob } from "./pack";
import { runnerSourceHash, stageRunnerSources } from "./stage";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "warden-stage-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const FILES = {
	"ios-runner/WardenRunner.xcodeproj/project.pbxproj": "pbx",
	"ios-runner/Host/App.swift": "app",
	"ios/Sources/warden-simd/Protocol/Wire.swift": "wire",
};

describe("stageRunnerSources", () => {
	test("writes the tree under src/<version>-<hash> with a ready marker", async () => {
		const staged = await stageRunnerSources({ home, version: "1.2.3", loadSources: async () => ok(FILES) });
		if (!staged.success) throw new Error(staged.error);
		expect(staged.data.dir).toBe(join(home, "ios-runner", "src", `1.2.3-${runnerSourceHash(FILES)}`));
		expect(staged.data.project).toBe(join(staged.data.dir, "ios-runner", "WardenRunner.xcodeproj"));
		expect(readFileSync(join(staged.data.dir, "ios/Sources/warden-simd/Protocol/Wire.swift"), "utf8")).toBe("wire");
		expect(existsSync(join(staged.data.dir, ".ready"))).toBe(true);
	});

	test("the same sources reuse the copy; changed sources get their own", async () => {
		const a = await stageRunnerSources({ home, version: "1", loadSources: async () => ok(FILES) });
		const again = await stageRunnerSources({ home, version: "1", loadSources: async () => ok(FILES) });
		const changed = await stageRunnerSources({
			home,
			version: "1",
			loadSources: async () => ok({ ...FILES, "ios-runner/Host/App.swift": "app2" }),
		});
		expect(a.success && again.success && changed.success).toBe(true);
		if (a.success && again.success && changed.success) {
			expect(again.data.dir).toBe(a.data.dir);
			expect(changed.data.dir).not.toBe(a.data.dir);
			expect(existsSync(join(a.data.dir, "ios-runner/Host/App.swift"))).toBe(true);
		}
	});

	test("a copy without the marker (crashed run) is rewritten", async () => {
		const a = await stageRunnerSources({ home, version: "1", loadSources: async () => ok(FILES) });
		if (!a.success) throw new Error(a.error);
		rmSync(join(a.data.dir, ".ready"));
		rmSync(join(a.data.dir, "ios-runner/Host/App.swift"));
		const b = await stageRunnerSources({ home, version: "1", loadSources: async () => ok(FILES) });
		expect(b.success).toBe(true);
		expect(existsSync(join(a.data.dir, "ios-runner/Host/App.swift"))).toBe(true);
	});

	test("refuses paths that leave the directory, and sources without a project", async () => {
		const outside = await stageRunnerSources({
			home,
			version: "1",
			loadSources: async () => ok({ ...FILES, "../evil": "x" }),
		});
		expect(outside.success).toBe(false);
		const noProject = await stageRunnerSources({ home, version: "1", loadSources: async () => ok({ a: "b" }) });
		expect(!noProject.success && noProject.error).toContain("project.pbxproj");
	});

	test("a failing loader is passed through", async () => {
		const got = await stageRunnerSources({ home, version: "1", loadSources: async () => err("no blob") });
		expect(got).toEqual({ success: false, error: "no blob" });
	});
});

describe("blob", () => {
	test("parseRunnerBlob checks shape and paths", () => {
		expect(parseRunnerBlob(JSON.stringify(FILES)).success).toBe(true);
		expect(parseRunnerBlob("nope").success).toBe(false);
		expect(parseRunnerBlob("[]").success).toBe(false);
		expect(parseRunnerBlob(JSON.stringify({ a: 1 })).success).toBe(false);
		expect(parseRunnerBlob(JSON.stringify({ "../x": "y" })).success).toBe(false);
	});

	test("isSafeSourcePath", () => {
		expect(isSafeSourcePath("ios-runner/Host/App.swift")).toBe(true);
		for (const bad of ["", "/abs", "a/../b", "a//b", "a\\b", "./a"]) expect(isSafeSourcePath(bad)).toBe(false);
	});

	test("loadEmbeddedRunnerSources finds the hashed blob name", async () => {
		const blob = Object.assign(new Blob([JSON.stringify(FILES)]), { name: "ios-runner-abc123.bin" });
		expect((await loadEmbeddedRunnerSources([blob])).success).toBe(true);
		expect((await loadEmbeddedRunnerSources([])).success).toBe(false);
	});
});

describe("collectRunnerSources (this checkout)", () => {
	const native = join(import.meta.dir, "..", "..", "..", "e2e", "native");
	const collected = collectRunnerSources(native);

	test("has the project, host, tests, core sources and the shared simd files, none of the symlinks", () => {
		if (!collected.success) throw new Error(collected.error);
		const names = Object.keys(collected.data);
		for (const must of [
			"ios-runner/WardenRunner.xcodeproj/project.pbxproj",
			"ios-runner/Host/WardenRunnerHostApp.swift",
			"ios-runner/RunnerTests/RunnerTests.swift",
			"ios-runner/RunnerCore/Sources/RunnerCore/Router.swift",
			"ios/Sources/warden-simd/Protocol/Wire.swift",
			"ios/Sources/warden-simd/Model/RoleMap.swift",
		]) {
			expect(names).toContain(must);
		}
		expect(names.some((n) => n.includes("/Shared/"))).toBe(false);
		expect(names.some((n) => n.includes("xcuserdata") || n.includes("/Tests/"))).toBe(false);
	});

	test("every .swift file the checked-in project compiles is in the set", () => {
		if (!collected.success) throw new Error(collected.error);
		const have = new Set(Object.keys(collected.data).map((n) => n.split("/").pop()));
		const pbx = collected.data["ios-runner/WardenRunner.xcodeproj/project.pbxproj"] ?? "";
		const referenced = [...pbx.matchAll(/path = ([A-Za-z]+\.swift);/g)].map((m) => m[1]);
		expect(referenced.length).toBeGreaterThan(10);
		for (const file of referenced) expect(have.has(file)).toBe(true);
	});
});

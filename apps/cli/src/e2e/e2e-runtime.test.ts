import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { err, ok } from "@delacour/warden-types/result";
import {
	loadEmbeddedRuntime,
	parseRuntime,
	RUNTIME_FALLBACK_PRELOAD,
	readE2ePackageVersion,
	runtimeDir,
	selectPreload,
	stageRuntime,
} from "./e2e-runtime";

const FILES = { "index.mjs": "export const hello = 1;\n", "preload.mjs": "globalThis.__pre = 1;\n" };

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "warden-e2e-runtime-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("parseRuntime", () => {
	test("a JSON object of name → text", () => {
		expect(parseRuntime(JSON.stringify(FILES))).toEqual({ success: true, data: FILES });
	});

	test("rejects non-objects, non-string values and paths that leave the directory", () => {
		expect(parseRuntime("[]").success).toBe(false);
		expect(parseRuntime(JSON.stringify({ "index.mjs": 1 })).success).toBe(false);
		expect(parseRuntime(JSON.stringify({ "../x.mjs": "" })).success).toBe(false);
		expect(parseRuntime(JSON.stringify({ "a/b.mjs": "" })).success).toBe(false);
		expect(parseRuntime("not json").success).toBe(false);
	});
});

describe("stageRuntime", () => {
	test("writes the files, the fallback preload and the marker under <home>/e2e-runtime/<version>", async () => {
		const staged = await stageRuntime({ home, version: "1.2.3", keyed: "release", load: async () => ok(FILES) });
		const dir = runtimeDir(home, "1.2.3");
		expect(staged).toEqual({ success: true, data: join(dir, RUNTIME_FALLBACK_PRELOAD) });
		expect(readFileSync(join(dir, "index.mjs"), "utf8")).toBe(FILES["index.mjs"]);
		expect(existsSync(join(dir, RUNTIME_FALLBACK_PRELOAD))).toBe(true);
		expect(existsSync(join(dir, ".ready"))).toBe(true);
	});

	test("reuse: an existing ready copy is not loaded again", async () => {
		let loads = 0;
		const load = async () => {
			loads += 1;
			return ok(FILES);
		};
		await stageRuntime({ home, version: "1.2.3", keyed: "release", load });
		await stageRuntime({ home, version: "1.2.3", keyed: "release", load });
		expect(loads).toBe(1);
	});

	test("content-keyed (local / dev builds): changed files land in a new dir, the old one stays intact", async () => {
		const first = await stageRuntime({ home, version: "1.2.3", keyed: "content", load: async () => ok(FILES) });
		const changed = { "index.mjs": "export const hello = 2;\n", "preload.mjs": "" };
		const second = await stageRuntime({ home, version: "1.2.3", keyed: "content", load: async () => ok(changed) });
		const again = await stageRuntime({ home, version: "1.2.3", keyed: "content", load: async () => ok(FILES) });
		expect(first.success && second.success && again.success).toBe(true);
		if (!first.success || !second.success || !again.success) return;
		expect(second.data).not.toBe(first.data);
		expect(again.data).toBe(first.data);
		expect(readFileSync(join(dirname(first.data), "index.mjs"), "utf8")).toBe(FILES["index.mjs"]);
		expect(readFileSync(join(dirname(second.data), "index.mjs"), "utf8")).toContain("2");
	});

	test("a half-written copy (no marker) is replaced", async () => {
		const dir = runtimeDir(home, "1.2.3");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "index.mjs"), "stale");
		const staged = await stageRuntime({ home, version: "1.2.3", keyed: "release", load: async () => ok(FILES) });
		expect(staged.success).toBe(true);
		expect(readFileSync(join(dir, "index.mjs"), "utf8")).toBe(FILES["index.mjs"]);
	});

	test("a load failure is the error and leaves no copy behind", async () => {
		const staged = await stageRuntime({ home, version: "1.2.3", keyed: "release", load: async () => err("no bundle") });
		expect(staged).toEqual({ success: false, error: "no bundle" });
		expect(existsSync(runtimeDir(home, "1.2.3"))).toBe(false);
	});

	test("a bundle without index.mjs + preload.mjs is refused", async () => {
		const staged = await stageRuntime({
			home,
			version: "1.2.3",
			keyed: "release",
			load: async () => ok({ "x.mjs": "" }),
		});
		expect(staged.success).toBe(false);
	});

	test("the fallback preload maps @delacour/warden-e2e to the copy's index.mjs, then loads its preload.mjs", async () => {
		await stageRuntime({ home, version: "1.2.3", keyed: "release", load: async () => ok(FILES) });
		const text = readFileSync(join(runtimeDir(home, "1.2.3"), RUNTIME_FALLBACK_PRELOAD), "utf8");
		expect(text).toContain('"@delacour/warden-e2e"');
		expect(text).toContain("index.mjs");
		expect(text).toContain("preload.mjs");
	});
});

describe("loadEmbeddedRuntime", () => {
	test("reads the embedded blob by its hashed name", async () => {
		const blob = new File([JSON.stringify(FILES)], "e2e-runtime-dwdzq42g.bin");
		expect(await loadEmbeddedRuntime([new File(["x"], "other.bin"), blob])).toEqual({ success: true, data: FILES });
	});

	test("no blob (a build without the runtime): an error saying how to get the package", async () => {
		const loaded = await loadEmbeddedRuntime([]);
		expect(loaded.success).toBe(false);
		if (!loaded.success) expect(loaded.error).toContain("bun add -d @delacour/warden-e2e");
	});
});

describe("selectPreload", () => {
	const base = {
		cwd: "/repo/app",
		version: "1.2.3",
		stage: async () => ok("/home/e2e-runtime/1.2.3/fallback-preload.mjs"),
	};

	test("no repo dep: the bundled copy", async () => {
		const picked = await selectPreload({
			...base,
			resolve: () => {
				throw new Error("Cannot find package");
			},
			readVersion: () => undefined,
		});
		expect(picked).toEqual({
			success: true,
			data: { path: "/home/e2e-runtime/1.2.3/fallback-preload.mjs", source: "bundled" },
		});
	});

	test("repo dep at warden's version wins; nothing is staged", async () => {
		let staged = 0;
		const picked = await selectPreload({
			...base,
			stage: async () => {
				staged += 1;
				return ok("/x");
			},
			resolve: () => "/repo/node_modules/@delacour/warden-e2e/preload.mjs",
			readVersion: () => "1.2.3",
		});
		expect(picked).toEqual({
			success: true,
			data: { path: "/repo/node_modules/@delacour/warden-e2e/preload.mjs", source: "repo" },
		});
		expect(staged).toBe(0);
	});

	test("repo dep from the workspace sources (no published version): repo wins", async () => {
		const picked = await selectPreload({
			...base,
			resolve: () => "/ws/packages/e2e/src/preload.ts",
			readVersion: () => undefined,
		});
		expect(picked).toEqual({ success: true, data: { path: "/ws/packages/e2e/src/preload.ts", source: "repo" } });
	});

	test("repo dep at another version: a clear error naming both and both ways out", async () => {
		const picked = await selectPreload({
			...base,
			resolve: () => "/repo/node_modules/@delacour/warden-e2e/preload.mjs",
			readVersion: () => "1.0.0",
		});
		expect(picked.success).toBe(false);
		if (picked.success) return;
		expect(picked.error).toContain("1.0.0");
		expect(picked.error).toContain("1.2.3");
		expect(picked.error).toContain("bun add -d @delacour/warden-e2e@1.2.3");
		expect(picked.error).toContain("remove");
	});

	test("a staging failure is the error", async () => {
		const picked = await selectPreload({
			...base,
			stage: async () => err("disk full"),
			resolve: () => {
				throw new Error("nope");
			},
			readVersion: () => undefined,
		});
		expect(picked).toEqual({ success: false, error: "disk full" });
	});
});

describe("readE2ePackageVersion", () => {
	function pkg(dir: string, manifest: Record<string, unknown>): string {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
		const preload = join(dir, "preload.mjs");
		writeFileSync(preload, "");
		return preload;
	}

	test("the version of the published @delacour/warden-e2e that owns the file", () => {
		const preload = pkg(join(home, "node_modules/@delacour/warden-e2e"), {
			name: "@delacour/warden-e2e",
			version: "1.2.3",
		});
		expect(readE2ePackageVersion(preload)).toBe("1.2.3");
	});

	test("the private workspace package has no published version", () => {
		const preload = pkg(join(home, "packages/e2e"), { name: "@delacour/warden-e2e", version: "0.1.1", private: true });
		expect(readE2ePackageVersion(preload)).toBeUndefined();
	});

	test("unreadable or another package: undefined", () => {
		expect(readE2ePackageVersion(join(home, "missing/preload.mjs"))).toBeUndefined();
		const other = pkg(join(home, "other"), { name: "something-else", version: "9.9.9" });
		expect(readE2ePackageVersion(other)).toBeUndefined();
	});
});

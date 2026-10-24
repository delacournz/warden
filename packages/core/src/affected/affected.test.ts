import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec, type Exec } from "../exec";
import { createGitFactsCache } from "../git-facts";
import { computeAffected, findSuite } from "./affected";
import { DEV_MENU_OFF_ARGS } from "./affected.defaults";
import { makeSuiteRepo } from "./fixture.testing";

const SNAPSHOT = /^[0-9a-f]{40}-[0-9a-f]{16}\.json$/;

let dir: string;
let write: (path: string, text: string) => void;

beforeEach(async () => {
	({ dir, write } = await makeSuiteRepo());
});
const cleanup: string[] = [];
afterEach(() => {
	for (const path of [dir, ...cleanup.splice(0)]) rmSync(path, { recursive: true, force: true });
});

describe("computeAffected", () => {
	test("git changes vs base → selection for the suite's platform; imports cached to disk", async () => {
		write("src/settings/form.tsx", "export const changed = 1;\n");
		const cacheDir = join(dir, ".cache");
		const res = await computeAffected({ exec: bunExec, cwd: join(dir, "src"), cacheDir });
		if (!res.success) throw new Error(res.error);
		expect(res.data.suite.name).toBe("mobile");
		expect(res.data.base).toBe("main");
		expect(res.data.changes).toEqual([{ path: "src/settings/form.tsx", status: "modified" }]);
		expect(res.data.selections.map((s) => s.platform)).toEqual(["ios"]);
		expect(res.data.selections[0]?.selected.map((f) => f.id)).toEqual(["settings"]);
		const cached = readdirSync(cacheDir);
		expect(cached).toHaveLength(2);
		expect(cached.filter((f) => SNAPSHOT.test(f))).toHaveLength(1);
	});

	test("the same repo state again reads the graph snapshot: no worker runs, same selection", async () => {
		write("src/settings/form.tsx", "export const changed = 1;\n");
		const cacheDir = mkdtempSync(join(tmpdir(), "warden-affected-cache-"));
		cleanup.push(cacheDir);
		const workers: string[][] = [];
		const exec: Exec = (cmd, opts) => {
			if (cmd[0] !== "git") workers.push([...cmd]);
			return bunExec(cmd, opts);
		};
		const first = await computeAffected({ exec, cwd: join(dir, "src"), cacheDir });
		const again = await computeAffected({ exec, cwd: join(dir, "src"), cacheDir });
		if (!first.success || !again.success) throw new Error("computeAffected failed");
		expect(workers).toHaveLength(1);
		expect(again.data.selections).toEqual(first.data.selections);
		expect(again.data.warnings).toEqual([]);
		write("src/settings/form.tsx", "export const changed = 2;\n");
		await computeAffected({ exec, cwd: join(dir, "src"), cacheDir });
		expect(workers).toHaveLength(2);
	});

	test("a suite in a subdirectory of the repo still sees its untracked files", async () => {
		const outer = realpathSync(mkdtempSync(join(tmpdir(), "warden-affected-outer-")));
		cleanup.push(outer);
		rmSync(join(dir, ".git"), { recursive: true, force: true });
		mkdirSync(join(outer, "apps"));
		const app = join(outer, "apps", "mobile");
		renameSync(dir, app);
		for (const args of [
			["init", "-q", "-b", "main"],
			["config", "user.email", "t@t"],
			["config", "user.name", "t"],
			["add", "."],
			["commit", "-qm", "base"],
			["checkout", "-qb", "feature"],
		]) {
			const res = Bun.spawnSync(["git", ...args], { cwd: outer });
			if (res.exitCode !== 0) throw new Error(res.stderr.toString());
		}
		writeFileSync(join(app, "src/settings/extra.tsx"), "export {};\n");
		const res = await computeAffected({ exec: bunExec, cwd: join(app, "src") });
		if (!res.success) throw new Error(res.error);
		expect(res.data.changes).toEqual([{ path: "src/settings/extra.tsx", status: "added" }]);
	});

	test("--files instead of git, relative to cwd", async () => {
		const res = await computeAffected({ exec: bunExec, cwd: join(dir, "src"), files: ["chat/lazy.tsx"] });
		if (!res.success) throw new Error(res.error);
		expect(res.data.base).toBeUndefined();
		expect(res.data.selections[0]?.selected.map((f) => f.id)).toEqual(["chats"]);
	});

	test("a diff run in a project without typescript: a clear error naming the fix", async () => {
		write("src/settings/form.tsx", "export const changed = 1;\n");
		const res = await computeAffected({ exec: bunExec, cwd: join(dir, "src"), typescript: () => undefined });
		expect(res.success).toBe(false);
		if (res.success) return;
		expect(res.error).toStartWith("needs typescript in the analysed project: add it as a devDependency");
		expect(res.error).toContain(`node_modules/typescript from ${dir}`);
	});

	test("a diff run whose typescript is older than 5.0: the version and path, before any walk (cli-size-R1)", async () => {
		write("src/settings/form.tsx", "export const changed = 1;\n");
		write("node_modules/typescript/package.json", JSON.stringify({ name: "typescript", version: "4.9.5" }));
		write("node_modules/typescript/index.js", "module.exports = {};\n");
		const entry = join(dir, "node_modules/typescript/index.js");
		const res = await computeAffected({ exec: bunExec, cwd: join(dir, "src"), typescript: () => entry });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain(`typescript 4.9.5 at ${entry}`);
	});

	test("no typescript is fine when no graph is needed (--only)", async () => {
		const res = await computeAffected({ exec: bunExec, cwd: dir, only: { mode: "all" }, typescript: () => undefined });
		expect(res.success).toBe(true);
	});

	test("unknown suite", async () => {
		const res = await computeAffected({ exec: bunExec, cwd: dir, suite: "web" });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain('no e2e suite "web"');
	});

	test("suite.headless: the suite's own, else the top-level default", async () => {
		const top = await makeSuiteRepo({}, { headless: true });
		const own = await makeSuiteRepo({ headless: false }, { headless: true });
		const none = await makeSuiteRepo();
		try {
			const [a, b, c] = await Promise.all([top, own, none].map((r) => findSuite(bunExec, r.dir)));
			expect(a?.success && a.data.headless).toBe(true);
			expect(b?.success && b.data.headless).toBe(false);
			expect(c?.success && c.data.headless).toBeUndefined();
		} finally {
			for (const r of [top, own, none]) rmSync(r.dir, { recursive: true, force: true });
		}
	});

	test("computeAffected asks git for the toplevel once, through the facts cache (also across calls)", async () => {
		write("src/settings/form.tsx", "export const changed = 1;\n");
		const spawns: string[] = [];
		const exec: Exec = (cmd, opts) => {
			spawns.push(cmd.slice(cmd[0] === "git" ? 1 : 0).join(" "));
			return bunExec(cmd, opts);
		};
		const git = createGitFactsCache();
		for (let i = 0; i < 2; i++) {
			const res = await computeAffected({ exec, cwd: join(dir, "src"), git });
			expect(res.success).toBe(true);
		}
		const facts = "rev-parse --show-toplevel --git-common-dir --symbolic-full-name HEAD";
		expect(spawns.filter((s) => s === facts)).toHaveLength(1);
		expect(spawns.filter((s) => s === "rev-parse --show-toplevel")).toHaveLength(0);
		expect(spawns.filter((s) => s.startsWith("diff "))).toHaveLength(2);
	});

	test("findSuite asks git once per cwd, however often it is called", async () => {
		const spawns: string[] = [];
		const counting: Exec = (cmd, opts) => {
			spawns.push(cmd.join(" "));
			return bunExec(cmd, opts);
		};
		const git = createGitFactsCache();
		for (let i = 0; i < 3; i++) {
			const res = await findSuite(counting, dir, undefined, git);
			expect(res.success).toBe(true);
		}
		expect(spawns).toEqual(["git rev-parse --show-toplevel --git-common-dir --symbolic-full-name HEAD"]);
	});
});

describe("computeAffected without e2e suites (an Expo app with an e2e/ dir)", () => {
	let app: string;
	beforeEach(() => {
		app = mkdtempSync(join(tmpdir(), "warden-default-suite-"));
		writeFileSync(join(app, "app.json"), JSON.stringify({ expo: { slug: "fresh", ios: { bundleIdentifier: "x.y" } } }));
	});
	afterEach(() => rmSync(app, { recursive: true, force: true }));

	test("the default suite: every flow in e2e/, a spec process per device of a 2-sim pool, the dev client on warden's Metro", async () => {
		mkdirSync(join(app, "e2e/helpers"), { recursive: true });
		writeFileSync(join(app, "e2e/a.e2e.ts"), "export {};\n");
		writeFileSync(join(app, "e2e/b.e2e.ts"), "export {};\n");
		writeFileSync(join(app, "e2e/helpers/ids.ts"), "export {};\n");
		const res = await computeAffected({ exec: bunExec, cwd: join(app, "e2e") });
		if (!res.success) throw new Error(res.error);
		const { suite } = res.data;
		expect(suite).toMatchObject({ name: "fresh", implicit: true, configDir: app, cwd: app, projectRoot: app });
		expect(suite.config).toMatchObject({
			flowsDir: "e2e",
			isolate: "device",
			platform: "ios",
			count: 2,
			app: true,
			metro: { enabled: true, open: true, launchArgs: DEV_MENU_OFF_ARGS },
		});
		expect(res.data.base).toBeUndefined();
		expect(res.data.selections.map((s) => s.platform)).toEqual(["ios"]);
		expect(res.data.selections[0]?.selected.map((f) => f.id)).toEqual(["a", "b"]);
	});

	test("the default suite is iOS unless asked: platform android runs the same flows on Android", async () => {
		mkdirSync(join(app, "e2e"));
		writeFileSync(join(app, "e2e/a.e2e.ts"), "export {};\n");
		const res = await computeAffected({ exec: bunExec, cwd: app, platform: "android" });
		if (!res.success) throw new Error(res.error);
		expect(res.data.selections.map((s) => s.platform)).toEqual(["android"]);
		expect(res.data.selections[0]?.selected.map((f) => f.id)).toEqual(["a"]);
	});

	test("a project with a dev variant installs it", async () => {
		mkdirSync(join(app, "e2e"));
		writeFileSync(
			join(app, "warden.config.json"),
			JSON.stringify({
				projects: [
					{ name: "fresh", bundleId: { ios: "x.y" }, build: { configuration: "Release" }, variants: { dev: {} } },
				],
			})
		);
		const res = await computeAffected({ exec: bunExec, cwd: app });
		if (!res.success) throw new Error(res.error);
		expect(res.data.suite.config.app).toEqual({ variant: "dev" });
	});

	test("the top-level headless applies to the default suite", async () => {
		mkdirSync(join(app, "e2e"));
		writeFileSync(
			join(app, "warden.config.json"),
			JSON.stringify({ headless: true, projects: [{ name: "fresh", bundleId: { ios: "x.y" } }] })
		);
		const res = await computeAffected({ exec: bunExec, cwd: app });
		if (!res.success) throw new Error(res.error);
		expect(res.data.suite).toMatchObject({ implicit: true, headless: true });
	});

	test("no e2e/ dir → an error pointing at warden init", async () => {
		const res = await computeAffected({ exec: bunExec, cwd: app });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("warden init");
	});

	test("a named suite still needs a config", async () => {
		mkdirSync(join(app, "e2e"));
		const res = await computeAffected({ exec: bunExec, cwd: app, suite: "mobile" });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("warden.config.ts");
	});
});

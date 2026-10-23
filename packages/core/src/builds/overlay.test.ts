import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec, type Exec } from "../exec";
import { findWardenConfig, loadProject } from "./config";
import { overlayDir, overlayDirFor, overlayDirUnlessRepoConfig } from "./overlay";

let dir: string;
let home: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-overlay-")));
	home = join(dir, "home");
	env = { WARDEN_HOME: home, HOME: "/home/me" };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(path: string, data: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
}

const config = (name: string, root = ".") => ({
	projects: [{ name, root, bundleId: { ios: `com.x.${name}` } }],
});

async function git(cwd: string, ...args: string[]): Promise<void> {
	const res = await bunExec(["git", ...args], { cwd });
	if (res.exitCode !== 0) throw new Error(res.stderr);
}

describe("overlayDir", () => {
	test("lives under <WARDEN_HOME>/projects", () => {
		expect(overlayDir(env, "github.com/o/r:.")).toStartWith(join(home, "projects"));
	});
});

describe("loadProject with an overlay", () => {
	test("overlay config only: source overlay, root resolves against the checkout", () => {
		const checkout = join(dir, "checkout");
		const overlay = join(home, "projects", "k");
		write(join(checkout, "apps/app/app.json"), { expo: { name: "x" } });
		write(join(overlay, "warden.config.json"), config("app", "apps/app"));
		const res = loadProject({ start: join(checkout, "apps/app"), stopAt: checkout, env, overlayDir: overlay });
		if (!res.success) throw new Error(res.error);
		expect(res.data.source).toBe("overlay");
		expect(res.data.origin).toBe("config");
		expect(res.data.root).toBe(join(checkout, "apps/app"));
	});

	test("repo config wins over the overlay", () => {
		const overlay = join(home, "projects", "k");
		write(join(dir, "warden.config.json"), config("repo"));
		write(join(overlay, "warden.config.json"), config("overlay"));
		const res = loadProject({ start: dir, stopAt: dir, env, overlayDir: overlay });
		if (!res.success) throw new Error(res.error);
		expect(res.data.name).toBe("repo");
		expect(res.data.source).toBe("repo");
	});

	test("no config anywhere: autodetect, source auto (an empty overlay is ignored)", () => {
		write(join(dir, "app.json"), { expo: { slug: "auto", ios: { bundleIdentifier: "com.x.auto" } } });
		const res = loadProject({ start: dir, stopAt: dir, env, overlayDir: join(home, "projects", "none") });
		if (!res.success) throw new Error(res.error);
		expect(res.data.source).toBe("auto");
	});

	test("a config function in the overlay sees the overlay as configDir", () => {
		const overlay = join(home, "projects", "k");
		write(
			join(overlay, "warden.config.js"),
			`module.exports = (ctx) => ({ projects: [{ name: ctx.configDir, bundleId: { ios: "com.x.a" } }] });`
		);
		const found = findWardenConfig(dir, dir, env, overlay);
		if (!found.success) throw new Error(found.error);
		expect(found.data?.dir).toBe(overlay);
		expect(found.data?.rootDir).toBe(dir);
		expect(found.data?.config.projects?.[0]?.name).toBe(overlay);
	});

	test("a broken overlay config is an error, not a silent fallback", () => {
		const overlay = join(home, "projects", "k");
		write(join(overlay, "warden.config.json"), { nope: true });
		expect(findWardenConfig(dir, dir, env, overlay).success).toBe(false);
	});
});

describe("overlayDirFor", () => {
	test("two worktrees of one repo (no remote) share one overlay", async () => {
		const main = join(dir, "main");
		mkdirSync(main);
		await git(main, "init", "-q", "-b", "main");
		await git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i");
		const wt = join(dir, "wt");
		await git(main, "worktree", "add", "-q", wt, "-b", "other");
		const a = await overlayDirFor(bunExec, main, env);
		const b = await overlayDirFor(bunExec, wt, env);
		expect(a).toBeDefined();
		expect(a).toBe(b);
	});

	test("a subdir of the checkout maps to the repo-level overlay", async () => {
		const repo = join(dir, "repo");
		mkdirSync(join(repo, "apps/a"), { recursive: true });
		await git(repo, "init", "-q");
		expect(await overlayDirFor(bunExec, join(repo, "apps/a"), env)).toBe(await overlayDirFor(bunExec, repo, env));
	});

	test("different repos get different overlays", async () => {
		for (const n of ["r1", "r2"]) {
			mkdirSync(join(dir, n));
			await git(join(dir, n), "init", "-q");
		}
		expect(await overlayDirFor(bunExec, join(dir, "r1"), env)).not.toBe(
			await overlayDirFor(bunExec, join(dir, "r2"), env)
		);
	});
});

describe("overlayDirUnlessRepoConfig", () => {
	test("a repo config means no overlay lookup (and no git spawn)", async () => {
		write(join(dir, "warden.config.json"), config("repo"));
		const calls: string[][] = [];
		const exec: Exec = (cmd, opts) => {
			calls.push([...cmd]);
			return bunExec(cmd, opts);
		};
		expect(await overlayDirUnlessRepoConfig(exec, dir, dir, env)).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("no repo config: the overlay dir", async () => {
		mkdirSync(join(dir, "r"));
		await git(join(dir, "r"), "init", "-q");
		expect(await overlayDirUnlessRepoConfig(bunExec, join(dir, "r"), join(dir, "r"), env)).toBe(
			await overlayDirFor(bunExec, join(dir, "r"), env)
		);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bunExec, type Exec } from "../exec";
import { createGitFactsCache } from "../git-facts";
import { computeAffected, findSuite } from "./affected";
import { makeSuiteRepo } from "./fixture.testing";

let dir: string;
let write: (path: string, text: string) => void;

beforeEach(async () => {
	({ dir, write } = await makeSuiteRepo());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
		expect(readdirSync(cacheDir)).toHaveLength(1);
	});

	test("--files instead of git, relative to cwd", async () => {
		const res = await computeAffected({ exec: bunExec, cwd: join(dir, "src"), files: ["chat/lazy.tsx"] });
		if (!res.success) throw new Error(res.error);
		expect(res.data.base).toBeUndefined();
		expect(res.data.selections[0]?.selected.map((f) => f.id)).toEqual(["chats"]);
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

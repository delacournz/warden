import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectContextFor } from "./project-context";
import { fakeExec, type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const FACTS = "git rev-parse --show-toplevel --git-common-dir --symbolic-full-name HEAD";

/** A context whose cwd is a checkout holding `app/` (project `demo`); `calls` records every spawn. */
function setup(calls: string[][]): { c: TestContext; app: string } {
	const c = testContext([]);
	ctx = c;
	const app = join(c.cwd, "app");
	mkdirSync(app, { recursive: true });
	writeFileSync(
		join(c.cwd, "warden.config.json"),
		JSON.stringify({ projects: [{ name: "demo", root: "app", bundleId: { ios: "com.demo" } }] })
	);
	c.exec = fakeExec(
		[
			[FACTS, { stdout: `${c.cwd}\n${c.cwd}/.git\nrefs/heads/main\n` }],
			["git config --get remote.origin.url", { stdout: "git@github.com:o/r.git" }],
		],
		calls
	);
	return { c, app };
}

describe("projectContextFor", () => {
	test("the facts of the start dir and of the project root are read once each; a second lookup spawns none", async () => {
		const calls: string[][] = [];
		const { c } = setup(calls);
		for (let i = 0; i < 2; i++) {
			const res = await projectContextFor(c, { start: c.cwd });
			if (!res.success) throw new Error(res.error);
			expect(res.data.projectKey).toBe("github.com/o/r:app");
		}
		const spawned = calls.map((call) => call.join(" "));
		expect(spawned.filter((line) => line.startsWith("git rev-parse"))).toEqual([FACTS, FACTS]);
	});

	test("facts the command already read (its git cache) cost no rev-parse", async () => {
		const calls: string[][] = [];
		const { c, app } = setup(calls);
		const facts = { toplevel: c.cwd, commonDir: join(c.cwd, ".git"), branch: "main" };
		c.git.store(c.cwd, facts);
		c.git.store(realpathSync(app), facts);
		const res = await projectContextFor(c, { start: c.cwd });
		expect(res.success).toBe(true);
		expect(calls.map((call) => call.join(" ")).filter((line) => line.startsWith("git rev-parse"))).toEqual([]);
	});

	test("the caller's options reach projectContext (variant, bundle id)", async () => {
		const { c } = setup([]);
		const res = await projectContextFor(c, { start: c.cwd, variant: "dev" });
		expect(res.success).toBe(false);
		const optional = await projectContextFor(c, { start: c.cwd, variant: "dev", variantOptional: true });
		expect(optional.success).toBe(true);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL_MD } from "../skill";
import { type TestContext, testContext } from "../testing";
import { createSkillCommand, type SkillDeps } from "./skill";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

type Harness = { deps: SkillDeps; runs: string[][] };

function harness(opts: { which?: Record<string, string>; exitCode?: number } = {}): Harness {
	const which = opts.which ?? { bunx: "/opt/bun/bin/bunx", npx: "/usr/bin/npx" };
	const h: Harness = {
		runs: [],
		deps: {
			which: (cmd) => which[cmd] ?? null,
			runInteractive: async (cmd) => {
				h.runs.push(cmd);
				return opts.exitCode ?? 0;
			},
		},
	};
	return h;
}

describe("warden skill show", () => {
	test("prints the raw SKILL.md (pipe to pbcopy)", async () => {
		ctx = testContext(["show"]);
		expect(await createSkillCommand(harness().deps).run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toBe(SKILL_MD.trimEnd());
		expect(SKILL_MD).toStartWith("---\nname: warden\n");
	});

	test("--json", async () => {
		ctx = testContext(["show", "--json"]);
		expect(await createSkillCommand(harness().deps).run(ctx)).toBe(0);
		expect(JSON.parse(ctx.stdout.join("\n"))).toEqual({ name: "warden", content: SKILL_MD });
	});
});

describe("warden skill install", () => {
	test("default: embedded copy written under WARDEN_HOME, bunx skills add <dir> --skill warden -g", async () => {
		const h = harness();
		ctx = testContext(["install"]);
		expect(await createSkillCommand(h.deps).run(ctx)).toBe(0);
		const dir = join(ctx.env.WARDEN_HOME ?? "", "skill");
		expect(readFileSync(join(dir, "warden", "SKILL.md"), "utf8")).toBe(SKILL_MD);
		expect(h.runs).toEqual([["bunx", "skills", "add", dir, "--skill", "warden", "-g"]]);
	});

	test("--from github installs from the repo (updatable with `skills update`)", async () => {
		const h = harness();
		ctx = testContext(["install", "--from", "github", "--yes", "--agent", "claude-code", "--agent", "codex"]);
		expect(await createSkillCommand(h.deps).run(ctx)).toBe(0);
		expect(h.runs).toEqual([
			[
				"bunx",
				"skills",
				"add",
				"delacournz/warden",
				"--skill",
				"warden",
				"-g",
				"-a",
				"claude-code",
				"-a",
				"codex",
				"-y",
			],
		]);
	});

	test("--project installs into the current project (no -g); --copy passes through", async () => {
		const h = harness();
		ctx = testContext(["install", "--project", "--copy"]);
		expect(await createSkillCommand(h.deps).run(ctx)).toBe(0);
		expect(h.runs[0]).not.toContain("-g");
		expect(h.runs[0]).toContain("--copy");
	});

	test("no bunx → npx --yes", async () => {
		const h = harness({ which: { npx: "/usr/bin/npx" } });
		ctx = testContext(["install"]);
		expect(await createSkillCommand(h.deps).run(ctx)).toBe(0);
		expect(h.runs[0]?.slice(0, 4)).toEqual(["npx", "--yes", "skills", "add"]);
	});

	test("neither bunx nor npx → exit 1 with the manual fallback", async () => {
		const h = harness({ which: {} });
		ctx = testContext(["install"]);
		expect(await createSkillCommand(h.deps).run(ctx)).toBe(1);
		expect(ctx.stderr.join("\n")).toContain("warden skill show");
		expect(h.runs).toEqual([]);
	});

	test("--dry-run prints the command, runs nothing, writes nothing", async () => {
		const h = harness();
		ctx = testContext(["install", "--dry-run"]);
		expect(await createSkillCommand(h.deps).run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toContain("bunx skills add");
		expect(h.runs).toEqual([]);
		expect(existsSync(join(ctx.env.WARDEN_HOME ?? "", "skill"))).toBe(false);
	});

	test("skills CLI failure → its exit code", async () => {
		ctx = testContext(["install"]);
		expect(await createSkillCommand(harness({ exitCode: 3 }).deps).run(ctx)).toBe(3);
	});

	test("-a takes several agents; repeats accumulate", async () => {
		const h = harness();
		ctx = testContext(["install", "-a", "claude-code", "codex", "-a", "cursor", "--dry-run"]);
		expect(await createSkillCommand(h.deps).run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toContain("-a claude-code -a codex -a cursor");
	});

	test("--dry-run --json → the command as one JSON document", async () => {
		ctx = testContext(["install", "--dry-run", "--json", "--from", "github"]);
		expect(await createSkillCommand(harness().deps).run(ctx)).toBe(0);
		expect(JSON.parse(ctx.stdout.join("\n")).command).toEqual([
			"bunx",
			"skills",
			"add",
			"delacournz/warden",
			"--skill",
			"warden",
			"-g",
		]);
	});

	test("bad --from → commander choices error, exit 1", async () => {
		const h = harness();
		ctx = testContext(["install", "--from", "gitlab"]);
		expect(await createSkillCommand(h.deps).run(ctx)).toBe(1);
		expect(ctx.stderr.join("\n")).toContain("Allowed choices are local, github");
		expect(h.runs).toEqual([]);
	});

	test("unknown / missing subcommand → exit 1", async () => {
		ctx = testContext(["nope"]);
		expect(await createSkillCommand(harness().deps).run(ctx)).toBe(1);
		expect(ctx.stderr.join("\n")).toContain("unknown command 'nope'");
		ctx.cleanup();
		ctx = testContext([]);
		expect(await createSkillCommand(harness().deps).run(ctx)).toBe(1);
		expect(ctx.stdout).toEqual([]);
	});
});

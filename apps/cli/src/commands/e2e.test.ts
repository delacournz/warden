import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeSuiteRepo } from "@delacour/warden-core/affected/fixture.testing";
import { bunExec, type Exec } from "@delacour/warden-core/exec";
import { fakeSimctl, OWNER_ENV, wardenSim } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { harness } from "./batch.testing";
import { createE2eCommand, type E2eReport } from "./e2e";

let dir: string;
let write: (path: string, text: string) => void;
let ctx: TestContext | undefined;

beforeEach(async () => {
	({ dir, write } = await makeSuiteRepo());
});
afterEach(() => {
	ctx?.cleanup();
	ctx = undefined;
	rmSync(dir, { recursive: true, force: true });
});

/** Swap the fixture for one whose suite has `overrides`. */
async function resuite(overrides: Record<string, unknown>): Promise<void> {
	rmSync(dir, { recursive: true, force: true });
	({ dir, write } = await makeSuiteRepo(overrides));
}

function setup(argv: string[]): TestContext {
	const sim = fakeSimctl([wardenSim(1, "Booted"), wardenSim(2, "Booted")]);
	const exec: Exec = (cmd, opts) => (cmd[0] === "git" ? bunExec(cmd, opts) : sim(cmd, opts));
	ctx = testContext(argv, { exec });
	ctx.env = { ...ctx.env, ...OWNER_ENV };
	ctx.cwd = dir;
	return ctx;
}

const reportOf = (files: Map<string, string>, c: TestContext): E2eReport =>
	JSON.parse(files.get(join(c.env.WARDEN_HOME ?? "", "batches", "b1", "e2e-report.json")) ?? "{}");

describe("warden e2e", () => {
	test("runs the affected flows with the suite's runner, in the config dir; report + gate pass", async () => {
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		write("src/settings/form.tsx", "export const y = 2;\n");
		const c = setup(["--count", "2"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		const jobs = h.jobs();
		expect(jobs.map((j) => j.opts.env.WARDEN_JOB).sort()).toEqual(["chats", "settings"]);
		const chats = jobs.find((j) => j.opts.env.WARDEN_JOB === "chats");
		expect(chats?.cmd).toEqual([
			"run-flow",
			join(dir, "flows/chats.yaml"),
			"--device",
			chats?.opts.env.WARDEN_UDID ?? "",
		]);
		expect(chats?.opts.cwd).toBe(dir);
		const report = reportOf(h.files, c);
		expect(report).toMatchObject({ suite: "mobile", platform: "ios", base: "main", ok: true });
		expect(report.flows.map((f) => [f.id, f.verdict, f.required])).toEqual([
			["chats", "passed", true],
			["settings", "passed", false],
		]);
		expect(c.db.listLeases()).toEqual([]);
		expect(c.stderr.join("\n")).toContain("2/2 flow(s) passed — gate passed");
	});

	test("an optional flow failing doesn't fail the gate; a required one does", async () => {
		write("src/chat/lazy.tsx", "export const x = 2;\n");
		write("src/settings/form.tsx", "export const y = 2;\n");
		const c = setup([]);
		const optional = harness({ exitCodes: { settings: 1 } });
		expect(await createE2eCommand(optional.deps).run(c)).toBe(0);
		expect(c.stderr.join("\n")).toContain("settings failed (optional)");

		const required = harness({ exitCodes: { chats: 1 } });
		expect(await createE2eCommand(required.deps).run(c)).toBe(1);
		expect(reportOf(required.files, c).ok).toBe(false);
		expect(c.stderr.join("\n")).toContain("gate failed");
	});

	test("suite passes (2) → every flow runs twice on its device", async () => {
		await resuite({ passes: 2 });
		const c = setup(["--files", "src/chat/lazy.tsx"]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.jobs().map((j) => j.opts.env.WARDEN_PASS)).toEqual(["0", "1"]);
	});

	test("nothing affected → exit 0 without claiming; --dry-run runs nothing", async () => {
		const c = setup([]);
		const h = harness();
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.jobs()).toEqual([]);
		expect(c.stderr.join("\n")).toContain("no affected flows");

		c.argv = ["--files", "src/chat/lazy.tsx", "--dry-run"];
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		expect(h.jobs()).toEqual([]);
		expect(c.stderr.join("\n")).toContain("● chats");
	});

	test("a two-platform suite needs --platform", async () => {
		await resuite({ platform: undefined });
		const c = setup(["--files", "src/chat/lazy.tsx"]);
		expect(await createE2eCommand(harness().deps).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("pass --platform");
	});
});

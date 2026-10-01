import { afterEach, describe, expect, test } from "bun:test";
import { goldenKey, goldenName } from "@delacour/warden-core/golden/golden";
import { fakeHost, IPHONE_17, RUNTIME_BUILD, RUNTIME_ID } from "@delacour/warden-core/golden/golden.testing";
import { scriptedUi, type TestContext, testContext } from "../testing";
import { createGoldenCommand } from "./golden";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const KEY = goldenKey({
	xcodeBuild: "17F113",
	runtimeId: RUNTIME_ID,
	runtimeBuild: RUNTIME_BUILD,
	deviceType: IPHONE_17,
});
const GOLDEN = goldenName("iphone-17", KEY);
const instant = { sleep: async () => {} };

function setup(argv: string[], host: ReturnType<typeof fakeHost>): TestContext {
	ctx = testContext(argv, { exec: host.exec });
	ctx.env = { ...ctx.env, WARDEN_SESSION_ID: "me" };
	return ctx;
}

describe("warden golden", () => {
	test("ensure builds once, then reuses", async () => {
		const host = fakeHost({ migrationPolls: 0 });
		const cmd = createGoldenCommand(instant);
		const c = setup(["ensure", "--json"], host);
		expect(await cmd.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ name: GOLDEN, built: true });
		c.stdout.length = 0;
		expect(await cmd.run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ name: GOLDEN, built: false });
	});

	test("ls lists goldens only", async () => {
		const host = fakeHost({
			sims: [
				{ udid: "G", name: GOLDEN, state: "Shutdown" },
				{ udid: "P", name: "warden-iphone-17-1", state: "Shutdown" },
			],
		});
		const c = setup(["ls"], host);
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		expect(c.stdout.join("\n")).toContain(GOLDEN);
		expect(c.stdout.join("\n")).not.toContain("warden-iphone-17-1");
	});

	test("ensure runs under a spinner; build progress is logged above it", async () => {
		const host = fakeHost({ migrationPolls: 0 });
		const c = setup(["ensure"], host);
		const ui = scriptedUi();
		c.ui = ui;
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		expect(ui.events[0]).toBe("spin: ensuring golden iphone-17 image…");
		expect(ui.events).toContain(`ok: golden ${GOLDEN} built`);
		expect(ui.events.at(-1)).toBe("stop");
		expect(c.stdout.join("\n")).toContain(`${GOLDEN}`);
	});

	function goldenHost() {
		return fakeHost({
			sims: [
				{ udid: "G", name: GOLDEN, state: "Shutdown" },
				{ udid: "P", name: "warden-iphone-17-1", state: "Shutdown" },
			],
		});
	}

	test("prune --all --yes deletes goldens only", async () => {
		const host = goldenHost();
		const c = setup(["prune", "--all", "--yes", "--json"], host);
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		expect(host.sims.map((s) => s.udid)).toEqual(["P"]);
		expect(JSON.parse(c.stdout.join("\n")).map((g: { udid: string }) => g.udid)).toEqual(["G"]);
	});

	test("prune --all without a terminal needs --yes", async () => {
		const host = goldenHost();
		const c = setup(["prune", "--all"], host);
		expect(await createGoldenCommand(instant).run(c)).toBe(1);
		expect(c.stderr.join("\n")).toContain("--yes");
		expect(host.sims).toHaveLength(2);
	});

	test("prune --all in a terminal asks first", async () => {
		const host = goldenHost();
		const c = setup(["prune", "--all"], host);
		const ui = scriptedUi({ interactive: true, confirm: [true] });
		c.ui = ui;
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		expect(ui.events[0]).toBe("confirm: Delete all 1 golden image(s)?");
		expect(ui.events).toContain("spin: deleting golden images…");
		expect(host.sims.map((s) => s.udid)).toEqual(["P"]);
	});

	test("prune --all declined / cancelled → exit 1, nothing deleted", async () => {
		for (const answer of [false, undefined]) {
			const host = goldenHost();
			const c = setup(["prune", "--all"], host);
			const ui = scriptedUi({ interactive: true, confirm: [answer] });
			c.ui = ui;
			expect(await createGoldenCommand(instant).run(c)).toBe(1);
			expect(ui.events).toContain("cancelled: Aborted.");
			expect(host.sims).toHaveLength(2);
			c.cleanup();
			ctx = undefined;
		}
	});

	test("prune (stale only) never asks", async () => {
		const host = goldenHost();
		const c = setup(["prune"], host);
		const ui = scriptedUi({ interactive: true });
		c.ui = ui;
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		expect(ui.events.some((e) => e.startsWith("confirm"))).toBe(false);
	});

	test("unknown / missing subcommand → exit 1", async () => {
		expect(await createGoldenCommand(instant).run(setup(["nope"], fakeHost()))).toBe(1);
		expect(ctx?.stderr.join("\n")).toContain("unknown command 'nope'");
		ctx?.cleanup();
		expect(await createGoldenCommand(instant).run(setup([], fakeHost()))).toBe(1);
	});
});

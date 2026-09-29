import { afterEach, describe, expect, test } from "bun:test";
import { goldenKey, goldenName } from "@warden/core/golden/golden";
import { fakeHost, IPHONE_17, RUNTIME_BUILD, RUNTIME_ID } from "@warden/core/golden/golden.testing";
import { type TestContext, testContext } from "../testing";
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

	test("prune --all deletes goldens only", async () => {
		const host = fakeHost({
			sims: [
				{ udid: "G", name: GOLDEN, state: "Shutdown" },
				{ udid: "P", name: "warden-iphone-17-1", state: "Shutdown" },
			],
		});
		const c = setup(["prune", "--all"], host);
		expect(await createGoldenCommand(instant).run(c)).toBe(0);
		expect(host.sims.map((s) => s.udid)).toEqual(["P"]);
	});

	test("unknown subcommand → exit 1", async () => {
		expect(await createGoldenCommand(instant).run(setup(["nope"], fakeHost()))).toBe(1);
	});
});

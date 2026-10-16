import { afterEach, describe, expect, test } from "bun:test";
import { Chalk } from "chalk";
import { defineCommand, runProgram } from "./command";
import { scriptedUi, type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const alpha = defineCommand({
	name: "alpha",
	aliases: ["a"],
	group: "Lease",
	summary: "first thing",
	register: (cmd, _ctx, done) => {
		cmd
			.argument("[platform]", "ios | android")
			.option("--json", "machine-readable output")
			.action(() => done(3));
	},
});
const beta = defineCommand({ name: "beta", group: "Setup", summary: "second thing", register: () => {} });
const gamma = defineCommand({ name: "gamma", group: "Lease", summary: "third thing", register: () => {} });

function run(argv: string[], ui = scriptedUi()): Promise<number> {
	ctx = testContext(argv, { ui });
	return runProgram([alpha, beta, gamma], argv, ctx);
}

describe("runProgram help", () => {
	test("root help groups commands under their headings, without the [options] noise", async () => {
		expect(await run(["--help"])).toBe(0);
		const text = ctx?.stdout.join("\n") ?? "";
		expect(text).toContain("Lease:\n  alpha|a [platform]  first thing\n  gamma               third thing");
		expect(text).toContain("Setup:\n  beta                second thing");
		expect(text.indexOf("Lease:")).toBeLessThan(text.indexOf("Setup:"));
		expect(text).not.toContain("alpha|a [options]");
	});

	test("colour: bold titles, cyan command + option names", async () => {
		const ui = scriptedUi();
		ui.color = new Chalk({ level: 1 });
		expect(await run(["alpha", "--help"], ui)).toBe(0);
		const text = ctx?.stdout.join("\n") ?? "";
		expect(text).toContain(ui.color.bold("Options:"));
		expect(text).toContain(ui.color.cyan("--json"));
		expect(text).toContain(`${ui.color.bold("warden")} ${ui.color.bold("alpha|a")}`);
	});

	test("no colour: no escape codes", async () => {
		expect(await run(["alpha", "--help"])).toBe(0);
		expect(ctx?.stdout.join("\n")).not.toContain("\u001b[");
	});

	test("help wraps to the terminal width", async () => {
		expect(await run(["--help"], scriptedUi({ columns: 50 }))).toBe(0);
		for (const line of (ctx?.stdout.join("\n") ?? "").split("\n")) expect(line.length).toBeLessThanOrEqual(50);
	});

	test("action exit code is returned", async () => {
		expect(await run(["alpha"])).toBe(3);
	});

	test("usage error: red on stderr, exit 1, with the glyph at a terminal", async () => {
		expect(await run(["alpha", "--nope"], scriptedUi({ rich: true }))).toBe(1);
		expect(ctx?.stderr.join("\n")).toContain("✗ warden alpha: unknown option '--nope'");
		expect(await run(["alpha", "--nope"])).toBe(1);
		expect(ctx?.stderr.join("\n")).toContain("error: unknown option '--nope'");
	});
});

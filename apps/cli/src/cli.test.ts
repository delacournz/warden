import { afterEach, describe, expect, test } from "bun:test";
import { main } from "./cli";
import { COMMANDS } from "./commands/registry";
import { type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function run(argv: string[]): Promise<number> {
	return main(argv, (rest) => {
		ctx = testContext(rest);
		return ctx;
	});
}

describe("cli", () => {
	test("--help lists every command", async () => {
		expect(await run(["--help"])).toBe(0);
		const text = ctx?.stdout.join("\n") ?? "";
		for (const c of COMMANDS) expect(text).toContain(c.name);
	});

	test("unknown command exits 1", async () => {
		expect(await run(["nope"])).toBe(1);
		expect(ctx?.stderr.join("\n")).toContain("unknown command 'nope'");
	});

	test("command --help prints its usage", async () => {
		expect(await run(["ls", "--help"])).toBe(0);
		expect(ctx?.stdout.join("\n")).toContain("warden ls");
	});

	test("aliases dispatch to their command", async () => {
		expect(await run(["list", "--help"])).toBe(0);
		expect(ctx?.stdout.join("\n")).toContain("devices");
	});

	test("--version routes to the version command", async () => {
		expect(await run(["--version"])).toBe(0);
		expect(ctx?.stdout[0]).toMatch(/^warden \d+\.\d+\.\d+/);
	});
});

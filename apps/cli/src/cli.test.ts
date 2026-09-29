import { afterEach, describe, expect, test } from "bun:test";
import { helpText, main } from "./cli";
import { COMMANDS } from "./commands/registry";
import { type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe("cli", () => {
	test("help lists every command", () => {
		const text = helpText(COMMANDS);
		for (const c of COMMANDS) expect(text).toContain(c.name);
	});

	test("unknown command exits 1", async () => {
		const code = await main(["nope"], (rest) => {
			ctx = testContext(rest);
			return ctx;
		});
		expect(code).toBe(1);
		expect(ctx?.stderr.join("\n")).toContain('unknown command "nope"');
	});

	test("command --help prints usage", async () => {
		const code = await main(["ls", "--help"], (rest) => {
			ctx = testContext(rest);
			return ctx;
		});
		expect(code).toBe(0);
		expect(ctx?.stdout[0]).toContain("warden ls");
	});
});

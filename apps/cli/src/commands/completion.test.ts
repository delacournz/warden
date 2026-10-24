import { afterEach, describe, expect, test } from "bun:test";
import { completionScript } from "../completion-scripts";
import { type TestContext, testContext } from "../testing";
import { completionCommand } from "./completion";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe("warden completion", () => {
	test("prints the script for the named shell", async () => {
		ctx = testContext(["fish"]);
		expect(await completionCommand.run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toBe(completionScript("fish").replace(/\n$/, ""));
	});

	test("defaults to $SHELL", async () => {
		ctx = testContext([]);
		ctx.env.SHELL = "/bin/zsh";
		expect(await completionCommand.run(ctx)).toBe(0);
		expect(ctx.stdout.join("\n")).toContain("compdef _warden warden");
	});

	test("an unknown shell is a usage error", async () => {
		ctx = testContext(["tcsh"]);
		expect(await completionCommand.run(ctx)).toBe(1);
	});

	test("no shell and an unsupported $SHELL names the argument", async () => {
		ctx = testContext([]);
		ctx.env.SHELL = "/bin/tcsh";
		expect(await completionCommand.run(ctx)).toBe(1);
		expect(ctx.stderr.join("\n")).toContain("zsh | bash | fish");
	});
});

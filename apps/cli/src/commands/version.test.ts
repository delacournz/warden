import { afterEach, describe, expect, test } from "bun:test";
import { cliEntry } from "../cli";
import { cliTesting, type TestContext } from "../testing";
import { versionCommand } from "./version";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe("warden version", () => {
	test("from source reports the dev channel + checkout", async () => {
		ctx = cliTesting.testContext(["--json"]);
		expect(await versionCommand.run(ctx)).toBe(0);
		expect(JSON.parse(ctx.stdout.join("\n"))).toMatchObject({ channel: "dev", version: expect.any(String) });
	});

	test("--version flag routes to the version command", async () => {
		const code = await cliEntry.main(["--version"], (rest) => {
			ctx = cliTesting.testContext(rest);
			return ctx;
		});
		expect(code).toBe(0);
		expect(ctx?.stdout[0]).toMatch(/^warden \d+\.\d+\.\d+ \(dev, /);
	});
});

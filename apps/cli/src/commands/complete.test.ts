import { afterEach, describe, expect, test } from "bun:test";
import { main } from "../cli";
import { type TestContext, testContext } from "../testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

async function completeLine(words: string[]): Promise<string[]> {
	const code = await main(["__complete", "--", ...words], (rest) => {
		ctx = testContext(rest);
		return ctx;
	});
	expect(code).toBe(0);
	return ctx?.stdout ?? [];
}

describe("warden __complete", () => {
	test("bare `warden ` lists every visible command, hidden workers left out", async () => {
		const lines = await completeLine([""]);
		const names = lines.map((l) => l.split("\t")[1]);
		expect(names).toContain("claim");
		expect(names).toContain("sims");
		expect(names).toContain("completion");
		expect(names).not.toContain("__complete");
		expect(names).not.toContain("__affected-graph");
		expect(names).not.toContain("help");
		expect(lines.find((l) => l.startsWith("command\tclaim\t"))).toContain("lease iOS sims");
	});

	test("`warden sims ` lists its subcommands", async () => {
		const names = (await completeLine(["sims", ""])).map((l) => l.split("\t")[1]);
		expect(names).toEqual(["audit", "prune", "delete"]);
	});

	test("options after a dash, through words commander would otherwise parse (--json, --help)", async () => {
		const lines = await completeLine(["ui", "snapshot", "--json", "--"]);
		const names = lines.map((l) => l.split("\t")[1]);
		expect(names).toContain("--udid");
		expect(names).not.toContain("--json");
	});

	test("`warden completion ` offers the shells", async () => {
		expect(await completeLine(["completion", ""])).toEqual(["value\tzsh\t", "value\tbash\t", "value\tfish\t"]);
	});

	test("prints nothing to stderr", async () => {
		await completeLine(["claim", "--"]);
		expect(ctx?.stderr).toEqual([]);
	});
});

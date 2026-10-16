import { describe, expect, test } from "bun:test";
import { main } from "./cli";
import { COMMANDS } from "./commands/registry";
import { type TestContext, testContext } from "./testing";

async function help(path: string[]): Promise<string> {
	let run: TestContext | undefined;
	const code = await main([...path, "--help"], (rest) => {
		run = testContext(rest);
		return run;
	});
	const text = (run?.stdout ?? []).join("\n");
	run?.cleanup();
	expect(code).toBe(0);
	return text;
}

/** Subcommand names listed under a `Commands:` heading (aliases dropped, commander's `help` left out). */
function subcommands(text: string): string[] {
	const lines = text.split("\n");
	const start = lines.indexOf("Commands:");
	if (start < 0) return [];
	const names: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line === "") break;
		const match = /^ {2}(\S+)/.exec(line);
		const name = match?.[1]?.split("|")[0];
		if (name && name !== "help") names.push(name);
	}
	return names;
}

/** `warden <path> --help` for a command and every nested subcommand, one `$ …` header each. */
async function helpTree(path: string[]): Promise<string> {
	const text = await help(path);
	const parts = [`$ warden ${path.join(" ")} --help\n${text}`];
	for (const name of subcommands(text)) parts.push(await helpTree([...path, name]));
	return parts.join("\n\n");
}

/**
 * Byte-for-byte guard on what users see: the registry may load command modules lazily, but `--help` at
 * every level must read exactly as it did when every command was imported up front.
 */
describe("help output", () => {
	test("warden --help", async () => {
		expect(await help([])).toMatchSnapshot();
	});

	for (const command of COMMANDS) {
		test(`warden ${command.name} --help (and nested subcommands)`, async () => {
			expect(await helpTree([command.name])).toMatchSnapshot();
		});
	}

	test("warden help <command> matches <command> --help", async () => {
		let run: TestContext | undefined;
		const code = await main(["help", "claim"], (rest) => {
			run = testContext(rest);
			return run;
		});
		expect(code).toBe(0);
		expect((run?.stdout ?? []).join("\n")).toBe(await help(["claim"]));
		run?.cleanup();
	});

	test("unknown command suggests the closest registered one", async () => {
		let run: TestContext | undefined;
		const code = await main(["claime"], (rest) => {
			run = testContext(rest);
			return run;
		});
		expect(code).toBe(1);
		expect((run?.stderr ?? []).join("\n")).toMatchSnapshot();
		run?.cleanup();
	});
});

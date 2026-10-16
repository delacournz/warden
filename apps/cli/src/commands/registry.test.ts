import { describe, expect, test } from "bun:test";
import { COMMANDS } from "./registry";

describe("registry", () => {
	test("names and aliases are unique", () => {
		const seen = COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
		expect(new Set(seen).size).toBe(seen.length);
	});

	test.each(COMMANDS.map((entry) => [entry.name, entry] as const))(
		"%s: the listing matches the command module it loads",
		async (_name, entry) => {
			const command = await entry.load();
			expect({
				name: entry.name,
				aliases: entry.aliases,
				group: entry.group,
				summary: entry.summary,
				hidden: entry.hidden,
			}).toEqual({
				name: command.name,
				aliases: command.aliases,
				group: command.group,
				summary: command.summary,
				hidden: command.hidden,
			});
		}
	);
});

import { afterAll, describe, expect, test } from "bun:test";
import type { CommandUnknownOpts } from "@commander-js/extra-typings";
import { buildProgram } from "../command";
import { COMMANDS } from "../commands/registry";
import { testContext } from "../testing";
import { CONTRACT_OMISSIONS } from "./contracts-coverage.data";
import { CONTRACTS } from "./registry.schema";

const ctx = testContext([]);
afterAll(() => ctx.cleanup());
const program = buildProgram(await Promise.all(COMMANDS.map((entry) => entry.load())), [], ctx);

const JSON_FLAGS = new Set(["--json", "--json-lines"]);

/** Every visible command path that takes `--json` or `--json-lines`. */
function jsonCommands(cmd: CommandUnknownOpts, prefix: string[]): string[] {
	return cmd
		.createHelp()
		.visibleCommands(cmd)
		.filter((sub) => sub.name() !== "help")
		.flatMap((sub) => {
			const path = [...prefix, sub.name()];
			const own = sub.options.some((o) => o.long !== undefined && JSON_FLAGS.has(o.long)) ? [path.join(" ")] : [];
			return [...own, ...jsonCommands(sub, path)];
		});
}

const JSON_COMMANDS = jsonCommands(program, []);
const VERSIONED = new Set(CONTRACTS.map((c) => c.command));
const HINT =
	"add a schema to apps/cli/src/contracts (registry.schema.ts + a fixture), or list it in contracts-coverage.data.ts with why it has none";

describe("every --json output has a versioned contract", () => {
	test("each --json command has a registry entry or a listed omission", () => {
		const missing = JSON_COMMANDS.filter((p) => !VERSIONED.has(p) && !(p in CONTRACT_OMISSIONS));
		expect(missing, HINT).toEqual([]);
	});

	test("a command with a schema is not also listed as omitted", () => {
		expect(Object.keys(CONTRACT_OMISSIONS).filter((p) => VERSIONED.has(p))).toEqual([]);
	});

	test("omissions and registry entries name commands that still exist and take --json", () => {
		const known = new Set(JSON_COMMANDS);
		expect(Object.keys(CONTRACT_OMISSIONS).filter((p) => !known.has(p))).toEqual([]);
		expect([...VERSIONED].filter((p) => p !== "*" && !known.has(p))).toEqual([]);
	});
});

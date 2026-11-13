import { describe, expect, test } from "bun:test";
import { Command, type CommandUnknownOpts } from "@commander-js/extra-typings";
import {
	commandPathOf,
	errorKindOf,
	flagsSetOnCli,
	PROPERTY_DISCLOSURE,
	platformOf,
	suitesOf,
	type WardenCommandProperties,
} from "./properties";

class ClaimFailure extends Error {}

/** A program shaped like warden's: `ui press <target>`, `claim [platform]`, `e2e [suite]`; returns the action command. */
function parse(argv: string[]): CommandUnknownOpts {
	let seen: CommandUnknownOpts | undefined;
	const program = new Command().name("warden").exitOverride();
	const ui = program.command("ui");
	ui.command("press")
		.argument("<target>")
		.option("--udid <udid>")
		.option("--json")
		.option("--no-verify")
		.action((_target, _opts, command) => {
			seen = command;
		});
	program
		.command("claim")
		.argument("[platform]")
		.option("--platform <platform>")
		.option("--label <label>")
		.option("--json")
		.action((_platform, _opts, command) => {
			seen = command;
		});
	program
		.command("e2e")
		.argument("[suite...]")
		.option("--platform <platform>")
		.action((_suite, _opts, command) => {
			seen = command;
		});
	program.parse(argv, { from: "user" });
	if (!seen) throw new Error("action did not run");
	return seen;
}

describe("commandPathOf", () => {
	test("joins nested subcommand names, without the program name", () => {
		expect(commandPathOf(parse(["ui", "press", "@e3"]))).toBe("ui press");
		expect(commandPathOf(parse(["claim"]))).toBe("claim");
	});
});

describe("flagsSetOnCli", () => {
	test("lists long names typed, never values", () => {
		const flags = flagsSetOnCli(parse(["claim", "--label", "SecretLabel", "--json"]));
		expect(flags).toEqual(["--json", "--label"]);
		expect(JSON.stringify(flags)).not.toContain("SecretLabel");
	});

	test("leaves out what was not typed", () => {
		expect(flagsSetOnCli(parse(["claim"]))).toEqual([]);
	});

	test("reports a negated flag by its negated name", () => {
		expect(flagsSetOnCli(parse(["ui", "press", "x", "--no-verify"]))).toEqual(["--no-verify"]);
	});
});

describe("platformOf", () => {
	test("reads --platform or a positional, only when it is ios or android", () => {
		expect(platformOf(parse(["claim", "--platform", "ios"]))).toBe("ios");
		expect(platformOf(parse(["claim", "android"]))).toBe("android");
		expect(platformOf(parse(["claim", "--platform", "com.secret.app"]))).toBeUndefined();
		expect(platformOf(parse(["ui", "press", "ios"]))).toBeUndefined();
	});
});

describe("suitesOf", () => {
	test("counts suite arguments for e2e and nothing else, never their names", () => {
		expect(suitesOf(parse(["e2e", "login", "checkout"]))).toBe(2);
		expect(suitesOf(parse(["e2e"]))).toBe(0);
		expect(suitesOf(parse(["claim", "ios"]))).toBeUndefined();
	});
});

describe("errorKindOf", () => {
	test("is the class name and never the message", () => {
		expect(errorKindOf(new ClaimFailure("/Users/me/secret"))).toBe("ClaimFailure");
		expect(errorKindOf("boom")).toBe("unknown");
	});

	test("falls back to Error for an odd constructor name", () => {
		const odd = new Error("x");
		Object.defineProperty(odd, "constructor", { value: { name: "has space/ and slash" } });
		expect(errorKindOf(odd)).toBe("Error");
	});
});

describe("PROPERTY_DISCLOSURE", () => {
	test("words every property a command event can carry", () => {
		const keys: (keyof WardenCommandProperties)[] = [
			"command",
			"flags",
			"json",
			"platform",
			"suites",
			"errorKind",
			"exitCode",
		];
		for (const key of keys) expect(PROPERTY_DISCLOSURE[key].length).toBeGreaterThan(3);
		expect(Object.keys(PROPERTY_DISCLOSURE).sort()).toEqual([...keys].sort());
	});
});

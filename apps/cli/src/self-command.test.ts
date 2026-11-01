import { describe, expect, test } from "bun:test";
import { selfCommandHelpers } from "./self-command";

describe("selfCommand", () => {
	test("source: the runtime and the script", () => {
		expect(selfCommandHelpers.selfCommand("/repo/cli.ts", "/bin/bun")).toEqual(["/bin/bun", "/repo/cli.ts"]);
	});
	test("compiled: the binary alone", () => {
		expect(selfCommandHelpers.selfCommand("/$bunfs/root/warden", "/usr/local/bin/warden")).toEqual([
			"/usr/local/bin/warden",
		]);
		expect(selfCommandHelpers.selfCommand("B:/~BUN/root/warden.exe", "C:/warden.exe")).toEqual(["C:/warden.exe"]);
	});
});

describe("compiledSubcommand", () => {
	test("compiled: the binary and the hidden subcommand", () => {
		expect(selfCommandHelpers.compiledSubcommand("__scheduler", "/$bunfs/root/warden", "/w")).toEqual([
			"/w",
			"__scheduler",
		]);
	});
	test("source: undefined, so the caller keeps running its script", () => {
		expect(selfCommandHelpers.compiledSubcommand("__scheduler", "/repo/cli.ts", "/bin/bun")).toBeUndefined();
	});
});

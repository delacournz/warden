import { describe, expect, test } from "bun:test";
import { compiledSubcommand, selfCommand } from "./self-command";

describe("selfCommand", () => {
	test("source: the runtime and the script", () => {
		expect(selfCommand("/repo/cli.ts", "/bin/bun")).toEqual(["/bin/bun", "/repo/cli.ts"]);
	});
	test("compiled: the binary alone", () => {
		expect(selfCommand("/$bunfs/root/warden", "/usr/local/bin/warden")).toEqual(["/usr/local/bin/warden"]);
		expect(selfCommand("B:/~BUN/root/warden.exe", "C:/warden.exe")).toEqual(["C:/warden.exe"]);
	});
});

describe("compiledSubcommand", () => {
	test("compiled: the binary and the hidden subcommand", () => {
		expect(compiledSubcommand("__scheduler", "/$bunfs/root/warden", "/w")).toEqual(["/w", "__scheduler"]);
	});
	test("source: undefined, so the caller keeps running its script", () => {
		expect(compiledSubcommand("__scheduler", "/repo/cli.ts", "/bin/bun")).toBeUndefined();
	});
});

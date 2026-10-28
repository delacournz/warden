import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { main } from "./cli";
import { COMMANDS } from "./commands/registry";
import { type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function run(argv: string[]): Promise<number> {
	return main(argv, (rest) => {
		ctx = testContext(rest);
		return ctx;
	});
}

describe("cli", () => {
	test("--help lists every command except the hidden workers", async () => {
		expect(await run(["--help"])).toBe(0);
		const text = ctx?.stdout.join("\n") ?? "";
		for (const c of COMMANDS.filter((command) => !command.hidden)) expect(text).toContain(c.name);
		for (const c of COMMANDS.filter((command) => command.hidden)) expect(text).not.toContain(c.name);
	});

	test("unknown command exits 1", async () => {
		expect(await run(["nope"])).toBe(1);
		expect(ctx?.stderr.join("\n")).toContain("unknown command 'nope'");
	});

	test("command --help prints its usage", async () => {
		expect(await run(["ls", "--help"])).toBe(0);
		expect(ctx?.stdout.join("\n")).toContain("warden ls");
	});

	test("aliases dispatch to their command", async () => {
		expect(await run(["list", "--help"])).toBe(0);
		expect(ctx?.stdout.join("\n")).toContain("devices");
	});

	test("--version routes to the version command", async () => {
		expect(await run(["--version"])).toBe(0);
		expect(ctx?.stdout[0]).toMatch(/^warden \d+\.\d+\.\d+/);
	});

	test("a --json document bigger than the pipe buffer reaches a slow reader whole", async () => {
		// a shell pipe whose reader starts late (Bun.spawn's own pipe is drained eagerly and never fills), so the CLI
		// is done while most of the document still waits behind a full 64 KB pipe
		const cli = resolve(import.meta.dir, "cli.ts");
		const proc = Bun.spawn(["sh", "-c", `bun "${cli}" skill show --json 2>/dev/null | (sleep 0.5; cat)`], {
			env: { ...process.env, NO_COLOR: "1", CI: "1" },
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
		});
		const stdout = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		expect(stdout.length).toBeGreaterThan(64 * 1024);
		expect(() => JSON.parse(stdout)).not.toThrow();
	});

	test("a reader that hangs up early (`| head`) doesn't keep the CLI waiting for the pipe to drain", async () => {
		const cli = resolve(import.meta.dir, "cli.ts");
		const proc = Bun.spawn(["sh", "-c", `bun "${cli}" skill show --json 2>/dev/null | head -c 10`], {
			env: { ...process.env, NO_COLOR: "1", CI: "1" },
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
		});
		expect(await new Response(proc.stdout).text()).toBe('{\n  "name"');
		expect(await proc.exited).toBe(0);
	}, 5000);
});

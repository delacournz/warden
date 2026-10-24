import { afterEach, describe, expect, test } from "bun:test";
import { createPerfCommand } from "../commands/perf";
import { type TestContext, testContext } from "../testing";
import { registerMemory } from "./memory";
import { registerMetrics } from "./metrics";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const droid = { platform: "android", id: "emulator-5554", name: "warden-pixel-1" } as const;

function setup(argv: string[]) {
	const c = testContext(argv, { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) });
	ctx = c;
	asMe(c);
	c.db.recordDevice(droid, c.now());
	return { c, command: createPerfCommand(fakePerfDeps([droid]), [registerMetrics, registerMemory]) };
}

describe("registerMetrics / registerMemory", () => {
	test("help lists both subcommands", async () => {
		const { c, command } = setup(["--help"]);
		expect(await command.run(c)).toBe(0);
		const help = c.stdout.join("\n");
		expect(help).toContain("metrics");
		expect(help).toContain("memory");
	});

	test("metrics --help documents --interval, --duration and --watch", async () => {
		const { c, command } = setup(["metrics", "--help"]);
		await command.run(c);
		const help = c.stdout.join("\n");
		for (const flag of ["--interval", "--duration", "--watch", "--app"]) expect(help).toContain(flag);
	});

	test("memory --help documents --snapshot", async () => {
		const { c, command } = setup(["memory", "--help"]);
		await command.run(c);
		expect(c.stdout.join("\n")).toContain("--snapshot");
	});

	test("metrics flags reach the run: a bad --interval is a usage error envelope", async () => {
		const { c, command } = setup(["metrics", "--app", "nz.co.x", "--interval", "soon", "--json"]);
		expect(await command.run(c)).toBe(1);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({
			ok: false,
			command: "perf metrics",
			error: { code: "usage" },
		});
	});

	test("memory reaches the run: an app that is not running is app_not_found", async () => {
		const { c, command } = setup(["memory", "--app", "nz.co.x", "--json"]);
		expect(await command.run(c)).toBe(1);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({
			ok: false,
			command: "perf memory",
			error: { code: "app_not_found" },
		});
	});
});

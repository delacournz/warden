import { afterEach, describe, expect, test } from "bun:test";
import { PERF_SUBCOMMANDS, type PerfRegister } from "../perf/register";
import { fakePerfDeps } from "../perf/testing";
import { type TestContext, testContext } from "../testing";
import { createPerfCommand } from "./perf";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const sim = { platform: "ios", id: "U1", name: "warden-iphone-17-1" } as const;

function setup(argv: string[]) {
	const c = testContext(argv);
	ctx = c;
	c.db.recordDevice({ platform: "ios", id: "U1", name: sim.name }, c.now());
	return { c, deps: fakePerfDeps([sim]) };
}

describe("warden perf", () => {
	test("--help lists ls, mark and doctor", async () => {
		const { c, deps } = setup(["--help"]);
		expect(await createPerfCommand(deps).run(c)).toBe(0);
		const help = c.stdout.join("\n");
		for (const sub of ["ls", "mark", "doctor"]) expect(help).toContain(sub);
	});

	test("ls --json dispatches to the ls subcommand", async () => {
		const { c, deps } = setup(["ls", "--json"]);
		expect(await createPerfCommand(deps).run(c)).toBe(0);
		expect(JSON.parse(c.stdout.join("\n"))).toEqual({ sessions: [] });
	});

	test("mark with no session reports session_not_found through the UiJson envelope", async () => {
		const { c, deps } = setup(["mark", "hello", "--json"]);
		expect(await createPerfCommand(deps).run(c)).toBe(1);
		expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({
			ok: false,
			command: "perf mark",
			error: { code: "session_not_found" },
		});
	});

	test("text-mode errors read `warden perf <sub>: …`", async () => {
		const { c, deps } = setup(["mark", "hello"]);
		await createPerfCommand(deps).run(c);
		expect(c.stderr.join("\n")).toContain("warden perf mark: no active perf session");
	});

	test("the extension point: one more registrar in the list adds a subcommand", async () => {
		const { c, deps } = setup(["ping"]);
		const registerPing: PerfRegister = (cmd, _ctx, done) => {
			cmd.command("ping").action(() => done(7));
		};
		const command = createPerfCommand(deps, [...PERF_SUBCOMMANDS, registerPing]);
		expect(await command.run(c)).toBe(7);
	});

	test("PERF_SUBCOMMANDS registers each subcommand exactly once", () => {
		expect(PERF_SUBCOMMANDS).toHaveLength(20);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { Chalk } from "chalk";
import { type Command, type CommandEntry, defineCommand, runLazyProgram, runProgram } from "./command";
import { scriptedUi, type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const alpha = defineCommand({
	name: "alpha",
	aliases: ["a"],
	group: "Lease",
	summary: "first thing",
	register: (cmd, _ctx, done) => {
		cmd
			.argument("[platform]", "ios | android")
			.option("--json", "machine-readable output")
			.action(() => done(3));
	},
});
const beta = defineCommand({ name: "beta", group: "Setup", summary: "second thing", register: () => {} });
const gamma = defineCommand({ name: "gamma", group: "Lease", summary: "third thing", register: () => {} });

function run(argv: string[], ui = scriptedUi()): Promise<number> {
	ctx = testContext(argv, { ui });
	return runProgram([alpha, beta, gamma], argv, ctx);
}

describe("runProgram help", () => {
	test("root help groups commands under their headings, without the [options] noise", async () => {
		expect(await run(["--help"])).toBe(0);
		const text = ctx?.stdout.join("\n") ?? "";
		expect(text).toContain("Lease:\n  alpha|a [platform]  first thing\n  gamma               third thing");
		expect(text).toContain("Setup:\n  beta                second thing");
		expect(text.indexOf("Lease:")).toBeLessThan(text.indexOf("Setup:"));
		expect(text).not.toContain("alpha|a [options]");
	});

	test("colour: bold titles, cyan command + option names", async () => {
		const ui = scriptedUi();
		ui.color = new Chalk({ level: 1 });
		expect(await run(["alpha", "--help"], ui)).toBe(0);
		const text = ctx?.stdout.join("\n") ?? "";
		expect(text).toContain(ui.color.bold("Options:"));
		expect(text).toContain(ui.color.cyan("--json"));
		expect(text).toContain(`${ui.color.bold("warden")} ${ui.color.bold("alpha|a")}`);
	});

	test("no colour: no escape codes", async () => {
		expect(await run(["alpha", "--help"])).toBe(0);
		expect(ctx?.stdout.join("\n")).not.toContain("\u001b[");
	});

	test("help wraps to the terminal width", async () => {
		expect(await run(["--help"], scriptedUi({ columns: 50 }))).toBe(0);
		for (const line of (ctx?.stdout.join("\n") ?? "").split("\n")) expect(line.length).toBeLessThanOrEqual(50);
	});

	test("action exit code is returned", async () => {
		expect(await run(["alpha"])).toBe(3);
	});

	test("usage error: red on stderr, exit 1, with the glyph at a terminal", async () => {
		expect(await run(["alpha", "--nope"], scriptedUi({ rich: true }))).toBe(1);
		expect(ctx?.stderr.join("\n")).toContain("✗ warden alpha: unknown option '--nope'");
		expect(await run(["alpha", "--nope"])).toBe(1);
		expect(ctx?.stderr.join("\n")).toContain("error: unknown option '--nope'");
	});
});

/** `command`'s listing with a `load` that records which modules were asked for. */
function lazyEntries(commands: readonly Command[], loaded: string[]): CommandEntry[] {
	return commands.map(({ name, aliases, group, summary, hidden }) => ({
		name,
		summary,
		...(aliases ? { aliases } : {}),
		...(group ? { group } : {}),
		...(hidden ? { hidden } : {}),
		load: async () => {
			loaded.push(name);
			const command = commands.find((c) => c.name === name);
			if (!command) throw new Error(`no ${name}`);
			return command;
		},
	}));
}

describe("runLazyProgram", () => {
	const all = [alpha, beta, gamma];

	async function lazy(argv: string[], ui = scriptedUi()): Promise<{ code: number; loaded: string[] }> {
		const loaded: string[] = [];
		ctx = testContext(argv, { ui });
		const code = await runLazyProgram(lazyEntries(all, loaded), argv, ctx);
		return { code, loaded };
	}

	test("loads only the dispatched command's module", async () => {
		const { code, loaded } = await lazy(["alpha"]);
		expect(code).toBe(3);
		expect(loaded).toEqual(["alpha"]);
	});

	test("an alias loads its command and nothing else", async () => {
		const { code, loaded } = await lazy(["a"]);
		expect(code).toBe(3);
		expect(loaded).toEqual(["alpha"]);
	});

	test("`<command> --help` loads only that command", async () => {
		const { code, loaded } = await lazy(["beta", "--help"]);
		expect(code).toBe(0);
		expect(loaded).toEqual(["beta"]);
	});

	test.each([[["--help"]], [[]], [["nope"]], [["help", "alpha"]], [["--bogus"]]])(
		"%j needs the whole command list, so loads every module",
		async (argv) => {
			const { loaded } = await lazy(argv);
			expect([...loaded].sort()).toEqual(["alpha", "beta", "gamma"]);
		}
	);

	test("output matches the eager program byte for byte", async () => {
		for (const argv of [["--help"], ["alpha", "--help"], ["nope"], ["alpha", "--nope"], ["help", "alpha"], []]) {
			const eager = testContext(argv);
			const eagerCode = await runProgram(all, argv, eager);
			const lazyRun = testContext(argv);
			const lazyCode = await runLazyProgram(lazyEntries(all, []), argv, lazyRun);
			expect({ argv, code: lazyCode, out: lazyRun.stdout, err: lazyRun.stderr }).toEqual({
				argv,
				code: eagerCode,
				out: eager.stdout,
				err: eager.stderr,
			});
			eager.cleanup();
			lazyRun.cleanup();
		}
	});

	test("a usage error in a lazily loaded command still names its scope", async () => {
		const { code } = await lazy(["alpha", "--nope"], scriptedUi({ rich: true }));
		expect(code).toBe(1);
		expect(ctx?.stderr.join("\n")).toContain("✗ warden alpha: unknown option '--nope'");
	});
});

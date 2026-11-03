import { afterEach, describe, expect, test } from "bun:test";
import { Chalk } from "chalk";
import { type Command, type CommandEntry, defineCommand, runLazyProgram, runProgram } from "./command";
import { reportError } from "./output";
import { withSpinner } from "./spinner-context";
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

describe("runProgram --json failures", () => {
	const failing = defineCommand({
		name: "delta",
		summary: "fails",
		register: (cmd, ctx, done) => {
			cmd
				.option("--json", "machine-readable output")
				.option("--wrote", "print a document before failing")
				.option("--silent", "fail without reporting why")
				.option("--spin", "report the error from under a spinner")
				.argument("[rest...]")
				.action(async (_rest, opts) => {
					if (opts.wrote) ctx.out(JSON.stringify({ unknown: ["x"] }));
					else if (opts.spin) await withSpinner(ctx, "working", async (sctx) => reportError(sctx, "delta", "boom"));
					else if (!opts.silent) {
						reportError(ctx, "delta", "boom");
						reportError(ctx, "delta", "and then this");
					}
					done(opts.silent ? 4 : 1);
				});
		},
	});
	const nested = defineCommand({
		name: "eps",
		summary: "has a subcommand",
		register: (cmd, ctx, done) => {
			cmd
				.command("sub")
				.option("--json", "machine-readable output")
				.action(() => {
					reportError(ctx, "eps sub", "nope");
					done(2);
				});
		},
	});

	function runJson(argv: string[]): Promise<number> {
		ctx = testContext(argv);
		return runProgram([alpha, failing, nested], argv, ctx);
	}
	const doc = () => JSON.parse(ctx?.stdout.join("\n") ?? "");

	test("a reported failure → one envelope on stdout with the first error, exit code kept, stderr still says it", async () => {
		expect(await runJson(["delta", "--json"])).toBe(1);
		expect(ctx?.stdout).toHaveLength(1);
		expect(doc()).toEqual({ ok: false, command: "delta", error: { code: "failed", message: "boom" } });
		expect(ctx?.stderr.join("\n")).toContain("warden delta: boom");
	});

	test("the command path names the subcommand", async () => {
		expect(await runJson(["eps", "sub", "--json"])).toBe(2);
		expect(doc()).toEqual({ ok: false, command: "eps sub", error: { code: "failed", message: "nope" } });
	});

	test("an error reported from under a spinner is still the envelope's", async () => {
		expect(await runJson(["delta", "--json", "--spin"])).toBe(1);
		expect(doc().error.message).toBe("boom");
	});

	test("a command that already printed its document gets no second one", async () => {
		expect(await runJson(["delta", "--json", "--wrote"])).toBe(1);
		expect(ctx?.stdout).toEqual([JSON.stringify({ unknown: ["x"] })]);
	});

	test("a failure nobody reported still gets an envelope, naming the exit code", async () => {
		expect(await runJson(["delta", "--json", "--silent"])).toBe(4);
		expect(doc()).toEqual({ ok: false, command: "delta", error: { code: "failed", message: "warden delta exited 4" } });
	});

	test("a usage error under --json → code usage", async () => {
		expect(await runJson(["delta", "--json", "--nope"])).toBe(1);
		expect(doc()).toEqual({
			ok: false,
			command: "delta",
			error: { code: "usage", message: "unknown option '--nope'" },
		});
	});

	test("without --json (or with it only after --) stdout stays empty", async () => {
		expect(await runJson(["delta"])).toBe(1);
		expect(await runJson(["delta", "--nope"])).toBe(1);
		expect(ctx?.stdout).toEqual([]);
		expect(await runJson(["delta", "--", "--json"])).toBe(1);
		expect(ctx?.stdout).toEqual([]);
	});

	test("success prints no envelope", async () => {
		expect(await runJson(["alpha", "--json"])).toBe(3);
		expect(doc().command).toBe("alpha");
		ctx?.cleanup();
		const ok = defineCommand({
			name: "zeta",
			summary: "ok",
			register: (cmd, _ctx, done) => {
				cmd.option("--json", "machine-readable output").action(() => done(0));
			},
		});
		ctx = testContext([]);
		expect(await runProgram([ok], ["zeta", "--json"], ctx)).toBe(0);
		expect(ctx.stdout).toEqual([]);
	});
});

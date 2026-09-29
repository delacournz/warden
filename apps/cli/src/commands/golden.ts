import { parseArgs } from "node:util";
import { DEFAULT_PROFILE } from "@warden/core/config.defaults";
import { ensureGolden, type GoldenDeps, listGoldens, pruneGoldens } from "@warden/core/golden/ios-golden";
import { resolveOwner } from "../claim-flags";
import type { Command, CommandContext } from "../context";
import { goldenDeps, type Sleep } from "../golden-deps";
import { emit, formatTable } from "../output";

const USAGE = [
	"warden golden ensure [--profile iphone-17] [--runtime latest] [--json]   build (once) or reuse the golden image",
	"warden golden ls [--json]                                              list golden images",
	"warden golden prune [--all] [--json]                                   delete stale goldens (--all: every golden)",
].join("\n");

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		options: {
			profile: { type: "string" },
			runtime: { type: "string" },
			all: { type: "boolean" },
			json: { type: "boolean" },
		},
		allowPositionals: true,
		strict: true,
	});
}

type Values = ReturnType<typeof parse>["values"];

async function ensure(ctx: CommandContext, deps: GoldenDeps, values: Values): Promise<number> {
	const golden = await ensureGolden(deps, values.profile ?? DEFAULT_PROFILE.ios, values.runtime);
	if (!golden.success) return fail(ctx, golden.error);
	const { name, udid, built } = golden.data;
	emit(ctx, values.json === true, golden.data, `${name} ${udid} (${built ? "built" : "reused"})`);
	return 0;
}

async function ls(ctx: CommandContext, deps: GoldenDeps, values: Values): Promise<number> {
	const goldens = await listGoldens(deps);
	if (!goldens.success) return fail(ctx, goldens.error);
	const table = formatTable(
		["NAME", "UDID", "STATE", "RUNTIME", "AVAILABLE"],
		goldens.data.map((g) => [g.name, g.udid, g.state, g.runtimeId.split(".").pop() ?? "", g.isAvailable ? "yes" : "no"])
	);
	emit(ctx, values.json === true, goldens.data, goldens.data.length > 0 ? table : "no golden images");
	return 0;
}

async function prune(ctx: CommandContext, deps: GoldenDeps, values: Values): Promise<number> {
	const pruned = await pruneGoldens(deps, { all: values.all === true });
	if (!pruned.success) return fail(ctx, pruned.error);
	const text = pruned.data.length > 0 ? `deleted ${pruned.data.map((g) => g.name).join(" ")}` : "nothing to prune";
	emit(ctx, values.json === true, pruned.data, text);
	return 0;
}

const SUBCOMMANDS: Record<string, (ctx: CommandContext, deps: GoldenDeps, values: Values) => Promise<number>> = {
	ensure,
	ls,
	prune,
};

/**
 * Golden iOS images: one first-booted, settled, shut-down sim per Xcode + runtime + device type.
 * `warden claim` clones new pool devices from it (seconds) instead of a fresh first boot (minutes).
 */
export function createGoldenCommand(opts: { sleep?: Sleep } = {}): Command {
	async function run(ctx: CommandContext): Promise<number> {
		let parsed: ReturnType<typeof parse>;
		try {
			parsed = parse(ctx.argv);
		} catch (error) {
			ctx.err(`warden golden: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
			return 1;
		}
		const sub = SUBCOMMANDS[parsed.positionals[0] ?? ""];
		if (!sub) {
			ctx.err(`warden golden: expected ensure | ls | prune\n${USAGE}`);
			return 1;
		}
		return sub(ctx, goldenDeps(ctx, resolveOwner(ctx), opts.sleep), parsed.values);
	}
	return {
		name: "golden",
		summary: "golden iOS images new sims are cloned from (fast boots): ensure | ls | prune",
		usage: USAGE,
		run,
	};
}

function fail(ctx: CommandContext, error: string): number {
	ctx.err(`warden golden: ${error}`);
	return 1;
}

export const goldenCommand: Command = createGoldenCommand();

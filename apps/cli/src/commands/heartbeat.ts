import { parseArgs } from "node:util";
import type { Command, CommandContext } from "../context";
import { isEmptySelector, SELECT_OPTIONS, selectLeases, selectorFrom } from "../lease-select";
import { emit } from "../output";

const USAGE = "warden heartbeat <leaseId…> | --udid X | --mine | --session S [--json]";

async function run(ctx: CommandContext): Promise<number> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(ctx.argv);
	} catch (error) {
		ctx.err(`warden heartbeat: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
		return 1;
	}
	const { values, positionals } = parsed;
	const selector = selectorFrom(positionals, values);
	if (isEmptySelector(selector)) {
		ctx.err(`warden heartbeat: nothing selected\n${USAGE}`);
		return 1;
	}
	const { leases, unknown } = selectLeases(ctx, selector);
	const ids = leases.map((l) => l.id);
	ctx.store().heartbeat(ids, ctx.now());
	for (const u of unknown) ctx.err(`warden heartbeat: no lease for ${u}`);
	emit(
		ctx,
		values.json === true,
		{ heartbeat: ids, unknown },
		ids.length > 0 ? `heartbeat ${ids.join(" ")}` : "no leases"
	);
	return unknown.length > 0 ? 1 : 0;
}

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		options: { ...SELECT_OPTIONS, json: { type: "boolean" } },
		allowPositionals: true,
		strict: true,
	});
}

export const heartbeatCommand: Command = {
	name: "heartbeat",
	summary: "refresh lease heartbeats so they don't go stale",
	usage: USAGE,
	run,
};

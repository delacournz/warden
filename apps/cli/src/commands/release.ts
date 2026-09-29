import { parseArgs } from "node:util";
import { resolveOwner } from "../claim-flags";
import type { Command, CommandContext } from "../context";
import { shutdownReleasedDevices } from "../device-shutdown";
import { isEmptySelector, SELECT_OPTIONS, selectLeases, selectorFrom } from "../lease-select";
import { emit } from "../output";

const USAGE = "warden release <leaseId…> | --udid X | --mine | --session S [--shutdown] [--json]";

async function run(ctx: CommandContext): Promise<number> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(ctx.argv);
	} catch (error) {
		ctx.err(`warden release: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
		return 1;
	}
	const { values, positionals } = parsed;
	const selector = selectorFrom(positionals, values);
	if (isEmptySelector(selector)) {
		ctx.err(`warden release: nothing selected\n${USAGE}`);
		return 1;
	}
	const { leases, unknown } = selectLeases(ctx, selector);
	const { shutdown, notes } = values.shutdown
		? await shutdownReleasedDevices(ctx, leases, resolveOwner(ctx))
		: { shutdown: [], notes: [] };
	const store = ctx.store();
	store.deleteLeases(leases.map((l) => l.id));
	const now = ctx.now();
	for (const l of leases) if (l.resource.kind === "device") store.touchDevice(l.resource.platform, l.resource.id, now);

	for (const u of unknown) ctx.err(`warden release: no lease for ${u}`);
	const text = [
		leases.length === 0 ? "nothing released" : `released ${leases.map((l) => l.id).join(" ")}`,
		...(shutdown.length > 0 ? [`shut down ${shutdown.join(" ")}`] : []),
		...notes,
	].join("\n");
	emit(ctx, values.json === true, { released: leases.map((l) => l.id), shutdown, unknown, notes }, text);
	return unknown.length > 0 ? 1 : 0;
}

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		options: { ...SELECT_OPTIONS, shutdown: { type: "boolean" }, json: { type: "boolean" } },
		allowPositionals: true,
		strict: true,
	});
}

export const releaseCommand: Command = {
	name: "release",
	summary: "release leases (optionally shut down devices warden created)",
	usage: USAGE,
	run,
};

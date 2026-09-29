import { parseArgs } from "node:util";
import type { Lease } from "@warden/core/types";
import { resolveOwner } from "../claim-flags";
import type { Command, CommandContext } from "../context";
import { isEmptySelector, SELECT_OPTIONS, selectLeases, selectorFrom } from "../lease-select";
import { emit } from "../output";
import { providerFor } from "../providers";

const USAGE = "warden release <leaseId…> | --udid X | --mine | --session S [--shutdown] [--json]";

/**
 * Shut down released devices warden created (store `devices` table) — never foreign ones. Runs while
 * the lease is still held so nobody is handed a device mid-shutdown.
 */
async function shutdownOwn(ctx: CommandContext, leases: Lease[], notes: string[]): Promise<string[]> {
	const store = ctx.store();
	const owner = resolveOwner(ctx);
	const done: string[] = [];
	for (const lease of leases) {
		const r = lease.resource;
		if (r.kind !== "device") continue;
		const own = store.listDevices(r.platform).some((d) => d.id === r.id);
		if (!own) {
			notes.push(`not shutting down ${r.id}: not created by warden`);
			continue;
		}
		const result = await providerFor(r.platform, ctx, owner).shutdown(r.id);
		if (result.success) done.push(r.id);
		else notes.push(`shutdown ${r.id} failed: ${result.error}`);
	}
	return done;
}

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
	const notes: string[] = [];
	const shutdown = values.shutdown ? await shutdownOwn(ctx, leases, notes) : [];
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

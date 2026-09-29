import { resolveOwner } from "../claim-flags";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { type ShutdownOutcome, shutdownReleasedDevices } from "../device-shutdown";
import {
	isEmptySelector,
	NOTHING_SELECTED,
	type SelectOptionValues,
	selectLeases,
	selectorFrom,
	withSelectOptions,
} from "../lease-select";
import { emit } from "../output";
import { withSpinner } from "../spinner-context";

type ReleaseOpts = SelectOptionValues & { shutdown?: true; json?: true };

/** Release the selected leases; with `--shutdown`, first shut down the devices warden may shut down. */
async function release(ctx: CommandContext, ids: string[], opts: ReleaseOpts): Promise<number> {
	const { color } = ctx.ui;
	const selector = selectorFrom(ids, opts);
	if (isEmptySelector(selector)) {
		ctx.err(color.red(`warden release: ${NOTHING_SELECTED}`));
		return 1;
	}
	const { leases, unknown } = selectLeases(ctx, selector);
	const devices = leases.filter((l) => l.resource.kind === "device");
	const { shutdown, notes }: ShutdownOutcome =
		opts.shutdown && devices.length > 0
			? await withSpinner(ctx, `shutting down ${devices.length} device(s)…`, async (sctx, spinner) => {
					const outcome = await shutdownReleasedDevices(sctx, leases, resolveOwner(ctx));
					spinner.succeed(
						outcome.shutdown.length > 0 ? `shut down ${outcome.shutdown.join(" ")}` : "nothing to shut down"
					);
					return outcome;
				})
			: { shutdown: [], notes: [] };
	const store = ctx.store();
	store.deleteLeases(leases.map((l) => l.id));
	const now = ctx.now();
	for (const l of leases) if (l.resource.kind === "device") store.touchDevice(l.resource.platform, l.resource.id, now);

	for (const u of unknown) ctx.err(color.red(`warden release: no lease for ${u}`));
	const text = [
		leases.length === 0
			? color.yellow("nothing released")
			: color.green(`released ${leases.map((l) => l.id).join(" ")}`),
		...(shutdown.length > 0 ? [color.green(`shut down ${shutdown.join(" ")}`)] : []),
		...notes.map((n) => color.yellow(n)),
	].join("\n");
	emit(ctx, opts.json === true, { released: leases.map((l) => l.id), shutdown, unknown, notes }, text);
	return unknown.length > 0 ? 1 : 0;
}

export const releaseCommand = defineCommand({
	name: "release",
	summary: "release leases (optionally shut down devices warden created)",
	register: (cmd, ctx, done) => {
		withSelectOptions(cmd.argument("[leaseIds...]", "lease ids to release"))
			.option("--shutdown", "also shut down devices warden created (or the lease owner booted)")
			.option("--json", "machine-readable output")
			.action(async (ids, opts) => done(await release(ctx, ids, opts)));
	},
});

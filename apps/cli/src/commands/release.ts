import { PENDING_PREFIX } from "@delacour/warden-core/claim";
import { wardenNameProfile } from "@delacour/warden-core/inventory";
import type { Lease } from "@delacour/warden-core/types";
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

type ReleaseOpts = SelectOptionValues & { shutdown?: true; bad?: true | string; json?: true };

/**
 * `--bad`: quarantine the devices behind the released leases so no claim hands them out again.
 * Only warden devices (a store record or a `warden-<profile>-N` name); foreign ones are released
 * only. Returns the quarantined ids + notes.
 */
function quarantineReleased(ctx: CommandContext, leases: Lease[], reason: string | undefined) {
	const store = ctx.store();
	const quarantined: string[] = [];
	const notes: string[] = [];
	const records = store.listDevices();
	for (const l of leases) {
		if (l.resource.kind !== "device" || l.resource.id.startsWith(PENDING_PREFIX)) continue;
		const { platform, id, name } = l.resource;
		const record = records.find((r) => r.platform === platform && r.id === id);
		const profile = record?.profile ?? wardenNameProfile(name);
		if (!record && profile === undefined) {
			notes.push(`${name} (${id}) is not a warden device — released, not quarantined`);
			continue;
		}
		store.quarantineDevice({ platform, id, name, ...(profile !== undefined ? { profile } : {}) }, reason, ctx.now());
		quarantined.push(id);
	}
	return { quarantined, notes };
}

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
			: { shutdown: [], notes: [], kept: [] };
	const store = ctx.store();
	const bad =
		opts.bad !== undefined
			? quarantineReleased(ctx, leases, typeof opts.bad === "string" ? opts.bad : undefined)
			: { quarantined: [], notes: [] };
	store.deleteLeases(leases.map((l) => l.id));
	const now = ctx.now();
	for (const l of leases) if (l.resource.kind === "device") store.touchDevice(l.resource.platform, l.resource.id, now);

	for (const u of unknown) ctx.err(color.red(`warden release: no lease for ${u}`));
	const text = [
		leases.length === 0
			? color.yellow("nothing released")
			: color.green(`released ${leases.map((l) => l.id).join(" ")}`),
		...(shutdown.length > 0 ? [color.green(`shut down ${shutdown.join(" ")}`)] : []),
		...(bad.quarantined.length > 0
			? [color.yellow(`quarantined ${bad.quarantined.join(" ")} (clear with: warden sim unquarantine <udid>)`)]
			: []),
		...[...notes, ...bad.notes].map((n) => color.yellow(n)),
	].join("\n");
	emit(
		ctx,
		opts.json === true,
		{
			released: leases.map((l) => l.id),
			shutdown,
			quarantined: bad.quarantined,
			unknown,
			notes: [...notes, ...bad.notes],
		},
		text
	);
	return unknown.length > 0 ? 1 : 0;
}

export const releaseCommand = defineCommand({
	name: "release",
	summary: "release leases (optionally shut down devices warden created)",
	register: (cmd, ctx, done) => {
		withSelectOptions(cmd.argument("[leaseIds...]", "lease ids to release"))
			.option("--shutdown", "also shut down devices warden created (or the lease owner booted)")
			.option("--bad [reason]", "also quarantine the released devices (warden devices only) so claims skip them")
			.option("--json", "machine-readable output")
			.action(async (ids, opts) => done(await release(ctx, ids, opts)));
	},
});

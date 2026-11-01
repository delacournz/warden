import { PENDING_PREFIX } from "@delacour/warden-leasing/claim";
import { DeviceReleaser } from "@delacour/warden-leasing/device-lease";
import { ReleasedDeviceShutdown, type ShutdownOutcome } from "@delacour/warden-leasing/device-shutdown";
import { inventoryMarker } from "@delacour/warden-leasing/inventory";
import { LeaseSelection, leaseSelectorRules, NOTHING_SELECTED } from "@delacour/warden-leasing/lease-select";
import { ownerResolver } from "@delacour/warden-leasing/owner";
import type { ReleaseJson } from "@delacour/warden-sdk/contracts/leases";
import { type Lease, leaseModel } from "@delacour/warden-store/types";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { leaseHostFromContext } from "../lease-host";
import { type SelectOptionValues, selectorFrom, withSelectOptions } from "../lease-select";
import { emit, note, plural, reportError } from "../output";
import { releaseAfter } from "../perf/release-after";
import { withSpinner } from "../spinner-context";
import { describeResource } from "./ls";

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
		const profile = record?.profile ?? inventoryMarker.profileOf(name);
		if (!record && profile === undefined) {
			notes.push(`${name} (${id}) is not a warden device — released, not quarantined`);
			continue;
		}
		store.quarantineDevice({ platform, id, name, ...(profile !== undefined ? { profile } : {}) }, reason, ctx.now());
		quarantined.push(id);
	}
	return { quarantined, notes };
}

type Picked = { kind: "ids"; ids: string[] } | { kind: "exit"; code: number };

/**
 * `warden release` with no selector: in a terminal, offer every lease in a menu (the caller's own start
 * listed first and ticked); otherwise — or for `--json`, or with nothing leased — it stays the usage error.
 */
async function pickLeases(ctx: CommandContext, opts: ReleaseOpts): Promise<Picked> {
	const { ui } = ctx;
	const all = ctx.store().listLeases();
	if (!ui.interactive || opts.json || all.length === 0) {
		reportError(ctx, "release", NOTHING_SELECTED);
		return { kind: "exit", code: 1 };
	}
	const me = ownerResolver.resolve(ctx);
	const mineFirst = [...all].sort(
		(a, b) => Number(leaseModel.sameOwner(b.owner, me)) - Number(leaseModel.sameOwner(a.owner, me))
	);
	const answer = await ui.multiselect(
		"Release which leases?",
		mineFirst.map((l) => ({
			value: l.id,
			label: `${describeResource(l.resource)}${l.label ? ` [${l.label}]` : ""}`,
			hint: `${leaseModel.describeOwner(l.owner)} · ${l.id}`,
			selected: leaseModel.sameOwner(l.owner, me),
		}))
	);
	if (answer === undefined) {
		ui.cancelled("Aborted.");
		return { kind: "exit", code: 1 };
	}
	if (answer.length === 0) {
		note(ctx, "nothing selected");
		return { kind: "exit", code: 0 };
	}
	return { kind: "ids", ids: answer };
}

/**
 * Release the selected leases; with `--shutdown`, first shut down the devices warden may shut down and stop every
 * released device's `warden-simd`. Without it the helper stays resident for the next run (idle timeout reaps it).
 */
async function release(ctx: CommandContext, ids: string[], opts: ReleaseOpts): Promise<number> {
	const { color } = ctx.ui;
	const selector = selectorFrom(ids, opts);
	const picked = leaseSelectorRules.isEmpty(selector) ? await pickLeases(ctx, opts) : { kind: "ids" as const, ids };
	if (picked.kind === "exit") return picked.code;
	const { leases, unknown } = new LeaseSelection(ctx).select({ ...selector, ids: picked.ids });
	const devices = leases.filter((l) => l.resource.kind === "device");
	const { shutdown, notes }: ShutdownOutcome =
		opts.shutdown && devices.length > 0
			? await withSpinner(ctx, `shutting down ${devices.length} device(s)…`, async (sctx, spinner) => {
					const outcome = await new ReleasedDeviceShutdown(leaseHostFromContext(sctx)).run(
						leases,
						ownerResolver.resolve(ctx)
					);
					spinner.succeed(
						outcome.shutdown.length > 0 ? `shut down ${outcome.shutdown.join(" ")}` : "nothing to shut down"
					);
					return outcome;
				})
			: { shutdown: [], notes: [], kept: [] };
	const bad =
		opts.bad !== undefined
			? quarantineReleased(ctx, leases, typeof opts.bad === "string" ? opts.bad : undefined)
			: { quarantined: [], notes: [] };
	await new DeviceReleaser(ctx).release(
		leases.map((l) => l.id),
		{ after: releaseAfter(ctx, { helper: opts.shutdown === true }) }
	);

	for (const u of unknown) reportError(ctx, "release", `no lease for ${u}`);
	const title = { scope: "release", detail: plural(leases.length, "lease") };
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
	const doc: ReleaseJson = {
		released: leases.map((l) => l.id),
		shutdown,
		quarantined: bad.quarantined,
		unknown,
		notes: [...notes, ...bad.notes],
	};
	emit(ctx, opts.json === true, doc, text, title);
	return unknown.length > 0 ? 1 : 0;
}

export const releaseCommand = defineCommand({
	name: "release",
	group: "Lease",
	summary: "release leases (optionally shut down devices warden created)",
	register: (cmd, ctx, done) => {
		withSelectOptions(cmd.argument("[leaseIds...]", "lease ids to release"))
			.option("--shutdown", "also shut down devices warden created (or the lease owner booted)")
			.option("--bad [reason]", "also quarantine the released devices (warden devices only) so claims skip them")
			.option("--json", "machine-readable output")
			.action(async (ids, opts) => done(await release(ctx, ids, opts)));
	},
});

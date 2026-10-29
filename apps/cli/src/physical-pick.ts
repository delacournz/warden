import { isLeaseAlive, processAlive } from "@delacour/warden-core/liveness";
import { type InventoryDevice, isPhysicalReady, type Owner, type Platform } from "@delacour/warden-core/types";
import { type ClaimFlags, withPhysicalAllowlist } from "./claim-flags";
import type { CommandContext } from "./context";
import { formatTable } from "./output";
import { providerFor } from "./providers";

/** The hint every `ambiguous_device` physical claim carries. */
export const AMBIGUOUS_HINT = "pass --udid <id> (iOS) / --serial <id> (Android), or set WARDEN_PHYSICAL_IDS";

/** One usable physical device, as the picker, the table and the JSON error show it. */
export type PhysicalCandidate = {
	id: string;
	name: string;
	platform: Platform;
	model: string | null;
	osVersion: string | null;
	/** `usb` / `wifi` (android), `wired` / `localNetwork` (ios) */
	transport: string;
};

/** What `pickPhysical` decided: claim with these flags, ask the caller to choose, or stop. */
export type PhysicalPick =
	| { kind: "ok"; flags: ClaimFlags[] }
	| { kind: "ambiguous"; platform: Platform; candidates: PhysicalCandidate[] }
	| { kind: "cancelled" }
	| { kind: "failed"; message: string };

const TRANSPORT_LABEL: Record<string, string> = {
	usb: "USB",
	wifi: "Wi-Fi",
	wired: "wired",
	localNetwork: "network",
};

function candidateOf(d: InventoryDevice): PhysicalCandidate {
	const p = d.physical;
	const api = d.runtime?.match(/^android-(\d+)$/)?.[1];
	return {
		id: d.id,
		name: d.name,
		platform: d.platform,
		model: p?.platform === "ios" ? p.deviceType : (p?.model ?? null),
		osVersion: p?.platform === "ios" ? p.osVersion : api !== undefined ? `API ${api}` : null,
		transport: p?.transport ?? "unknown",
	};
}

/** `Name · model · OS · transport` for the picker. */
function labelOf(c: PhysicalCandidate): string {
	const parts = [c.name, c.model !== c.name ? c.model : null, c.osVersion, TRANSPORT_LABEL[c.transport] ?? c.transport];
	return parts.filter((p): p is string => p !== null && p !== "").join(" · ");
}

type Found = { ok: true; list: PhysicalCandidate[] } | { ok: false; message: string };

/** Ready, reachable, unleased, allowlisted physical devices of the claim's platform, minus `taken`. */
async function candidatesFor(
	ctx: CommandContext,
	owner: Owner,
	flags: ClaimFlags,
	taken: ReadonlySet<string>
): Promise<Found> {
	const { request } = flags;
	const inventory = await providerFor(
		request.platform,
		ctx,
		owner,
		request.platform === "ios" ? { physical: true } : {}
	).inventory();
	if (!inventory.success) return { ok: false, message: inventory.error };
	const now = ctx.now();
	const held = new Set<string>();
	for (const l of ctx.store().listLeases()) {
		if (l.resource.kind === "device" && isLeaseAlive(l, now, processAlive)) {
			held.add(`${l.resource.platform}:${l.resource.id}`);
		}
	}
	const allow = request.physical?.allow;
	const list = inventory.data
		.filter(
			(d) =>
				d.platform === request.platform &&
				isPhysicalReady(d) &&
				(allow === undefined || allow.includes(d.id)) &&
				!held.has(`${d.platform}:${d.id}`) &&
				!taken.has(d.id)
		)
		.map(candidateOf);
	return { ok: true, list };
}

/**
 * Decide, once and before any lease or build, which physical device an id-less `--physical` claim takes. One
 * candidate: as today (the claim picks it). Several: a picker when `opts.prompt`, else `ambiguous`. A chosen
 * device is named (`physical.ids`), so the claim's own transaction re-checks it and a device taken meanwhile fails there.
 * Several legs choose in turn, each from what the earlier ones left.
 */
export async function pickPhysical(
	ctx: CommandContext,
	owner: Owner,
	flags: readonly ClaimFlags[],
	opts: { prompt: boolean }
): Promise<PhysicalPick> {
	const taken = new Set<string>();
	const out: ClaimFlags[] = [];
	for (const f of flags) {
		const one = await pickOne(ctx, owner, f, { taken, alone: flags.length === 1, prompt: opts.prompt });
		if (one.kind !== "ok") return one;
		out.push(one.flags[0] ?? f);
	}
	return { kind: "ok", flags: out };
}

/** One claim's decision; `taken` holds what earlier legs chose and gains this leg's choice. */
async function pickOne(
	ctx: CommandContext,
	owner: Owner,
	f: ClaimFlags,
	o: { taken: Set<string>; alone: boolean; prompt: boolean }
): Promise<PhysicalPick> {
	if (!f.request.physical || f.request.physical.ids !== undefined) return { kind: "ok", flags: [f] };
	const allowed = await withPhysicalAllowlist(ctx, f.request);
	if (!allowed.success) return { kind: "failed", message: allowed.error };
	const withAllow: ClaimFlags = { ...f, request: allowed.data };
	const found = await candidatesFor(ctx, owner, withAllow, o.taken);
	if (!found.ok) return { kind: "failed", message: found.message };
	const { list } = found;
	const only = list[0];
	if (only === undefined || (list.length === 1 && o.alone)) return { kind: "ok", flags: [withAllow] };
	let chosen: string | undefined = list.length === 1 ? only.id : undefined;
	if (chosen === undefined) {
		if (!o.prompt) return { kind: "ambiguous", platform: f.request.platform, candidates: list };
		chosen = await ctx.ui.select(
			`Which ${f.request.platform === "ios" ? "iPhone / iPad" : "Android phone"}?`,
			list.map((c) => ({ value: c.id, label: labelOf(c) }))
		);
		if (chosen === undefined) {
			ctx.ui.cancelled("Aborted.");
			return { kind: "cancelled" };
		}
	}
	o.taken.add(chosen);
	return { kind: "ok", flags: [{ ...withAllow, request: { ...withAllow.request, physical: { ids: [chosen] } } }] };
}

/** May the picker be shown: a terminal, no `--json`, no `--yes`. */
export const canPrompt = (ctx: CommandContext, o: { json?: boolean | undefined; yes?: boolean | undefined }): boolean =>
	ctx.ui.interactive && o.json !== true && o.yes !== true;

/** The `ambiguous_device` message, one line. */
export function ambiguousMessage(platform: Platform, candidates: readonly PhysicalCandidate[]): string {
	return `several physical ${platform} devices are available: ${candidates.map((c) => `${c.id} (${c.name})`).join(", ")}`;
}

/** Candidates as a table (plain text). */
export function candidateTable(candidates: readonly PhysicalCandidate[]): string {
	return formatTable(
		["ID", "NAME", "MODEL", "OS", "TRANSPORT"],
		candidates.map((c) => [
			c.id,
			c.name,
			c.model ?? "-",
			c.osVersion ?? "-",
			TRANSPORT_LABEL[c.transport] ?? c.transport,
		])
	);
}

/**
 * Report a non-`ok` pick for command `scope` and return the exit code: 2 for `ambiguous` (the `--json` envelope
 * carries `ambiguous_device`, the hint and `details.candidates`), 1 otherwise.
 */
export function reportPick(ctx: CommandContext, scope: string, pick: Exclude<PhysicalPick, { kind: "ok" }>): 1 | 2 {
	if (pick.kind === "cancelled") return 1;
	if (pick.kind === "failed") {
		ctx.failure?.record(pick.message);
		ctx.err(ctx.ui.color.red(`warden ${scope}: ${pick.message}`));
		return 1;
	}
	const message = ambiguousMessage(pick.platform, pick.candidates);
	ctx.failure?.record(message, {
		code: "ambiguous_device",
		hint: AMBIGUOUS_HINT,
		details: { candidates: pick.candidates },
	});
	ctx.err(ctx.ui.color.red(`warden ${scope}: ${message}`));
	ctx.err(candidateTable(pick.candidates));
	ctx.err(ctx.ui.color.dim(AMBIGUOUS_HINT));
	return 2;
}

/** `pickPhysical` over a run's claim: its legs when it has them, else its one `flags`; returns the args with the chosen devices named. */
export async function pickPhysicalArgs<
	T extends { flags: ClaimFlags; legs?: Array<{ flags: ClaimFlags }> | undefined },
>(
	ctx: CommandContext,
	owner: Owner,
	args: T,
	opts: { prompt: boolean }
): Promise<{ kind: "ok"; args: T } | Exclude<PhysicalPick, { kind: "ok" }>> {
	const legs = args.legs ?? [];
	const picked = await pickPhysical(ctx, owner, legs.length > 0 ? legs.map((leg) => leg.flags) : [args.flags], opts);
	if (picked.kind !== "ok") return picked;
	if (legs.length > 0)
		return {
			kind: "ok",
			args: { ...args, legs: legs.map((leg, i) => ({ ...leg, flags: picked.flags[i] ?? leg.flags })) },
		};
	return { kind: "ok", args: { ...args, flags: picked.flags[0] ?? args.flags } };
}

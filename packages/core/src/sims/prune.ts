/**
 * Side-effect half of `warden sims audit|prune` (see `audit.ts` / `rules.ts`): list every sim,
 * judge it against the store, and delete the warden-owned ones the rules say `prune` may
 * (`canPrune`) through the shared `deleteSims` path. A sim leased since the audit is skipped.
 */
import { type AsyncResult, ok } from "@delacour/warden-types/result";
import type { PidAlive } from "../liveness";
import { auditSims, type SimAudit } from "./audit";
import { type DeleteDeps, deleteSims } from "./delete";
import { listAllSims } from "./list";
import { canPrune, judgeSims, type RulesInput, type SimEntry, type SimRuleOpts } from "./rules";

export type SimsDeps = DeleteDeps & { pidAlive: PidAlive };

export type SimsPruneOpts = SimRuleOpts & { dryRun: boolean };

export type SimsPruneResult = {
	audit: SimAudit;
	dryRun: boolean;
	removed: SimEntry[];
	/** leased by someone between the audit and the delete */
	skipped: SimEntry[];
	failed: Array<{ entry: SimEntry; error: string }>;
	freedBytes: number;
};

async function rulesInput(deps: SimsDeps, opts: SimRuleOpts): AsyncResult<RulesInput> {
	const sims = await listAllSims(deps.exec);
	if (!sims.success) return sims;
	return ok({
		...opts,
		sims: sims.data,
		records: deps.store.listDevices("ios"),
		leases: deps.store.listLeases(),
		now: deps.now(),
		pidAlive: deps.pidAlive,
	});
}

/** Every sim on the machine, judged (input order) — what `warden sims delete` lists. */
export async function judgeMachineSims(deps: SimsDeps, opts: SimRuleOpts): AsyncResult<SimEntry[]> {
	const input = await rulesInput(deps, opts);
	return input.success ? ok(judgeSims(input.data)) : input;
}

export async function auditMachineSims(deps: SimsDeps, opts: SimRuleOpts): AsyncResult<SimAudit> {
	const input = await rulesInput(deps, opts);
	return input.success ? ok(auditSims(input.data)) : input;
}

const bytesOf = (entries: readonly SimEntry[]) => entries.reduce((s, e) => s + e.bytes, 0);

export async function pruneSims(deps: SimsDeps, opts: SimsPruneOpts): AsyncResult<SimsPruneResult> {
	const audit = await auditMachineSims(deps, opts);
	if (!audit.success) return audit;
	const candidates = audit.data.entries.filter(canPrune);
	if (opts.dryRun)
		return ok({
			audit: audit.data,
			dryRun: true,
			removed: candidates,
			skipped: [],
			failed: [],
			freedBytes: bytesOf(candidates),
		});
	const result = await deleteSims(deps, candidates, { label: "sims prune" });
	return ok({
		audit: audit.data,
		dryRun: false,
		removed: result.removed,
		skipped: result.skipped.map((s) => s.entry),
		failed: result.failed,
		freedBytes: bytesOf(result.removed),
	});
}

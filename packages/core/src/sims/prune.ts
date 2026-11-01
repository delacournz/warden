/**
 * Side-effect half of `warden sims audit|prune` (see `audit.ts` / `rules.ts`): list every sim,
 * judge it against the store, and delete the warden-owned ones the rules say `prune` may
 * (`canPrune`) through the shared `deleteSims` path. A sim leased since the audit is skipped.
 */

import { SimctlLister } from "@delacour/warden-providers/simctl-list";
import type { PidAlive } from "@delacour/warden-store/liveness";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { type SimAudit, simAuditor } from "./audit";
import { type DeleteDeps, SimDeleter } from "./delete";
import { type RulesInput, type SimEntry, type SimRuleOpts, simRules } from "./rules";

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

export class SimsPruner {
	constructor(private readonly deps: SimsDeps) {}

	/** Every sim on the machine, judged (input order) — what `warden sims delete` lists. */
	async judge(opts: SimRuleOpts): AsyncResult<SimEntry[]> {
		const input = await this.rulesInput(opts);
		return input.success ? resultFactory.ok(simRules.judge(input.data)) : input;
	}

	async audit(opts: SimRuleOpts): AsyncResult<SimAudit> {
		const input = await this.rulesInput(opts);
		return input.success ? resultFactory.ok(simAuditor.report(input.data)) : input;
	}

	async prune(opts: SimsPruneOpts): AsyncResult<SimsPruneResult> {
		const audit = await this.audit(opts);
		if (!audit.success) return audit;
		const candidates = audit.data.entries.filter(simRules.canPrune);
		if (opts.dryRun)
			return resultFactory.ok({
				audit: audit.data,
				dryRun: true,
				removed: candidates,
				skipped: [],
				failed: [],
				freedBytes: this.bytesOf(candidates),
			});
		const result = await new SimDeleter(this.deps).run(candidates, { label: "sims prune" });
		return resultFactory.ok({
			audit: audit.data,
			dryRun: false,
			removed: result.removed,
			skipped: result.skipped.map((s) => s.entry),
			failed: result.failed,
			freedBytes: this.bytesOf(result.removed),
		});
	}

	private async rulesInput(opts: SimRuleOpts): AsyncResult<RulesInput> {
		const { deps } = this;
		const sims = await new SimctlLister(deps.exec).listAll();
		if (!sims.success) return sims;
		return resultFactory.ok({
			...opts,
			sims: sims.data,
			records: deps.store.listDevices("ios"),
			leases: deps.store.listLeases(),
			now: deps.now(),
			pidAlive: deps.pidAlive,
		});
	}

	private bytesOf(entries: readonly SimEntry[]): number {
		return entries.reduce((s, e) => s + e.bytes, 0);
	}
}

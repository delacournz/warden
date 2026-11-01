/**
 * Disk audit of every simulator on the machine (`listAllSims`): the per-sim rules (`rules.ts`)
 * plus totals — what warden can free (`prune`), what only the user can (`sims delete`), budget.
 * Pure: inputs injected.
 */
import { type RulesInput, type SimEntry, simRules } from "./rules";

export type SimAudit = {
	entries: SimEntry[];
	totalBytes: number;
	/** bytes warden would free (`delete` verdicts) */
	reclaimableBytes: number;
	/** bytes of foreign sims with a hint — only the user can free these */
	foreignReclaimableBytes: number;
	/** total after warden's deletes */
	afterBytes: number;
	maxBytes?: number;
	/** still over `maxBytes` after warden's deletes */
	overBudget: boolean;
};

export class SimAuditor {
	/** Entries sorted by size (largest first), then name. */
	report(input: RulesInput): SimAudit {
		const entries = simRules.judge(input).sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
		const totalBytes = this.sum(entries);
		const reclaimableBytes = this.sum(entries.filter((e) => e.verdict.kind === "delete"));
		const afterBytes = totalBytes - reclaimableBytes;
		const report: SimAudit = {
			entries,
			totalBytes,
			reclaimableBytes,
			foreignReclaimableBytes: this.sum(
				entries.filter((e) => e.verdict.kind === "foreign" && e.verdict.hint !== undefined)
			),
			afterBytes,
			overBudget: input.maxBytes !== undefined && afterBytes > input.maxBytes,
		};
		if (input.maxBytes !== undefined) report.maxBytes = input.maxBytes;
		return report;
	}

	private sum(entries: readonly SimEntry[]): number {
		return entries.reduce((s, e) => s + e.bytes, 0);
	}
}

export const simAuditor = new SimAuditor();

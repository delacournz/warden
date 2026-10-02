/**
 * Disk audit of every simulator on the machine (`listAllSims`): the per-sim rules (`rules.ts`)
 * plus totals — what warden can free (`prune`), what only the user can (`sims delete`), budget.
 * Pure: inputs injected.
 */
import { judgeSims, type RulesInput, type SimEntry } from "./rules";

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

const sum = (entries: readonly SimEntry[]) => entries.reduce((s, e) => s + e.bytes, 0);

/** Entries sorted by size (largest first), then name. */
export function auditSims(input: RulesInput): SimAudit {
	const entries = judgeSims(input).sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
	const totalBytes = sum(entries);
	const reclaimableBytes = sum(entries.filter((e) => e.verdict.kind === "delete"));
	const afterBytes = totalBytes - reclaimableBytes;
	const report: SimAudit = {
		entries,
		totalBytes,
		reclaimableBytes,
		foreignReclaimableBytes: sum(entries.filter((e) => e.verdict.kind === "foreign" && e.verdict.hint !== undefined)),
		afterBytes,
		overBudget: input.maxBytes !== undefined && afterBytes > input.maxBytes,
	};
	if (input.maxBytes !== undefined) report.maxBytes = input.maxBytes;
	return report;
}

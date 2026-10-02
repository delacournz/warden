/**
 * Disk audit of every simulator on the machine (`simctl list devices -j`, all platforms, including
 * unavailable runtimes): size, owner, lease, last use — and which ones warden may delete.
 *
 * Only warden-created sims are ever `delete`; goldens belong to `golden prune`, and foreign sims are
 * read-only here (they get a `hint`; the user deletes them with `warden sims delete`). Pure: inputs injected.
 */
import { type GoldenSim, isGoldenName } from "../golden/golden";
import { shortRuntime } from "../providers/ios";
import type { DeviceRecord } from "../store";

export type SimOwner = "warden" | "golden" | "foreign";

export type SimVerdict =
	| { kind: "keep"; reason: "leased" | "booted" | "golden" | "recent" }
	| { kind: "delete"; reason: "unavailable-runtime" | "orphan" | "idle" | "budget" }
	| { kind: "foreign"; hint?: "unavailable-runtime" | "idle" };

export type SimAuditEntry = {
	udid: string;
	name: string;
	runtimeId: string;
	/** short runtime, e.g. `iOS-26-5` */
	runtime: string;
	state: string;
	isAvailable: boolean;
	bytes: number;
	owner: SimOwner;
	leased: boolean;
	/** latest of warden's `lastUsedAt` and simctl's `lastBootedAt` */
	lastUsedAt?: number;
	verdict: SimVerdict;
};

export type AuditInput = {
	sims: readonly GoldenSim[];
	records: readonly DeviceRecord[];
	/** udids with a device lease (any liveness: a stale lease is gc's to reclaim first) */
	leased: ReadonlySet<string>;
	now: number;
	idleMs: number;
	/** disk budget for all sims; least-recently-used warden sims are marked `budget` until under it */
	maxBytes?: number;
};

export type SimAudit = {
	entries: SimAuditEntry[];
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

const WARDEN_NAME = /^warden-(.+)-\d+$/;

function ownerOf(sim: GoldenSim, record: DeviceRecord | undefined): SimOwner {
	if (isGoldenName(sim.name)) return "golden";
	return record || WARDEN_NAME.test(sim.name) ? "warden" : "foreign";
}

function latest(...times: Array<number | undefined>): number | undefined {
	const known = times.filter((t): t is number => t !== undefined);
	return known.length > 0 ? Math.max(...known) : undefined;
}

function verdictFor(
	entry: Omit<SimAuditEntry, "verdict">,
	record: DeviceRecord | undefined,
	input: AuditInput
): SimVerdict {
	const idle = entry.lastUsedAt === undefined || input.now - entry.lastUsedAt >= input.idleMs;
	if (entry.owner === "golden") return { kind: "keep", reason: "golden" };
	if (entry.owner === "foreign") {
		if (!entry.isAvailable) return { kind: "foreign", hint: "unavailable-runtime" };
		return entry.lastUsedAt !== undefined && idle ? { kind: "foreign", hint: "idle" } : { kind: "foreign" };
	}
	if (entry.leased) return { kind: "keep", reason: "leased" };
	if (entry.state !== "Shutdown") return { kind: "keep", reason: "booted" };
	if (!entry.isAvailable) return { kind: "delete", reason: "unavailable-runtime" };
	if (!record) return { kind: "delete", reason: "orphan" };
	return idle ? { kind: "delete", reason: "idle" } : { kind: "keep", reason: "recent" };
}

const deletable = (e: SimAuditEntry) => e.verdict.kind === "delete";
const sum = (entries: readonly SimAuditEntry[]) => entries.reduce((s, e) => s + e.bytes, 0);

export function auditSims(input: AuditInput): SimAudit {
	const records = new Map(input.records.filter((r) => r.platform === "ios").map((r) => [r.id, r]));
	const entries = input.sims.map((sim): SimAuditEntry => {
		const record = records.get(sim.udid);
		const lastUsedAt = latest(record?.lastUsedAt, sim.lastBootedAt);
		const base: Omit<SimAuditEntry, "verdict"> = {
			udid: sim.udid,
			name: sim.name,
			runtimeId: sim.runtimeId,
			runtime: shortRuntime(sim.runtimeId),
			state: sim.state,
			isAvailable: sim.isAvailable,
			bytes: sim.dataPathSize ?? 0,
			owner: ownerOf(sim, record),
			leased: input.leased.has(sim.udid),
			...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
		};
		return { ...base, verdict: verdictFor(base, record, input) };
	});
	const totalBytes = sum(entries);
	let afterBytes = totalBytes - sum(entries.filter(deletable));
	if (input.maxBytes !== undefined && afterBytes > input.maxBytes) {
		const lru = entries
			.filter((e) => e.verdict.kind === "keep" && e.verdict.reason === "recent")
			.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
		for (const e of lru) {
			if (afterBytes <= input.maxBytes) break;
			e.verdict = { kind: "delete", reason: "budget" };
			afterBytes -= e.bytes;
		}
	}
	entries.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
	const report: SimAudit = {
		entries,
		totalBytes,
		reclaimableBytes: sum(entries.filter(deletable)),
		foreignReclaimableBytes: sum(entries.filter((e) => e.verdict.kind === "foreign" && e.verdict.hint !== undefined)),
		afterBytes,
		overBudget: input.maxBytes !== undefined && afterBytes > input.maxBytes,
	};
	if (input.maxBytes !== undefined) report.maxBytes = input.maxBytes;
	return report;
}

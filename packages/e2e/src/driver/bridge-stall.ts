import { z } from "zod";
import { noteSpanDetail, type SpanDetail } from "./span-detail";

/**
 * What one iOS `axbridge` fallback or stall looked like, as `warden-simd` reports it (`fallback.stall` on a snapshot,
 * `detail.stall` on a failed read). Recorded in `trace.jsonl` (the `stall*` span fields), `results.jsonl` (`bridge`)
 * and under the header of `screen-at-failure.txt`.
 */
export const bridgeStallSchema = z.looseObject({
	/** `connect` (no bridge reader), `read` (a bridge read stalled or failed), `warm-up` (joined a stalled warm-up read), `cooldown` (skipped after a stall) */
	stage: z.string(),
	/** how long the bridge read ran; absent when the bridge was not asked */
	readMs: z.number().optional(),
	/** the deadline that read had (the cold one while the guest is cold) */
	deadlineMs: z.number().optional(),
	/** how long the AX guests had been up */
	guestAgeMs: z.number().optional(),
	/** the guest had not answered since it last went cold (helper start, recycle, launch) */
	cold: z.boolean(),
	/** what is left of the stall cooldown; absent when none is armed */
	cooldownRemainingMs: z.number().optional(),
	/** bridge reads that failed in a row, this one included */
	probes: z.number(),
	/** stalled guests the helper recycled before this read; absent while none was */
	recycles: z.number().optional(),
	/** every recycle the helper may do was spent before this read; absent while some are left */
	recyclesExhausted: z.boolean().optional(),
	/** `checking`: both readers were silent on this read and the helper checks the sim for a wedged accessibility service */
	axWedge: z.string().optional(),
	/** backboardd restarts the helper made before this read; absent while none was */
	axWedgeRestarts: z.number().optional(),
});

export type BridgeStall = {
	stage: string;
	readMs?: number;
	deadlineMs?: number;
	guestAgeMs?: number;
	cold: boolean;
	cooldownRemainingMs?: number;
	probes: number;
	recycles?: number;
	recyclesExhausted?: boolean;
	axWedge?: string;
	axWedgeRestarts?: number;
};

/** Span field ↔ stall field; booleans and numbers stay scalars. */
const SPAN_FIELDS = [
	["stallStage", "stage"],
	["stallReadMs", "readMs"],
	["stallDeadlineMs", "deadlineMs"],
	["stallGuestAgeMs", "guestAgeMs"],
	["stallCold", "cold"],
	["stallCooldownMs", "cooldownRemainingMs"],
	["stallProbes", "probes"],
	["stallRecycles", "recycles"],
	["stallRecyclesExhausted", "recyclesExhausted"],
	["stallAxWedge", "axWedge"],
	["stallAxWedgeRestarts", "axWedgeRestarts"],
] as const satisfies readonly (readonly [string, keyof BridgeStall])[];

/** Only the fields of the schema, so a newer helper's extra keys stay off the span and out of the results. */
export function toBridgeStall(wire: z.infer<typeof bridgeStallSchema>): BridgeStall {
	const stall: BridgeStall = { stage: wire.stage, cold: wire.cold, probes: wire.probes };
	if (wire.readMs !== undefined) stall.readMs = wire.readMs;
	if (wire.deadlineMs !== undefined) stall.deadlineMs = wire.deadlineMs;
	if (wire.guestAgeMs !== undefined) stall.guestAgeMs = wire.guestAgeMs;
	if (wire.cooldownRemainingMs !== undefined) stall.cooldownRemainingMs = wire.cooldownRemainingMs;
	if (wire.recycles !== undefined) stall.recycles = wire.recycles;
	if (wire.recyclesExhausted !== undefined) stall.recyclesExhausted = wire.recyclesExhausted;
	if (wire.axWedge !== undefined) stall.axWedge = wire.axWedge;
	if (wire.axWedgeRestarts !== undefined) stall.axWedgeRestarts = wire.axWedgeRestarts;
	return stall;
}

/** Leaves the stall on the span timing the read (`stallStage`, `stallReadMs`, …). */
export function noteBridgeStall(stall: BridgeStall): void {
	for (const [key, field] of SPAN_FIELDS) {
		const value = stall[field];
		if (value !== undefined) noteSpanDetail(key, value);
	}
}

/** The stall a span recorded, or undefined when it has none. */
export function bridgeStallFromSpan(detail: SpanDetail | undefined): BridgeStall | undefined {
	const stage = detail?.stallStage;
	if (detail === undefined || typeof stage !== "string") return undefined;
	const stall: BridgeStall = {
		stage,
		cold: detail.stallCold === true,
		probes: typeof detail.stallProbes === "number" ? detail.stallProbes : 0,
	};
	const numbers = [
		["stallReadMs", "readMs"],
		["stallDeadlineMs", "deadlineMs"],
		["stallGuestAgeMs", "guestAgeMs"],
		["stallCooldownMs", "cooldownRemainingMs"],
		["stallRecycles", "recycles"],
		["stallAxWedgeRestarts", "axWedgeRestarts"],
	] as const;
	for (const [key, field] of numbers) {
		const value = detail[key];
		if (typeof value === "number") stall[field] = value;
	}
	if (typeof detail.stallRecyclesExhausted === "boolean") stall.recyclesExhausted = detail.stallRecyclesExhausted;
	if (typeof detail.stallAxWedge === "string") stall.axWedge = detail.stallAxWedge;
	return stall;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** The wedged-accessibility-service part of the line. */
function axWedgeParts(stall: BridgeStall): string[] {
	const parts: string[] = [];
	if (stall.axWedge === "checking") parts.push("both readers silent: checking for a wedged accessibility service");
	if (stall.axWedgeRestarts !== undefined) {
		parts.push(`backboardd restarted ${stall.axWedgeRestarts} time${stall.axWedgeRestarts === 1 ? "" : "s"}`);
	}
	return parts;
}

/** One line for a log or a report: `stage read · read 4012 ms of a 4000 ms deadline · warm · …`. */
export function formatBridgeStall(stall: BridgeStall): string {
	const parts = [`stage ${stall.stage}`];
	if (stall.readMs !== undefined) {
		parts.push(
			stall.deadlineMs === undefined
				? `read ${stall.readMs} ms`
				: `read ${stall.readMs} ms of a ${stall.deadlineMs} ms deadline`
		);
	} else if (stall.deadlineMs !== undefined) parts.push(`${stall.deadlineMs} ms deadline`);
	parts.push(stall.cold ? "cold (first read)" : "warm");
	if (stall.guestAgeMs !== undefined) parts.push(`guest ${seconds(stall.guestAgeMs)} old`);
	if (stall.cooldownRemainingMs !== undefined) parts.push(`cooldown ${seconds(stall.cooldownRemainingMs)} left`);
	parts.push(`${stall.probes} failed bridge reads in a row`);
	if (stall.recycles !== undefined) {
		const guests = stall.recycles === 1 ? "guest" : "guests";
		parts.push(`${stall.recycles} stalled ${guests} recycled${stall.recyclesExhausted === true ? ", none left" : ""}`);
	}
	return [...parts, ...axWedgeParts(stall)].join(" · ");
}

/**
 * Flow file migrations, applied to the raw JSON before validation. v1 → v2 is renames only: `rotate`, `appearance` and
 * `screenshot` became `screen` steps, `swipe` and `longpress` became `gesture` steps (the swipe's `gesture` object is
 * flattened into the step). Anything that is not a v1 flow passes through untouched; the schema rejects what it cannot read.
 */

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

const SCREEN_KINDS: ReadonlySet<string> = new Set(["rotate", "appearance", "screenshot"]);

function migrateStep(step: unknown): unknown {
	if (!isRecord(step) || typeof step.kind !== "string") return step;
	const { kind, ...rest } = step;
	if (SCREEN_KINDS.has(kind)) return { kind: "screen", type: kind, ...rest };
	if (kind === "longpress") return { kind: "gesture", type: "longpress", ...rest };
	if (kind === "swipe") {
		const { gesture, ...fields } = rest;
		return { kind: "gesture", type: "swipe", ...fields, ...(isRecord(gesture) ? gesture : {}) };
	}
	return step;
}

/** v1 → v2; v2 and unknown versions are returned as they are. */
export function migrateFlow(raw: unknown): unknown {
	if (!isRecord(raw) || raw.v !== 1) return raw;
	const steps = Array.isArray(raw.steps) ? raw.steps.map(migrateStep) : raw.steps;
	return { ...raw, v: 2, steps };
}

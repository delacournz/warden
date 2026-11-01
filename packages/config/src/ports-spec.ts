import type { Result } from "@delacour/warden-types/result";
import { resultFactory } from "@delacour/warden-types/result";

/** Span used when a spec has no `:span` (mirrors salient's `pickPort` 20-port scan). */
export const DEFAULT_PORT_SPAN = 20;
export const MAX_PORT = 65_535;

export type PortRange = { from: number; span: number };

export function checkRange(from: number, span: number): Result<PortRange> {
	if (!Number.isInteger(from) || from < 1 || from > MAX_PORT)
		return resultFactory.err(`invalid port ${from} (1–${MAX_PORT})`);
	if (!Number.isInteger(span) || span < 1) return resultFactory.err(`invalid span ${span} (must be ≥ 1)`);
	if (from + span - 1 > MAX_PORT) return resultFactory.err(`port range ${from}–${from + span - 1} exceeds ${MAX_PORT}`);
	return resultFactory.ok({ from, span });
}

/**
 * `8091:20` → `{ from: 8091, span: 20 }`; bare `8091` → span `DEFAULT_PORT_SPAN`. Pure: no store, no sockets
 * (the bind probe and claiming live in `ports.ts`), so config schemas can validate specs.
 */
export function parsePortSpec(spec: string): Result<PortRange> {
	const match = /^(\d+)(?::(\d+))?$/.exec(spec.trim());
	if (!match?.[1]) return resultFactory.err(`invalid port spec "${spec}" (use <from>[:<span>], e.g. 8091:20)`);
	return checkRange(Number(match[1]), match[2] === undefined ? DEFAULT_PORT_SPAN : Number(match[2]));
}

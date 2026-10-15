import type { Element, Snapshot } from "./driver.types";

export type SettleDeps = {
	quietMs: number;
	timeoutMs: number;
	/** monotonic-ish clock in ms */
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	/** gap between polls, default 50 */
	pollMs?: number;
};

export type SettleOutcome = { quiet: boolean; waitedMs: number };

/** A screen counts as settled once its hash stayed equal this long (`device.settle`, `warden ui --settle`). */
export const DEFAULT_SETTLE_QUIET_MS = 250;
/** How long a settle waits for quiet before it gives up. */
export const DEFAULT_SETTLE_TIMEOUT_MS = 3000;

const DEFAULT_POLL_MS = 50;

/**
 * Snapshot-hash settle: poll a UI fingerprint until it stays unchanged for `quietMs`
 * (two consecutive equal hashes and ≥ quietMs since the last change), or give up at `timeoutMs`.
 * Side effects are injected so tests drive a fake clock.
 */
export async function settleByHash(poll: () => Promise<string>, deps: SettleDeps): Promise<SettleOutcome> {
	const { quietMs, timeoutMs, now, sleep } = deps;
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
	const start = now();
	let previous = await poll();
	let lastChange = now();
	for (;;) {
		const elapsed = now() - start;
		if (elapsed >= timeoutMs) return { quiet: false, waitedMs: elapsed };
		await sleep(Math.min(pollMs, Math.max(0, timeoutMs - elapsed)));
		const hash = await poll();
		const t = now();
		if (hash !== previous) {
			previous = hash;
			lastChange = t;
		} else if (t - lastChange >= quietMs) {
			return { quiet: true, waitedMs: t - start };
		}
		if (t - start >= timeoutMs) return { quiet: false, waitedMs: t - start };
	}
}

function tuple(element: Element): string {
	const { x, y, width, height } = element.frame;
	return JSON.stringify([
		element.role,
		element.identifier ?? null,
		element.label ?? null,
		element.value ?? null,
		Math.round(x),
		Math.round(y),
		Math.round(width),
		Math.round(height),
	]);
}

/** Stable fingerprint over `(role, identifier, label, value, frame)` of every node in preorder. */
export function snapshotHash(snapshot: Pick<Snapshot, "flat">): string {
	let text = "";
	for (const element of snapshot.flat) text += `${tuple(element)}\n`;
	return Bun.hash(text).toString(36);
}

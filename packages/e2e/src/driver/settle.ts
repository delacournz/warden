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

/** How a settle decided: the helper's quiescence `stream`, the helper's `snapshot` stability fallback, or client-side snapshot `hash` polling. */
export type SettleVia = "stream" | "snapshot" | "hash";

/**
 * What a driver's `settle` may report beyond the frozen `{ quiet, waitedMs }` of `Driver["settle"]` (a driver
 * returns this wider object; the contract in `driver.types.ts` is unchanged). iOS passes the helper's reply through:
 * `via`, `reason` (`frontmost_mismatch` when the launched app never came to the front, `helper_timeout` when the
 * helper answered after the client's padded timer) and `frontmostPid`. Android says `snapshot` when one `uiautomator dump`
 * covered the whole quiet window and `hash` when it compared successive dumps; the iOS hash fallback says `hash`.
 */
export type SettleDetail = SettleOutcome & { via?: SettleVia; reason?: string; frontmostPid?: number };

const isVia = (value: unknown): value is SettleVia => value === "stream" || value === "snapshot" || value === "hash";

/** The extra fields of a settle reply, kept when they have the right type. `Driver["settle"]` is typed narrower than it answers. */
export function settleDetailOf(outcome: SettleOutcome): SettleDetail {
	const reply: Record<string, unknown> = { ...outcome };
	const { via, reason, frontmostPid } = reply;
	return {
		quiet: outcome.quiet,
		waitedMs: outcome.waitedMs,
		...(isVia(via) ? { via } : {}),
		...(typeof reason === "string" ? { reason } : {}),
		...(typeof frontmostPid === "number" ? { frontmostPid } : {}),
	};
}

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

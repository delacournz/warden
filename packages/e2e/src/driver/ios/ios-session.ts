import type { Result } from "@delacour/warden-types/result";
import type { DriverError, Logger } from "../driver.types";
import { driverError } from "../errors";
import type { SimdClient } from "./simd-client";

/** The slice of {@link SimdClient} the iOS driver uses; the driver holds this, never a raw client. */
export type DriverClient = Pick<SimdClient, "request" | "ready" | "close">;

export type Reopen = () => Promise<Result<SimdClient, DriverError>>;

export type SwappableClient = {
	client: DriverClient;
	/** bumps on every restart, so a caller can tell "someone already restarted it" from "still the stale one" */
	generation(): number;
	/**
	 * Replace the helper: ask the current one to `shutdown`, drop it, `reopen()` (socket first, else a
	 * fresh stdio spawn). Single-flight; a caller whose `seenGeneration` is already stale just returns ok.
	 * `crashed`: the helper (or the connection to it) is already gone, so nothing is asked of it; asking
	 * would only make a stdio client respawn a helper to shut it down.
	 */
	restart(seenGeneration: number, o?: { crashed?: boolean }): Promise<Result<void, DriverError>>;
};

const SHUTDOWN_TIMEOUT_MS = 500;

/**
 * Wraps the helper client so it can be swapped at runtime (bridge-stale recovery) and so every
 * request's latency can be logged (`debug`, driven by `WARDEN_E2E_DEBUG=1`): `[ios] op snapshot 31 ms`.
 */
export function swappableClient(
	initial: SimdClient,
	o: { now: () => number; log?: Logger; debug?: boolean; reopen?: Reopen }
): SwappableClient {
	let current = initial;
	let generation = 0;
	let restarting: Promise<Result<void, DriverError>> | undefined;

	const request = async (op: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
		const started = o.now();
		const result = await current.request(op, params, opts);
		if (o.debug) {
			const failure = result.success ? "" : ` ${result.error.code}`;
			o.log?.(`[ios] op ${op} ${Math.round(o.now() - started)} ms${failure}`);
		}
		return result;
	};

	const client: DriverClient = {
		get ready() {
			return current.ready;
		},
		request: request as SimdClient["request"],
		close: () => current.close(),
	};

	async function doRestart(crashed: boolean): Promise<Result<void, DriverError>> {
		const { reopen } = o;
		if (!reopen) return { success: false, error: driverError("E_INTERNAL", "no way to reopen warden-simd") };
		const stale = current;
		// A shared socket daemon only stops if asked; a stdio helper would be asked by close() anyway.
		if (!crashed) await stale.request("shutdown", {}, { timeoutMs: SHUTDOWN_TIMEOUT_MS });
		await stale.close();
		const next = await reopen();
		if (!next.success) return next;
		current = next.data;
		generation += 1;
		return { success: true, data: undefined };
	}

	return {
		client,
		generation: () => generation,
		restart(seenGeneration, r) {
			if (seenGeneration !== generation) return Promise.resolve({ success: true, data: undefined });
			restarting ??= doRestart(r?.crashed === true).finally(() => {
				restarting = undefined;
			});
			return restarting;
		},
	};
}

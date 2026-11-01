import type { DriverError, Logger } from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import type { Result } from "@delacour/warden-types/result";
import type { SimdClient } from "./simd-client";

/** The slice of {@link SimdClient} the iOS driver uses; the driver holds this, never a raw client. */
export type DriverClient = Pick<SimdClient, "request" | "ready" | "close">;

export type Reopen = () => Promise<Result<SimdClient, DriverError>>;

export type SwappableClientOptions = { now: () => number; log?: Logger; debug?: boolean; reopen?: Reopen };

/** What the iOS driver needs of a {@link SwappableClient}: the stable client, a generation counter and a restart. */
export type SwapPort = {
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
export class SwappableClient implements SwapPort {
	private current: SimdClient;
	private currentGeneration = 0;
	private restarting: Promise<Result<void, DriverError>> | undefined;

	constructor(
		initial: SimdClient,
		private readonly o: SwappableClientOptions
	) {
		this.current = initial;
	}

	/** The client the driver holds: it always forwards to the current helper. */
	get client(): DriverClient {
		return this;
	}

	get ready(): SimdClient["ready"] {
		return this.current.ready;
	}

	close(): ReturnType<SimdClient["close"]> {
		return this.current.close();
	}

	/** bumps on every restart, so a caller can tell "someone already restarted it" from "still the stale one" */
	generation(): number {
		return this.currentGeneration;
	}

	/**
	 * Replace the helper: ask the current one to `shutdown`, drop it, `reopen()` (socket first, else a
	 * fresh stdio spawn). Single-flight; a caller whose `seenGeneration` is already stale just returns ok.
	 * `crashed`: the helper (or the connection to it) is already gone, so nothing is asked of it; asking
	 * would only make a stdio client respawn a helper to shut it down.
	 */
	restart(seenGeneration: number, r?: { crashed?: boolean }): Promise<Result<void, DriverError>> {
		if (seenGeneration !== this.currentGeneration) return Promise.resolve({ success: true, data: undefined });
		this.restarting ??= this.doRestart(r?.crashed === true).finally(() => {
			this.restarting = undefined;
		});
		return this.restarting;
	}

	request = (async (op: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
		const started = this.o.now();
		const result = await this.current.request(op, params, opts);
		if (this.o.debug) {
			const failure = result.success ? "" : ` ${result.error.code}`;
			this.o.log?.(`[ios] op ${op} ${Math.round(this.o.now() - started)} ms${failure}`);
		}
		return result;
	}) as SimdClient["request"];

	private async doRestart(crashed: boolean): Promise<Result<void, DriverError>> {
		const { reopen } = this.o;
		if (!reopen) return { success: false, error: driverErrors.make("E_INTERNAL", "no way to reopen warden-simd") };
		const stale = this.current;
		// A shared socket daemon only stops if asked; a stdio helper would be asked by close() anyway.
		if (!crashed) await stale.request("shutdown", {}, { timeoutMs: SHUTDOWN_TIMEOUT_MS });
		await stale.close();
		const next = await reopen();
		if (!next.success) return next;
		this.current = next.data;
		this.currentGeneration += 1;
		return { success: true, data: undefined };
	}
}

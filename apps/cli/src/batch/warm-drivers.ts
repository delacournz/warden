import { join } from "node:path";
import type { BatchWorker } from "@delacour/warden-core/batch/schedule";
import type { AsyncResult } from "@delacour/warden-types/result";

/** A running socket helper for one device, as the warm step needs it. */
export type WarmHelper = {
	/** where jobs reach it (`WARDEN_SIMD_SOCKET`) */
	socketPath: string;
	/** one UI snapshot: makes the in-sim bridge resident */
	snapshot: () => AsyncResult<unknown>;
	/** stop the helper */
	close: () => Promise<void>;
};

/** Connect to (spawning when needed) the socket helper of one device. */
export type WarmConnect = (udid: string) => AsyncResult<WarmHelper>;

export const WARM_TIMEOUT_MS = 120_000;

/** One device's warm-up outcome. */
export type Warmed = {
	worker: number;
	udid: string;
	ok: boolean;
	/** the helper's socket, when it is warm */
	socketPath?: string;
	/** why it is not warm (only ever a warning) */
	error?: string;
	log: string;
};

export type WarmRun = {
	/** the iOS devices to warm */
	devices: readonly BatchWorker[];
	logDir: string;
	now: () => number;
	/** run `fn` once after `ms`; returns cancel */
	after: (ms: number, fn: () => void) => () => void;
	writeFile: (path: string, data: string) => Promise<void>;
	/** SIGINT: stop waiting (helpers that come up late are closed) */
	signal?: AbortSignal;
};

export type WarmDeps = {
	connect: WarmConnect;
	timeoutMs?: number;
	/** a warning line for the terminal */
	warn?: (line: string) => void;
};

export type WarmOutcome = {
	devices: Warmed[];
	/** the helpers that are warm: close them when the run ends */
	helpers: WarmHelper[];
};

type Step = { helper?: WarmHelper; error?: string };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `connect` then one snapshot; never throws. A helper that connects but cannot snapshot is closed. */
async function warmOne(connect: WarmConnect, udid: string, note: (line: string) => void): Promise<Step> {
	let helper: WarmHelper;
	try {
		const connected = await connect(udid);
		if (!connected.success) return { error: connected.error };
		helper = connected.data;
	} catch (error) {
		return { error: message(error) };
	}
	note(`connected ${helper.socketPath}`);
	try {
		const shot = await helper.snapshot();
		if (shot.success) return { helper };
		await helper.close().catch(() => {});
		return { error: `snapshot failed: ${shot.error}` };
	} catch (error) {
		await helper.close().catch(() => {});
		return { error: `snapshot failed: ${message(error)}` };
	}
}

/**
 * Per device, in parallel: connect the socket helper and take one snapshot, so the in-sim bridge is
 * resident before the first job. Each device logs to `<logDir>/warm-<worker>.log`. Failures, the
 * timeout and an interrupt only leave that device cold (a late helper is closed); this never throws.
 */
export async function warmDrivers(run: WarmRun, deps: WarmDeps): Promise<WarmOutcome> {
	const helpers: WarmHelper[] = [];
	const devices = await Promise.all(
		run.devices.map(async (device): Promise<Warmed> => {
			const lines: string[] = [];
			const note = (line: string) => lines.push(`[${new Date(run.now()).toISOString()}] ${line}`);
			const log = join(run.logDir, `warm-${device.worker}.log`);
			note(`warming ${device.udid}`);
			const pending = warmOne(deps.connect, device.udid, note);
			let late = false;
			const step = await new Promise<Step>((resolve) => {
				const finish = (s: Step) => {
					cancel();
					run.signal?.removeEventListener("abort", onAbort);
					resolve(s);
				};
				const cancel = run.after(deps.timeoutMs ?? WARM_TIMEOUT_MS, () => {
					late = true;
					finish({ error: `timed out after ${(deps.timeoutMs ?? WARM_TIMEOUT_MS) / 1000}s` });
				});
				const onAbort = () => {
					late = true;
					finish({ error: "interrupted" });
				};
				run.signal?.addEventListener("abort", onAbort, { once: true });
				if (run.signal?.aborted) onAbort();
				void pending.then(finish);
			});
			if (late) void pending.then((s) => s.helper?.close().catch(() => {}));
			if (step.helper) {
				helpers.push(step.helper);
				note("snapshot ok — bridge resident");
			} else {
				note(`not warm: ${step.error}`);
				deps.warn?.(`warm ${device.udid}: ${step.error} (continuing cold) — log: ${log}`);
			}
			await run.writeFile(log, `${lines.join("\n")}\n`).catch(() => {});
			return {
				worker: device.worker,
				udid: device.udid,
				ok: step.helper !== undefined,
				...(step.helper ? { socketPath: step.helper.socketPath } : {}),
				...(step.error !== undefined ? { error: step.error } : {}),
				log,
			};
		})
	);
	return { devices, helpers };
}

import { join } from "node:path";
import type { BatchWorker } from "@delacour/warden-core/batch/schedule";
import type { AsyncResult } from "@delacour/warden-types/result";

/** A running socket helper for one device, as the warm step needs it. */
export type WarmHelper = {
	/** where jobs reach it (`WARDEN_SIMD_SOCKET`) */
	socketPath: string;
	/** one UI snapshot: makes the in-sim bridge resident */
	snapshot: () => AsyncResult<unknown>;
	/** disconnect from the helper; it stays resident for the jobs and after the run */
	close: () => Promise<void>;
	/**
	 * stop the helper process itself (and disconnect): for a helper whose device will run its jobs cold, which
	 * would otherwise each spawn a helper of their own beside it (two quiescence streams on one sim, 20-1)
	 */
	stop?: () => Promise<void>;
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
	/** one device's outcome the moment it settles (its helper when warm, its warning when not), before the others */
	onDevice?: (device: Warmed, helper: WarmHelper | undefined, warning: string | undefined) => void;
};

export type WarmOutcome = {
	devices: Warmed[];
	/** the helpers that are warm: close them when the run ends */
	helpers: WarmHelper[];
};

type Step = { helper?: WarmHelper; error?: string };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A helper whose device goes cold: stopped when it can be (else only disconnected); never throws. */
const discard = (helper: WarmHelper): Promise<void> => (helper.stop ? helper.stop() : helper.close()).catch(() => {});

/**
 * `connect` then one snapshot; never throws. A helper that connects but cannot snapshot is stopped: it may be
 * wedged, so the device's jobs are not handed its socket, and it must not stay resident beside their own helpers.
 */
async function coldHelper(helper: WarmHelper, note: (line: string) => void): Promise<void> {
	await discard(helper);
	note(helper.stop ? "stopped the helper: this device's jobs start their own" : "closed the helper");
}

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
		await coldHelper(helper, note);
		return { error: `snapshot failed: ${shot.error}` };
	} catch (error) {
		await coldHelper(helper, note);
		return { error: `snapshot failed: ${message(error)}` };
	}
}

/**
 * Per device, in parallel: connect the socket helper and take one snapshot, so the in-sim bridge is
 * resident before the first job. Each device logs to `<logDir>/warm-<worker>.log`. Failures, the
 * timeout and an interrupt only leave that device cold; this never throws. A helper that arrives after
 * the timeout is stopped (its device's jobs run cold); after an interrupt it is only disconnected.
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
			let late: "timeout" | "interrupt" | undefined;
			const step = await new Promise<Step>((resolve) => {
				const finish = (s: Step) => {
					cancel();
					run.signal?.removeEventListener("abort", onAbort);
					resolve(s);
				};
				const cancel = run.after(deps.timeoutMs ?? WARM_TIMEOUT_MS, () => {
					late = "timeout";
					finish({ error: `timed out after ${(deps.timeoutMs ?? WARM_TIMEOUT_MS) / 1000}s` });
				});
				const onAbort = () => {
					late = "interrupt";
					finish({ error: "interrupted" });
				};
				run.signal?.addEventListener("abort", onAbort, { once: true });
				if (run.signal?.aborted) onAbort();
				void pending.then(finish);
			});
			if (late === "timeout") void pending.then((s) => (s.helper ? discard(s.helper) : undefined));
			else if (late === "interrupt") void pending.then((s) => s.helper?.close().catch(() => {}));
			let warning: string | undefined;
			if (step.helper) {
				helpers.push(step.helper);
				note("snapshot ok — bridge resident");
			} else {
				note(`not warm: ${step.error}`);
				warning = `warm ${device.udid}: ${step.error} (continuing cold) — log: ${log}`;
				deps.warn?.(warning);
			}
			await run.writeFile(log, `${lines.join("\n")}\n`).catch(() => {});
			const warmed: Warmed = {
				worker: device.worker,
				udid: device.udid,
				ok: step.helper !== undefined,
				...(step.helper ? { socketPath: step.helper.socketPath } : {}),
				...(step.error !== undefined ? { error: step.error } : {}),
				log,
			};
			deps.onDevice?.(warmed, step.helper, warning);
			return warmed;
		})
	);
	return { devices, helpers };
}

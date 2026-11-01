import type {
	DriverError,
	DriverResult,
	Logger,
	Point,
	ScreenInfo,
	Snapshot,
} from "@delacour/warden-driver/driver.types";
import type { GesturePlan } from "@delacour/warden-driver/gesture-geometry";
import type { SettleDetail } from "@delacour/warden-driver/settle";
import { spanDetails } from "@delacour/warden-driver/trace/span-detail";
import { DEFAULT_LONG_PRESS_MS, DEFAULT_SWIPE_MS, DRAG_STEPS } from "./android-argv";
import { androidDevice, type Clock } from "./android-device";
import type { UiadBackend } from "./uiad-backend";
import { type UiadClient, uiadClients } from "./uiad-client";
import type { UiadSnapshotData } from "./uiad-protocol";
import { uiautomatorParser } from "./uiautomator";

/**
 * What the Android driver asks of `warden-uiad`, one method per thing the server does faster than `uiautomator dump`
 * and `input`. Every method answers `undefined` when the server is not the way to do that call (it is off, it could
 * not start, or it refused this one op) and the driver then does it the old way; a result, success or error, is final.
 *
 * Which failures fall back and which are surfaced:
 * - the op was refused (`E_HID`, `E_NO_ELEMENT`, `E_UNSUPPORTED`): nothing happened, the server is fine, this call
 *   falls back (a `typeText` with nothing focused is typed by `input text` as before);
 * - the server died, hung or sent nonsense: it is stopped, so the dump can have UiAutomation again, and the next call
 *   starts a new one. A read (`snapshot`, `settle`, `selectAll`) falls back; a tap, swipe, key or typed text is
 *   surfaced, because it may have happened and doing it twice is worse than a failed step;
 * - the request never left (the server had already gone): started again and sent again, once.
 */

/** A settled `DriverResult`. */
type Res<T> = Awaited<DriverResult<T>>;

export type Maybe<T> = Promise<Res<T> | undefined>;

export type UiadOps = {
	/** the server is on and has not been given up on: what `capabilities` reports */
	enabled(): boolean;
	/** `up`, `idle`, `busy`, or `off: <why>`: for `health` */
	status(): string;
	snapshot(): Maybe<Snapshot>;
	settle(opts: { quietMs: number; timeoutMs: number }): Maybe<SettleDetail>;
	tap(point: Point, opts?: { count?: number; durationMs?: number }): Maybe<void>;
	longPress(point: Point, durationMs?: number): Maybe<void>;
	swipe(from: Point, to: Point, durationMs?: number): Maybe<void>;
	drag(from: Point, to: Point, timing: { pressMs: number; durationMs: number; releaseMs: number }): Maybe<void>;
	/** replay a 1-2 finger plan as one multi-pointer MotionEvent stream (`gesture` op, server 0.3.0+) */
	gesture(plan: GesturePlan): Maybe<void>;
	key(keyCode: number, times?: number): Maybe<void>;
	selectAll(): Maybe<void>;
	typeText(text: string): Maybe<void>;
	/** replace the whole text of the focused input (`ACTION_SET_TEXT`); `undefined` = refused or no server */
	setText(text: string): Maybe<void>;
	stop(): Promise<void>;
};

export type UiadOpsDeps = {
	backend: UiadBackend;
	baseScreen: ScreenInfo;
	clock: Clock;
	log?: Logger;
};

/** The wire has no `E_HID` for "nothing was injected" vs "some was": a refusal means the server could not inject at all. */
const REFUSALS: ReadonlySet<DriverError["code"]> = new Set(["E_HID", "E_NO_ELEMENT", "E_UNSUPPORTED"]);

/** uiautomator fails transiently (`null root node`) while a window is opening; a few quick retries ride it out. */
const SNAPSHOT_ATTEMPTS = 3;
const SNAPSHOT_RETRY_MS = 400;
/**
 * After text or a key went in, the app needs a moment to take it: a controlled React Native input sends the change to
 * JS and back, and a tap that arrives in that window is lost (measured: the next press on a button was dropped 3 times
 * in 20 when it followed `typeText` by about 20 ms, never once when it followed a quiet of 50 ms or more). `input text`
 * and `input keyevent` took 300 ms or more to start, which hid it; the server returns in 20 ms, so it waits for the
 * accessibility events to stop itself.
 */
const EDIT_QUIET_MS = 80;
const EDIT_QUIET_TIMEOUT_MS = 1_000;
const KEY_GAP_MS = 30;
const KEY_BASE_TIMEOUT_MS = 10_000;
const KEY_PRESS_BUDGET_MS = 150;
const ok = { success: true as const, data: undefined };

class UiadSnapshots {
	/** `null root node`: the window is not there yet. (A busy slot is also `E_AX_UNAVAILABLE`, but it never comes from a request.) */
	isNoWindowYet(error: DriverError): boolean {
		return error.code === "E_AX_UNAVAILABLE" && !uiadClients.isBusy(error);
	}

	/** The `Snapshot` the driver builds from a server reply: the same tree the dump of that screen gives. */
	snapshotFromUiad(data: UiadSnapshotData, baseScreen: ScreenInfo, takenAt: number): Snapshot {
		const screen = androidDevice.rotatedScreen(baseScreen, data.screen.rotation ?? 0);
		return {
			platform: "android",
			backend: "uiautomator",
			takenAt,
			screen,
			...uiautomatorParser.parseUiadNodes(data.elements, screen),
			truncated: data.truncated,
		};
	}

	mapVoid<T>(result: Res<T>): Res<void> {
		return result.success ? ok : result;
	}
}

export const uiadSnapshots = new UiadSnapshots();

/** The driver's view of `warden-uiad`: one method per op, with the fallback rules in the header. */
export class UiadOpsService implements UiadOps {
	constructor(private readonly deps: UiadOpsDeps) {}

	enabled(): boolean {
		return this.deps.backend.wanted();
	}

	status(): string {
		return this.deps.backend.status();
	}

	snapshot(): Maybe<Snapshot> {
		return this.readSnapshot();
	}

	settle(opts: { quietMs: number; timeoutMs: number }): Maybe<SettleDetail> {
		return this.readSettle(opts);
	}

	tap(point: Point, opts?: { count?: number; durationMs?: number }): Maybe<void> {
		return this.effect("tap", {
			x: point.x,
			y: point.y,
			...(opts?.count !== undefined && opts.count > 1 ? { count: opts.count } : {}),
			...(opts?.durationMs ? { holdMs: opts.durationMs } : {}),
		});
	}

	longPress(point: Point, durationMs = DEFAULT_LONG_PRESS_MS): Maybe<void> {
		return this.effect("tap", { x: point.x, y: point.y, holdMs: durationMs });
	}

	swipe(from: Point, to: Point, durationMs = DEFAULT_SWIPE_MS): Maybe<void> {
		return this.effect("swipe", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, durationMs });
	}

	drag(from: Point, to: Point, timing: { pressMs: number; durationMs: number; releaseMs: number }): Maybe<void> {
		return this.effect(
			"swipe",
			{
				x1: from.x,
				y1: from.y,
				x2: to.x,
				y2: to.y,
				durationMs: timing.durationMs,
				pressMs: timing.pressMs,
				releaseMs: timing.releaseMs,
				steps: DRAG_STEPS,
			},
			{ timeoutMs: KEY_BASE_TIMEOUT_MS + timing.pressMs + timing.durationMs + timing.releaseMs }
		);
	}

	gesture(plan: GesturePlan): Maybe<void> {
		return this.effect(
			"gesture",
			{ paths: plan.paths, frameMs: plan.frameMs, holdMs: plan.holdMs, releaseMs: plan.releaseMs },
			{ timeoutMs: KEY_BASE_TIMEOUT_MS + plan.totalMs }
		);
	}

	key(keyCode: number, times = 1): Maybe<void> {
		return this.edit("key", (server) =>
			server.request(
				"key",
				{ keyCode, ...(times > 1 ? { times, gapMs: KEY_GAP_MS } : {}) },
				{ timeoutMs: KEY_BASE_TIMEOUT_MS + times * KEY_PRESS_BUDGET_MS }
			)
		);
	}

	selectAll(): Maybe<void> {
		return this.call("selectAll", async (server) => uiadSnapshots.mapVoid(await server.request("selectAll")), true);
	}

	typeText(text: string): Maybe<void> {
		return this.edit("typeText", (server) => server.typeText(text));
	}

	setText(text: string): Maybe<void> {
		return this.edit("setText", (server) => server.request("setText", { text }));
	}

	stop(): Promise<void> {
		return this.deps.backend.stop();
	}

	/** The error to return when the slot is held by something else (the dump needs the same slot and would only say "Killed"). */
	private blocked(): Res<never> | undefined {
		const error = this.deps.backend.blocked();
		return error === undefined ? undefined : { success: false, error };
	}

	/** What a failed request means for the call: this one is done the old way, again on a new server, or it is the error. */
	private async judge(op: string, error: DriverError, canRetry: boolean): Promise<"fallback" | "retry" | "surface"> {
		if (REFUSALS.has(error.code)) {
			this.deps.log?.(`uiad ${op} refused (${error.code}: ${error.message}); doing it the old way`);
			return "fallback";
		}
		await this.deps.backend.failed(error);
		return uiadClients.neverSent(error) && canRetry ? "retry" : "surface";
	}

	/** One request that has an effect or a read-back, with the fallback rules in the header. */
	private async call<T>(op: string, use: (server: UiadClient) => DriverResult<T>, idempotent: boolean): Maybe<T> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const server = await this.deps.backend.server();
			if (server === undefined) return undefined;
			const res = await use(server);
			if (res.success) return res;
			const verdict = await this.judge(op, res.error, attempt === 0);
			if (verdict === "surface" && !idempotent) return res;
			if (verdict !== "retry") return undefined;
		}
		return undefined;
	}

	private effect(op: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }): Maybe<void> {
		return this.call(op, async (server) => uiadSnapshots.mapVoid(await server.request(op, params, opts)), false);
	}

	/** The effect, then, when it went in, the quiet the app needs to take an edit (see `EDIT_QUIET_MS`). */
	private edit(op: string, send: (server: UiadClient) => DriverResult<unknown>): Maybe<void> {
		return this.call(
			op,
			async (server) => {
				const sent = uiadSnapshots.mapVoid(await send(server));
				if (sent.success) await server.settle({ quietMs: EDIT_QUIET_MS, timeoutMs: EDIT_QUIET_TIMEOUT_MS });
				return sent;
			},
			false
		);
	}

	private async readSnapshot(): Maybe<Snapshot> {
		const { backend, clock, log } = this.deps;
		for (let attempt = 1; ; attempt++) {
			const server = await backend.server();
			if (server === undefined) return this.blocked();
			const res = await server.snapshot();
			if (res.success) {
				spanDetails.note("backend", "uiad");
				spanDetails.note("uiadMs", res.data.ms);
				return {
					success: true,
					data: uiadSnapshots.snapshotFromUiad(res.data, this.deps.baseScreen, clock.now()),
				};
			}
			if (!uiadSnapshots.isNoWindowYet(res.error)) {
				await backend.failed(res.error);
				return undefined;
			}
			if (attempt >= SNAPSHOT_ATTEMPTS) return res;
			log?.(`uiad: no window to read yet, retrying (${attempt}/${SNAPSHOT_ATTEMPTS - 1})`);
			await clock.sleep(SNAPSHOT_RETRY_MS);
		}
	}

	private async readSettle(opts: { quietMs: number; timeoutMs: number }): Maybe<SettleDetail> {
		const server = await this.deps.backend.server();
		if (server === undefined) return this.blocked();
		const res = await server.settle(opts);
		if (!res.success) {
			await this.deps.backend.failed(res.error);
			return undefined;
		}
		spanDetails.note("backend", "uiad");
		spanDetails.note("via", "stream");
		const { quiet, waitedMs, reason } = res.data;
		return {
			success: true,
			data: { quiet, waitedMs, via: "stream", ...(reason !== undefined ? { reason } : {}) },
		};
	}
}

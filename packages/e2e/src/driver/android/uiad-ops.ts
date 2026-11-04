import { type A11yEventsRead, parseUiadA11yEvents } from "../a11y-events";
import type { DriverError, DriverResult, Element, Logger, Point, ScreenInfo, Snapshot } from "../driver.types";
import { driverErr } from "../errors";
import type { GesturePlan } from "../gesture-geometry";
import type { SettleDetail } from "../settle";
import { noteSpanDetail } from "../span-detail";
import { DEFAULT_LONG_PRESS_MS, DEFAULT_SWIPE_MS, DRAG_STEPS } from "./android-argv";
import { type Clock, rotatedScreen } from "./android-device";
import type { UiadBackend } from "./uiad-backend";
import { isBusy, neverSent, type UiadClient } from "./uiad-client";
import type { UiadSnapshotData } from "./uiad-protocol";
import {
	parseScrolled,
	parseSrEvents,
	parseSrFocus,
	parseSrFocused,
	type SrEventsRead,
	type SrFocusRead,
} from "./uiad-screen-reader";
import { parseUiadNodes } from "./uiautomator";

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
	/** announcements and live-region changes since a cursor (`a11yEvents` op, server 0.5.0+) */
	a11yEvents(since?: number): Maybe<A11yEventsRead>;
	/** move accessibility focus one stop (`dir`) or to the stop at a point (`srFocus` op, server 0.6.0+) */
	srFocus(target: { dir: "next" | "prev" } | { point: Point }): Maybe<SrFocusRead>;
	/** the node holding accessibility focus (`srFocused`, 0.6.0+) */
	srFocused(): Maybe<Element | undefined>;
	/** `ACTION_CLICK` on the focused node's clickable ancestor (`srActivate`, 0.6.0+) */
	srActivate(): Maybe<void>;
	/** accessibility-focus moves since a cursor (`srEvents`, 0.6.0+) */
	srEvents(since?: number): Maybe<SrEventsRead>;
	/** `ACTION_CLICK` on the clickable node at a point, no touch injected (`actionClick`, 0.6.0+) */
	actionClick(point: Point): Maybe<void>;
	/** `ACTION_SCROLL_FORWARD|BACKWARD` on the scrollable at a point, else the largest on screen; answers whether it moved (`actionScroll`, 0.6.0+) */
	actionScroll(dir: "forward" | "backward", point?: Point): Maybe<boolean>;
	/** run the Accessibility Test Framework on the active window (`audit` op, server 0.5.0+); `undefined` = no server */
	audit(opts: { contrast: boolean }): Maybe<unknown>;
	stop(): Promise<void>;
};

export type UiadOpsDeps = {
	backend: UiadBackend;
	baseScreen: ScreenInfo;
	clock: Clock;
	log?: Logger;
	/** puts `warden-atf.jar` on the device and names it; without it `audit` answers `undefined` */
	atf?: () => DriverResult<string> | Promise<Res<string>>;
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
const AUDIT_TIMEOUT_MS = 30_000;
const ok = { success: true as const, data: undefined };

/** `null root node`: the window is not there yet. (A busy slot is also `E_AX_UNAVAILABLE`, but it never comes from a request.) */
function isNoWindowYet(error: DriverError): boolean {
	return error.code === "E_AX_UNAVAILABLE" && !isBusy(error);
}

/** The `Snapshot` the driver builds from a server reply: the same tree the dump of that screen gives. */
export function snapshotFromUiad(data: UiadSnapshotData, baseScreen: ScreenInfo, takenAt: number): Snapshot {
	const screen = rotatedScreen(baseScreen, data.screen.rotation ?? 0);
	return {
		platform: "android",
		backend: "uiautomator",
		takenAt,
		screen,
		...parseUiadNodes(data.elements, screen),
		truncated: data.truncated,
	};
}

export function createUiadOps(deps: UiadOpsDeps): UiadOps {
	const { backend, clock, log } = deps;

	/** The error to return when the slot is held by something else (the dump needs the same slot and would only say "Killed"). */
	const blocked = (): Res<never> | undefined => {
		const error = backend.blocked();
		return error === undefined ? undefined : { success: false, error };
	};

	/** What a failed request means for the call: this one is done the old way, again on a new server, or it is the error. */
	async function judge(op: string, error: DriverError, canRetry: boolean): Promise<"fallback" | "retry" | "surface"> {
		if (REFUSALS.has(error.code)) {
			log?.(`uiad ${op} refused (${error.code}: ${error.message}); doing it the old way`);
			return "fallback";
		}
		await backend.failed(error);
		return neverSent(error) && canRetry ? "retry" : "surface";
	}

	/** One request that has an effect or a read-back, with the fallback rules in the header. */
	async function call<T>(
		op: string,
		use: (server: UiadClient) => DriverResult<T>,
		idempotent: boolean,
		surfaceRefusals = false
	): Maybe<T> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const server = await backend.server();
			if (server === undefined) return undefined;
			const res = await use(server);
			if (res.success) return res;
			// a screen-reader op that is refused has an answer for the caller ("nothing is focused"), not a way to do it otherwise
			if (surfaceRefusals && REFUSALS.has(res.error.code)) return res;
			const verdict = await judge(op, res.error, attempt === 0);
			if (verdict === "surface" && !idempotent) return res;
			if (verdict !== "retry") return undefined;
		}
		return undefined;
	}

	const effect = (op: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }): Maybe<void> =>
		call(op, async (server) => mapVoid(await server.request(op, params, opts)), false);

	/** The effect, then, when it went in, the quiet the app needs to take an edit (see `EDIT_QUIET_MS`). */
	const edit = (op: string, send: (server: UiadClient) => DriverResult<unknown>): Maybe<void> =>
		call(
			op,
			async (server) => {
				const sent = mapVoid(await send(server));
				if (sent.success) await server.settle({ quietMs: EDIT_QUIET_MS, timeoutMs: EDIT_QUIET_TIMEOUT_MS });
				return sent;
			},
			false
		);

	async function snapshot(): Maybe<Snapshot> {
		for (let attempt = 1; ; attempt++) {
			const server = await backend.server();
			if (server === undefined) return blocked();
			const res = await server.snapshot();
			if (res.success) {
				noteSpanDetail("backend", "uiad");
				noteSpanDetail("uiadMs", res.data.ms);
				return { success: true, data: snapshotFromUiad(res.data, deps.baseScreen, clock.now()) };
			}
			if (!isNoWindowYet(res.error)) {
				await backend.failed(res.error);
				return undefined;
			}
			if (attempt >= SNAPSHOT_ATTEMPTS) return res;
			log?.(`uiad: no window to read yet, retrying (${attempt}/${SNAPSHOT_ATTEMPTS - 1})`);
			await clock.sleep(SNAPSHOT_RETRY_MS);
		}
	}

	async function settle(opts: { quietMs: number; timeoutMs: number }): Maybe<SettleDetail> {
		const server = await backend.server();
		if (server === undefined) return blocked();
		const res = await server.settle(opts);
		if (!res.success) {
			await backend.failed(res.error);
			return undefined;
		}
		noteSpanDetail("backend", "uiad");
		noteSpanDetail("via", "stream");
		const { quiet, waitedMs, reason } = res.data;
		return {
			success: true,
			data: { quiet, waitedMs, via: "stream", ...(reason !== undefined ? { reason } : {}) },
		};
	}

	return {
		enabled: backend.wanted,
		status: backend.status,
		snapshot,
		settle,
		tap: (point, opts) =>
			effect("tap", {
				x: point.x,
				y: point.y,
				...(opts?.count !== undefined && opts.count > 1 ? { count: opts.count } : {}),
				...(opts?.durationMs ? { holdMs: opts.durationMs } : {}),
			}),
		longPress: (point, durationMs = DEFAULT_LONG_PRESS_MS) =>
			effect("tap", { x: point.x, y: point.y, holdMs: durationMs }),
		swipe: (from, to, durationMs = DEFAULT_SWIPE_MS) =>
			effect("swipe", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, durationMs }),
		drag: (from, to, timing) =>
			effect(
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
			),
		gesture: (plan) =>
			effect(
				"gesture",
				{ paths: plan.paths, frameMs: plan.frameMs, holdMs: plan.holdMs, releaseMs: plan.releaseMs },
				{ timeoutMs: KEY_BASE_TIMEOUT_MS + plan.totalMs }
			),
		key: (keyCode, times = 1) =>
			edit("key", (server) =>
				server.request(
					"key",
					{ keyCode, ...(times > 1 ? { times, gapMs: KEY_GAP_MS } : {}) },
					{ timeoutMs: KEY_BASE_TIMEOUT_MS + times * KEY_PRESS_BUDGET_MS }
				)
			),
		selectAll: () => call("selectAll", async (server) => mapVoid(await server.request("selectAll")), true),
		typeText: (text) => edit("typeText", (server) => server.typeText(text)),
		setText: (text) => edit("setText", (server) => server.request("setText", { text })),
		a11yEvents: (since) =>
			call(
				"a11yEvents",
				async (server) => {
					const res = await server.request("a11yEvents", since ? { since } : {});
					if (!res.success) return res;
					const parsed = parseUiadA11yEvents(res.data);
					return parsed.success ? { success: true, data: parsed.data } : driverErr("E_INTERNAL", parsed.error);
				},
				true
			),
		srFocus: (target) =>
			call(
				"srFocus",
				async (server) => {
					const params = "dir" in target ? { dir: target.dir } : { x: target.point.x, y: target.point.y };
					const res = await server.request("srFocus", params);
					if (!res.success) return res;
					const parsed = parseSrFocus(res.data, deps.baseScreen);
					return parsed.success ? { success: true, data: parsed.data } : driverErr("E_INTERNAL", parsed.error);
				},
				false,
				true
			),
		srFocused: () =>
			call(
				"srFocused",
				async (server) => {
					const res = await server.request("srFocused");
					if (!res.success) return res;
					const parsed = parseSrFocused(res.data, deps.baseScreen);
					return parsed.success ? { success: true, data: parsed.data } : driverErr("E_INTERNAL", parsed.error);
				},
				true
			),
		srActivate: () => call("srActivate", async (server) => mapVoid(await server.request("srActivate")), false, true),
		srEvents: (since) =>
			call(
				"srEvents",
				async (server) => {
					const res = await server.request("srEvents", since ? { since } : {});
					if (!res.success) return res;
					const parsed = parseSrEvents(res.data, deps.baseScreen);
					return parsed.success ? { success: true, data: parsed.data } : driverErr("E_INTERNAL", parsed.error);
				},
				true
			),
		actionClick: (point) => effect("actionClick", { x: point.x, y: point.y }),
		actionScroll: (dir, point) =>
			call(
				"actionScroll",
				async (server) => {
					const res = await server.request("actionScroll", { dir, ...(point ? { x: point.x, y: point.y } : {}) });
					if (!res.success) return res;
					const parsed = parseScrolled(res.data);
					return parsed.success ? { success: true, data: parsed.data } : driverErr("E_INTERNAL", parsed.error);
				},
				false
			),
		audit: async (opts) => {
			if (deps.atf === undefined) return undefined;
			const jar = await deps.atf();
			if (!jar.success) return jar;
			return call(
				"audit",
				(server) =>
					server.request("audit", { atf: jar.data, contrast: opts.contrast }, { timeoutMs: AUDIT_TIMEOUT_MS }),
				true
			);
		},
		stop: () => backend.stop(),
	};
}

function mapVoid<T>(result: Res<T>): Res<void> {
	return result.success ? ok : result;
}

import { ok, type Result } from "@delacour/warden-types/result";
import { type CdpClient, describeException, openCdp, readEvaluateReply } from "./cdp";
import {
	type CdpTap,
	type DevtoolsError,
	type DevtoolsResult,
	devtoolsErr,
	type EvaluateError,
	type Fetch,
	type Sleep,
} from "./devtools.types";
import { listTargets, type SelectedTarget, selectTarget } from "./inspector";

/** The one binding warden installs; scripts call `__warden_cb(JSON.stringify({ requestId, … }))`. */
export const WARDEN_BINDING = "__warden_cb";

const RECONNECT_BACKOFF_MS = 200;
/** attempts at the base backoff before it starts growing (the old fixed budget: about 2 s) */
const FAST_RECONNECT_ATTEMPTS = 10;
const MAX_RECONNECT_BACKOFF_MS = 1_000;
/** "no target yet" is normal while the app relaunches (4.5-6.4 s for a Release build, more for a dev client) */
const RECONNECT_BUDGET_MS = 30_000;
const RELOAD_WAIT_MS = 5_000;
const HANDSHAKE_OPTIONAL_TIMEOUT_MS = 3_000;

export type DevtoolsDevice = {
	/** the simulator's name as the app reports it */
	deviceName?: string;
	/** pin this device on a Metro shared by several (persist `session.target.logicalDeviceId`) */
	logicalDeviceId?: string;
	appId?: string;
};

export type ConnectDevtoolsOptions = {
	/** `undefined` = no Metro: a release build, so `devtools_unavailable` */
	metroUrl: string | undefined;
	device: DevtoolsDevice;
	fetch: Fetch;
	WebSocket?: typeof WebSocket;
	log?: (line: string) => void;
	/** injectable for tests; defaults to a timer */
	sleep?: Sleep;
	/** per-request and connect timeout (default 10 s) */
	timeoutMs?: number;
	/** first pause between reconnect attempts (default 200 ms; grows to `maxReconnectBackoffMs` after 10 attempts) */
	reconnectBackoffMs?: number;
	/** longest pause between reconnect attempts (default 1 s) */
	maxReconnectBackoffMs?: number;
	/** reconnect attempts before giving up (default: no cap, `reconnectBudgetMs` decides) */
	maxReconnectAttempts?: number;
	/** how long one reconnect keeps trying before it emits `lost` (default 30 s) */
	reconnectBudgetMs?: number;
	/** injectable for tests; defaults to `Date.now` (with the time slept, measures `reconnectBudgetMs`) */
	now?: () => number;
	/** Called for every CDP event from the moment each socket opens, handshake included (so replays are seen). */
	taps?: readonly CdpTap[];
	/** how long `reloadJs` waits for the app to start tearing its JS context down (default 5 s) */
	reloadWaitMs?: number;
};

export type DevtoolsSession = {
	/** `Runtime.evaluate` by value. A thrown JS error fails with `exceptionDetails`. Waits out a reconnect. */
	evaluate: (
		expression: string,
		options?: { await?: boolean; timeoutMs?: number }
	) => Promise<Result<unknown, EvaluateError>>;
	/**
	 * Reloads this device's JS: `expo.reloadAppAsync()` evaluated in the app, else `DevSettings.reload()`, else (only
	 * when the app has neither) `POST <metro>/reload`, which reloads every device on that Metro. Never `Page.reload`:
	 * RN handles it inside the inspector dispatch on the main thread and a bridgeless host freezes. Fails with
	 * `reload_failed` when the JS context did not restart in time; resolves once the app has reconnected.
	 */
	reloadJs: () => Promise<DevtoolsResult<{ method: ReloadMethod }>>;
	/** the page currently attached (changes after a reconnect) */
	readonly target: SelectedTarget;
	/** false on legacy Hermes: `evaluateWithBinding` is refused */
	readonly bindingAvailable: boolean;
	/** raw CDP call on the current socket (waits out a reconnect) */
	send: (
		method: string,
		params?: Record<string, unknown>,
		options?: { timeoutMs?: number }
	) => Promise<DevtoolsResult<unknown>>;
	/** CDP event subscription that survives reconnects */
	onCdp: (method: string, handler: (params: unknown) => void) => () => void;
	/** Tap on every CDP event, handshake events flagged `replay`; survives reconnects. */
	onEvent: (tap: CdpTap) => () => void;
	evaluateWithBinding: (script: string, requestId: string, timeoutMs?: number) => Promise<DevtoolsResult<unknown>>;
	/** `reconnected` (new target attached) and `lost` (gave up reconnecting) */
	on: <E extends keyof SessionEvents>(event: E, handler: (arg: SessionEvents[E]) => void) => () => void;
	close: () => void;
};

export type ReloadMethod = "expo" | "devsettings" | "http";

/**
 * Reloads only the app this socket is attached to, scheduled with `setTimeout` so the evaluate replies first.
 * `expo.reloadAppAsync` is per app and works in a dev client; `DevSettings.reload` is a no-op under expo-dev-launcher.
 */
const RELOAD_EXPRESSION =
	'(function(){var g=globalThis;if(g.expo&&typeof g.expo.reloadAppAsync==="function"){setTimeout(function(){g.expo.reloadAppAsync("warden e2e reloadJs")},0);return "expo"}var m=g.nativeModuleProxy&&g.nativeModuleProxy.DevSettings;if(m&&typeof m.reload==="function"){setTimeout(function(){m.reload()},0);return "devsettings"}return false})()';

export type SessionEvents = { reconnected: SelectedTarget; lost: DevtoolsError };

type Attached = { cdp: CdpClient; target: SelectedTarget };

type State =
	| { kind: "up"; attached: Attached }
	| { kind: "reconnecting"; done: Promise<DevtoolsResult<Attached>> }
	| { kind: "lost"; error: DevtoolsError }
	| { kind: "closed" };

const timerSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Attach to the app's Hermes runtime through Metro's inspector proxy. Connect sequence (same as Chrome's Fusebox
 * frontend): `FuseboxClient.setClientMetadata`, `ReactNativeApplication.enable`, `Runtime.enable`,
 * `Runtime.runIfWaitingForDebugger`, `Runtime.addBinding`. The session re-attaches on socket close and on
 * `Runtime.executionContextsCleared` (JS reload), re-selecting the target because a reload gets a new page id.
 */
export async function connectDevtools(o: ConnectDevtoolsOptions): Promise<DevtoolsResult<DevtoolsSession>> {
	const { metroUrl } = o;
	if (!metroUrl) {
		return devtoolsErr("devtools_unavailable", "no Metro URL: release builds have no devtools (start a dev client)");
	}
	const sleep = o.sleep ?? timerSleep;
	const log = o.log ?? (() => undefined);
	const now = o.now ?? Date.now;
	const backoffMs = o.reconnectBackoffMs ?? RECONNECT_BACKOFF_MS;
	const maxBackoffMs = Math.max(backoffMs, o.maxReconnectBackoffMs ?? MAX_RECONNECT_BACKOFF_MS);
	const maxAttempts = o.maxReconnectAttempts ?? Number.POSITIVE_INFINITY;
	const budgetMs = o.reconnectBudgetMs ?? RECONNECT_BUDGET_MS;
	/** pause after failed attempt `n` (1-based): the base for the first 10, then doubling up to the cap */
	const backoffAfter = (attempt: number): number =>
		attempt <= FAST_RECONNECT_ATTEMPTS
			? backoffMs
			: Math.min(maxBackoffMs, backoffMs * 2 ** (attempt - FAST_RECONNECT_ATTEMPTS));

	let pinnedLogicalId = o.device.logicalDeviceId;
	let state: State = { kind: "closed" };
	const phase = (): State["kind"] => state.kind;
	let epoch = 0;
	const epochWaiters = new Set<() => void>();
	const cdpHandlers = new Map<string, Set<(params: unknown) => void>>();
	const eventHandlers: { [E in keyof SessionEvents]: Set<(arg: SessionEvents[E]) => void> } = {
		reconnected: new Set(),
		lost: new Set(),
	};
	let unsubscribeCdp: (() => void)[] = [];
	let connection = 0;
	const taps = new Set<CdpTap>(o.taps ?? []);

	async function handshake(cdp: CdpClient, target: SelectedTarget): Promise<DevtoolsResult<Attached>> {
		const optional = { timeoutMs: HANDSHAKE_OPTIONAL_TIMEOUT_MS };
		await cdp.send("FuseboxClient.setClientMetadata", {}, optional);
		await cdp.send("ReactNativeApplication.enable", {}, optional);
		const enabled = await cdp.send("Runtime.enable");
		if (!enabled.success) return enabled;
		await cdp.send("Runtime.runIfWaitingForDebugger", {}, optional);
		const binding = await cdp.addBinding(WARDEN_BINDING);
		if (!binding.success) return binding;
		return ok({ cdp, target });
	}

	/** list -> select -> socket -> handshake; the socket is closed again if any step fails */
	async function establish(): Promise<DevtoolsResult<Attached>> {
		const listed = await listTargets(metroUrl as string, o.fetch);
		if (!listed.success) return listed;
		const selected = selectTarget(
			listed.data,
			{ deviceName: o.device.deviceName, logicalDeviceId: pinnedLogicalId, appId: o.device.appId },
			metroUrl as string
		);
		if (!selected.success) return selected;
		const opened = await openCdp(selected.data.wsUrl, { WebSocket: o.WebSocket, timeoutMs: o.timeoutMs });
		if (!opened.success) return opened;
		const connectionNumber = ++connection;
		let replay = true;
		opened.data.onAny((method, params) => {
			for (const tap of [...taps]) tap({ method, params, connection: connectionNumber, replay });
		});
		const attached = await handshake(opened.data, selected.data);
		replay = false;
		if (!attached.success) opened.data.close();
		return attached;
	}

	function attach(attached: Attached): void {
		state = { kind: "up", attached };
		pinnedLogicalId = attached.target.logicalDeviceId ?? pinnedLogicalId;
		for (const off of unsubscribeCdp) off();
		unsubscribeCdp = [];
		for (const [method, handlers] of cdpHandlers) {
			for (const handler of handlers) unsubscribeCdp.push(attached.cdp.on(method, handler));
		}
		attached.cdp.onClose(() => {
			if (state.kind === "up" && state.attached.cdp === attached.cdp) void reconnect("socket closed");
		});
		attached.cdp.on("Runtime.executionContextsCleared", () => {
			if (state.kind === "up" && state.attached.cdp === attached.cdp) void reconnect("JS context cleared");
		});
	}

	const closedError = (): DevtoolsResult<Attached> => devtoolsErr("cdp_closed", "devtools session is closed");

	/** Makes `attached` the live socket and tells the `reconnected` listeners. */
	function adopt(attached: Attached): void {
		attach(attached);
		log(`devtools: reconnected to ${attached.target.id}`);
		for (const handler of [...eventHandlers.reconnected]) handler(attached.target);
	}

	/** Adopts a fresh socket, unless the session was closed while it was being established (then it is closed again). */
	function adoptIfOpen(attached: Attached): DevtoolsResult<Attached> {
		if (phase() === "closed") {
			attached.cdp.close();
			return closedError();
		}
		adopt(attached);
		return ok(attached);
	}

	/** Moves to `lost` with `error` and tells the `lost` listeners, unless the session is closed. */
	function markLost(error: DevtoolsError): void {
		if (phase() === "closed") return;
		state = { kind: "lost", error };
		for (const handler of [...eventHandlers.lost]) handler(error);
	}

	/** Closes the dead socket, then re-establishes with backoff until the attempt count or time budget runs out. */
	async function reconnectLoop(previous: Attached): Promise<DevtoolsResult<Attached>> {
		previous.cdp.close();
		let last: DevtoolsError = { code: "devtools_unavailable", message: "reconnect failed" };
		// the budget runs out on the clock or on the time slept, whichever is first (an injected sleep may not
		// move the clock)
		const startedAt = now();
		let slept = 0;
		const leftMs = (): number => budgetMs - Math.max(now() - startedAt, slept);
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			if (phase() === "closed") return closedError();
			const result = await establish();
			if (result.success) return adoptIfOpen(result.data);
			last = result.error;
			const left = leftMs();
			const cap = Number.isFinite(maxAttempts) ? `/${maxAttempts}` : "";
			log(`devtools: reconnect attempt ${attempt}${cap} failed: ${last.message}`);
			if (attempt >= maxAttempts || left <= 0) break;
			const pause = Math.min(backoffAfter(attempt), left);
			slept += pause;
			await sleep(pause);
		}
		markLost(last);
		return { success: false, error: last };
	}

	function reconnect(reason: string): Promise<DevtoolsResult<Attached>> {
		if (state.kind === "reconnecting") return state.done;
		if (state.kind !== "up") return Promise.resolve(closedError());
		const previous = state.attached;
		log(`devtools: ${reason}, reconnecting`);
		const done = reconnectLoop(previous);
		state = { kind: "reconnecting", done };
		epoch++;
		for (const wake of [...epochWaiters]) wake();
		return done;
	}

	/**
	 * Leaves `lost`: one fresh attach attempt, shared by every caller that arrives while it runs. A failure stays
	 * `lost` (with the new error) without emitting `lost` again; a success emits `reconnected`.
	 */
	function revive(): Promise<DevtoolsResult<Attached>> {
		log("devtools: lost, trying to attach again");
		const done = (async (): Promise<DevtoolsResult<Attached>> => {
			const result = await establish();
			if (phase() === "closed") {
				if (result.success) result.data.cdp.close();
				return closedError();
			}
			if (!result.success) {
				state = { kind: "lost", error: result.error };
				return result;
			}
			adopt(result.data);
			return result;
		})();
		state = { kind: "reconnecting", done };
		return done;
	}

	/** the live socket, waiting out a reconnect; a `lost` session tries to attach again */
	async function current(): Promise<DevtoolsResult<Attached>> {
		if (state.kind === "up") return ok(state.attached);
		if (state.kind === "reconnecting") return state.done;
		if (state.kind === "lost") return revive();
		return devtoolsErr("cdp_closed", "devtools session is closed");
	}

	/** Triggers the reload: nothing to do for `expo` / `devsettings` (the probe scheduled it), a POST for `http`. */
	async function requestReload(method: ReloadMethod, baseUrl: string): Promise<DevtoolsResult<never> | undefined> {
		if (method !== "http") {
			log(`devtools: reload via ${method}`);
			return undefined;
		}
		log("devtools: reload via http");
		try {
			const res = await o.fetch(`${baseUrl.replace(/\/+$/, "")}/reload`, { method: "POST" });
			if (!res.ok) {
				return devtoolsErr("devtools_unavailable", `reload failed: POST /reload answered ${res.status}`);
			}
		} catch (error) {
			return devtoolsErr("devtools_unavailable", `reload failed: POST /reload threw ${String(error)}`);
		}
		return undefined;
	}

	/** After a reload request: an error when the JS context never restarted or the reconnect it caused failed. */
	async function awaitReload(
		method: ReloadMethod,
		startedAt: number,
		waitMs: number
	): Promise<DevtoolsResult<never> | undefined> {
		if (epoch === startedAt) await waitForEpochChange(waitMs);
		if (epoch === startedAt && state.kind === "up") {
			log(`devtools: reload via ${method} not observed after ${waitMs} ms`);
			return devtoolsErr(
				"reload_failed",
				`reload via ${method} acknowledged but the JS context did not restart within ${waitMs} ms`
			);
		}
		if (state.kind !== "reconnecting") return undefined;
		const back = await state.done;
		return back.success ? undefined : back;
	}

	/** Resolves when the session next reconnects or closes, or after `waitMs`, whichever is first. */
	function waitForEpochChange(waitMs: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const wake = () => {
				epochWaiters.delete(wake);
				resolve();
			};
			epochWaiters.add(wake);
			void sleep(waitMs).then(wake);
		});
	}

	const first = await establish();
	if (!first.success) return first;
	attach(first.data);
	log(`devtools: attached to ${first.data.target.id} (${first.data.target.fusebox ? "Fusebox" : "legacy"})`);

	const session: DevtoolsSession = {
		async evaluate(expression, options = {}) {
			const live = await current();
			if (!live.success) return { success: false, error: { message: live.error.message, code: live.error.code } };
			const reply = await live.data.cdp.send(
				"Runtime.evaluate",
				{ expression, returnByValue: true, awaitPromise: options.await ?? false },
				{ timeoutMs: options.timeoutMs }
			);
			if (!reply.success) return { success: false, error: { message: reply.error.message, code: reply.error.code } };
			const { value, exceptionDetails } = readEvaluateReply(reply.data);
			if (exceptionDetails) {
				return {
					success: false,
					error: { message: describeException(exceptionDetails), code: "eval_failed", exceptionDetails },
				};
			}
			return ok(value);
		},
		async reloadJs() {
			const live = await current();
			if (!live.success) return live;
			const startedAt = epoch;
			const waitMs = o.reloadWaitMs ?? RELOAD_WAIT_MS;
			const probe = await live.data.cdp.send("Runtime.evaluate", {
				expression: RELOAD_EXPRESSION,
				returnByValue: true,
			});
			if (!probe.success) {
				log(`devtools: reload probe failed: ${probe.error.message}`);
				return devtoolsErr(probe.error.code, `reload probe failed: ${probe.error.message}`);
			}
			const method: ReloadMethod = readReloadMethod(probe.data) ?? "http";
			const failure = (await requestReload(method, metroUrl)) ?? (await awaitReload(method, startedAt, waitMs));
			return failure ?? ok({ method });
		},
		get target() {
			if (state.kind === "up") return state.attached.target;
			return first.data.target;
		},
		get bindingAvailable() {
			return state.kind === "up" && state.attached.cdp.bindingAvailable === true;
		},
		async send(method, params, options) {
			const live = await current();
			if (!live.success) return live;
			return live.data.cdp.send(method, params, options);
		},
		onEvent(tap) {
			taps.add(tap);
			return () => {
				taps.delete(tap);
			};
		},
		onCdp(method, handler) {
			let set = cdpHandlers.get(method);
			if (!set) {
				set = new Set();
				cdpHandlers.set(method, set);
			}
			set.add(handler);
			const off = state.kind === "up" ? state.attached.cdp.on(method, handler) : undefined;
			if (off) unsubscribeCdp.push(off);
			return () => {
				set.delete(handler);
				off?.();
			};
		},
		async evaluateWithBinding(script, requestId, timeoutMs) {
			const live = await current();
			if (!live.success) return live;
			return live.data.cdp.evaluateWithBinding(script, requestId, timeoutMs);
		},
		on(event, handler) {
			const handlers = eventHandlers[event] as Set<typeof handler>;
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		close() {
			const previous = state;
			state = { kind: "closed" };
			if (previous.kind === "up") previous.attached.cdp.close();
			for (const wake of [...epochWaiters]) wake();
		},
	};
	return ok(session);
}

/** The method the reload expression scheduled, or `undefined` when the app has neither JS reload API. */
function readReloadMethod(data: unknown): "expo" | "devsettings" | undefined {
	if (typeof data !== "object" || data === null || !("result" in data)) return undefined;
	const { result } = data;
	if (typeof result !== "object" || result === null || !("value" in result)) return undefined;
	return result.value === "expo" || result.value === "devsettings" ? result.value : undefined;
}

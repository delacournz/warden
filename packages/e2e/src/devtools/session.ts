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
const RECONNECT_ATTEMPTS = 10;
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
	/** pause between reconnect attempts (default 200 ms) */
	reconnectBackoffMs?: number;
	/** reconnect attempts before giving up (default 10) */
	maxReconnectAttempts?: number;
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
	const backoffMs = o.reconnectBackoffMs ?? RECONNECT_BACKOFF_MS;
	const maxAttempts = o.maxReconnectAttempts ?? RECONNECT_ATTEMPTS;

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

	function reconnect(reason: string): Promise<DevtoolsResult<Attached>> {
		if (state.kind === "reconnecting") return state.done;
		if (state.kind !== "up") return Promise.resolve(devtoolsErr("cdp_closed", "devtools session is closed"));
		const previous = state.attached;
		log(`devtools: ${reason}, reconnecting`);
		const done = (async (): Promise<DevtoolsResult<Attached>> => {
			previous.cdp.close();
			let last: DevtoolsError = { code: "devtools_unavailable", message: "reconnect failed" };
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				if (phase() === "closed") return devtoolsErr("cdp_closed", "devtools session is closed");
				const result = await establish();
				if (result.success) {
					if (phase() === "closed") {
						result.data.cdp.close();
						return devtoolsErr("cdp_closed", "devtools session is closed");
					}
					attach(result.data);
					log(`devtools: reconnected to ${result.data.target.id}`);
					for (const handler of [...eventHandlers.reconnected]) handler(result.data.target);
					return result;
				}
				last = result.error;
				log(`devtools: reconnect attempt ${attempt}/${maxAttempts} failed: ${last.message}`);
				if (attempt < maxAttempts) await sleep(backoffMs);
			}
			if (phase() !== "closed") {
				state = { kind: "lost", error: last };
				for (const handler of [...eventHandlers.lost]) handler(last);
			}
			return { success: false, error: last };
		})();
		state = { kind: "reconnecting", done };
		epoch++;
		for (const wake of [...epochWaiters]) wake();
		return done;
	}

	/** the live socket, waiting out a reconnect */
	async function current(): Promise<DevtoolsResult<Attached>> {
		if (state.kind === "up") return ok(state.attached);
		if (state.kind === "reconnecting") return state.done;
		if (state.kind === "lost") return { success: false, error: state.error };
		return devtoolsErr("cdp_closed", "devtools session is closed");
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
			if (method === "http") {
				log("devtools: reload via http");
				try {
					const res = await o.fetch(`${metroUrl.replace(/\/+$/, "")}/reload`, { method: "POST" });
					if (!res.ok) {
						return devtoolsErr("devtools_unavailable", `reload failed: POST /reload answered ${res.status}`);
					}
				} catch (error) {
					return devtoolsErr("devtools_unavailable", `reload failed: POST /reload threw ${String(error)}`);
				}
			} else {
				log(`devtools: reload via ${method}`);
			}
			if (epoch === startedAt) {
				await new Promise<void>((resolve) => {
					const wake = () => {
						epochWaiters.delete(wake);
						resolve();
					};
					epochWaiters.add(wake);
					void sleep(waitMs).then(wake);
				});
			}
			if (epoch === startedAt && state.kind === "up") {
				log(`devtools: reload via ${method} not observed after ${waitMs} ms`);
				return devtoolsErr(
					"reload_failed",
					`reload via ${method} acknowledged but the JS context did not restart within ${waitMs} ms`
				);
			}
			if (state.kind === "reconnecting") {
				const back = await state.done;
				if (!back.success) return back;
			}
			return ok({ method });
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

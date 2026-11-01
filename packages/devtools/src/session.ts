import { type Result, resultFactory } from "@delacour/warden-types/result";
import { type CdpClient, type CloseInfo, cdpConnector, cdpProtocol } from "./cdp";
import {
	type CdpTap,
	type DevtoolsError,
	type DevtoolsResult,
	devtoolsErrors,
	type EvaluateError,
	type Fetch,
	type Sleep,
} from "./devtools.types";
import { inspectorTargets, type SelectedTarget } from "./inspector";
import { timer } from "./timer";

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
	/**
	 * Asked when the socket closes on its own. `true` = another debugger took the page: do not reconnect (that would
	 * kick it in turn), close the session and emit `yielded`. Default: always reconnect.
	 */
	yieldOnClose?: (info: CloseInfo) => boolean;
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
	/** `reconnected` (new target attached), `lost` (gave up reconnecting), `yielded` (`yieldOnClose` said stop) */
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

export type SessionEvents = { reconnected: SelectedTarget; lost: DevtoolsError; yielded: CloseInfo };

type Attached = { cdp: CdpClient; target: SelectedTarget };

type State =
	| { kind: "up"; attached: Attached }
	| { kind: "reconnecting"; done: Promise<DevtoolsResult<Attached>> }
	| { kind: "lost"; error: DevtoolsError }
	| { kind: "closed" };

type ConnectionOptions = Omit<ConnectDevtoolsOptions, "metroUrl"> & { metroUrl: string };

/** Pause schedule and budget of one reconnect, from {@link ConnectDevtoolsOptions}. */
class ReconnectPolicy {
	readonly maxAttempts: number;
	readonly budgetMs: number;
	private readonly backoffMs: number;
	private readonly maxBackoffMs: number;

	constructor(o: ConnectDevtoolsOptions) {
		this.backoffMs = o.reconnectBackoffMs ?? RECONNECT_BACKOFF_MS;
		this.maxBackoffMs = Math.max(this.backoffMs, o.maxReconnectBackoffMs ?? MAX_RECONNECT_BACKOFF_MS);
		this.maxAttempts = o.maxReconnectAttempts ?? Number.POSITIVE_INFINITY;
		this.budgetMs = o.reconnectBudgetMs ?? RECONNECT_BUDGET_MS;
	}

	/** pause after failed attempt `n` (1-based): the base for the first 10, then doubling up to the cap */
	backoffAfter(attempt: number): number {
		return attempt <= FAST_RECONNECT_ATTEMPTS
			? this.backoffMs
			: Math.min(this.maxBackoffMs, this.backoffMs * 2 ** (attempt - FAST_RECONNECT_ATTEMPTS));
	}
}

/**
 * One attached devtools session. Connect sequence (same as Chrome's Fusebox frontend):
 * `FuseboxClient.setClientMetadata`, `ReactNativeApplication.enable`, `Runtime.enable`,
 * `Runtime.runIfWaitingForDebugger`, `Runtime.addBinding`. The session re-attaches on socket close and on
 * `Runtime.executionContextsCleared` (JS reload), re-selecting the target because a reload gets a new page id.
 * Build one with {@link DevtoolsConnector}.
 */
export class DevtoolsSessionConnection implements DevtoolsSession {
	private readonly sleep: Sleep;
	private readonly log: (line: string) => void;
	private readonly now: () => number;
	private readonly policy: ReconnectPolicy;
	private pinnedLogicalId: string | undefined;
	private state: State = { kind: "closed" };
	private epoch = 0;
	private readonly epochWaiters = new Set<() => void>();
	private readonly cdpHandlers = new Map<string, Set<(params: unknown) => void>>();
	private readonly eventHandlers: { [E in keyof SessionEvents]: Set<(arg: SessionEvents[E]) => void> } = {
		reconnected: new Set(),
		lost: new Set(),
		yielded: new Set(),
	};
	private unsubscribeCdp: (() => void)[] = [];
	private connection = 0;
	private readonly taps: Set<CdpTap>;
	private firstTarget: SelectedTarget | undefined;

	constructor(private readonly o: ConnectionOptions) {
		this.sleep = o.sleep ?? timer.sleep;
		this.log = o.log ?? (() => undefined);
		this.now = o.now ?? Date.now;
		this.policy = new ReconnectPolicy(o);
		this.pinnedLogicalId = o.device.logicalDeviceId;
		this.taps = new Set<CdpTap>(o.taps ?? []);
	}

	/** The first attach; fails when Metro, the target or the handshake does. */
	async start(): Promise<DevtoolsResult<DevtoolsSession>> {
		const first = await this.establish();
		if (!first.success) return first;
		this.firstTarget = first.data.target;
		this.attach(first.data);
		this.log(`devtools: attached to ${first.data.target.id} (${first.data.target.fusebox ? "Fusebox" : "legacy"})`);
		return resultFactory.ok(this);
	}

	get target(): SelectedTarget {
		if (this.state.kind === "up") return this.state.attached.target;
		return this.firstTarget as SelectedTarget;
	}

	get bindingAvailable(): boolean {
		return this.state.kind === "up" && this.state.attached.cdp.bindingAvailable === true;
	}

	async evaluate(
		expression: string,
		options: { await?: boolean; timeoutMs?: number } = {}
	): Promise<Result<unknown, EvaluateError>> {
		const live = await this.current();
		if (!live.success) return { success: false, error: { message: live.error.message, code: live.error.code } };
		const reply = await live.data.cdp.send(
			"Runtime.evaluate",
			{ expression, returnByValue: true, awaitPromise: options.await ?? false },
			{ timeoutMs: options.timeoutMs }
		);
		if (!reply.success) return { success: false, error: { message: reply.error.message, code: reply.error.code } };
		const { value, exceptionDetails } = cdpProtocol.readEvaluateReply(reply.data);
		if (exceptionDetails) {
			return {
				success: false,
				error: { message: cdpProtocol.describeException(exceptionDetails), code: "eval_failed", exceptionDetails },
			};
		}
		return resultFactory.ok(value);
	}

	async reloadJs(): Promise<DevtoolsResult<{ method: ReloadMethod }>> {
		const live = await this.current();
		if (!live.success) return live;
		const startedAt = this.epoch;
		const waitMs = this.o.reloadWaitMs ?? RELOAD_WAIT_MS;
		const probe = await live.data.cdp.send("Runtime.evaluate", {
			expression: RELOAD_EXPRESSION,
			returnByValue: true,
		});
		if (!probe.success) {
			this.log(`devtools: reload probe failed: ${probe.error.message}`);
			return devtoolsErrors.err(probe.error.code, `reload probe failed: ${probe.error.message}`);
		}
		const method: ReloadMethod = this.readReloadMethod(probe.data) ?? "http";
		const failure =
			(await this.requestReload(method, this.o.metroUrl)) ?? (await this.awaitReload(method, startedAt, waitMs));
		return failure ?? resultFactory.ok({ method });
	}

	async send(
		method: string,
		params?: Record<string, unknown>,
		options?: { timeoutMs?: number }
	): Promise<DevtoolsResult<unknown>> {
		const live = await this.current();
		if (!live.success) return live;
		return live.data.cdp.send(method, params, options);
	}

	onEvent(tap: CdpTap): () => void {
		this.taps.add(tap);
		return () => {
			this.taps.delete(tap);
		};
	}

	onCdp(method: string, handler: (params: unknown) => void): () => void {
		let set = this.cdpHandlers.get(method);
		if (!set) {
			set = new Set();
			this.cdpHandlers.set(method, set);
		}
		const handlers = set;
		handlers.add(handler);
		const off = this.state.kind === "up" ? this.state.attached.cdp.on(method, handler) : undefined;
		if (off) this.unsubscribeCdp.push(off);
		return () => {
			handlers.delete(handler);
			off?.();
		};
	}

	async evaluateWithBinding(script: string, requestId: string, timeoutMs?: number): Promise<DevtoolsResult<unknown>> {
		const live = await this.current();
		if (!live.success) return live;
		return live.data.cdp.evaluateWithBinding(script, requestId, timeoutMs);
	}

	readonly on = <E extends keyof SessionEvents>(event: E, handler: (arg: SessionEvents[E]) => void): (() => void) => {
		const handlers = this.eventHandlers[event] as Set<typeof handler>;
		handlers.add(handler);
		return () => {
			handlers.delete(handler);
		};
	};

	close(): void {
		const previous = this.state;
		this.state = { kind: "closed" };
		if (previous.kind === "up") previous.attached.cdp.close();
		for (const wake of [...this.epochWaiters]) wake();
	}

	private async handshake(cdp: CdpClient, target: SelectedTarget): Promise<DevtoolsResult<Attached>> {
		const optional = { timeoutMs: HANDSHAKE_OPTIONAL_TIMEOUT_MS };
		await cdp.send("FuseboxClient.setClientMetadata", {}, optional);
		await cdp.send("ReactNativeApplication.enable", {}, optional);
		const enabled = await cdp.send("Runtime.enable");
		if (!enabled.success) return enabled;
		await cdp.send("Runtime.runIfWaitingForDebugger", {}, optional);
		const binding = await cdp.addBinding(WARDEN_BINDING);
		if (!binding.success) return binding;
		return resultFactory.ok({ cdp, target });
	}

	/** list -> select -> socket -> handshake; the socket is closed again if any step fails */
	private async establish(): Promise<DevtoolsResult<Attached>> {
		const { metroUrl } = this.o;
		const listed = await inspectorTargets.list(metroUrl, this.o.fetch);
		if (!listed.success) return listed;
		const selected = inspectorTargets.select(
			listed.data,
			{ deviceName: this.o.device.deviceName, logicalDeviceId: this.pinnedLogicalId, appId: this.o.device.appId },
			metroUrl
		);
		if (!selected.success) return selected;
		const opened = await cdpConnector.open(selected.data.wsUrl, {
			WebSocket: this.o.WebSocket,
			timeoutMs: this.o.timeoutMs,
		});
		if (!opened.success) return opened;
		this.connection += 1;
		const connectionNumber = this.connection;
		let replay = true;
		opened.data.onAny((method, params) => {
			for (const tap of [...this.taps]) tap({ method, params, connection: connectionNumber, replay });
		});
		const attached = await this.handshake(opened.data, selected.data);
		replay = false;
		if (!attached.success) opened.data.close();
		return attached;
	}

	private attach(attached: Attached): void {
		this.state = { kind: "up", attached };
		this.pinnedLogicalId = attached.target.logicalDeviceId ?? this.pinnedLogicalId;
		for (const off of this.unsubscribeCdp) off();
		this.unsubscribeCdp = [];
		for (const [method, handlers] of this.cdpHandlers) {
			for (const handler of handlers) this.unsubscribeCdp.push(attached.cdp.on(method, handler));
		}
		attached.cdp.onClose((info) => this.onSocketClosed(attached, info));
		attached.cdp.on("Runtime.executionContextsCleared", () => {
			if (this.isLive(attached)) void this.reconnect("JS context cleared");
		});
	}

	private isLive(attached: Attached): boolean {
		return this.state.kind === "up" && this.state.attached.cdp === attached.cdp;
	}

	private onSocketClosed(attached: Attached, info: CloseInfo): void {
		if (!this.isLive(attached)) return;
		if (this.o.yieldOnClose?.(info)) {
			this.state = { kind: "closed" };
			this.log(`devtools: yielded (${info.code} ${info.reason})`);
			for (const handler of [...this.eventHandlers.yielded]) handler(info);
			return;
		}
		void this.reconnect("socket closed");
	}

	private closedError(): DevtoolsResult<Attached> {
		return devtoolsErrors.err("cdp_closed", "devtools session is closed");
	}

	/** Makes `attached` the live socket and tells the `reconnected` listeners. */
	private adopt(attached: Attached): void {
		this.attach(attached);
		this.log(`devtools: reconnected to ${attached.target.id}`);
		for (const handler of [...this.eventHandlers.reconnected]) handler(attached.target);
	}

	/** Adopts a fresh socket, unless the session was closed while it was being established (then it is closed again). */
	private adoptIfOpen(attached: Attached): DevtoolsResult<Attached> {
		if (this.state.kind === "closed") {
			attached.cdp.close();
			return this.closedError();
		}
		this.adopt(attached);
		return resultFactory.ok(attached);
	}

	/** Moves to `lost` with `error` and tells the `lost` listeners, unless the session is closed. */
	private markLost(error: DevtoolsError): void {
		if (this.state.kind === "closed") return;
		this.state = { kind: "lost", error };
		for (const handler of [...this.eventHandlers.lost]) handler(error);
	}

	/** Closes the dead socket, then re-establishes with backoff until the attempt count or time budget runs out. */
	private async reconnectLoop(previous: Attached): Promise<DevtoolsResult<Attached>> {
		previous.cdp.close();
		let last: DevtoolsError = { code: "devtools_unavailable", message: "reconnect failed" };
		const { maxAttempts, budgetMs } = this.policy;
		// the budget runs out on the clock or on the time slept, whichever is first (an injected sleep may not
		// move the clock)
		const startedAt = this.now();
		let slept = 0;
		const leftMs = (): number => budgetMs - Math.max(this.now() - startedAt, slept);
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			if (this.state.kind === "closed") return this.closedError();
			const result = await this.establish();
			if (result.success) return this.adoptIfOpen(result.data);
			last = result.error;
			const left = leftMs();
			const cap = Number.isFinite(maxAttempts) ? `/${maxAttempts}` : "";
			this.log(`devtools: reconnect attempt ${attempt}${cap} failed: ${last.message}`);
			if (attempt >= maxAttempts || left <= 0) break;
			const pause = Math.min(this.policy.backoffAfter(attempt), left);
			slept += pause;
			await this.sleep(pause);
		}
		this.markLost(last);
		return { success: false, error: last };
	}

	private reconnect(reason: string): Promise<DevtoolsResult<Attached>> {
		if (this.state.kind === "reconnecting") return this.state.done;
		if (this.state.kind !== "up") return Promise.resolve(this.closedError());
		const previous = this.state.attached;
		this.log(`devtools: ${reason}, reconnecting`);
		const done = this.reconnectLoop(previous);
		this.state = { kind: "reconnecting", done };
		this.epoch++;
		for (const wake of [...this.epochWaiters]) wake();
		return done;
	}

	/**
	 * Leaves `lost`: one fresh attach attempt, shared by every caller that arrives while it runs. A failure stays
	 * `lost` (with the new error) without emitting `lost` again; a success emits `reconnected`.
	 */
	private revive(): Promise<DevtoolsResult<Attached>> {
		this.log("devtools: lost, trying to attach again");
		const done = this.reviveOnce();
		this.state = { kind: "reconnecting", done };
		return done;
	}

	private async reviveOnce(): Promise<DevtoolsResult<Attached>> {
		const result = await this.establish();
		if (this.state.kind === "closed") {
			if (result.success) result.data.cdp.close();
			return this.closedError();
		}
		if (!result.success) {
			this.state = { kind: "lost", error: result.error };
			return result;
		}
		this.adopt(result.data);
		return result;
	}

	/** the live socket, waiting out a reconnect; a `lost` session tries to attach again */
	private async current(): Promise<DevtoolsResult<Attached>> {
		if (this.state.kind === "up") return resultFactory.ok(this.state.attached);
		if (this.state.kind === "reconnecting") return this.state.done;
		if (this.state.kind === "lost") return this.revive();
		return devtoolsErrors.err("cdp_closed", "devtools session is closed");
	}

	/** Triggers the reload: nothing to do for `expo` / `devsettings` (the probe scheduled it), a POST for `http`. */
	private async requestReload(method: ReloadMethod, baseUrl: string): Promise<DevtoolsResult<never> | undefined> {
		if (method !== "http") {
			this.log(`devtools: reload via ${method}`);
			return undefined;
		}
		this.log("devtools: reload via http");
		try {
			const res = await this.o.fetch(`${baseUrl.replace(/\/+$/, "")}/reload`, { method: "POST" });
			if (!res.ok) {
				return devtoolsErrors.err("devtools_unavailable", `reload failed: POST /reload answered ${res.status}`);
			}
		} catch (error) {
			return devtoolsErrors.err("devtools_unavailable", `reload failed: POST /reload threw ${String(error)}`);
		}
		return undefined;
	}

	/** After a reload request: an error when the JS context never restarted or the reconnect it caused failed. */
	private async awaitReload(
		method: ReloadMethod,
		startedAt: number,
		waitMs: number
	): Promise<DevtoolsResult<never> | undefined> {
		if (this.epoch === startedAt) await this.waitForEpochChange(waitMs);
		if (this.epoch === startedAt && this.state.kind === "up") {
			this.log(`devtools: reload via ${method} not observed after ${waitMs} ms`);
			return devtoolsErrors.err(
				"reload_failed",
				`reload via ${method} acknowledged but the JS context did not restart within ${waitMs} ms`
			);
		}
		if (this.state.kind !== "reconnecting") return undefined;
		const back = await this.state.done;
		return back.success ? undefined : back;
	}

	/** Resolves when the session next reconnects or closes, or after `waitMs`, whichever is first. */
	private waitForEpochChange(waitMs: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const wake = () => {
				this.epochWaiters.delete(wake);
				resolve();
			};
			this.epochWaiters.add(wake);
			void this.sleep(waitMs).then(wake);
		});
	}

	/** The method the reload expression scheduled, or `undefined` when the app has neither JS reload API. */
	private readReloadMethod(data: unknown): "expo" | "devsettings" | undefined {
		if (typeof data !== "object" || data === null || !("result" in data)) return undefined;
		const { result } = data;
		if (typeof result !== "object" || result === null || !("value" in result)) return undefined;
		return result.value === "expo" || result.value === "devsettings" ? result.value : undefined;
	}
}

/** Attaches to the app's Hermes runtime through Metro's inspector proxy. Use the shared {@link devtoolsConnector}. */
export class DevtoolsConnector {
	async connect(o: ConnectDevtoolsOptions): Promise<DevtoolsResult<DevtoolsSession>> {
		const { metroUrl } = o;
		if (!metroUrl) {
			return devtoolsErrors.err(
				"devtools_unavailable",
				"no Metro URL: release builds have no devtools (start a dev client)"
			);
		}
		return new DevtoolsSessionConnection({ ...o, metroUrl }).start();
	}
}

export const devtoolsConnector = new DevtoolsConnector();

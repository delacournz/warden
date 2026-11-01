import type { AlertBackend, ProbesFrontmost, ReadsAlertOn } from "@delacour/warden-driver/alerts";
import type {
	AlertInfo,
	AppCommands,
	Driver,
	DriverCapabilities,
	DriverError,
	DriverResult,
	KeyName,
	Snapshot,
} from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import { simdTransports, type Transport } from "@delacour/warden-driver/helper/simd-transport";
import type { DetectsAlerts } from "@delacour/warden-driver/observation-cache";
import type { RepeatingKeys, SelectsAll, SetsText } from "@delacour/warden-driver/typing";
import { androidAlert } from "@delacour/warden-driver-android/android-alert";
import type { Result } from "@delacour/warden-types/result";
import {
	REMOTE_PROTOCOL,
	type ReadyEvent,
	type RemoteOp,
	readyEventSchema,
	remoteWire,
	responseSchema,
	type WireScreenshot,
	type WireSnapshot,
} from "./remote-protocol";

/** Long enough for any single driver op (an install, a 60 s gesture); a hung host is still noticed. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_READY_TIMEOUT_MS = 2000;

/** A remote driver plus whichever optional capabilities the served one offers. */
export type RemoteDriver = Driver &
	Partial<RepeatingKeys & SelectsAll & SetsText & DetectsAlerts & ReadsAlertOn & ProbesFrontmost>;

export type RequestOptions = { timeoutMs?: number };

export type RemoteClient = {
	readonly ready: ReadyEvent;
	/** a control op (`ping`, `shutdown`) or any op without arguments; `params` is accepted for the helper contract and unused */
	request(op: string, params?: Record<string, unknown>, opts?: RequestOptions): DriverResult<unknown>;
	/** the `Driver` over this connection; its `close()` only disconnects (the host keeps the device open) */
	driver(): RemoteDriver;
	close(): Promise<void>;
};

export type ConnectRemoteOptions = {
	socketPath: string;
	readyTimeoutMs?: number;
	requestTimeoutMs?: number;
};

type Pending = { resolve: (result: Result<unknown, DriverError>) => void; timer: ReturnType<typeof setTimeout> };

/**
 * The wire state of one connection: request ids, what is in flight, the capabilities the host last reported, and
 * the failure that closed it.
 */
class RemoteLink {
	capabilities: DriverCapabilities | undefined;
	readonly readyPromise: Promise<Result<ReadyEvent, DriverError>>;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private closed: DriverError | undefined;
	private transport: Transport | undefined;
	private onReady: (ready: Result<ReadyEvent, DriverError>) => void = () => undefined;

	constructor(private readonly requestTimeoutMs: number) {
		this.readyPromise = new Promise<Result<ReadyEvent, DriverError>>((resolve) => {
			this.onReady = resolve;
		});
	}

	attach(transport: Transport): void {
		this.transport = transport;
	}

	readonly reportReady = (ready: Result<ReadyEvent, DriverError>): void => {
		this.onReady(ready);
	};

	failAll(error: DriverError): void {
		this.closed ??= error;
		this.onReady({ success: false, error });
		for (const [id, entry] of this.pending) {
			clearTimeout(entry.timer);
			this.pending.delete(id);
			entry.resolve({ success: false, error });
		}
	}

	readonly onLine = (line: string): void => {
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			return;
		}
		const ready = readyEventSchema.safeParse(raw);
		if (ready.success) {
			this.capabilities = ready.data.capabilities;
			this.onReady({ success: true, data: ready.data });
			return;
		}
		const response = responseSchema.safeParse(raw);
		if (!response.success) return;
		const { id, result } = response.data;
		if (response.data.capabilities !== undefined) this.capabilities = response.data.capabilities;
		const entry = this.pending.get(id);
		if (entry === undefined) return;
		clearTimeout(entry.timer);
		this.pending.delete(id);
		entry.resolve(
			result.success
				? { success: true, data: result.data }
				: { success: false, error: remoteWire.wireError(result.error) }
		);
	};

	send(op: string, args: readonly unknown[], opts: RequestOptions = {}): DriverResult<unknown> {
		if (this.closed !== undefined) return Promise.resolve({ success: false, error: this.closed });
		const transport = this.transport;
		if (transport === undefined) {
			return Promise.resolve({ success: false, error: driverErrors.make("E_HELPER_CRASHED", "not connected") });
		}
		const id = this.nextId++;
		return new Promise((resolve) => {
			const ms = opts.timeoutMs ?? this.requestTimeoutMs;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ success: false, error: driverErrors.make("E_TIMEOUT", `\`${op}\` got no answer within ${ms} ms`) });
			}, ms);
			this.pending.set(id, { resolve, timer });
			transport.send(`${JSON.stringify({ id, op, args })}\n`);
		});
	}

	readonly close = async (): Promise<void> => {
		await this.transport?.close();
		this.failAll(driverErrors.make("E_HELPER_CRASHED", "the remote driver connection is closed"));
	};
}

/** A connected {@link RemoteClient}: the `Driver` surface sent over a {@link RemoteLink}. */
class RemoteClientImpl implements RemoteClient {
	constructor(
		readonly ready: ReadyEvent,
		private readonly link: RemoteLink
	) {}

	readonly request: RemoteClient["request"] = (op, _params, opts) => this.link.send(op, [], opts);

	readonly close = (): Promise<void> => this.link.close();

	readonly driver = (): RemoteDriver => {
		const hello = this.ready;
		const link = this.link;
		const call = <T>(op: RemoteOp, ...args: unknown[]): DriverResult<T> => this.call<T>(op, ...args);
		const base: Driver = {
			platform: hello.platform,
			id: hello.id,
			get capabilities(): DriverCapabilities {
				return link.capabilities ?? hello.capabilities;
			},
			health: () => call("health"),
			snapshot: this.snapshot,
			elementAtPoint: (point, opts) => call("elementAtPoint", point, opts),
			tap: (point, opts) => call("tap", point, opts),
			longPress: (point, opts) => call("longPress", point, opts),
			swipe: (from, to, opts) => call("swipe", from, to, opts),
			drag: (from, to, opts) => call("drag", from, to, opts),
			pinch: (center, scale, opts) => call("pinch", center, scale, opts),
			rotate: (center, degrees, opts) => call("rotate", center, degrees, opts),
			gesture: (paths, opts) => call("gesture", paths, opts),
			typeText: (text) => call("typeText", text),
			key: (key, modifiers) => call("key", key, modifiers),
			pressButton: (button) => call("pressButton", button),
			screenshot: this.screenshot,
			orientation: (set) => call("orientation", set),
			settle: (opts) => call("settle", opts),
			alert: () => call<AlertInfo | null>("alert"),
			appearance: (set) => call("appearance", set),
			clipboard: (set) => call("clipboard", set),
			network: (op, opts) => call("network", op, opts),
			networkFaults: (faults) => call("networkFaults", faults),
			location: (op) => call("location", op),
			clock: (op, opts) => call("clock", op, opts),
			permissions: (grants, opts) => call("permissions", grants, opts),
			timezone: (tz, opts) => call("timezone", tz, opts),
			locale: (tag, opts) => call("locale", tag, opts),
			a11y: (op) => call("a11y", op),
			battery: (op) => call("battery", op),
			memoryWarning: (opts) => call("memoryWarning", opts),
			push: (payload, opts) => call("push", payload, opts),
			biometrics: (op) => call("biometrics", op),
			app: this.appCommands(),
			close: this.close,
		};
		const offered = new Set(hello.optional);
		return Object.assign(
			base,
			offered.has("pressKeyRepeat")
				? { pressKeyRepeat: (key: KeyName, times: number) => call<void>("pressKeyRepeat", key, times) }
				: {},
			offered.has("selectAll") ? { selectAll: () => call<void>("selectAll") } : {},
			offered.has("setText") ? { setText: (text: string) => call<void>("setText", text) } : {},
			offered.has("alertOn") ? { alertOn: (backend: AlertBackend) => call<AlertInfo | null>("alertOn", backend) } : {},
			offered.has("isFrontmost") ? { isFrontmost: (bundleId: string) => call<boolean>("isFrontmost", bundleId) } : {},
			hello.alertIn === "android" ? { alertIn: (shot: Snapshot) => androidAlert.detectAlert(shot.flat) } : {}
		);
	};

	private readonly snapshot: Driver["snapshot"] = async (opts) => {
		const taken = await this.call<WireSnapshot>("snapshot", opts);
		return taken.success ? { success: true, data: remoteWire.snapshotFromWire(taken.data) } : taken;
	};

	private readonly screenshot: Driver["screenshot"] = async (opts) => {
		const shot = await this.call<WireScreenshot>("screenshot", opts);
		return shot.success ? { success: true, data: remoteWire.screenshotFromWire(shot.data) } : shot;
	};

	/** The op's own `DriverResult`, typed by the `Driver` method it serves (the host is this warden's own build). */
	private call<T>(op: RemoteOp, ...args: unknown[]): DriverResult<T> {
		return this.link.send(op, args) as DriverResult<T>;
	}

	private appCommands(): AppCommands {
		return {
			launch: (bundleId, opts) => this.call("app.launch", bundleId, opts),
			terminate: (bundleId) => this.call("app.terminate", bundleId),
			openUrl: (url) => this.call("app.openUrl", url),
			install: (path) => this.call("app.install", path),
			uninstall: (bundleId) => this.call("app.uninstall", bundleId),
			isInstalled: (bundleId) => this.call("app.isInstalled", bundleId),
			isRunning: (bundleId) => this.call("app.isRunning", bundleId),
			clearData: (bundleId, opts) => this.call("app.clearData", bundleId, opts),
		};
	}
}

/** Connects to a served driver. */
export class RemoteDriverConnector {
	/**
	 * Connect to a `DriverServer` socket and wait for its `ready` event (protocol checked). Every request gets an id and a
	 * timeout (`E_TIMEOUT`); the connection closing fails what is in flight, and everything after, with `E_HELPER_CRASHED`
	 * (a tap in flight may have landed: callers must not resend input on it).
	 */
	async connect(options: ConnectRemoteOptions): Promise<Result<RemoteClient, DriverError>> {
		const link = new RemoteLink(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
		const opened = await simdTransports.socket({ socketPath: options.socketPath })({
			onLine: link.onLine,
			onDiagnostic: () => undefined,
			onClose: () =>
				link.failAll(
					driverErrors.make("E_HELPER_CRASHED", `the driver host on ${options.socketPath} closed the connection`)
				),
		});
		if (!opened.success) return opened;
		const transport: Transport = opened.data;
		link.attach(transport);

		const timeout = setTimeout(
			() =>
				link.reportReady({
					success: false,
					error: driverErrors.make("E_TIMEOUT", `no ready event on ${options.socketPath}`),
				}),
			options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
		);
		const ready = await link.readyPromise;
		clearTimeout(timeout);
		if (!ready.success) {
			await transport.close();
			return ready;
		}
		if (ready.data.protocol !== REMOTE_PROTOCOL) {
			await transport.close();
			return {
				success: false,
				error: driverErrors.make(
					"E_HELPER_CRASHED",
					`the driver host speaks protocol ${ready.data.protocol}, this warden expects ${REMOTE_PROTOCOL}`,
					{ retryable: false }
				),
			};
		}
		return { success: true, data: new RemoteClientImpl(ready.data, link) };
	}
}

export const remoteDriverConnector = new RemoteDriverConnector();

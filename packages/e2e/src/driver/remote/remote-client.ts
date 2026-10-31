import type { Result } from "@delacour/warden-types/result";
import type { AlertBackend, ProbesFrontmost, ReadsAlertOn } from "../alerts";
import { detectAlert } from "../android/android-alert";
import type {
	AlertInfo,
	AppCommands,
	Driver,
	DriverCapabilities,
	DriverError,
	DriverResult,
	KeyName,
	Snapshot,
} from "../driver.types";
import { driverError } from "../errors";
import { socketTransport, type Transport } from "../ios/simd-transport";
import type { DetectsAlerts } from "../observation-cache";
import type { RepeatingKeys, SelectsAll, SetsText } from "../typing";
import {
	REMOTE_PROTOCOL,
	type ReadyEvent,
	type RemoteOp,
	readyEventSchema,
	responseSchema,
	screenshotFromWire,
	snapshotFromWire,
	type WireScreenshot,
	type WireSnapshot,
	wireError,
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
 * Connect to a `serveDriver` socket and wait for its `ready` event (protocol checked). Every request gets an id and a
 * timeout (`E_TIMEOUT`); the connection closing fails what is in flight, and everything after, with `E_HELPER_CRASHED`
 * (a tap in flight may have landed: callers must not resend input on it).
 */
export async function connectRemoteDriver(options: ConnectRemoteOptions): Promise<Result<RemoteClient, DriverError>> {
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const pending = new Map<number, Pending>();
	let nextId = 1;
	let closed: DriverError | undefined;
	let capabilities: DriverCapabilities | undefined;
	let onReady: (ready: Result<ReadyEvent, DriverError>) => void = () => undefined;
	const readyPromise = new Promise<Result<ReadyEvent, DriverError>>((resolve) => {
		onReady = resolve;
	});

	const failAll = (error: DriverError) => {
		closed ??= error;
		onReady({ success: false, error });
		for (const [id, entry] of pending) {
			clearTimeout(entry.timer);
			pending.delete(id);
			entry.resolve({ success: false, error });
		}
	};

	const onLine = (line: string) => {
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			return;
		}
		const ready = readyEventSchema.safeParse(raw);
		if (ready.success) {
			capabilities = ready.data.capabilities;
			onReady({ success: true, data: ready.data });
			return;
		}
		const response = responseSchema.safeParse(raw);
		if (!response.success) return;
		const { id, result } = response.data;
		if (response.data.capabilities !== undefined) capabilities = response.data.capabilities;
		const entry = pending.get(id);
		if (entry === undefined) return;
		clearTimeout(entry.timer);
		pending.delete(id);
		entry.resolve(
			result.success ? { success: true, data: result.data } : { success: false, error: wireError(result.error) }
		);
	};

	const opened = await socketTransport({ socketPath: options.socketPath })({
		onLine,
		onDiagnostic: () => undefined,
		onClose: () =>
			failAll(driverError("E_HELPER_CRASHED", `the driver host on ${options.socketPath} closed the connection`)),
	});
	if (!opened.success) return opened;
	const transport: Transport = opened.data;

	const timeout = setTimeout(
		() => onReady({ success: false, error: driverError("E_TIMEOUT", `no ready event on ${options.socketPath}`) }),
		options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
	);
	const ready = await readyPromise;
	clearTimeout(timeout);
	if (!ready.success) {
		await transport.close();
		return ready;
	}
	if (ready.data.protocol !== REMOTE_PROTOCOL) {
		await transport.close();
		return {
			success: false,
			error: driverError(
				"E_HELPER_CRASHED",
				`the driver host speaks protocol ${ready.data.protocol}, this warden expects ${REMOTE_PROTOCOL}`,
				{ retryable: false }
			),
		};
	}
	const hello = ready.data;

	const send = (op: string, args: readonly unknown[], opts: RequestOptions = {}): DriverResult<unknown> => {
		if (closed !== undefined) return Promise.resolve({ success: false, error: closed });
		const id = nextId++;
		return new Promise((resolve) => {
			const ms = opts.timeoutMs ?? requestTimeoutMs;
			const timer = setTimeout(() => {
				pending.delete(id);
				resolve({ success: false, error: driverError("E_TIMEOUT", `\`${op}\` got no answer within ${ms} ms`) });
			}, ms);
			pending.set(id, { resolve, timer });
			transport.send(`${JSON.stringify({ id, op, args })}\n`);
		});
	};

	/** The op's own `DriverResult`, typed by the `Driver` method it serves (the host is this warden's own build). */
	const call = <T>(op: RemoteOp, ...args: unknown[]): DriverResult<T> => send(op, args) as DriverResult<T>;

	const close = async () => {
		await transport.close();
		failAll(driverError("E_HELPER_CRASHED", "the remote driver connection is closed"));
	};

	const app: AppCommands = {
		launch: (bundleId, opts) => call("app.launch", bundleId, opts),
		terminate: (bundleId) => call("app.terminate", bundleId),
		openUrl: (url) => call("app.openUrl", url),
		install: (path) => call("app.install", path),
		uninstall: (bundleId) => call("app.uninstall", bundleId),
		isInstalled: (bundleId) => call("app.isInstalled", bundleId),
		isRunning: (bundleId) => call("app.isRunning", bundleId),
		clearData: (bundleId, opts) => call("app.clearData", bundleId, opts),
	};

	const snapshot: Driver["snapshot"] = async (opts) => {
		const taken = await call<WireSnapshot>("snapshot", opts);
		return taken.success ? { success: true, data: snapshotFromWire(taken.data) } : taken;
	};

	const screenshot: Driver["screenshot"] = async (opts) => {
		const shot = await call<WireScreenshot>("screenshot", opts);
		return shot.success ? { success: true, data: screenshotFromWire(shot.data) } : shot;
	};

	const buildDriver = (): RemoteDriver => {
		const base: Driver = {
			platform: hello.platform,
			id: hello.id,
			get capabilities(): DriverCapabilities {
				return capabilities ?? hello.capabilities;
			},
			health: () => call("health"),
			snapshot,
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
			screenshot,
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
			app,
			close,
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
			hello.alertIn === "android" ? { alertIn: (shot: Snapshot) => detectAlert(shot.flat) } : {}
		);
	};

	return {
		success: true,
		data: {
			ready: hello,
			request: (op, _params, opts) => send(op, [], opts),
			driver: buildDriver,
			close,
		},
	};
}

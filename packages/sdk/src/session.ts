import { statSync } from "node:fs";
import { openDriver } from "@delacour/warden-device/open";
import type { Driver, DriverResult, Element, Role } from "@delacour/warden-driver/driver.types";
import { E2eError } from "@delacour/warden-driver/e2e-error";
import { driverErr } from "@delacour/warden-driver/errors";
import { cacheObservations } from "@delacour/warden-driver/observation-cache";
import { assignRefs } from "@delacour/warden-driver/refs";
import { traceDriver } from "@delacour/warden-driver/traced-driver";

import { connectHelper } from "@delacour/warden-driver-ios/helper";
import { type CallerLease, ensureCallerLease } from "@delacour/warden-leasing/device-lease";
import { createScreen } from "@delacour/warden-screen/screen";
import { formatSelector } from "@delacour/warden-screen/selector";
import { getInstall, listBuilds } from "@delacour/warden-store/builds-table";
import type { Lease, Platform } from "@delacour/warden-store/types";
import { type WardenError as EngineError, wardenErr } from "@delacour/warden-types/error";
import { ok, type Result } from "@delacour/warden-types/result";
import { abortableSleep, type Core, guard, guarded } from "./core";
import { defaultDevtoolsDeps } from "./devtools-deps";
import { fromThrown, interrupted, toWardenError, WardenError } from "./errors";
import { hidLostIn, recoverSimHid } from "./hid-recovery";
import { nativeLogsMethod } from "./native-logs-namespace";
import { fill, key, longPress, parseKey, press, swipe, type as typeOp } from "./ops/actions";
import { authoringFor } from "./ops/authoring/authoring-default";
import { journalRecorder, routeAfterFor } from "./ops/authoring/recorder";
import { alert, hardware, screenAppearance, screenRotate, screenshot as screenshotOp } from "./ops/controls";
import { evaluate, logs, network, reload, tree } from "./ops/devtools";
import { driverError } from "./ops/errors";
import { path as pathOp, pinch, rotate } from "./ops/gestures";
import { followNativeLogs as followNativeLogsOp, nativeLogs as nativeLogsOp } from "./ops/native-logs";
import { open as openOp } from "./ops/open";
import { get, is, wait } from "./ops/query";
import { createMemoryRefStore } from "./ops/ref-store";
import { route as routeOp } from "./ops/route";
import { scroll } from "./ops/scroll";
import type { OpDevice, OpDone, OpOutcome, OpSession } from "./ops/session";
import type { ElementJson } from "./ops/snapshot";
import { find, snapshot } from "./ops/snapshot";
import { createMemoryStateStore } from "./ops/state-store";
import { video } from "./ops/video";
import { buildSessionPerf } from "./perf";
import type { SessionPerfNamespace } from "./perf.types";
import type {
	AppOpenParams,
	AppRefParams,
	CallOptions,
	ClearDataParams,
	ConsoleEntry,
	ConsoleParams,
	DeviceRef,
	ElementTarget,
	EvalParams,
	FillParams,
	FindParams,
	GestureParams,
	GetParams,
	GetResult,
	IsParams,
	KeyParams,
	LongPressParams,
	NativeLogEntry,
	NativeLogsParams,
	NetworkEntry,
	NetworkParams,
	PinchParams,
	PressParams,
	RotateParams,
	ScreenshotParams,
	ScreenshotResult,
	ScrollParams,
	Session,
	SessionAppsNamespace,
	SessionCaptureNamespace,
	SessionDeviceNamespace,
	SessionDevtoolsNamespace,
	SessionInteractionsNamespace,
	SessionLocator,
	SessionOpenParams,
	SessionQueryNamespace,
	SessionRecordNamespace,
	SnapshotElement,
	SnapshotParams,
	SnapshotResult,
	SwipeParams,
	Target,
	TreeNode,
	TypeParams,
	VideoResult,
	VideoStartParams,
	WaitParams,
} from "./sdk.types";

const IOS_UDID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^@e\d+$/;

const ROLES: ReadonlySet<string> = new Set<Role>([
	"button",
	"text",
	"textfield",
	"securefield",
	"searchfield",
	"image",
	"switch",
	"checkbox",
	"slider",
	"link",
	"cell",
	"list",
	"scrollview",
	"tab",
	"tabbar",
	"alert",
	"sheet",
	"keyboard",
	"navbar",
	"toolbar",
	"window",
	"application",
	"other",
]);

const isRole = (value: string): value is Role => ROLES.has(value);
const isRefText = (value: string): value is `@e${number}` => REF.test(value);

/** A target as the words the ops parse: `@e3`, a selector, or `x y`. */
export function targetText(target: Target): string {
	if ("ref" in target) return target.ref;
	if ("selector" in target) return target.selector;
	return `${target.point.x} ${target.point.y}`;
}

function usage(message: string, hint?: string): WardenError {
	return new WardenError({ code: "usage", message, ...(hint !== undefined ? { hint } : {}) });
}

/** The platform and id a {@link DeviceRef} names, from the lease, the store's records, or the id's shape. */
export function deviceOf(core: Core, ref: DeviceRef): { platform: Platform; id: string; name?: string } {
	if ("lease" in ref) {
		const resource = ref.lease.resource;
		if (resource.kind !== "device") throw usage(`lease ${ref.lease.id} is not a device lease`);
		return { platform: resource.platform, id: resource.id, name: resource.name };
	}
	if ("serial" in ref) return { platform: "android", id: ref.serial };
	const store = core.store();
	const leased = store.listLeases().find((l) => l.resource.kind === "device" && l.resource.id === ref.udid);
	if (leased?.resource.kind === "device") {
		return { platform: leased.resource.platform, id: ref.udid, name: leased.resource.name };
	}
	const known = store.listDevices().find((d) => d.id === ref.udid);
	if (known) return { platform: known.platform, id: ref.udid, name: known.name };
	return { platform: IOS_UDID.test(ref.udid) ? "ios" : "android", id: ref.udid };
}

/**
 * Prove the client's owner may use the device: its own lease (heartbeat), else `device_foreign` /
 * `device_not_leased`. A device warden did not lease is never touched, and a free device is not leased here
 * (`leases.claim` does that).
 */
export function requireLease(core: Core, device: { platform: Platform; id: string; name?: string }): CallerLease {
	const checked = ensureCallerLease(core.store(), core.owner, device.platform, device.id, {
		now: core.host.now(),
		pidAlive: core.host.pidAlive,
		claim: false,
		label: core.options.label ?? "warden sdk",
		...(device.name !== undefined ? { name: device.name } : {}),
		pid: process.pid,
	});
	if (checked.success) return checked.data;
	const { code, message } = checked.error;
	throw new WardenError({
		code,
		message,
		...(code === "device_not_leased"
			? { hint: `lease it first: client.leases.claim({ platform: "${device.platform}" })` }
			: {}),
	});
}

type LiveSession = {
	core: Core;
	device: OpDevice;
	lease: Lease;
	appId: string | undefined;
	sessionId: string;
};

function pngSize(bytes: Uint8Array): { width: number; height: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.byteLength < 24 || view.getUint32(0) !== 0x89504e47) return { width: 0, height: 0 };
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

const kebab = (orientation: string): string => orientation.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const camel = (orientation: string): "portrait" | "portraitUpsideDown" | "landscapeLeft" | "landscapeRight" => {
	switch (orientation) {
		case "portrait-upside-down":
			return "portraitUpsideDown";
		case "landscape-left":
			return "landscapeLeft";
		case "landscape-right":
			return "landscapeRight";
		default:
			return "portrait";
	}
};

function snapshotElement(e: ElementJson): SnapshotElement | undefined {
	if (e.ref === undefined || !isRefText(e.ref)) return undefined;
	return {
		ref: e.ref,
		role: isRole(e.role) ? e.role : "other",
		...(e.name !== undefined ? { label: e.name } : {}),
		...(e.id !== undefined ? { identifier: e.id } : {}),
		...(e.value !== undefined ? { value: e.value } : {}),
		frame: [e.frame.x, e.frame.y, e.frame.width, e.frame.height],
		enabled: e.enabled,
		...(e.selected !== undefined ? { selected: e.selected } : {}),
		...(e.checked !== undefined ? { checked: e.checked } : {}),
	};
}

function elementsOf(list: readonly ElementJson[]): SnapshotElement[] {
	return list.flatMap((e) => snapshotElement(e) ?? []);
}

type TreeComponent = {
	id: number;
	name: string;
	testID?: string;
	label?: string;
	text?: string;
	parent: number | null;
	rect?: { x: number; y: number; width: number; height: number };
};

/** The props a component carries into a {@link TreeNode}: only the ones it has. */
function treeProps(c: TreeComponent): Record<string, unknown> {
	return {
		...(c.testID !== undefined ? { testID: c.testID } : {}),
		...(c.label !== undefined ? { label: c.label } : {}),
		...(c.text !== undefined ? { text: c.text } : {}),
		...(c.rect !== undefined ? { rect: c.rect } : {}),
	};
}

function treeOf(components: readonly TreeComponent[]): TreeNode[] {
	const nodes = new Map<number, TreeNode>();
	for (const c of components) {
		const props = treeProps(c);
		nodes.set(c.id, { name: c.name, ...(Object.keys(props).length > 0 ? { props } : {}), children: [] });
	}
	const roots: TreeNode[] = [];
	for (const c of components) {
		const node = nodes.get(c.id);
		if (!node) continue;
		const parent = c.parent === null ? undefined : nodes.get(c.parent);
		(parent ? parent.children : roots).push(node);
	}
	return roots;
}

/** The session: one driver on one leased device. Every method calls a typed op and throws a {@link WardenError}. */
export class WardenSession implements Session {
	readonly deviceId: string;
	readonly platform: Platform;
	readonly sessionId: string;
	readonly apps: SessionAppsNamespace;
	readonly capture: SessionCaptureNamespace;
	readonly interactions: SessionInteractionsNamespace;
	readonly query: SessionQueryNamespace;
	readonly device: SessionDeviceNamespace;
	readonly devtools: SessionDevtoolsNamespace;
	readonly record: SessionRecordNamespace;
	readonly perf: SessionPerfNamespace;

	private readonly core: Core;
	private readonly dev: OpDevice;
	private readonly appId: string | undefined;
	private readonly leaseId: string;
	private readonly refs = createMemoryRefStore();
	private readonly state = createMemoryStateStore();
	private driverOpen: Promise<Result<Driver, EngineError>> | undefined;
	private opened: Driver | undefined;
	private closed = false;
	private videoStartedAt: number | undefined;
	private hidRecovered = false;
	private readonly stopPerf: () => Promise<void>;

	constructor(init: LiveSession) {
		this.core = init.core;
		this.dev = init.device;
		this.appId = init.appId;
		this.leaseId = init.lease.id;
		this.deviceId = init.device.id;
		this.platform = init.device.platform;
		this.sessionId = init.sessionId;
		this.apps = this.buildApps();
		this.capture = this.buildCapture();
		this.interactions = this.buildInteractions();
		this.query = this.buildQuery();
		this.device = this.buildDevice();
		this.devtools = this.buildDevtools();
		this.record = this.buildRecord();
		const perf = buildSessionPerf(init.core, {
			device: init.device,
			lease: init.lease,
			appId: init.appId,
			closed: () => this.closed,
		});
		this.perf = perf.namespace;
		this.stopPerf = perf.stopOwn;
	}

	/** Open the driver now, so a missing engine fails `sessions.open` rather than the first call. */
	async connect(): Promise<void> {
		const driver = await this.driver();
		if (!driver.success) throw toWardenError(driver.error, "no");
	}

	locator(selector: string): SessionLocator {
		const host = this.core.host;
		const timeout = 10_000;
		const locatorFor = (signal: AbortSignal | undefined) => {
			const screen = createScreen({
				driver: async () => {
					const driver = await this.driver();
					if (!driver.success) throw toWardenError(driver.error, "no");
					return driver.data;
				},
				env: { actionTimeoutMs: timeout, assertionTimeoutMs: timeout },
				...(signal ? { signal } : {}),
				clock: { now: host.now, sleep: (ms) => abortableSleep(ms, signal) },
			});
			return screen.locator(selector);
		};
		const run = async <T>(
			opts: CallOptions | undefined,
			work: (l: ReturnType<typeof locatorFor>) => Promise<T>
		): Promise<T> => {
			const signal = this.core.signalFor(opts);
			return guarded(signal, async () => {
				try {
					return await work(locatorFor(signal));
				} catch (error) {
					throw this.fromLocatorError(error);
				}
			});
		};
		return {
			selector,
			press: (opts) => run(opts, (l) => l.tap()),
			fill: (text, opts) => run(opts, (l) => l.fill(text)),
			waitForVisible: async (params, opts) => {
				await run(opts, (l) =>
					l.waitFor({ state: "visible", ...(params?.timeoutMs !== undefined ? { timeout: params.timeoutMs } : {}) })
				);
				const found = await this.query.find({ selector }, opts);
				const first = found[0];
				if (!first) throw new WardenError({ code: "target_not_found", message: `${selector} matched nothing` });
				return first;
			},
			count: (opts) => run(opts, (l) => l.count()),
		};
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.core.sessions.delete(this.sessionId);
		this.core.emit({ kind: "session:closed", sessionId: this.sessionId });
		await this.stopPerf();
		const driver =
			this.opened ??
			(this.driverOpen ? await this.driverOpen.then((r) => (r.success ? r.data : undefined)) : undefined);
		await driver?.close();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}

	// ─── plumbing ──────────────────────────────────────────────────────

	private fromLocatorError(error: unknown): WardenError {
		if (error instanceof E2eError) {
			switch (error.code) {
				case "TIMEOUT":
					return new WardenError({ code: "timeout", message: error.message, retryable: true });
				case "LOCATOR_NOT_FOUND":
					return new WardenError({ code: "target_not_found", message: error.message });
				case "INVALID_LOCATOR":
				case "INVALID_ARGUMENT":
					return new WardenError({ code: "usage", message: error.message });
				case "DRIVER":
					return new WardenError({ code: "engine_unavailable", message: error.message });
				default:
					return new WardenError({ code: "failed", message: error.message });
			}
		}
		return fromThrown(error);
	}

	private driver(): Promise<Result<Driver, EngineError>> {
		this.driverOpen ??= this.openDriver().then((result) => {
			if (result.success) this.opened = result.data;
			return result;
		});
		return this.driverOpen;
	}

	private async openDriver(): Promise<Result<Driver, EngineError>> {
		const raw = await this.openRaw();
		if (!raw.success) return raw;
		const traced = traceDriver(raw.data, {
			now: this.core.host.now,
			trace: () => ({
				write: (event) => {
					if (event.type === "span") {
						this.core.emit({ kind: "debug", message: `${event.op} ${event.ok ? "ok" : "failed"} ${event.ms}ms` });
					}
				},
			}),
		});
		return ok(cacheObservations(traced, { now: this.core.host.now }));
	}

	private async openRaw(): Promise<Result<Driver, EngineError>> {
		const { core } = this;
		if (core.seams.openDriver) return core.seams.openDriver(this.dev, this.appId);
		const pluginName = core.store().getLease(this.leaseId)?.provider;
		if (pluginName !== undefined) return this.openPluginDriver(pluginName);
		if (this.dev.platform === "ios") {
			return connectHelper(
				{ env: core.host.env, now: core.host.now, store: core.store, exec: core.host.exec },
				this.dev.id
			);
		}
		const opened = await openDriver({
			platform: "android",
			id: this.dev.id,
			...(this.appId !== undefined ? { appId: this.appId } : {}),
			host: { exec: core.host.exec, home: core.host.home },
		});
		return opened.success ? opened : { success: false, error: driverError(opened.error) };
	}

	/** The driver of a device a provider plugin leased: its `driver(id)`, whose throw becomes a typed failure. */
	private async openPluginDriver(name: string): Promise<Result<Driver, EngineError>> {
		try {
			const provider = await this.core.pluginProvider(name);
			if (!provider.driver) {
				return wardenErr("engine_unavailable", `provider plugin "${name}" has no driver()`, {
					hint: "give the plugin a driver(id) or open sessions through a bundled provider",
				});
			}
			return ok(await provider.driver(this.dev.id));
		} catch (error) {
			return wardenErr("engine_unavailable", `provider plugin "${name}" could not open a driver: ${String(error)}`);
		}
	}

	private sleepFor(signal: AbortSignal | undefined): (ms: number) => Promise<void> {
		if (!signal) return (ms) => this.core.host.sleep(ms);
		return (ms) =>
			new Promise<void>((resolve, reject) => {
				if (signal.aborted) {
					reject(interrupted());
					return;
				}
				const onAbort = () => reject(interrupted());
				signal.addEventListener("abort", onAbort, { once: true });
				this.core.host.sleep(ms).then(
					() => {
						signal.removeEventListener("abort", onAbort);
						resolve();
					},
					(error: unknown) => {
						signal.removeEventListener("abort", onAbort);
						reject(error);
					}
				);
			});
	}

	private opSession(signal: AbortSignal | undefined, timeoutMs = 10_000): OpSession {
		const { core } = this;
		const host = {
			env: core.host.env,
			cwd: core.host.cwd,
			home: core.host.home,
			now: core.host.now,
			exec: (cmd: readonly string[], options?: Parameters<typeof core.host.exec>[1]) =>
				core.host.exec(cmd, signal ? { ...options, signal: options?.signal ?? signal } : options),
			sleep: this.sleepFor(signal),
			...(core.host.log ? { log: core.host.log } : {}),
		};
		const session: OpSession = {
			device: this.dev,
			host,
			driver: () => this.driver(),
			refs: this.refs,
			state: this.state,
			timeoutMs,
			ports: () =>
				core
					.store()
					.listLeases()
					.flatMap((lease) =>
						lease.resource.kind === "port" && lease.owner.kind === core.owner.kind ? [lease.resource.port] : []
					),
			...(core.seams.video ? { video: core.seams.video } : {}),
			devtools: core.seams.devtools ?? defaultDevtoolsDeps(core.host.env),
			authoring: authoringFor(core),
		};
		session.recorder = journalRecorder({
			home: host.home,
			env: host.env,
			now: host.now,
			state: this.state,
			refs: this.refs,
			warn: (message) => core.emit({ kind: "debug", message }),
		});
		session.routeAfter = routeAfterFor(this.state, () => session);
		return session;
	}

	/** Run one op: abort check, the op, an `action` event, and the unwrap into a thrown {@link WardenError}. */
	private async run<R>(
		name: string,
		opts: CallOptions | undefined,
		op: (session: OpSession) => OpOutcome<R>,
		timeoutMs?: number
	): Promise<OpDone<R>> {
		if (this.closed) throw usage("session is closed");
		const signal = this.core.signalFor(opts);
		guard(signal);
		const started = this.core.host.now();
		let done: Result<OpDone<R>, EngineError>;
		try {
			done = await this.withHidRecovery(signal, () => op(this.opSession(signal, timeoutMs)));
		} catch (error) {
			this.core.emit({
				kind: "action",
				sessionId: this.sessionId,
				op: name,
				ok: false,
				ms: this.core.host.now() - started,
			});
			throw fromThrown(error, signal);
		}
		this.core.emit({
			kind: "action",
			sessionId: this.sessionId,
			op: name,
			ok: done.success,
			ms: this.core.host.now() - started,
		});
		if (!done.success) throw toWardenError(done.error);
		return done.data;
	}

	/**
	 * iOS only, once per session: an op that fails because the sim's HID connection was lost (Device Hub quit) reboots
	 * the sim, reopens the driver and runs once more (see `hid-recovery.ts`).
	 */
	private async withHidRecovery<R>(
		signal: AbortSignal | undefined,
		attempt: () => OpOutcome<R>
	): Promise<Result<OpDone<R>, EngineError>> {
		const first = await attempt();
		if (this.platform !== "ios" || this.hidRecovered || !hidLostIn(first)) return first;
		this.hidRecovered = true;
		const { host } = this.core;
		const recovered = await recoverSimHid(
			{
				exec: (cmd, options) => host.exec(cmd, signal ? { ...options, signal: options?.signal ?? signal } : options),
				env: host.env,
				log: (message) => this.core.emit({ kind: "warn", message }),
				resetDriver: () => this.resetDriver(),
			},
			this.deviceId
		);
		return recovered ? attempt() : first;
	}

	/** Close the open driver and forget it: the next call opens a fresh one. */
	private async resetDriver(): Promise<void> {
		const open = this.driverOpen;
		this.driverOpen = undefined;
		this.opened = undefined;
		const driver = open ? await open.then((r) => (r.success ? r.data : undefined)) : undefined;
		await driver?.close().catch(() => undefined);
	}

	/** A driver call outside the ops (clipboard, hardware buttons, install): same abort and error rules. */
	private async direct<T>(
		name: string,
		opts: CallOptions | undefined,
		work: (driver: Driver) => DriverResult<T>
	): Promise<T> {
		const done = await this.run(name, opts, async () => {
			const driver = await this.driver();
			if (!driver.success) return driver;
			const result = await work(driver.data);
			return result.success
				? ok({ result: result.data, text: name })
				: { success: false as const, error: driverError(result.error) };
		});
		return done.result;
	}

	/** An element target as a selector: a ref is read back from the stored snapshot (`id=` else `label=`). */
	private selectorOf(target: ElementTarget): string {
		if ("selector" in target) return target.selector;
		const last = this.refs.last();
		const element: Element | undefined = last
			? assignRefs(last.snapshot, last.generation).byRef.get(target.ref)
			: undefined;
		if (!element) {
			throw new WardenError({
				code: "stale_ref",
				message: `${target.ref} is not in the current snapshot`,
				hint: "take a snapshot again",
			});
		}
		if (element.identifier !== undefined) return formatSelector({ id: { kind: "text", value: element.identifier } });
		if (element.label !== undefined) return formatSelector({ label: { kind: "text", value: element.label } });
		throw usage(`${target.ref} has neither an id nor a label to select it by`, "use a selector");
	}

	private appFor(app: string | undefined): string {
		const id = app ?? this.appId;
		if (id === undefined) throw usage("no app: pass `app` or open the session with one");
		return id;
	}

	// ─── namespaces ────────────────────────────────────────────────────

	private buildApps(): SessionAppsNamespace {
		const launch = async (params: AppOpenParams | undefined, opts: CallOptions | undefined, relaunch: boolean) => {
			const app = this.appFor(params?.app);
			if (params?.url !== undefined) {
				await this.run("apps.open", opts, (s) => openOp(s, { target: params.url ?? "" }));
				return;
			}
			if (params?.env !== undefined && Object.keys(params.env).length > 0) {
				await this.direct("apps.open", opts, (d) =>
					d.app.launch(app, {
						relaunch,
						env: params.env ?? {},
						...(params.args ? { args: params.args } : {}),
					})
				);
				return;
			}
			await this.run("apps.open", opts, (s) =>
				openOp(s, { target: app, relaunch, ...(params?.args ? { args: params.args } : {}) })
			);
		};
		return {
			open: (params, opts) => launch(params, opts, params?.relaunch ?? true),
			close: async (params, opts) => {
				const app = this.appFor(params?.app);
				await this.direct("apps.close", opts, (d) => d.app.terminate(app));
			},
			restart: (params, opts) => launch(params, opts, true),
			reinstall: async (params: AppRefParams | undefined, opts) => {
				const app = this.appFor(params?.app);
				const path = this.cachedBuildFor(app);
				await this.direct("apps.reinstall", opts, async (d) => {
					const removed = await d.app.uninstall(app);
					return removed.success ? d.app.install(path) : removed;
				});
			},
			clearData: async (params: ClearDataParams | undefined, opts) => {
				const app = this.appFor(params?.app);
				await this.direct("apps.clearData", opts, (d) =>
					d.app.clearData(app, params?.keychain ? { keychain: true } : {})
				);
			},
		};
	}

	/** The cached build the store says is installed for `app` on this device. */
	private cachedBuildFor(app: string): string {
		const store = this.core.store();
		const installed = getInstall(store, this.dev.platform, this.dev.id, app);
		const build = installed
			? listBuilds(store).find((b) => b.platform === this.dev.platform && b.hash === installed.hash)
			: undefined;
		if (!build) {
			throw new WardenError({
				code: "not_found",
				message: `no cached build of ${app} for ${this.dev.id}`,
				hint: "install it with client.apps.ensure(...) first",
			});
		}
		return build.path;
	}

	private buildCapture(): SessionCaptureNamespace {
		return {
			snapshot: async (params: SnapshotParams | undefined, opts) => {
				const done = await this.run("capture.snapshot", opts, (s) =>
					snapshot(s, {
						interactiveOnly: params?.interactiveOnly === true,
						all: params?.offscreen === true,
					})
				);
				const r = done.result;
				const stored = this.refs.last();
				const result: SnapshotResult = {
					platform: this.platform,
					takenAt: stored?.takenAt ?? this.core.host.now(),
					generation: r.generation,
					screen: { width: r.screen.width, height: r.screen.height, scale: r.screen.scale },
					elements: elementsOf(r.elements),
					text: done.text,
					truncated: r.truncated,
				};
				return result;
			},
			screenshot: async (params: ScreenshotParams | undefined, opts): Promise<ScreenshotResult> => {
				if (params?.format === "jpeg") throw usage("jpeg screenshots are not supported yet", "use format png");
				let path: string;
				if (params?.scale !== undefined) {
					path = params.path ?? `${this.core.host.home}/ui/${this.dev.id}/shot-${this.core.host.now()}.png`;
					await this.direct("capture.screenshot", opts, (d) => d.screenshot({ path, scale: params.scale ?? 1 }));
				} else {
					const done = await this.run("capture.screenshot", opts, (s) =>
						screenshotOp(s, params?.path !== undefined ? { path: params.path } : {})
					);
					path = done.result.path;
				}
				const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
				const size = pngSize(bytes);
				return { ...(params?.path !== undefined ? { path } : {}), ...size, bytes };
			},
			video: {
				start: async (params: VideoStartParams, opts) => {
					await this.run("capture.video.start", opts, (s) => video(s, { action: "start", path: params.path }));
					this.videoStartedAt = this.core.host.now();
				},
				stop: async (opts): Promise<VideoResult> => {
					const done = await this.run("capture.video.stop", opts, (s) => video(s, { action: "stop" }));
					const started = this.videoStartedAt ?? this.core.host.now();
					this.videoStartedAt = undefined;
					return {
						path: done.result.state === "stopped" ? done.result.path : "",
						durationMs: this.core.host.now() - started,
					};
				},
			},
		};
	}

	private buildInteractions(): SessionInteractionsNamespace {
		return {
			press: async (params: PressParams, opts) => {
				for (let i = 0; i < (params.count ?? 1); i += 1) {
					await this.run("interactions.press", opts, (s) => press(s, { target: targetText(params) }));
				}
			},
			longPress: async (params: LongPressParams, opts) => {
				await this.run("interactions.longPress", opts, (s) =>
					longPress(s, {
						target: targetText(params),
						...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
					})
				);
			},
			fill: async (params: FillParams, opts) => {
				await this.run("interactions.fill", opts, (s) => fill(s, { target: targetText(params), text: params.text }));
			},
			type: async (params: TypeParams, opts) => {
				await this.run("interactions.type", opts, (s) => typeOp(s, { text: params.text }));
			},
			key: async (params: KeyParams, opts) => {
				const times = params.times ?? 1;
				for (let i = 0; i < times; i += 1) {
					if (params.modifiers && params.modifiers.length > 0) {
						const name = parseKey(params.key);
						if (!name.success) throw toWardenError(name.error);
						await this.direct("interactions.key", opts, (d) => d.key(name.data, params.modifiers));
					} else {
						await this.run("interactions.key", opts, (s) => key(s, { key: params.key }));
					}
				}
			},
			swipe: async (params: SwipeParams, opts) => {
				await this.run("interactions.swipe", opts, (s) => swipe(s, { from: params.from, to: params.to }));
			},
			scroll: async (params: ScrollParams, opts) => {
				await this.run("interactions.scroll", opts, (s) =>
					scroll(s, {
						direction: params.direction,
						...(params.amount !== undefined ? { amount: params.amount } : {}),
						...(params.target ? { within: targetText(params.target) } : {}),
						...(params.until ? { until: this.selectorOf(params.until) } : {}),
					})
				);
			},
			pinch: async (params: PinchParams, opts) => {
				await this.run("interactions.pinch", opts, (s) =>
					pinch(s, {
						scale: params.scale,
						target: targetText(params),
						...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
					})
				);
			},
			rotate: async (params: RotateParams, opts) => {
				await this.run("interactions.rotate", opts, (s) =>
					rotate(s, {
						degrees: params.degrees,
						target: targetText(params),
						...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
					})
				);
			},
			gesture: async (params: GestureParams, opts) => {
				const durationMs = params.paths.find((p) => p.durationMs !== undefined)?.durationMs;
				await this.run("interactions.gesture", opts, (s) =>
					pathOp(s, {
						paths: params.paths.map((p) => p.points.map((pt) => `${pt.x},${pt.y}`).join(" ")),
						...(durationMs !== undefined ? { durationMs } : {}),
					})
				);
			},
		};
	}

	private buildQuery(): SessionQueryNamespace {
		return {
			find: async (params: FindParams, opts) => {
				const done = await this.run("query.find", opts, (s) => find(s, { selector: params.selector }));
				const all = elementsOf(done.result.elements);
				return params.all === false ? all.slice(0, 1) : all;
			},
			wait: async (params: WaitParams, opts) => {
				const timeoutMs = params.timeoutMs;
				const condition = params.for;
				if (condition === "hidden" || condition === "present") {
					const selector = this.selectorOf(params);
					const locator = this.locator(selector);
					const signal = this.core.signalFor(opts);
					await guarded(signal, async () => {
						const screen = createScreen({
							driver: async () => {
								const driver = await this.driver();
								if (!driver.success) throw toWardenError(driver.error, "no");
								return driver.data;
							},
							env: { actionTimeoutMs: timeoutMs ?? 10_000, assertionTimeoutMs: timeoutMs ?? 10_000 },
							...(signal ? { signal } : {}),
							clock: { now: this.core.host.now, sleep: (ms) => abortableSleep(ms, signal) },
						});
						try {
							await screen.locator(locator.selector).waitFor({ state: condition === "hidden" ? "hidden" : "attached" });
						} catch (error) {
							throw this.fromLocatorError(error);
						}
					});
					return undefined;
				}
				const done = await this.run(
					"query.wait",
					opts,
					(s) => {
						switch (params.for) {
							case "visible":
								return wait(s, { mode: "visible", selector: this.selectorOf(params) });
							case "absent":
								return wait(s, { mode: "absent", selector: this.selectorOf(params) });
							case "text":
								return wait(s, { mode: "text", text: params.text });
							default:
								return wait(s, { mode: "stable" });
						}
					},
					timeoutMs
				);
				const found = done.result.element ? snapshotElement(done.result.element) : undefined;
				return found;
			},
			is: async (params: IsParams, opts) => {
				const done = await this.run("query.is", opts, (s) =>
					is(s, { selector: this.selectorOf(params), state: params.state })
				);
				return done.result.matched;
			},
			get: async (params: GetParams, opts): Promise<GetResult> => {
				const property = params.property === "identifier" ? "id" : params.property;
				const done = await this.run("query.get", opts, (s) => get(s, { selector: this.selectorOf(params), property }));
				const r = done.result;
				if (r.property === "count") return { property: "text", value: String(r.value) };
				const text = typeof r.value === "string" ? r.value : undefined;
				switch (params.property) {
					case "frame":
						return typeof r.value === "object"
							? { property: "frame", value: [r.value.x, r.value.y, r.value.width, r.value.height] }
							: { property: "text", value: text };
					case "role": {
						const role = String(r.value);
						return { property: "role", value: isRole(role) ? role : "other" };
					}
					default:
						return { property: params.property, value: text };
				}
			},
		};
	}

	private buildDevice(): SessionDeviceNamespace {
		return {
			home: async (opts) => {
				await this.run("device.home", opts, (s) => hardware(s, { button: "home" }));
			},
			back: async (opts) => {
				await this.run("device.back", opts, (s) => hardware(s, { button: "back" }));
			},
			button: async (button, opts) => {
				if (button === "home" || button === "back") {
					await this.run(`device.${button}`, opts, (s) => hardware(s, { button }));
					return;
				}
				await this.direct("device.button", opts, (d) => d.pressButton(button));
			},
			alert: async (params, opts) => {
				if (params === undefined) {
					const info = await this.direct("device.alert", opts, (d) => d.alert());
					return info ?? undefined;
				}
				const action = params.action;
				if (action === "accept" || action === "dismiss") {
					await this.run("device.alert", opts, (s) => alert(s, { action }));
					return undefined;
				}
				await this.direct("device.alert", opts, async (d) => {
					const info = await d.alert();
					if (!info.success) return info;
					const button = info.data?.buttons.find((b) => (b.label ?? b.text) === action.button);
					const point =
						button?.tapPoint ??
						(button
							? { x: button.frame.x + button.frame.width / 2, y: button.frame.y + button.frame.height / 2 }
							: undefined);
					if (!point) {
						return driverErr("E_NO_ELEMENT", `no alert button "${action.button}"`);
					}
					return d.tap(point);
				});
				return undefined;
			},
			orientation: async (params, opts) => {
				const done = await this.run("device.orientation", opts, (s) =>
					screenRotate(s, params?.set !== undefined ? { orientation: kebab(params.set) } : {})
				);
				return camel(kebab(done.result.orientation));
			},
			appearance: async (params, opts) => {
				const done = await this.run("device.appearance", opts, (s) =>
					screenAppearance(s, params?.set !== undefined ? { mode: params.set } : {})
				);
				return done.result.appearance;
			},
			clipboard: async (params, opts) => {
				if ("set" in params) {
					const text = params.set;
					await this.direct("device.clipboard", opts, (d) => d.clipboard(text));
					return undefined;
				}
				return this.direct("device.clipboard", opts, (d) => d.clipboard());
			},
			openUrl: async (params, opts) => {
				await this.run("device.openUrl", opts, (s) => openOp(s, { target: params.url }));
			},
		};
	}

	private buildRecord(): SessionRecordNamespace {
		return {
			start: async (params, opts) => {
				const { recordStart } = await import("./ops/authoring/start");
				return (await this.run("record.start", opts, (s) => recordStart(s, params))).result;
			},
			note: async (text, opts) => {
				const { recordNote } = await import("./ops/authoring/journal-ops");
				return (await this.run("record.note", opts, (s) => recordNote(s, { text }))).result;
			},
			undo: async (params, opts) => {
				const { recordUndo } = await import("./ops/authoring/journal-ops");
				return (await this.run("record.undo", opts, (s) => recordUndo(s, params ?? {}))).result;
			},
			use: async (params, opts) => {
				const { recordUse } = await import("./ops/authoring/use");
				return (await this.run("record.use", opts, (s) => recordUse(s, params))).result;
			},
			status: async (opts) => {
				const { recordStatus } = await import("./ops/authoring/journal-ops");
				return (await this.run("record.status", opts, (s) => recordStatus(s))).result;
			},
			cancel: async (opts) => {
				const { recordCancel } = await import("./ops/authoring/journal-ops");
				return (await this.run("record.cancel", opts, (s) => recordCancel(s))).result;
			},
			stop: async (params, opts) => {
				const { recordStop } = await import("./ops/authoring/stop");
				const { result } = await this.run("record.stop", opts, (s) => recordStop(s, params ?? {}));
				return { ...result, verified: result.outcome === "verified", configSnippet: result.config?.snippet ?? null };
			},
		};
	}

	private buildDevtools(): SessionDevtoolsNamespace {
		return {
			eval: async (params: EvalParams, opts) => {
				const done = await this.run("devtools.eval", opts, (s) =>
					evaluate(s, { expression: params.expression, await: true })
				);
				return done.result.value;
			},
			console: async (params: ConsoleParams | undefined, opts): Promise<ConsoleEntry[]> => {
				if (!this.state.read().collector) {
					await this.run("devtools.console", opts, (s) => logs(s, { action: "start" }));
				}
				const done = await this.run("devtools.console", opts, (s) =>
					logs(s, { action: "tail", count: params?.limit ?? 200 })
				);
				const result = done.result;
				if (!("lines" in result)) return [];
				return result.lines
					.filter((l) => l.kind !== "note")
					.filter((l) => params?.since === undefined || l.ts >= params.since)
					.filter((l) => params?.level === undefined || l.level === params.level)
					.map((l) => ({ level: l.level, text: l.text, ts: l.ts }));
			},
			network: async (params: NetworkParams | undefined, opts): Promise<NetworkEntry[]> => {
				const done = await this.run("devtools.network", opts, (s) =>
					network(s, params?.limit !== undefined ? { count: params.limit } : {})
				);
				const result = done.result;
				if (!("entries" in result)) return [];
				return result.entries
					.filter((e) => params?.since === undefined || e.ts >= params.since)
					.filter((e) => params?.urlContains === undefined || e.url.includes(params.urlContains))
					.map((e) => ({
						id: String(e.id),
						method: e.method,
						url: e.url,
						...(e.status !== 0 ? { status: e.status } : {}),
						ms: e.durationMs,
						ts: e.ts,
						...(e.error !== undefined || e.status === 0 ? { failed: true } : {}),
					}));
			},
			tree: async (params, opts) => {
				const done = await this.run("devtools.tree", opts, (s) =>
					tree(s, params?.maxDepth !== undefined ? { max: params.maxDepth } : {})
				);
				return treeOf(done.result.components);
			},
			reload: async (opts) => {
				await this.run("devtools.reload", opts, (s) => reload(s));
			},
			route: async (opts) => (await this.run("devtools.route", opts, (s) => routeOp(s))).result.route,
			nativeLogs: nativeLogsMethod({
				read: async (params, opts) =>
					(await this.run("devtools.nativeLogs", opts, (s) => nativeLogsOp(s, params ?? {}))).result.lines,
				follow: (params, opts) => this.followNativeLogs(params, opts),
			}),
		};
	}

	/** `devtools.nativeLogs({ follow: true })`: batches of the op's poll loop, flattened; abort ends the stream. */
	private async *followNativeLogs(
		params: NativeLogsParams,
		opts: CallOptions | undefined
	): AsyncGenerator<NativeLogEntry, void, void> {
		if (this.closed) throw usage("session is closed");
		const signal = this.core.signalFor(opts);
		for await (const batch of followNativeLogsOp(this.opSession(signal), params, signal)) {
			if (!batch.success) throw toWardenError(batch.error);
			yield* batch.data;
		}
	}
}

/** Where a path the SDK wrote is (file size check used by tests and callers). */
export function fileBytes(path: string): number {
	return statSync(path).size;
}

/** The session for `params`: lease check, then driver. */
export async function openSession(core: Core, params: SessionOpenParams, opts?: CallOptions): Promise<WardenSession> {
	const signal = core.signalFor(opts);
	return guarded(signal, async () => {
		if (core.closed) throw usage("client is closed");
		const device = deviceOf(core, params);
		const { lease } = requireLease(core, device);
		const name = lease.resource.kind === "device" ? lease.resource.name : device.name;
		const sessionId = `ses-${device.id.slice(0, 8)}-${core.host.now().toString(36)}-${core.sessions.size}`;
		const session = new WardenSession({
			core,
			device: { id: device.id, platform: device.platform, ...(name !== undefined ? { name } : {}) },
			lease,
			appId: params.app,
			sessionId,
		});
		await session.connect();
		core.sessions.set(sessionId, () => session.close());
		core.emit({ kind: "session:opened", sessionId, deviceId: device.id });
		return session;
	});
}

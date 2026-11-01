import type {
	AlertInfo,
	Element,
	HardwareButton,
	KeyName,
	Modifier,
	Orientation,
	Role,
	Snapshot,
} from "@delacour/warden-driver/driver.types";
import type { Lease, Platform } from "@delacour/warden-store/types";
import type { ExecResult, WardenHost } from "@delacour/warden-types/host";
import type {
	RecordCancelled,
	RecordIdle,
	RecordNoted,
	RecordStarted,
	RecordStatus,
	RecordStopped,
	RecordUndone,
	RecordUsed,
} from "./contracts/record.schema";
import type { RecordStartParams } from "./ops/authoring/start";
import type { RecordStopParams } from "./ops/authoring/stop";
import type { RecordUseParams } from "./ops/authoring/use";
import type { PerfNamespace, SessionPerfNamespace } from "./perf.types";
import type { ProviderPlugin } from "./plugins/define-provider";
import type { SpecsNamespace } from "./specs.types";

/**
 * Public contract of `@delacour/warden-sdk` (plan WSDK, `docs/plans/wsdk-sdk.md`). TYPES ONLY: the
 * implementation is `client.ts` / `session.ts`. Any change here changes `api/warden-sdk.api.d.ts` and must be reviewed.
 */

export type { Element, Lease, Platform, Role, Snapshot };

/** Per-call options: every SDK method accepts them as its last argument. */
export type CallOptions = {
	/** abort the call (claim waits, exec, polling); the call rejects with `interrupted` */
	signal?: AbortSignal;
};

/** What to do when a requested device is held by someone else: queue for it, or fail fast. */
export type LockPolicy = "wait" | "reject";

/** Every machine-readable failure code. Append-only within a major version. */
export type WardenErrorCode =
	| "usage"
	| "failed"
	| "wait_target_absent"
	| "wait_target_hidden"
	| "wait_target_present"
	| "wait_text_absent"
	| "wait_not_stable"
	| "target_not_found"
	| "no_alert"
	| "device_foreign"
	| "device_busy"
	| "device_unauthorized"
	| "device_offline"
	| "device_locked"
	| "device_not_leased"
	| "no_device_leased"
	| "ambiguous_device"
	| "lease_not_found"
	| "engine_unavailable"
	| "devtools_unavailable"
	| "stale_ref"
	| "no_recording"
	| "recording_active"
	| "target_exists"
	| "empty_recording"
	| "verify_failed"
	| "helper_missing"
	| "use_failed"
	| "verify_unavailable"
	| "device_unknown"
	| "session_active"
	| "session_not_found"
	| "app_not_found"
	| "unsupported"
	| "not_profileable"
	| "tool_missing"
	| "interrupted"
	| "lease_foreign"
	| "lease_busy"
	| "lease_missing"
	| "claim_aborted"
	| "probe_timeout"
	| "capacity_exhausted"
	| "not_found"
	| "build_failed"
	| "config_invalid"
	| "store_incompatible"
	| "duplicate_provider"
	| "timeout";

/**
 * Whether the failed operation may have reached the device: `no` = safe to retry, `yes` = it happened,
 * `unknown` = it may have (a timed-out tap). Carried over from agent-device's retry semantics.
 */
export type Dispatched = "no" | "unknown" | "yes";

/** The JSON shape of a thrown `WardenError`. */
export type WardenErrorShape = {
	/** machine-readable code */
	code: WardenErrorCode;
	/** human-readable one-liner */
	message: string;
	/** what to do next */
	hint?: string;
	/** structured context (device id, lease id, selector, ...) */
	details?: Record<string, unknown>;
	/** true when trying the same call again later can succeed */
	retryable?: boolean;
	/** whether the operation may have reached the device */
	dispatched: Dispatched;
};

/** Structured log event handed to `onEvent`; the CLI renders spinners from these. */
export type WardenEvent =
	| { kind: "progress"; message: string }
	| { kind: "warn"; message: string }
	| { kind: "debug"; message: string }
	| { kind: "lease:claimed"; lease: Lease }
	| { kind: "lease:released"; leaseId: string }
	| { kind: "device:booted"; leaseId: string; deviceId: string; platform: Platform }
	| { kind: "session:opened"; sessionId: string; deviceId: string }
	| { kind: "session:closed"; sessionId: string }
	| { kind: "action"; sessionId: string; op: string; ok: boolean; ms: number };

/** The `kind` of every {@link WardenEvent}. */
export type WardenEventKind = WardenEvent["kind"];

/** The {@link WardenEvent} variant of one `kind`. */
export type WardenEventOf<K extends WardenEventKind> = Extract<WardenEvent, { kind: K }>;

/** Handler of `client.on(kind, handler)`. */
export type WardenEventHandler<K extends WardenEventKind> = (event: WardenEventOf<K>) => void;

/**
 * Host seams a test can inject; everything defaults to the real machine. The fields are the matching members of the
 * engine's `WardenHost`, so one fake serves both.
 */
export type WardenHostOverrides = Partial<Pick<WardenHost, "env" | "cwd" | "now" | "exec" | "sleep" | "pidAlive">>;

/** Result of an injected `exec` (the engine's `ExecResult`). */
export type ExecOutput = ExecResult;

/** Options of `createWardenClient`. */
export type WardenClientOptions = {
	/** shown next to leases this client takes (`warden ls`) */
	label?: string;
	/** override the detected lease owner */
	owner?: LeaseOwnerInput;
	/** queue (`wait`, default) or fail fast (`reject`) when a device is taken */
	lockPolicy?: LockPolicy;
	/** claim queue priority; higher goes first */
	priority?: number;
	/** `WARDEN_HOME` for this client */
	home?: string;
	/** injected host seams (tests) */
	host?: WardenHostOverrides;
	/** cancels every in-flight call of this client */
	signal?: AbortSignal;
	/** receives progress and lifecycle events */
	onEvent?: (event: WardenEvent) => void;
	/** device-provider plugins (experimental, see `@delacour/warden-sdk/plugins`); claim one with `ClaimParams.provider` */
	providers?: readonly ProviderPlugin[];
	/** argv prefix that runs the `warden` CLI for `specs.run` (default: `warden` on PATH, else this checkout's source) */
	cliCommand?: readonly string[];
};

/** Owner identity an embedder may supply instead of the detected one. */
export type LeaseOwnerInput =
	| { kind: "agent"; sessionId: string; cwd?: string }
	| { kind: "user"; pid?: number; cwd?: string }
	| { kind: "ci"; runId: string };

/** A target for an interaction or query: a snapshot ref, a selector expression, or a screen point. */
export type Target = { ref: `@e${number}` } | { selector: string } | { point: { x: number; y: number } };

/** A target that must resolve to an element (no raw point). */
export type ElementTarget = { ref: `@e${number}` } | { selector: string };

/** Which device a session or app call acts on. */
export type DeviceRef = { lease: Lease } | { udid: string } | { serial: string };

// ─── devices ───────────────────────────────────────────────────────────

/** One device as warden sees it. */
export type DeviceInfo = {
	platform: Platform;
	id: string;
	name: string;
	state: "booted" | "shutdown" | "booting";
	/** warden created or launched it */
	wardenCreated: boolean;
	profile?: string;
	runtime?: string;
	/** a lease currently holds it */
	leased: boolean;
	quarantined?: boolean;
	/** the provider plugin serving it; absent = the bundled ios / android provider */
	provider?: string;
};

/** Host headroom for booting more devices. */
export type CapacityInfo = {
	platform: Platform;
	/** set on a provider plugin's row: its devices only, with no host cap */
	provider?: string;
	/** devices that can still be booted now */
	available: number;
	/** devices booted now */
	running: number;
	/** most devices the host can run */
	max: number;
	/** claims waiting for capacity */
	queued: number;
};

export type DevicesListParams = { platform?: Platform; booted?: boolean };
export type DevicesNamespace = {
	/** Devices on this machine (warden-created and foreign). */
	list(params?: DevicesListParams, opts?: CallOptions): Promise<DeviceInfo[]>;
	/** Devices plus their lease, if any. */
	inventory(params?: DevicesListParams, opts?: CallOptions): Promise<InventoryEntry[]>;
	/** Boot capacity of the host. */
	capacity(params?: { platform?: Platform }, opts?: CallOptions): Promise<CapacityInfo[]>;
	/** Which app shows simulator windows: Simulator.app, Xcode 27's Device Hub, or neither (always `"none"` off macOS). */
	viewer(opts?: CallOptions): Promise<SimViewerKind>;
	/** Tile the open windows of warden simulators (what `warden arrange` does); `open` first asks Device Hub for those sims' windows. */
	arrange(params?: ArrangeParams, opts?: CallOptions): Promise<ArrangeResult>;
};

export type SimViewerKind = "simulator" | "device-hub" | "none";
export type ArrangeParams = {
	/** simulator udids whose Device Hub windows to open before tiling (Xcode 27, only while Device Hub runs) */
	open?: string[];
};
export type ArrangeResult = {
	/** names of the sims whose windows were tiled, in order */
	arranged: string[];
	/** names of the sims whose windows were asked for (`open`) */
	opened: string[];
	viewer: SimViewerKind;
};

/** A device with the lease that holds it. */
export type InventoryEntry = { device: DeviceInfo; lease?: Lease };

// ─── leases ────────────────────────────────────────────────────────────

/** Ask for devices. */
export type ClaimParams = {
	platform: Platform;
	/** warden profile slug, e.g. `iphone-17-pro` */
	profile?: string;
	/** runtime identifier, e.g. `iOS-26-5` */
	runtime?: string;
	/** how many devices (default 1) */
	count?: number;
	/** allow leasing foreign devices that match the profile */
	adopt?: boolean;
	/** lease ttl in ms */
	ttlMs?: number;
	/** overrides the client's `lockPolicy` for this claim */
	lockPolicy?: LockPolicy;
	/** claim through the registered provider plugin of this name instead of the bundled one (its `platform` must match) */
	provider?: string;
	/**
	 * Mark the leases shared (`Lease.shared`), as `warden dev` does: other processes of the same owner (`warden ui`,
	 * other SDK clients) attach to the device instead of failing with `device_busy`, and never release it.
	 */
	shared?: boolean;
};

export type ReleaseParams = {
	/** lease ids to release; the client's own leases when omitted */
	leaseIds?: string[];
	/** also shut down devices this client booted */
	shutdown?: boolean;
};

export type ReleaseResult = { released: string[]; shutdown: string[] };

/** Outcome of `leases.check`. */
export type LeaseCheck =
	| { state: "held"; lease: Lease; expiresInMs: number }
	| { state: "stale"; lease: Lease }
	| { state: "missing" };

export type LeasesNamespace = {
	/** Claim devices. The client releases them on dispose. */
	claim(params: ClaimParams, opts?: CallOptions): Promise<Lease[]>;
	/** Active leases on this machine. */
	list(params?: { mine?: boolean }, opts?: CallOptions): Promise<Lease[]>;
	/** Extend a lease. */
	heartbeat(lease: Lease | string, opts?: CallOptions): Promise<Lease>;
	/** Release leases. */
	release(params?: ReleaseParams, opts?: CallOptions): Promise<ReleaseResult>;
	/** Is this lease still ours and alive. */
	check(lease: Lease | string, opts?: CallOptions): Promise<LeaseCheck>;
};

// ─── ports ─────────────────────────────────────────────────────────────

export type PortClaimParams = {
	/** a port, a range `8081-8090`, or a list; first free wins */
	spec?: string;
	ttlMs?: number;
};
export type PortsNamespace = {
	/** Lease a TCP port. */
	claim(params?: PortClaimParams, opts?: CallOptions): Promise<Lease>;
	/** Release a port lease. */
	release(lease: Lease | string, opts?: CallOptions): Promise<void>;
};

// ─── apps ──────────────────────────────────────────────────────────────

export type EnsureAppParams = DeviceRef & {
	/** project directory (default `.`) */
	project?: string;
	/** app profile name from `warden.config.ts` */
	profile?: string;
	/** rebuild even when the fingerprint cache hits */
	force?: boolean;
};

/** A prepared and installed app. */
export type EnsuredApp = {
	bundleId: string;
	/** fingerprint cache key */
	buildKey: string;
	/** true when the cached build was reused */
	cached: boolean;
	installed: boolean;
};

export type InstallAppParams = DeviceRef & {
	/** path to an `.app` / `.apk` */
	path: string;
};

export type BuildInfo = { key: string; platform: Platform; path: string; sizeBytes: number; createdAt: number };

export type BuildsNamespace = {
	/** Cached builds. */
	list(params?: { platform?: Platform }, opts?: CallOptions): Promise<BuildInfo[]>;
	/** Drop cached builds; returns the keys removed. */
	prune(params?: { olderThanMs?: number; keep?: number }, opts?: CallOptions): Promise<string[]>;
};

export type AppsNamespace = {
	/** Build (or reuse the cached build of) the project and install it on the device. */
	ensure(params: EnsureAppParams, opts?: CallOptions): Promise<EnsuredApp>;
	/** Install a prebuilt app. */
	install(params: InstallAppParams, opts?: CallOptions): Promise<void>;
	/** The build cache. */
	builds: BuildsNamespace;
};

// ─── metro ─────────────────────────────────────────────────────────────

export type MetroStartParams = {
	/** project directory (default `.`) */
	project?: string;
	/** port; a free one is leased when omitted */
	port?: number;
};
export type MetroStatus =
	| { running: false }
	| { running: true; port: number; url: string; pid: number; project: string };
export type MetroNamespace = {
	/** Start (or reuse) a dev server for the project. */
	start(params?: MetroStartParams, opts?: CallOptions): Promise<Extract<MetroStatus, { running: true }>>;
	/** Stop the dev server this client started. */
	stop(params?: { project?: string }, opts?: CallOptions): Promise<void>;
	/** Is a dev server running for the project. */
	status(params?: { project?: string }, opts?: CallOptions): Promise<MetroStatus>;
};

// ─── sessions ──────────────────────────────────────────────────────────

export type SessionOpenParams = DeviceRef & {
	/** bundle id / package of the app under test */
	app?: string;
};

export type SessionsNamespace = {
	/** Open a driver on a device the caller leases (never on a foreign one). */
	open(params: SessionOpenParams, opts?: CallOptions): Promise<Session>;
	/** Close a session by id. */
	end(sessionId: string, opts?: CallOptions): Promise<void>;
};

/** Entry point of the SDK. Dispose releases everything the client claimed. */
export interface WardenClient extends AsyncDisposable {
	/** Devices on the machine. */
	readonly devices: DevicesNamespace;
	/** Device leases. */
	readonly leases: LeasesNamespace;
	/** Port leases. */
	readonly ports: PortsNamespace;
	/** App build, cache and install. */
	readonly apps: AppsNamespace;
	/** Dev server. */
	readonly metro: MetroNamespace;
	/** Driver sessions. */
	readonly sessions: SessionsNamespace;
	/** e2e specs: list, affected, run. */
	readonly specs: SpecsNamespace;
	/** recorded perf sessions: list, report. */
	readonly perf: PerfNamespace;
	/** Subscribe to one event kind; returns the unsubscribe function. A throwing handler never fails the call. */
	on<K extends WardenEventKind>(kind: K, handler: WardenEventHandler<K>): () => void;
	/** Remove a handler added with `on`. */
	off<K extends WardenEventKind>(kind: K, handler: WardenEventHandler<K>): void;
	/** Release claimed leases and close sessions. Same as `Symbol.asyncDispose`. */
	close(opts?: CallOptions): Promise<void>;
}

/** `createWardenClient` (see `client.ts`). */
export type CreateWardenClient = (options?: WardenClientOptions) => WardenClient;

// ─── session: apps ─────────────────────────────────────────────────────

export type AppOpenParams = {
	/** default: the session's app */
	app?: string;
	args?: readonly string[];
	env?: Record<string, string>;
	/** restart when already running (default true) */
	relaunch?: boolean;
	/** deep link to open instead of the launcher */
	url?: string;
};
export type AppRefParams = { app?: string };
export type ClearDataParams = AppRefParams & { keychain?: boolean };

export type SessionAppsNamespace = {
	/** Launch the app. */
	open(params?: AppOpenParams, opts?: CallOptions): Promise<void>;
	/** Terminate the app. */
	close(params?: AppRefParams, opts?: CallOptions): Promise<void>;
	/** Terminate then launch. */
	restart(params?: AppOpenParams, opts?: CallOptions): Promise<void>;
	/** Uninstall then install the cached build. */
	reinstall(params?: AppRefParams, opts?: CallOptions): Promise<void>;
	/** Wipe app data, keep the build. */
	clearData(params?: ClearDataParams, opts?: CallOptions): Promise<void>;
};

// ─── session: capture ──────────────────────────────────────────────────

export type SnapshotParams = {
	/** only elements a user can act on */
	interactiveOnly?: boolean;
	/** include elements outside the viewport */
	offscreen?: boolean;
};

/** One element of a snapshot with its stable ref. */
export type SnapshotElement = {
	/** `@e1`, `@e2`, ... valid until the next snapshot generation */
	ref: `@e${number}`;
	role: Role;
	label?: string;
	identifier?: string;
	value?: string;
	/** `[x, y, width, height]` in screen points */
	frame: [number, number, number, number];
	enabled: boolean;
	focused?: boolean;
	selected?: boolean;
	checked?: boolean;
};

export type SnapshotResult = {
	platform: Platform;
	/** epoch ms the tree was read */
	takenAt: number;
	/** ref generation; refs from an older generation are `stale_ref` */
	generation: number;
	screen: { width: number; height: number; scale: number };
	elements: SnapshotElement[];
	/** compact text rendering for models */
	text: string;
	truncated: boolean;
};

export type ScreenshotParams = {
	/** write here; the bytes are returned either way */
	path?: string;
	/** 0-1 downscale */
	scale?: number;
	format?: "png" | "jpeg";
};
export type ScreenshotResult = { path?: string; width: number; height: number; bytes: Uint8Array };

export type VideoStartParams = { path: string };
export type VideoResult = { path: string; durationMs: number };

export type SessionCaptureNamespace = {
	/** Read the accessibility tree and assign refs. */
	snapshot(params?: SnapshotParams, opts?: CallOptions): Promise<SnapshotResult>;
	/** Capture the screen. */
	screenshot(params?: ScreenshotParams, opts?: CallOptions): Promise<ScreenshotResult>;
	/** Screen recording. */
	video: {
		/** Start recording. */
		start(params: VideoStartParams, opts?: CallOptions): Promise<void>;
		/** Stop recording and finalise the file. */
		stop(opts?: CallOptions): Promise<VideoResult>;
	};
};

// ─── session: interactions ─────────────────────────────────────────────

export type Direction = "up" | "down" | "left" | "right";

export type PressParams = Target & { count?: number };
export type LongPressParams = Target & { durationMs?: number };
export type FillParams = ElementTarget & { text: string; clear?: boolean };
export type TypeParams = { text: string; delayMs?: number };
export type KeyParams = { key: KeyName | string; modifiers?: Modifier[]; times?: number };
export type SwipeParams = { from: { x: number; y: number }; to: { x: number; y: number }; durationMs?: number };
export type ScrollParams = { direction: Direction; target?: ElementTarget; amount?: number; until?: ElementTarget };
export type PinchParams = Target & { scale: number; durationMs?: number };
export type RotateParams = Target & { degrees: number; durationMs?: number };
export type GesturePath = { points: { x: number; y: number }[]; durationMs?: number };
export type GestureParams = { paths: GesturePath[] };

export type SessionInteractionsNamespace = {
	/** Tap. */
	press(params: PressParams, opts?: CallOptions): Promise<void>;
	/** Press and hold. */
	longPress(params: LongPressParams, opts?: CallOptions): Promise<void>;
	/** Focus a field, clear it, type, confirm the value. */
	fill(params: FillParams, opts?: CallOptions): Promise<void>;
	/** Type into the focused field. */
	type(params: TypeParams, opts?: CallOptions): Promise<void>;
	/** Press a key. */
	key(params: KeyParams, opts?: CallOptions): Promise<void>;
	/** One-finger swipe between two points. */
	swipe(params: SwipeParams, opts?: CallOptions): Promise<void>;
	/** Scroll a container or the screen. */
	scroll(params: ScrollParams, opts?: CallOptions): Promise<void>;
	/** Two-finger pinch. */
	pinch(params: PinchParams, opts?: CallOptions): Promise<void>;
	/** Two-finger rotate. */
	rotate(params: RotateParams, opts?: CallOptions): Promise<void>;
	/** Free-form 1-2 finger gesture. */
	gesture(params: GestureParams, opts?: CallOptions): Promise<void>;
};

// ─── session: query ────────────────────────────────────────────────────

export type FindParams = { selector: string; all?: boolean };
export type WaitCondition =
	| { for: "visible" }
	| { for: "hidden" }
	| { for: "present" }
	| { for: "absent" }
	| { for: "text"; text: string }
	| { for: "stable" };
export type WaitParams = ElementTarget & WaitCondition & { timeoutMs?: number };
export type IsState = "visible" | "enabled" | "focused" | "selected" | "checked" | "hittable";
export type IsParams = ElementTarget & { state: IsState };
export type GetProperty = "text" | "label" | "value" | "identifier" | "frame" | "role";
export type GetParams = ElementTarget & { property: GetProperty };
/** Value of `query.get`, discriminated by the property asked for. */
export type GetResult =
	| { property: "frame"; value: [number, number, number, number] }
	| { property: "role"; value: Role }
	| { property: "text" | "label" | "value" | "identifier"; value: string | undefined };

export type SessionQueryNamespace = {
	/** Elements matching a selector in a fresh snapshot. */
	find(params: FindParams, opts?: CallOptions): Promise<SnapshotElement[]>;
	/** Wait for a condition; throws `wait_*` on timeout. */
	wait(params: WaitParams, opts?: CallOptions): Promise<SnapshotElement | undefined>;
	/** Test a state of one element. */
	is(params: IsParams, opts?: CallOptions): Promise<boolean>;
	/** Read one property of one element. */
	get(params: GetParams, opts?: CallOptions): Promise<GetResult>;
};

// ─── session: device ───────────────────────────────────────────────────

export type AlertAction = "accept" | "dismiss" | { button: string };
export type Appearance = "light" | "dark";
export type ClipboardParams = { set: string } | { get: true };

export type SessionDeviceNamespace = {
	/** Home button / gesture. */
	home(opts?: CallOptions): Promise<void>;
	/** Back (Android key, iOS nav back). */
	back(opts?: CallOptions): Promise<void>;
	/** Hardware button. */
	button(button: HardwareButton, opts?: CallOptions): Promise<void>;
	/** Read the system alert, or answer it. */
	alert(params?: { action: AlertAction }, opts?: CallOptions): Promise<AlertInfo | undefined>;
	/** Read or set orientation. */
	orientation(params?: { set: Orientation }, opts?: CallOptions): Promise<Orientation>;
	/** Read or set light/dark appearance. */
	appearance(params?: { set: Appearance }, opts?: CallOptions): Promise<Appearance>;
	/** Set or read the clipboard. */
	clipboard(params: ClipboardParams, opts?: CallOptions): Promise<string | undefined>;
	/** Open a URL (deep link). */
	openUrl(params: { url: string }, opts?: CallOptions): Promise<void>;
};

// ─── session: devtools ─────────────────────────────────────────────────

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";
export type ConsoleEntry = { level: ConsoleLevel; text: string; ts: number };
export type ConsoleParams = { since?: number; level?: ConsoleLevel; limit?: number };
export type NetworkEntry = {
	id: string;
	method: string;
	url: string;
	status?: number;
	ms?: number;
	ts: number;
	failed?: boolean;
};
export type NetworkParams = { since?: number; urlContains?: string; limit?: number };
/** A node of the React component tree. */
export type TreeNode = { name: string; props?: Record<string, unknown>; children: TreeNode[] };
export type EvalParams = { expression: string };

/** Severity of a native log line; `level` filters to this one and above. */
export type NativeLogLevel = "debug" | "info" | "warn" | "error";
/** One line of the app's native log (os_log on iOS, logcat on Android). */
export type NativeLogEntry = { ts: number; level: NativeLogLevel; text: string };
export type NativeLogsParams = {
	/** ms since epoch; default one minute ago */
	since?: number;
	/** this severity and above */
	level?: NativeLogLevel;
	/** the newest N lines of the window (the first batch when following) */
	limit?: number;
};

export type SessionDevtoolsNamespace = {
	/** Evaluate JS in the app's Hermes runtime. */
	eval(params: EvalParams, opts?: CallOptions): Promise<unknown>;
	/** Console messages. */
	console(params?: ConsoleParams, opts?: CallOptions): Promise<ConsoleEntry[]>;
	/** Network requests. */
	network(params?: NetworkParams, opts?: CallOptions): Promise<NetworkEntry[]>;
	/** React component tree. */
	tree(params?: { maxDepth?: number }, opts?: CallOptions): Promise<TreeNode[]>;
	/** Reload the JS bundle. */
	reload(opts?: CallOptions): Promise<void>;
	/**
	 * The Expo Router key of the focused screen (`(tabs)/todos`), or `undefined` when no screen is focused yet.
	 * Throws `devtools_unavailable` for a release build.
	 */
	route(opts?: CallOptions): Promise<string | undefined>;
	/**
	 * The app's native log (iOS os_log, Android logcat), oldest first. With `follow: true` an async iterable of new
	 * lines, polled until the `signal` aborts (then it ends without throwing). Needs an app opened in the session.
	 */
	nativeLogs(params: NativeLogsParams & { follow: true }, opts?: CallOptions): AsyncIterable<NativeLogEntry>;
	nativeLogs(params?: NativeLogsParams & { follow?: false }, opts?: CallOptions): Promise<NativeLogEntry[]>;
};

// ─── session: record (spec authoring) ──────────────────────────────────

export type {
	RecordCancelled,
	RecordIdle,
	RecordNoted,
	RecordStarted,
	RecordStartParams,
	RecordStatus,
	RecordStopParams,
	RecordStopped,
	RecordUndone,
	RecordUsed,
	RecordUseParams,
};

/** What `record.stop` returns: the written file's report plus the two fields most callers want. */
export type RecordStopResult = RecordStopped & {
	/** the spec ran on the device and passed */
	verified: boolean;
	/** the `specs.<id>` block to paste into `warden.config.ts` (null for a helper) */
	configSnippet: string | null;
};

/**
 * Turn a session into an e2e spec. While a recording is active, the session's `interactions.*` (and `device.openUrl`,
 * `query.wait|is|get`) calls are journalled as steps; `stop` writes `<suite specsDir>/<name>.e2e.ts` (or a helper).
 * The journal lives under `$WARDEN_HOME/ui/<udid>/` and survives a failed verify.
 */
export type SessionRecordNamespace = {
	/** Start recording this device. */
	start(params: RecordStartParams, opts?: CallOptions): Promise<RecordStarted>;
	/** Mark a user-visible step boundary (a comment above the next step). */
	note(text: string, opts?: CallOptions): Promise<RecordNoted>;
	/** Drop the last `count` steps (default 1; notes count). */
	undo(params?: { count?: number }, opts?: CallOptions): Promise<RecordUndone>;
	/** Run an exported helper on the device and, when it passes, record a call to it. */
	use(params: RecordUseParams, opts?: CallOptions): Promise<RecordUsed>;
	/** The target, step count, last steps and lints so far (`outcome: "idle"` when not recording). */
	status(opts?: CallOptions): Promise<RecordStatus | RecordIdle>;
	/** Throw the recording away (a spec already written is left). */
	cancel(opts?: CallOptions): Promise<RecordCancelled>;
	/** Write the spec (or helper) and, by default, run it once on the device. */
	stop(params?: RecordStopParams, opts?: CallOptions): Promise<RecordStopResult>;
};

// ─── session: locator ──────────────────────────────────────────────────

/** Escape hatch to the full e2e `Locator` API for a selector. */
export type SessionLocator = {
	/** the selector this locator was made from */
	readonly selector: string;
	/** Tap the matched element. */
	press(opts?: CallOptions): Promise<void>;
	/** Fill the matched field. */
	fill(text: string, opts?: CallOptions): Promise<void>;
	/** Wait until the element is visible. */
	waitForVisible(params?: { timeoutMs?: number }, opts?: CallOptions): Promise<SnapshotElement>;
	/** Number of matches in a fresh snapshot. */
	count(opts?: CallOptions): Promise<number>;
};

/** An open driver on one device. Dispose closes it; the lease stays with the client. */
export interface Session extends AsyncDisposable {
	/** udid / serial */
	readonly deviceId: string;
	readonly platform: Platform;
	readonly sessionId: string;
	/** App lifecycle. */
	readonly apps: SessionAppsNamespace;
	/** Snapshot, screenshot, video. */
	readonly capture: SessionCaptureNamespace;
	/** Taps, text, gestures. */
	readonly interactions: SessionInteractionsNamespace;
	/** Find, wait, is, get. */
	readonly query: SessionQueryNamespace;
	/** Device-level controls. */
	readonly device: SessionDeviceNamespace;
	/** Console, network, React tree, eval. */
	readonly devtools: SessionDevtoolsNamespace;
	/** Spec authoring: record this session as an e2e spec. */
	readonly record: SessionRecordNamespace;
	/** performance profiling of this device: sessions, start-up, metrics, memory, logs, crashes. */
	readonly perf: SessionPerfNamespace;
	/** Locator escape hatch for a selector. */
	locator(selector: string): SessionLocator;
	/** Close the driver. */
	close(opts?: CallOptions): Promise<void>;
}

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { installer, nodeResetFs, type ResetFs } from "@delacour/warden-builds/install";
import type { LatLon, LocationCondition } from "@delacour/warden-config/conditions.types";
import { geoMath } from "@delacour/warden-driver/conditions/geo";
import { locationPlanner } from "@delacour/warden-driver/conditions/location-plan";
import { IOS_SCENARIO_NAMES } from "@delacour/warden-driver/conditions/location-scenarios.data";
import type {
	BiometricOp,
	BiometricState,
	DriverError,
	DriverResult,
	LaunchOptions,
} from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import { type Exec, type ExecResult, execErrors } from "@delacour/warden-runtime/exec";

/**
 * Everything the iOS driver does through `xcrun simctl` instead of the helper: app lifecycle,
 * clipboard, appearance, status bar, the screenshot fallback and the AX automation flag. Argv builders
 * are pure; `SimctlRunner` binds them to an injected `Exec`.
 */

const XCRUN = ["xcrun", "simctl"] as const;

const PLIST_READ_MS = 2_000;
const SHORT_MS = 15_000;
const LAUNCH_MS = 30_000;
const INSTALL_MS = 10 * 60_000;

export const SIMCTL_CHILD_PREFIX = "SIMCTL_CHILD_";

const ENROLLMENT_NOTIFICATION = "com.apple.BiometricKit.enrollmentChanged";

/** A route with more waypoints than this goes through stdin (`-`) instead of the argument list. */
export const LOCATION_ARGV_MAX_POINTS = 100;

export type StatusBarOverrides = {
	time?: string;
	batteryLevel?: number;
	batteryState?: "charged" | "charging" | "discharging";
	wifiBars?: number;
	cellularBars?: number;
};

export type LocationStartOptions = { speedMps?: number; intervalS?: number };

/** The `xcrun simctl …` argv builders. Use the shared {@link simctlArgv} singleton. */
export class SimctlArgv {
	/** `xcrun simctl launch [--terminate-running-process] <udid> <bundle> <args…>` (env goes through `SIMCTL_CHILD_*`, see {@link SimctlArgv.launchEnv}). */
	launch(udid: string, bundleId: string, opts: LaunchOptions = {}): string[] {
		return [
			...XCRUN,
			"launch",
			...(opts.relaunch === false ? [] : ["--terminate-running-process"]),
			udid,
			bundleId,
			...(opts.args ?? []),
		];
	}

	/** simctl forwards `SIMCTL_CHILD_<NAME>` from its own environment to the launched app as `<NAME>`. */
	launchEnv(env: Record<string, string> | undefined): Record<string, string> {
		return Object.fromEntries(Object.entries(env ?? {}).map(([key, value]) => [`${SIMCTL_CHILD_PREFIX}${key}`, value]));
	}

	terminate(udid: string, bundleId: string): string[] {
		return [...XCRUN, "terminate", udid, bundleId];
	}

	openUrl(udid: string, url: string): string[] {
		return [...XCRUN, "openurl", udid, url];
	}

	install(udid: string, appPath: string): string[] {
		return [...XCRUN, "install", udid, appPath];
	}

	uninstall(udid: string, bundleId: string): string[] {
		return [...XCRUN, "uninstall", udid, bundleId];
	}

	/** Exit 0 and a path on stdout when installed; non-zero when not. */
	appContainer(udid: string, bundleId: string): string[] {
		return [...XCRUN, "get_app_container", udid, bundleId];
	}

	/** Lists launchd jobs inside the simulator; a running app shows up as `UIKitApplication:<bundle>[…]` with a PID. */
	launchctlList(udid: string): string[] {
		return [...XCRUN, "spawn", udid, "launchctl", "list"];
	}

	pbpaste(udid: string): string[] {
		return [...XCRUN, "pbpaste", udid];
	}

	appearance(udid: string, set?: "light" | "dark"): string[] {
		return [...XCRUN, "ui", udid, "appearance", ...(set ? [set] : [])];
	}

	/** Sets the enrollment state, then posts the change (`notifyutil -s <name> <state>` before `-p <name>`). */
	biometricEnroll(udid: string, enrolled: boolean): string[][] {
		return [
			this.notifyutil(udid, ["-s", ENROLLMENT_NOTIFICATION, enrolled ? "1" : "0"]),
			this.notifyutil(udid, ["-p", ENROLLMENT_NOTIFICATION]),
		];
	}

	/** Prints `com.apple.BiometricKit.enrollmentChanged <0|1>`. */
	biometricState(udid: string): string[] {
		return this.notifyutil(udid, ["-g", ENROLLMENT_NOTIFICATION]);
	}

	/** The Face ID (`pearl`) or Touch ID (`fingerTouch`) match / nomatch notification the simulator's BiometricKit listens for. */
	biometricEvent(udid: string, modality: BiometricState["modality"], event: "match" | "nomatch"): string[] {
		return this.notifyutil(udid, [
			"-p",
			`com.apple.BiometricKit_Sim.${modality === "face" ? "pearl" : "fingerTouch"}.${event}`,
		]);
	}

	/** The notifications one op posts, in order; `status` posts nothing. */
	biometrics(udid: string, modality: BiometricState["modality"], op: BiometricOp): string[][] {
		if (op === "enroll" || op === "unenroll") return this.biometricEnroll(udid, op === "enroll");
		if (op === "match" || op === "fail")
			return [this.biometricEvent(udid, modality, op === "match" ? "match" : "nomatch")];
		return [];
	}

	/** Model identifier (`iPhone14,7`) of a booted sim. */
	modelIdentifier(udid: string): string[] {
		return [...XCRUN, "getenv", udid, "SIMULATOR_MODEL_IDENTIFIER"];
	}

	screenshot(udid: string, path: string): string[] {
		return [...XCRUN, "io", udid, "screenshot", "--type=png", path];
	}

	/** `AutomationEnabled` lets the AX bridge attach without the runner app; written once per open. */
	automation(udid: string): string[] {
		return [
			...XCRUN,
			"spawn",
			udid,
			"defaults",
			"write",
			"com.apple.Accessibility",
			"AutomationEnabled",
			"-bool",
			"true",
		];
	}

	/** Where CoreSimulator keeps every simulator's data directory on the host. */
	defaultDevicesRoot(): string {
		return join(homedir(), "Library", "Developer", "CoreSimulator", "Devices");
	}

	/**
	 * The simulator's Accessibility preferences, readable from the host without booting anything through `xcrun`
	 * (`simctl spawn` costs 300-500 ms, a `plutil` read about 10 ms).
	 */
	automationPlistPath(devicesRoot: string, udid: string): string {
		return join(devicesRoot, udid, "data", "Library", "Preferences", "com.apple.Accessibility.plist");
	}

	/** `plutil -extract AutomationEnabled raw -o - <plist>` prints `true` once the default is written. */
	automationRead(plist: string): string[] {
		return ["plutil", "-extract", "AutomationEnabled", "raw", "-o", "-", plist];
	}

	/** Clean 9:41 status bar by default (stable screenshots); pass `undefined` fields to drop them. */
	statusBarOverride(udid: string, o: StatusBarOverrides = {}): string[] {
		const time = o.time ?? "9:41";
		const flags: Array<[string, string]> = [
			["--time", time],
			["--batteryState", o.batteryState ?? "charged"],
			["--batteryLevel", String(o.batteryLevel ?? 100)],
			["--wifiBars", String(o.wifiBars ?? 3)],
			["--cellularBars", String(o.cellularBars ?? 4)],
		];
		return [...XCRUN, "status_bar", udid, "override", ...flags.flat()];
	}

	statusBarClear(udid: string): string[] {
		return [...XCRUN, "status_bar", udid, "clear"];
	}

	locationSet(udid: string, point: LatLon): string[] {
		return [...XCRUN, "location", udid, "set", this.latLon(point)];
	}

	locationClear(udid: string): string[] {
		return [...XCRUN, "location", udid, "clear"];
	}

	/** `name` is Apple's scenario name (`City Run`), see {@link IOS_SCENARIO_NAMES}. */
	locationRun(udid: string, name: string): string[] {
		return [...XCRUN, "location", udid, "run", name];
	}

	/**
	 * `simctl location <udid> start [--speed=] [--interval=] <lat,lon>…`. The sim plays the path itself
	 * after the command returns. Past {@link LOCATION_ARGV_MAX_POINTS} the waypoints ride stdin of a tiny
	 * `sh -c` (one `lat,lon` per line, never interpolated into the script) with the `-` operand.
	 */
	locationStart(udid: string, points: readonly LatLon[], o: LocationStartOptions = {}): string[] {
		const flags = [
			...(o.speedMps !== undefined ? [`--speed=${geoMath.formatCoord(o.speedMps)}`] : []),
			...(o.intervalS !== undefined ? [`--interval=${geoMath.formatCoord(o.intervalS)}`] : []),
		];
		if (points.length <= LOCATION_ARGV_MAX_POINTS)
			return [...XCRUN, "location", udid, "start", ...flags, ...points.map((p) => this.latLon(p))];
		return [
			"sh",
			"-c",
			'printf %s "$1" | xcrun simctl location "$2" start $3 -',
			"sh",
			points.map((p) => this.latLon(p)).join("\n"),
			udid,
			flags.join(" "),
		];
	}

	/**
	 * `simctl pbcopy` reads stdin and `Exec` has none, so the text rides as `$1` of a tiny `sh -c`
	 * (never interpolated into the script): `printf %s "$1" | xcrun simctl pbcopy "$2"`.
	 */
	pbcopy(udid: string, text: string): string[] {
		return ["sh", "-c", 'printf %s "$1" | xcrun simctl pbcopy "$2"', "sh", text, udid];
	}

	/**
	 * The same text through `devicectl device pasteboard copy`, the CoreDevice side of the simulator pasteboard.
	 * On Xcode 27.1 (iOS 26.5 runtime) `simctl pbcopy` exits 0 without changing the pasteboard, which then still
	 * holds whatever CoreDevice's `dtpasteboardd` last mirrored from the Mac; `devicectl` writes it in ~350 ms.
	 */
	devicectlPbcopy(udid: string, text: string): string[] {
		return [
			"sh",
			"-c",
			'printf %s "$1" | xcrun devicectl device pasteboard copy --quiet --device "$2"',
			"sh",
			text,
			udid,
		];
	}

	private notifyutil(udid: string, args: readonly string[]): string[] {
		return [...XCRUN, "spawn", udid, "notifyutil", ...args];
	}

	private latLon(p: LatLon): string {
		return `${geoMath.formatCoord(p.lat)},${geoMath.formatCoord(p.lon)}`;
	}
}

export const simctlArgv = new SimctlArgv();

/** The channels {@link SimctlRunner}'s `pbcopy` tries, in order; each write is confirmed with `simctl pbpaste`. */
export const PBCOPY_CHANNELS: readonly { name: string; argv: (udid: string, text: string) => string[] }[] = [
	{ name: "devicectl pasteboard copy", argv: (udid, text) => simctlArgv.devicectlPbcopy(udid, text) },
	{ name: "simctl pbcopy", argv: (udid, text) => simctlArgv.pbcopy(udid, text) },
];

/** Reads simctl's output. Use the shared {@link simctlParser} singleton. */
export class SimctlParser {
	/**
	 * Touch ID models by identifier: iPhone SE and everything up to the 8 (`iPhone10,1|2|4|5`; the X, `10,3|6`, has Face ID),
	 * and the iPads with a home or power-button sensor. Face ID iPads are the Pros from 2018 (`iPad8,*`, `iPad13,4-11`,
	 * `iPad14,3-6`, `iPad16,3-6`, `iPad17,*`). Unknown or empty falls back to Face ID.
	 */
	biometricModality(model: string): BiometricState["modality"] {
		const id = model.trim();
		const match = /^(iPhone|iPad)(\d+),(\d+)$/.exec(id);
		if (!match) return "face";
		const major = Number(match[2]);
		const minor = Number(match[3]);
		if (match[1] === "iPhone") {
			if (major <= 9) return "fingerprint";
			if (major === 10) return minor === 3 || minor === 6 ? "face" : "fingerprint";
			return id === "iPhone12,8" || id === "iPhone14,6" ? "fingerprint" : "face";
		}
		const faceMinors: Record<number, readonly [number, number]> = {
			8: [1, 12],
			13: [4, 11],
			14: [3, 6],
			16: [3, 6],
			17: [1, 99],
		};
		const range = faceMinors[major];
		return range && minor >= range[0] && minor <= range[1] ? "face" : "fingerprint";
	}

	/** `launchctl list` rows are `PID  STATUS  LABEL`; PID is `-` for loaded-but-not-running jobs. */
	running(launchctlOutput: string, bundleId: string): boolean {
		const row = new RegExp(`^\\s*(\\d+)\\s+\\S+\\s+UIKitApplication:${this.escapeRegExp(bundleId)}\\[`, "m");
		return row.test(launchctlOutput);
	}

	private escapeRegExp(text: string): string {
		return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
}

export const simctlParser = new SimctlParser();

/** Maps failed simctl runs to `DriverError`s. Use the shared {@link simctlFailures} singleton. */
export class SimctlFailures {
	/** Map a failed simctl run to a `DriverError`. `appCommand` marks launch-like calls where "not installed" means the app, not the device. */
	from(argv: readonly string[], res: ExecResult, appCommand = false): DriverError {
		const text = `${res.stderr}\n${res.stdout}`;
		const message = execErrors.format(argv, res);
		const detail = { argv, exitCode: res.exitCode };
		if (/current state:\s*(Shutdown|Creating|Shutting Down)/i.test(text) || /Unable to .* not booted/i.test(text)) {
			return driverErrors.make("E_NOT_BOOTED", message, { detail });
		}
		if (/Invalid device|No devices are booted|device .* not found/i.test(text)) {
			return driverErrors.make("E_UNKNOWN_DEVICE", message, { detail });
		}
		if (
			appCommand &&
			/not installed|found nothing|FBSOpenApplicationServiceErrorDomain|No such (file|app)|unknown app/i.test(text)
		) {
			return driverErrors.make("E_APP_UNAVAILABLE", message, { detail });
		}
		return driverErrors.make("E_IO", message, { detail });
	}
}

export const simctlFailures = new SimctlFailures();

export type SimctlDeps = {
	udid: string;
	exec: Exec;
	/** forwarded to core's installer helpers (resolves `adb`; unused on iOS but part of their deps) */
	env?: Record<string, string | undefined>;
	/** app data wipe filesystem; defaults to node fs */
	resetFs?: ResetFs;
	/** where the screenshot fallback writes before reading back; defaults to a fresh `os.tmpdir()` dir */
	scratchDir?: () => Promise<string>;
	readFile?: (path: string) => Promise<Uint8Array>;
	rmDir?: (path: string) => Promise<void>;
	/** CoreSimulator's devices directory, for the host-side `AutomationEnabled` check; defaults to `~/Library/...` */
	devicesRoot?: string;
};

export type Simctl = {
	launch(bundleId: string, opts?: LaunchOptions): DriverResult<void>;
	terminate(bundleId: string): DriverResult<void>;
	openUrl(url: string): DriverResult<void>;
	install(path: string): DriverResult<void>;
	uninstall(bundleId: string): DriverResult<void>;
	isInstalled(bundleId: string): DriverResult<boolean>;
	isRunning(bundleId: string): DriverResult<boolean>;
	clearData(bundleId: string, opts?: { keychain?: boolean }): DriverResult<void>;
	/**
	 * Puts `text` on the simulator pasteboard and confirms it with `pbpaste` before answering, trying every
	 * {@link PBCOPY_CHANNELS} entry: `E_IO` when none took, so a paste never lands other text.
	 */
	pbcopy(text: string): DriverResult<void>;
	pbpaste(): DriverResult<string>;
	appearance(set?: "light" | "dark"): DriverResult<"light" | "dark">;
	statusBar(overrides?: StatusBarOverrides | "clear"): DriverResult<void>;
	/** `simctl location`: point, route (also from a GPX file), Apple scenario, or clear. Loop is not supported. */
	location(op: LocationCondition): DriverResult<void>;
	/**
	 * Face ID / Touch ID through BiometricKit notifications inside the sim. Modality comes from the booted sim's
	 * `SIMULATOR_MODEL_IDENTIFIER` (read once; unreadable = Face ID); the answer is the state after the op.
	 */
	biometrics(op: BiometricOp): DriverResult<BiometricState>;
	/** `simctl io screenshot` to `path`, or (no path) to a scratch file read back as PNG bytes */
	screenshot(path?: string): DriverResult<{ path?: string; png?: Uint8Array }>;
	/** `defaults write com.apple.Accessibility AutomationEnabled -bool true` inside the sim */
	enableAutomation(): DriverResult<void>;
};

type StartableRoute = Extract<LocationCondition, { kind: "route" | "gpx" }>;

type RunOutcome = { ok: true; res: ExecResult } | { ok: false; error: DriverError };

/** `xcrun simctl` bound to one simulator and an injected `Exec`. */
export class SimctlRunner implements Simctl {
	private readonly udid: string;
	private readonly exec: Exec;
	private readonly env: Record<string, string | undefined>;
	private modality: BiometricState["modality"] | undefined;

	constructor(private readonly deps: SimctlDeps) {
		this.udid = deps.udid;
		this.exec = deps.exec;
		this.env = deps.env ?? {};
	}

	async launch(bundleId: string, opts: LaunchOptions = {}): DriverResult<void> {
		const result = await this.run(
			simctlArgv.launch(this.udid, bundleId, opts),
			LAUNCH_MS,
			true,
			simctlArgv.launchEnv(opts.env)
		);
		return result.ok ? this.ok(undefined) : { success: false, error: result.error };
	}

	async terminate(bundleId: string): DriverResult<void> {
		const argv = simctlArgv.terminate(this.udid, bundleId);
		const res = await this.exec(argv, { timeoutMs: SHORT_MS });
		// "found nothing to terminate": already gone is the desired state
		if (res.exitCode === 0 || /found nothing to terminate/i.test(`${res.stderr}${res.stdout}`))
			return this.ok(undefined);
		return { success: false, error: simctlFailures.from(argv, res) };
	}

	openUrl(url: string): DriverResult<void> {
		return this.runVoid(simctlArgv.openUrl(this.udid, url), SHORT_MS, true);
	}

	install(path: string): DriverResult<void> {
		return this.runVoid(simctlArgv.install(this.udid, path), INSTALL_MS);
	}

	async uninstall(bundleId: string): DriverResult<void> {
		if (!(await this.probe(bundleId))) return this.ok(undefined);
		return this.runVoid(simctlArgv.uninstall(this.udid, bundleId), INSTALL_MS);
	}

	async isInstalled(bundleId: string): DriverResult<boolean> {
		return this.ok(await this.probe(bundleId));
	}

	async isRunning(bundleId: string): DriverResult<boolean> {
		const result = await this.run(simctlArgv.launchctlList(this.udid), SHORT_MS);
		return result.ok
			? this.ok(simctlParser.running(result.res.stdout, bundleId))
			: { success: false, error: result.error };
	}

	async clearData(bundleId: string, opts: { keychain?: boolean } = {}): DriverResult<void> {
		const reset = await installer.resetAppData(
			{ exec: this.exec, env: this.env, fs: this.deps.resetFs ?? nodeResetFs },
			{ platform: "ios", deviceId: this.udid },
			bundleId,
			opts.keychain ? { keychain: true } : {}
		);
		if (reset.success) return this.ok(undefined);
		const code = /is not installed/.test(reset.error) ? "E_APP_UNAVAILABLE" : "E_IO";
		return { success: false, error: driverErrors.make(code, reset.error) };
	}

	async pbcopy(text: string): DriverResult<void> {
		const outcomes: string[] = [];
		for (const channel of PBCOPY_CHANNELS) {
			// not `run`: its failure would carry the argv, and with it the text
			const copied = await this.exec(channel.argv(this.udid, text), { timeoutMs: SHORT_MS });
			if (copied.exitCode !== 0) {
				outcomes.push(`${channel.name} exit ${copied.exitCode}`);
				continue;
			}
			const read = await this.run(simctlArgv.pbpaste(this.udid), SHORT_MS);
			if (!read.ok) return { success: false, error: read.error };
			if (read.res.stdout === text) return this.ok(undefined);
			// neither the text nor what the pasteboard holds: typeText carries passwords
			outcomes.push(`${channel.name} exit 0 but pbpaste reads other text`);
		}
		return {
			success: false,
			error: driverErrors.make("E_IO", `simulator pasteboard did not take the text (${outcomes.join("; ")})`),
		};
	}

	async pbpaste(): DriverResult<string> {
		const result = await this.run(simctlArgv.pbpaste(this.udid), SHORT_MS);
		return result.ok ? this.ok(result.res.stdout) : { success: false, error: result.error };
	}

	async appearance(set?: "light" | "dark"): DriverResult<"light" | "dark"> {
		if (set) {
			const done = await this.runVoid(simctlArgv.appearance(this.udid, set));
			return done.success ? this.ok(set) : done;
		}
		const result = await this.run(simctlArgv.appearance(this.udid), SHORT_MS);
		if (!result.ok) return { success: false, error: result.error };
		const value = result.res.stdout.trim();
		if (value === "light" || value === "dark") return this.ok(value);
		return {
			success: false,
			error: driverErrors.make("E_UNSUPPORTED", `simctl ui appearance reported \`${value}\``),
		};
	}

	async biometrics(op: BiometricOp): DriverResult<BiometricState> {
		const kind = await this.modalityOf();
		for (const argv of simctlArgv.biometrics(this.udid, kind, op)) {
			const done = await this.runVoid(argv);
			if (!done.success) return done;
		}
		const read = await this.run(simctlArgv.biometricState(this.udid), SHORT_MS);
		if (!read.ok) return { success: false, error: read.error };
		return this.ok({ enrolled: /\s1\s*$/.test(read.res.stdout), modality: kind });
	}

	statusBar(overrides?: StatusBarOverrides | "clear"): DriverResult<void> {
		return this.runVoid(
			overrides === "clear" ? simctlArgv.statusBarClear(this.udid) : simctlArgv.statusBarOverride(this.udid, overrides)
		);
	}

	location(op: LocationCondition): DriverResult<void> {
		switch (op.kind) {
			case "point":
				return this.runVoid(simctlArgv.locationSet(this.udid, op));
			case "clear":
				return this.runVoid(simctlArgv.locationClear(this.udid));
			case "scenario":
				return this.runVoid(simctlArgv.locationRun(this.udid, IOS_SCENARIO_NAMES[op.name]));
			default:
				return this.playRoute(op);
		}
	}

	async screenshot(path?: string): DriverResult<{ path?: string; png?: Uint8Array }> {
		if (!path) return this.screenshotToScratch();
		const done = await this.runVoid(simctlArgv.screenshot(this.udid, path), LAUNCH_MS);
		return done.success ? this.ok({ path }) : done;
	}

	async enableAutomation(): DriverResult<void> {
		// the default survives helper and sim restarts, so after the first open it is already there
		const plist = simctlArgv.automationPlistPath(this.deps.devicesRoot ?? simctlArgv.defaultDevicesRoot(), this.udid);
		const current = await this.exec(simctlArgv.automationRead(plist), { timeoutMs: PLIST_READ_MS }).catch(
			() => undefined
		);
		if (current?.exitCode === 0 && current.stdout.trim() === "true") return this.ok(undefined);
		return this.runVoid(simctlArgv.automation(this.udid));
	}

	private ok<T>(data: T) {
		return { success: true as const, data };
	}

	private fail(error: DriverError) {
		return { success: false as const, error };
	}

	private async readText(path: string): Promise<string> {
		return new TextDecoder().decode(await this.readBytes(path));
	}

	private readBytes(path: string): Promise<Uint8Array> {
		return (this.deps.readFile ?? ((p: string) => readFile(p)))(path);
	}

	private async run(
		argv: string[],
		timeoutMs: number,
		appCommand = false,
		envOverride?: Record<string, string>
	): Promise<RunOutcome> {
		const res = await this.exec(argv, { timeoutMs, ...(envOverride ? { env: envOverride } : {}) });
		return res.exitCode === 0
			? { ok: true as const, res }
			: { ok: false as const, error: simctlFailures.from(argv, res, appCommand) };
	}

	private async runVoid(argv: string[], timeoutMs = SHORT_MS, appCommand = false): DriverResult<void> {
		const result = await this.run(argv, timeoutMs, appCommand);
		return result.ok ? this.ok(undefined) : { success: false, error: result.error };
	}

	private startOptions(op: StartableRoute): LocationStartOptions {
		const intervalS = op.kind === "route" ? op.intervalS : undefined;
		return {
			...(op.speedMps !== undefined ? { speedMps: op.speedMps } : {}),
			...(intervalS !== undefined ? { intervalS } : {}),
		};
	}

	private async playRoute(op: StartableRoute): DriverResult<void> {
		if (op.kind === "route" && op.loop) {
			return this.fail(driverErrors.make("E_UNSUPPORTED", "simctl location has no loop; iOS routes play once"));
		}
		const loaded =
			op.kind === "gpx"
				? await locationPlanner.loadGpxPoints(op.path, (path) => this.readText(path))
				: this.ok(op.points);
		if (!loaded.success) return this.fail(driverErrors.make("E_BAD_REQUEST", loaded.error));
		const [only, second] = loaded.data;
		if (!only) return this.fail(driverErrors.make("E_BAD_REQUEST", "a route needs at least one point"));
		if (!second) return this.runVoid(simctlArgv.locationSet(this.udid, only));
		return this.runVoid(simctlArgv.locationStart(this.udid, loaded.data, this.startOptions(op)));
	}

	private async probe(bundleId: string): Promise<boolean> {
		const argv = simctlArgv.appContainer(this.udid, bundleId);
		const res = await this.exec(argv, { timeoutMs: SHORT_MS });
		return res.exitCode === 0 && res.stdout.trim() !== "";
	}

	private async screenshotToScratch(): DriverResult<{ path?: string; png?: Uint8Array }> {
		const dir = await (this.deps.scratchDir ?? (() => mkdtemp(join(tmpdir(), "warden-shot-"))))();
		const file = join(dir, "screen.png");
		try {
			const done = await this.runVoid(simctlArgv.screenshot(this.udid, file), LAUNCH_MS);
			if (!done.success) return done;
			const bytes = await this.readBytes(file);
			return this.ok({ png: new Uint8Array(bytes) });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { success: false, error: driverErrors.make("E_IO", `reading screenshot: ${reason}`) };
		} finally {
			await (this.deps.rmDir ?? ((p: string) => rm(p, { recursive: true, force: true })))(dir).catch(() => undefined);
		}
	}

	private async modalityOf(): Promise<BiometricState["modality"]> {
		if (this.modality) return this.modality;
		const result = await this.run(simctlArgv.modelIdentifier(this.udid), SHORT_MS);
		this.modality = result.ok ? simctlParser.biometricModality(result.res.stdout) : "face";
		return this.modality;
	}
}

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { nodeResetFs, type ResetFs, resetAppData } from "@delacour/warden-core/builds/install";
import type { LatLon, LocationCondition } from "@delacour/warden-core/conditions/conditions.types";
import { type Exec, type ExecResult, execError } from "@delacour/warden-core/exec";
import { formatCoord } from "../../conditions/geo";
import { loadGpxPoints } from "../../conditions/location-plan";
import { IOS_SCENARIO_NAMES } from "../../conditions/location-scenarios.data";
import type { BiometricOp, BiometricState, DriverError, DriverResult, LaunchOptions } from "../driver.types";
import { driverError } from "../errors";

/**
 * Everything the iOS driver does through `xcrun simctl` instead of the helper: app lifecycle,
 * clipboard, appearance, status bar, the screenshot fallback and the AX automation flag. Argv builders
 * are pure; `createSimctl` binds them to an injected `Exec`.
 */

const XCRUN = ["xcrun", "simctl"] as const;

const PLIST_READ_MS = 2_000;
const SHORT_MS = 15_000;
const LAUNCH_MS = 30_000;
const INSTALL_MS = 10 * 60_000;

export const SIMCTL_CHILD_PREFIX = "SIMCTL_CHILD_";

// ---------- argv builders ----------

/** `xcrun simctl launch [--terminate-running-process] <udid> <bundle> <args…>` (env goes through `SIMCTL_CHILD_*`, see {@link launchEnv}). */
export function launchArgv(udid: string, bundleId: string, opts: LaunchOptions = {}): string[] {
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
export function launchEnv(env: Record<string, string> | undefined): Record<string, string> {
	return Object.fromEntries(Object.entries(env ?? {}).map(([key, value]) => [`${SIMCTL_CHILD_PREFIX}${key}`, value]));
}

export const terminateArgv = (udid: string, bundleId: string): string[] => [...XCRUN, "terminate", udid, bundleId];
export const openUrlArgv = (udid: string, url: string): string[] => [...XCRUN, "openurl", udid, url];
export const installArgv = (udid: string, appPath: string): string[] => [...XCRUN, "install", udid, appPath];
export const uninstallArgv = (udid: string, bundleId: string): string[] => [...XCRUN, "uninstall", udid, bundleId];
/** Exit 0 and a path on stdout when installed; non-zero when not. */
export const appContainerArgv = (udid: string, bundleId: string): string[] => [
	...XCRUN,
	"get_app_container",
	udid,
	bundleId,
];
/** Lists launchd jobs inside the simulator; a running app shows up as `UIKitApplication:<bundle>[…]` with a PID. */
export const launchctlListArgv = (udid: string): string[] => [...XCRUN, "spawn", udid, "launchctl", "list"];
export const pbpasteArgv = (udid: string): string[] => [...XCRUN, "pbpaste", udid];
export const appearanceArgv = (udid: string, set?: "light" | "dark"): string[] => [
	...XCRUN,
	"ui",
	udid,
	"appearance",
	...(set ? [set] : []),
];
const notifyutilArgv = (udid: string, args: readonly string[]): string[] => [
	...XCRUN,
	"spawn",
	udid,
	"notifyutil",
	...args,
];
const ENROLLMENT_NOTIFICATION = "com.apple.BiometricKit.enrollmentChanged";
/** Sets the enrollment state, then posts the change (`notifyutil -s <name> <state>` before `-p <name>`). */
export const biometricEnrollArgvs = (udid: string, enrolled: boolean): string[][] => [
	notifyutilArgv(udid, ["-s", ENROLLMENT_NOTIFICATION, enrolled ? "1" : "0"]),
	notifyutilArgv(udid, ["-p", ENROLLMENT_NOTIFICATION]),
];
/** Prints `com.apple.BiometricKit.enrollmentChanged <0|1>`. */
export const biometricStateArgv = (udid: string): string[] => notifyutilArgv(udid, ["-g", ENROLLMENT_NOTIFICATION]);
/** The Face ID (`pearl`) or Touch ID (`fingerTouch`) match / nomatch notification the simulator's BiometricKit listens for. */
export const biometricEventArgv = (
	udid: string,
	modality: BiometricState["modality"],
	event: "match" | "nomatch"
): string[] =>
	notifyutilArgv(udid, ["-p", `com.apple.BiometricKit_Sim.${modality === "face" ? "pearl" : "fingerTouch"}.${event}`]);
/** The notifications one op posts, in order; `status` posts nothing. */
export function biometricArgvs(udid: string, modality: BiometricState["modality"], op: BiometricOp): string[][] {
	if (op === "enroll" || op === "unenroll") return biometricEnrollArgvs(udid, op === "enroll");
	if (op === "match" || op === "fail")
		return [biometricEventArgv(udid, modality, op === "match" ? "match" : "nomatch")];
	return [];
}
/** Model identifier (`iPhone14,7`) of a booted sim. */
export const modelIdentifierArgv = (udid: string): string[] => [...XCRUN, "getenv", udid, "SIMULATOR_MODEL_IDENTIFIER"];

/**
 * Touch ID models by identifier: iPhone SE and everything up to the 8 (`iPhone10,1|2|4|5`; the X, `10,3|6`, has Face ID),
 * and the iPads with a home or power-button sensor. Face ID iPads are the Pros from 2018 (`iPad8,*`, `iPad13,4-11`,
 * `iPad14,3-6`, `iPad16,3-6`, `iPad17,*`). Unknown or empty falls back to Face ID.
 */
export function biometricModalityOf(model: string): BiometricState["modality"] {
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
export const screenshotArgv = (udid: string, path: string): string[] => [
	...XCRUN,
	"io",
	udid,
	"screenshot",
	"--type=png",
	path,
];
/** `AutomationEnabled` lets the AX bridge attach without the runner app; written once per open. */
export const automationArgv = (udid: string): string[] => [
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

/** Where CoreSimulator keeps every simulator's data directory on the host. */
export const defaultDevicesRoot = (): string => join(homedir(), "Library", "Developer", "CoreSimulator", "Devices");

/**
 * The simulator's Accessibility preferences, readable from the host without booting anything through `xcrun`
 * (`simctl spawn` costs 300-500 ms, a `plutil` read about 10 ms).
 */
export const automationPlistPath = (devicesRoot: string, udid: string): string =>
	join(devicesRoot, udid, "data", "Library", "Preferences", "com.apple.Accessibility.plist");

/** `plutil -extract AutomationEnabled raw -o - <plist>` prints `true` once the default is written. */
export const automationReadArgv = (plist: string): string[] => [
	"plutil",
	"-extract",
	"AutomationEnabled",
	"raw",
	"-o",
	"-",
	plist,
];

export type StatusBarOverrides = {
	time?: string;
	batteryLevel?: number;
	batteryState?: "charged" | "charging" | "discharging";
	wifiBars?: number;
	cellularBars?: number;
};

/** Clean 9:41 status bar by default (stable screenshots); pass `undefined` fields to drop them. */
export function statusBarOverrideArgv(udid: string, o: StatusBarOverrides = {}): string[] {
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

export const statusBarClearArgv = (udid: string): string[] => [...XCRUN, "status_bar", udid, "clear"];

const latLon = (p: LatLon): string => `${formatCoord(p.lat)},${formatCoord(p.lon)}`;

export const locationSetArgv = (udid: string, point: LatLon): string[] => [
	...XCRUN,
	"location",
	udid,
	"set",
	latLon(point),
];
export const locationClearArgv = (udid: string): string[] => [...XCRUN, "location", udid, "clear"];
/** `name` is Apple's scenario name (`City Run`), see {@link IOS_SCENARIO_NAMES}. */
export const locationRunArgv = (udid: string, name: string): string[] => [...XCRUN, "location", udid, "run", name];

/** A route with more waypoints than this goes through stdin (`-`) instead of the argument list. */
export const LOCATION_ARGV_MAX_POINTS = 100;

export type LocationStartOptions = { speedMps?: number; intervalS?: number };

function startOptions(op: Extract<LocationCondition, { kind: "route" | "gpx" }>): LocationStartOptions {
	const intervalS = op.kind === "route" ? op.intervalS : undefined;
	return {
		...(op.speedMps !== undefined ? { speedMps: op.speedMps } : {}),
		...(intervalS !== undefined ? { intervalS } : {}),
	};
}

/**
 * `simctl location <udid> start [--speed=] [--interval=] <lat,lon>…`. The sim plays the path itself
 * after the command returns. Past {@link LOCATION_ARGV_MAX_POINTS} the waypoints ride stdin of a tiny
 * `sh -c` (one `lat,lon` per line, never interpolated into the script) with the `-` operand.
 */
export function locationStartArgv(udid: string, points: readonly LatLon[], o: LocationStartOptions = {}): string[] {
	const flags = [
		...(o.speedMps !== undefined ? [`--speed=${formatCoord(o.speedMps)}`] : []),
		...(o.intervalS !== undefined ? [`--interval=${formatCoord(o.intervalS)}`] : []),
	];
	if (points.length <= LOCATION_ARGV_MAX_POINTS)
		return [...XCRUN, "location", udid, "start", ...flags, ...points.map(latLon)];
	return [
		"sh",
		"-c",
		'printf %s "$1" | xcrun simctl location "$2" start $3 -',
		"sh",
		points.map(latLon).join("\n"),
		udid,
		flags.join(" "),
	];
}

/**
 * `simctl pbcopy` reads stdin and `Exec` has none, so the text rides as `$1` of a tiny `sh -c`
 * (never interpolated into the script): `printf %s "$1" | xcrun simctl pbcopy "$2"`.
 */
export function pbcopyArgv(udid: string, text: string): string[] {
	return ["sh", "-c", 'printf %s "$1" | xcrun simctl pbcopy "$2"', "sh", text, udid];
}

/**
 * The same text through `devicectl device pasteboard copy`, the CoreDevice side of the simulator pasteboard.
 * On Xcode 27.1 (iOS 26.5 runtime) `simctl pbcopy` exits 0 without changing the pasteboard, which then still
 * holds whatever CoreDevice's `dtpasteboardd` last mirrored from the Mac; `devicectl` writes it in ~350 ms.
 */
export function devicectlPbcopyArgv(udid: string, text: string): string[] {
	return [
		"sh",
		"-c",
		'printf %s "$1" | xcrun devicectl device pasteboard copy --quiet --device "$2"',
		"sh",
		text,
		udid,
	];
}

/** The channels {@link createSimctl}'s `pbcopy` tries, in order; each write is confirmed with `simctl pbpaste`. */
export const PBCOPY_CHANNELS: readonly { name: string; argv: (udid: string, text: string) => string[] }[] = [
	{ name: "devicectl pasteboard copy", argv: devicectlPbcopyArgv },
	{ name: "simctl pbcopy", argv: pbcopyArgv },
];

// ---------- parsing ----------

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `launchctl list` rows are `PID  STATUS  LABEL`; PID is `-` for loaded-but-not-running jobs. */
export function parseRunning(launchctlOutput: string, bundleId: string): boolean {
	const row = new RegExp(`^\\s*(\\d+)\\s+\\S+\\s+UIKitApplication:${escapeRegExp(bundleId)}\\[`, "m");
	return row.test(launchctlOutput);
}

// ---------- failures ----------

/** Map a failed simctl run to a `DriverError`. `appCommand` marks launch-like calls where "not installed" means the app, not the device. */
export function simctlFailure(argv: readonly string[], res: ExecResult, appCommand = false): DriverError {
	const text = `${res.stderr}\n${res.stdout}`;
	const message = execError(argv, res);
	const detail = { argv, exitCode: res.exitCode };
	if (/current state:\s*(Shutdown|Creating|Shutting Down)/i.test(text) || /Unable to .* not booted/i.test(text)) {
		return driverError("E_NOT_BOOTED", message, { detail });
	}
	if (/Invalid device|No devices are booted|device .* not found/i.test(text)) {
		return driverError("E_UNKNOWN_DEVICE", message, { detail });
	}
	if (
		appCommand &&
		/not installed|found nothing|FBSOpenApplicationServiceErrorDomain|No such (file|app)|unknown app/i.test(text)
	) {
		return driverError("E_APP_UNAVAILABLE", message, { detail });
	}
	return driverError("E_IO", message, { detail });
}

// ---------- runner ----------

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

const ok = <T>(data: T) => ({ success: true as const, data });
const fail = (error: DriverError) => ({ success: false as const, error });

export function createSimctl(deps: SimctlDeps): Simctl {
	const { udid, exec } = deps;
	const env = deps.env ?? {};
	const readText = async (path: string): Promise<string> =>
		new TextDecoder().decode(await (deps.readFile ?? ((p: string) => readFile(p)))(path));

	async function run(argv: string[], timeoutMs: number, appCommand = false, envOverride?: Record<string, string>) {
		const res = await exec(argv, { timeoutMs, ...(envOverride ? { env: envOverride } : {}) });
		return res.exitCode === 0
			? { ok: true as const, res }
			: { ok: false as const, error: simctlFailure(argv, res, appCommand) };
	}

	async function runVoid(argv: string[], timeoutMs = SHORT_MS, appCommand = false): ReturnType<Simctl["terminate"]> {
		const result = await run(argv, timeoutMs, appCommand);
		return result.ok ? ok(undefined) : { success: false, error: result.error };
	}

	async function playRoute(op: Extract<LocationCondition, { kind: "route" | "gpx" }>): DriverResult<void> {
		if (op.kind === "route" && op.loop) {
			return fail(driverError("E_UNSUPPORTED", "simctl location has no loop; iOS routes play once"));
		}
		const loaded = op.kind === "gpx" ? await loadGpxPoints(op.path, readText) : ok(op.points);
		if (!loaded.success) return fail(driverError("E_BAD_REQUEST", loaded.error));
		const [only, second] = loaded.data;
		if (!only) return fail(driverError("E_BAD_REQUEST", "a route needs at least one point"));
		if (!second) return runVoid(locationSetArgv(udid, only));
		return runVoid(locationStartArgv(udid, loaded.data, startOptions(op)));
	}

	const probe = async (bundleId: string) => {
		const argv = appContainerArgv(udid, bundleId);
		const res = await exec(argv, { timeoutMs: SHORT_MS });
		return res.exitCode === 0 && res.stdout.trim() !== "";
	};

	async function screenshotToScratch(): ReturnType<Simctl["screenshot"]> {
		const dir = await (deps.scratchDir ?? (() => mkdtemp(join(tmpdir(), "warden-shot-"))))();
		const file = join(dir, "screen.png");
		try {
			const done = await runVoid(screenshotArgv(udid, file), LAUNCH_MS);
			if (!done.success) return done;
			const bytes = await (deps.readFile ?? ((p: string) => readFile(p)))(file);
			return ok({ png: new Uint8Array(bytes) });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { success: false, error: driverError("E_IO", `reading screenshot: ${reason}`) };
		} finally {
			await (deps.rmDir ?? ((p: string) => rm(p, { recursive: true, force: true })))(dir).catch(() => undefined);
		}
	}

	let modality: BiometricState["modality"] | undefined;
	const modalityOf = async (): Promise<BiometricState["modality"]> => {
		if (modality) return modality;
		const result = await run(modelIdentifierArgv(udid), SHORT_MS);
		modality = result.ok ? biometricModalityOf(result.res.stdout) : "face";
		return modality;
	};

	return {
		async launch(bundleId, opts = {}) {
			const result = await run(launchArgv(udid, bundleId, opts), LAUNCH_MS, true, launchEnv(opts.env));
			return result.ok ? ok(undefined) : { success: false, error: result.error };
		},
		async terminate(bundleId) {
			const argv = terminateArgv(udid, bundleId);
			const res = await exec(argv, { timeoutMs: SHORT_MS });
			// "found nothing to terminate": already gone is the desired state
			if (res.exitCode === 0 || /found nothing to terminate/i.test(`${res.stderr}${res.stdout}`)) return ok(undefined);
			return { success: false, error: simctlFailure(argv, res) };
		},
		openUrl: (url) => runVoid(openUrlArgv(udid, url), SHORT_MS, true),
		install: (path) => runVoid(installArgv(udid, path), INSTALL_MS),
		async uninstall(bundleId) {
			if (!(await probe(bundleId))) return ok(undefined);
			return runVoid(uninstallArgv(udid, bundleId), INSTALL_MS);
		},
		async isInstalled(bundleId) {
			return ok(await probe(bundleId));
		},
		async isRunning(bundleId) {
			const result = await run(launchctlListArgv(udid), SHORT_MS);
			return result.ok ? ok(parseRunning(result.res.stdout, bundleId)) : { success: false, error: result.error };
		},
		async clearData(bundleId, opts = {}) {
			const reset = await resetAppData(
				{ exec, env, fs: deps.resetFs ?? nodeResetFs },
				{ platform: "ios", deviceId: udid },
				bundleId,
				opts.keychain ? { keychain: true } : {}
			);
			if (reset.success) return ok(undefined);
			const code = /is not installed/.test(reset.error) ? "E_APP_UNAVAILABLE" : "E_IO";
			return { success: false, error: driverError(code, reset.error) };
		},
		async pbcopy(text) {
			const outcomes: string[] = [];
			for (const channel of PBCOPY_CHANNELS) {
				// not `run`: its failure would carry the argv, and with it the text
				const copied = await exec(channel.argv(udid, text), { timeoutMs: SHORT_MS });
				if (copied.exitCode !== 0) {
					outcomes.push(`${channel.name} exit ${copied.exitCode}`);
					continue;
				}
				const read = await run(pbpasteArgv(udid), SHORT_MS);
				if (!read.ok) return { success: false, error: read.error };
				if (read.res.stdout === text) return ok(undefined);
				// neither the text nor what the pasteboard holds: typeText carries passwords
				outcomes.push(`${channel.name} exit 0 but pbpaste reads other text`);
			}
			return {
				success: false,
				error: driverError("E_IO", `simulator pasteboard did not take the text (${outcomes.join("; ")})`),
			};
		},
		async pbpaste() {
			const result = await run(pbpasteArgv(udid), SHORT_MS);
			return result.ok ? ok(result.res.stdout) : { success: false, error: result.error };
		},
		async appearance(set) {
			if (set) {
				const done = await runVoid(appearanceArgv(udid, set));
				return done.success ? ok(set) : done;
			}
			const result = await run(appearanceArgv(udid), SHORT_MS);
			if (!result.ok) return { success: false, error: result.error };
			const value = result.res.stdout.trim();
			if (value === "light" || value === "dark") return ok(value);
			return { success: false, error: driverError("E_UNSUPPORTED", `simctl ui appearance reported \`${value}\``) };
		},
		async biometrics(op) {
			const kind = await modalityOf();
			for (const argv of biometricArgvs(udid, kind, op)) {
				const done = await runVoid(argv);
				if (!done.success) return done;
			}
			const read = await run(biometricStateArgv(udid), SHORT_MS);
			if (!read.ok) return { success: false, error: read.error };
			return ok({ enrolled: /\s1\s*$/.test(read.res.stdout), modality: kind });
		},
		statusBar: (overrides) =>
			runVoid(overrides === "clear" ? statusBarClearArgv(udid) : statusBarOverrideArgv(udid, overrides)),
		location: (op) => {
			switch (op.kind) {
				case "point":
					return runVoid(locationSetArgv(udid, op));
				case "clear":
					return runVoid(locationClearArgv(udid));
				case "scenario":
					return runVoid(locationRunArgv(udid, IOS_SCENARIO_NAMES[op.name]));
				default:
					return playRoute(op);
			}
		},
		async screenshot(path) {
			if (!path) return screenshotToScratch();
			const done = await runVoid(screenshotArgv(udid, path), LAUNCH_MS);
			return done.success ? ok({ path }) : done;
		},
		enableAutomation: async () => {
			// the default survives helper and sim restarts, so after the first open it is already there
			const plist = automationPlistPath(deps.devicesRoot ?? defaultDevicesRoot(), udid);
			const current = await exec(automationReadArgv(plist), { timeoutMs: PLIST_READ_MS }).catch(() => undefined);
			if (current?.exitCode === 0 && current.stdout.trim() === "true") return ok(undefined);
			return runVoid(automationArgv(udid));
		},
	};
}

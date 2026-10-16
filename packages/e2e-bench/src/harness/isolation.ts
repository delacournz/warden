import { homedir } from "node:os";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { BenchAdapter } from "../adapters/adapter.types";
import type { Platform } from "../results/schema";
import { type Exec, runOk } from "./exec";
import { killMatching, listDriverApps, type Owner } from "./residue";

/** Every framework's long-lived helpers; killed (only when owned by this bench) so one never inherits another's daemons. */
export const KNOWN_PROCESS_PATTERNS: RegExp[] = [
	/warden-simd/,
	/argent.*(simulator-server|ax-service|tool-server)/,
	/agent-device.*daemon/,
	/(xctest|XCTRunner).*(maestro|agent-device)/i,
	/java.*maestro/i,
	/detox/,
];

export type IsolateInput = {
	exec: Exec;
	platform: Platform;
	udid: string;
	bundleId: string;
	previous?: BenchAdapter;
	next: BenchAdapter;
	/** driver / runner app ids of every framework, stopped on the device before each framework (Android) */
	allDrivers?: readonly string[];
	cold: boolean;
	rebootBetween: boolean;
	log: (line: string) => void;
	repoRoot: string;
	cliPath: string;
	/** pids the bench spawned (its tracking exec) */
	benchPids: () => readonly number[];
	/** private dirs whose processes are ours (run out dir, agent-device bench state, warden simd dir) */
	ownedPaths: readonly string[];
	home?: string;
	sleep?: (ms: number) => Promise<void>;
	/** max `sys.boot_completed` polls after an Android reboot (1 s apart) */
	bootPolls?: number;
	/** the device's original animation scales by serial (tests inject their own; default is process-wide) */
	animationBaselines?: AnimationBaselines;
};

export type IsolateOutcome = { killed: string[]; uninstalled: string[]; rebooted: boolean };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Stops helpers we own: this device's warden helper, and agent-device daemons only through their
 * private state dirs. Never the global agent-device daemon or the shared argent tool-server.
 */
async function stopHelpers(input: IsolateInput): Promise<void> {
	const { exec, udid, repoRoot, cliPath } = input;
	await exec.run("bun", [cliPath, "ui", "close", "--udid", udid], { cwd: repoRoot, timeoutMs: 30_000 });
	if (exec.which("agent-device") === undefined) return;
	const home = input.home ?? homedir();
	const dirs = new Set(
		[...(input.previous?.residuePatterns.stateDirs ?? []), ...(input.next.residuePatterns.stateDirs ?? [])].map((d) =>
			d === "~" || d.startsWith("~/") ? home + d.slice(1) : d
		)
	);
	for (const dir of dirs)
		await exec.run("agent-device", ["daemon", "stop", "--state-dir", dir, "--clean"], { timeoutMs: 30_000 });
}

/**
 * Android: force-stops every installed driver app of any framework. A resident driver (maestro's
 * `dev.mobile.maestro`, argent's `com.argent.androiddevtools`) holds the device's UiAutomation, which
 * kills every later `uiautomator dump`, so the next framework must start without one.
 */
async function stopDriverApps(input: IsolateInput): Promise<string[]> {
	const { exec, platform, udid } = input;
	if (platform !== "android") return [];
	const ids = [
		...(input.previous?.residuePatterns.driverBundleIds ?? []),
		...input.next.residuePatterns.driverBundleIds,
		...(input.allDrivers ?? []),
	];
	const present = await listDriverApps(exec, platform, udid, ids);
	for (const id of present) await exec.run("adb", ["-s", udid, "shell", "am", "force-stop", id], { timeoutMs: 30_000 });
	return present;
}

/** Removes the next framework's driver apps that are present (cold runs only). */
async function uninstallDrivers(input: IsolateInput): Promise<string[]> {
	const { exec, platform, udid, next } = input;
	const present = await listDriverApps(exec, platform, udid, next.residuePatterns.driverBundleIds);
	const removed: string[] = [];
	for (const id of present) {
		const args = platform === "ios" ? ["simctl", "uninstall", udid, id] : ["-s", udid, "uninstall", id];
		const r = await exec.run(platform === "ios" ? "xcrun" : "adb", args, { timeoutMs: 60_000 });
		if (r.code === 0) removed.push(id);
		else input.log(`uninstall ${id} failed: ${r.stderr.trim()}`);
	}
	return removed;
}

async function rebootIos(input: IsolateInput): Promise<string | undefined> {
	const { exec, udid } = input;
	await exec.run("xcrun", ["simctl", "shutdown", udid], { timeoutMs: 60_000 });
	const boot = await exec.run("xcrun", ["simctl", "boot", udid], { timeoutMs: 60_000 });
	if (boot.code !== 0 && !/current state: Booted/i.test(boot.stderr))
		return `simctl boot failed: ${boot.stderr.trim()}`;
	const status = await exec.run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeoutMs: 300_000 });
	return status.code === 0 ? undefined : `simctl bootstatus failed: ${status.stderr.trim()}`;
}

async function rebootAndroid(input: IsolateInput): Promise<string | undefined> {
	const { exec, udid } = input;
	const sleep = input.sleep ?? defaultSleep;
	const rb = await exec.run("adb", ["-s", udid, "reboot"], { timeoutMs: 30_000 });
	if (rb.code !== 0) return `adb reboot failed: ${rb.stderr.trim()}`;
	await exec.run("adb", ["-s", udid, "wait-for-device"], { timeoutMs: 180_000 });
	for (let i = 0; i < (input.bootPolls ?? 120); i++) {
		const r = await exec.run("adb", ["-s", udid, "shell", "getprop", "sys.boot_completed"], { timeoutMs: 10_000 });
		if (r.stdout.trim() === "1") return undefined;
		await sleep(1_000);
	}
	return "android did not finish booting";
}

/**
 * Android's three global animation scales. Warden's driver sets all of them to 0 for the run, so every
 * framework measured after it would otherwise run on a device with animations off.
 */
export const ANIMATION_SETTINGS = [
	"window_animation_scale",
	"transition_animation_scale",
	"animator_duration_scale",
] as const;

export type AnimationSetting = (typeof ANIMATION_SETTINGS)[number];

/** Each scale as `settings get` printed it; `undefined` when the key is unset (`null`). */
export type AnimationScales = Readonly<Record<AnimationSetting, string | undefined>>;

/** The device's original scales by serial, recorded once per bench. */
export type AnimationBaselines = Map<string, AnimationScales>;

const processBaselines: AnimationBaselines = new Map();

/** A plain non-negative number: the only thing ever written back to a device shell. */
const SCALE_VALUE = /^\d+(\.\d+)?$/;

async function readScale(exec: Exec, serial: string, key: AnimationSetting): AsyncResult<string | undefined> {
	const r = await runOk(exec, "adb", ["-s", serial, "shell", "settings", "get", "global", key], { timeoutMs: 10_000 });
	if (!r.success) return r;
	const text = r.data.stdout.trim();
	if (text === "null") return ok(undefined);
	return SCALE_VALUE.test(text) ? ok(text) : err(`${key}: unexpected value '${text}'`);
}

/** The device's current animation scales (`adb shell settings get global …`). */
export async function readAnimationScales(exec: Exec, serial: string): AsyncResult<AnimationScales> {
	const windowScale = await readScale(exec, serial, "window_animation_scale");
	if (!windowScale.success) return windowScale;
	const transition = await readScale(exec, serial, "transition_animation_scale");
	if (!transition.success) return transition;
	const animator = await readScale(exec, serial, "animator_duration_scale");
	if (!animator.success) return animator;
	return ok({
		window_animation_scale: windowScale.data,
		transition_animation_scale: transition.data,
		animator_duration_scale: animator.data,
	});
}

/** Remembers the device's animation scales the first time it is asked; later calls return that first reading. */
export async function recordAnimationScales(
	exec: Exec,
	serial: string,
	baselines: AnimationBaselines = processBaselines
): AsyncResult<AnimationScales> {
	const known = baselines.get(serial);
	if (known !== undefined) return ok(known);
	const read = await readAnimationScales(exec, serial);
	if (read.success) baselines.set(serial, read.data);
	return read;
}

/**
 * Puts back every animation scale that differs from the recorded original (`settings put`, or
 * `settings delete` for a key that was unset) and returns what changed as `key was -> original`.
 * Nothing recorded for the serial means nothing to restore. Tries every setting before reporting a failure.
 */
export async function restoreAnimationScales(
	exec: Exec,
	serial: string,
	baselines: AnimationBaselines = processBaselines
): AsyncResult<string[]> {
	const original = baselines.get(serial);
	if (original === undefined) return ok([]);
	const current = await readAnimationScales(exec, serial);
	if (!current.success) return current;
	const changed: string[] = [];
	const failures: string[] = [];
	for (const key of ANIMATION_SETTINGS) {
		const was = current.data[key];
		const want = original[key];
		if (was === want) continue;
		const verb = want === undefined ? ["delete", "global", key] : ["put", "global", key, want];
		const r = await runOk(exec, "adb", ["-s", serial, "shell", "settings", ...verb], { timeoutMs: 10_000 });
		if (r.success) changed.push(`${key} ${was ?? "unset"} -> ${want ?? "unset"}`);
		else failures.push(r.error);
	}
	return failures.length === 0 ? ok(changed) : err(failures.join("; "));
}

const showScales = (scales: AnimationScales): string =>
	ANIMATION_SETTINGS.map((key) => `${key}=${scales[key] ?? "unset"}`).join(" ");

/**
 * Android: the first call records the device's animation scales (nothing of this bench has run yet), every
 * later call resets them to that reading, so a framework never inherits the previous one's zeroed
 * animations. A problem is logged, not fatal: it must not turn into a failed framework.
 */
async function resetAnimationScales(input: IsolateInput): Promise<void> {
	if (input.platform !== "android") return;
	const { exec, udid, log } = input;
	const baselines = input.animationBaselines ?? processBaselines;
	if (!baselines.has(udid)) {
		const recorded = await recordAnimationScales(exec, udid, baselines);
		log(
			recorded.success
				? `recorded animation scales ${showScales(recorded.data)}`
				: `animation scales: ${recorded.error}`
		);
		return;
	}
	const restored = await restoreAnimationScales(exec, udid, baselines);
	if (!restored.success) {
		log(`animation scales: ${restored.error}`);
		return;
	}
	for (const line of restored.data) log(`restored animation scale ${line}`);
}

/** Terminates the app under test so the next framework launches it fresh. */
async function stopApp(input: IsolateInput): Promise<void> {
	const { exec, platform, udid, bundleId } = input;
	if (platform === "ios") await exec.run("xcrun", ["simctl", "terminate", udid, bundleId], { timeoutMs: 30_000 });
	else await exec.run("adb", ["-s", udid, "shell", "am", "force-stop", bundleId], { timeoutMs: 30_000 });
}

/**
 * Resets the device between frameworks: kill every known helper, stop servers through their CLIs,
 * optionally uninstall the next framework's driver apps (cold) and reboot, reset Android's animation
 * scales to what the device had at bench start, then stop the app.
 */
export async function isolate(input: IsolateInput): AsyncResult<IsolateOutcome> {
	const patterns = [...(input.previous?.residuePatterns.processes ?? []), ...KNOWN_PROCESS_PATTERNS];
	const owner: Owner = { udid: input.udid, benchPids: input.benchPids, ownedPaths: input.ownedPaths };
	const killed = await killMatching(input.exec, patterns, owner, { sleep: input.sleep });
	for (const line of killed) input.log(`killed ${line}`);
	await stopHelpers(input);
	for (const id of await stopDriverApps(input)) input.log(`stopped driver app ${id}`);
	const uninstalled = input.cold ? await uninstallDrivers(input) : [];
	let rebooted = false;
	if (input.rebootBetween) {
		const error = await (input.platform === "ios" ? rebootIos(input) : rebootAndroid(input));
		if (error !== undefined) return { success: false, error };
		rebooted = true;
	}
	await resetAnimationScales(input);
	await stopApp(input);
	return { success: true, data: { killed, uninstalled, rebooted } };
}

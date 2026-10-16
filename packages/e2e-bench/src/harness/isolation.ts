import { homedir } from "node:os";
import type { AsyncResult } from "@delacour/warden-types/result";
import type { BenchAdapter } from "../adapters/adapter.types";
import type { Platform } from "../results/schema";
import type { Exec } from "./exec";
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

/** Terminates the app under test so the next framework launches it fresh. */
async function stopApp(input: IsolateInput): Promise<void> {
	const { exec, platform, udid, bundleId } = input;
	if (platform === "ios") await exec.run("xcrun", ["simctl", "terminate", udid, bundleId], { timeoutMs: 30_000 });
	else await exec.run("adb", ["-s", udid, "shell", "am", "force-stop", bundleId], { timeoutMs: 30_000 });
}

/**
 * Resets the device between frameworks: kill every known helper, stop servers through their CLIs,
 * optionally uninstall the next framework's driver apps (cold) and reboot, then stop the app.
 */
export async function isolate(input: IsolateInput): AsyncResult<IsolateOutcome> {
	const patterns = [...(input.previous?.residuePatterns.processes ?? []), ...KNOWN_PROCESS_PATTERNS];
	const owner: Owner = { udid: input.udid, benchPids: input.benchPids, ownedPaths: input.ownedPaths };
	const killed = await killMatching(input.exec, patterns, owner, { sleep: input.sleep });
	for (const line of killed) input.log(`killed ${line}`);
	await stopHelpers(input);
	const uninstalled = input.cold ? await uninstallDrivers(input) : [];
	let rebooted = false;
	if (input.rebootBetween) {
		const error = await (input.platform === "ios" ? rebootIos(input) : rebootAndroid(input));
		if (error !== undefined) return { success: false, error };
		rebooted = true;
	}
	await stopApp(input);
	return { success: true, data: { killed, uninstalled, rebooted } };
}

import type { DriverError, DriverResult, Logger } from "../driver.types";
import { driverErr, driverError } from "../errors";
import type { SimdSpawn } from "../ios/simd-transport";
import type { AdbSession } from "./adb-session";
import { shellQuote } from "./android-argv";
import { isBusy, startUiad, type UiadClient } from "./uiad-client";
import { UIAD_DEX } from "./uiad-dex.generated";
import { UIAD_MAIN_CLASS } from "./uiad-protocol";

/**
 * Getting `warden-uiad` running on one device: the dex is written to `/data/local/tmp` (once per build, named by its
 * hash), the server is started as the shell user with `app_process`, and a busy UiAutomation slot is dealt with: a
 * stale server of ours is killed, anything else is named in the error and left alone. Everything here is argv and
 * parsing around injected seams (`AdbSession`, `PushDex`, `SimdSpawn`), so it is tested without adb.
 */

export const UIAD_DEVICE_DIR = "/data/local/tmp";

/** The server is built for API 26 and up (`d8 --min-api 26`); an older device keeps the dump and `input`. */
export const UIAD_MIN_SDK = 26;

export type UiadDex = Pick<typeof UIAD_DEX, "bytes" | "dexSha256" | "base64">;

/** `/data/local/tmp/warden-uiad-<hash8>.dex`: a new build is a new file, so an old build is never started by mistake. */
export function uiadDevicePath(dex: Pick<UiadDex, "dexSha256"> = UIAD_DEX): string {
	return `${UIAD_DEVICE_DIR}/warden-uiad-${dex.dexSha256.slice(0, 8)}.dex`;
}

/** The first eight characters of the dex hash: what the saved state keys "this build does not work here" on. */
export function uiadBuildId(dex: Pick<UiadDex, "dexSha256"> = UIAD_DEX): string {
	return dex.dexSha256.slice(0, 8);
}

/** `exec env CLASSPATH=<dex> app_process / <Main>`: `exec` keeps the pipe on the server rather than on a wrapper shell. */
export function uiadLaunchCommand(devicePath: string): string {
	return `exec env CLASSPATH=${shellQuote(devicePath)} app_process / ${UIAD_MAIN_CLASS}`;
}

/** The host command that runs the server and carries its stdio. */
export function uiadLaunchArgv(adb: string, serial: string, devicePath: string): string[] {
	return [adb, "-s", serial, "shell", uiadLaunchCommand(devicePath)];
}

/** Writes stdin to a temp name, makes it read-only, renames it into place: a half-written file is never `present`. */
export function uiadInstallCommand(devicePath: string): string {
	const part = shellQuote(`${devicePath}.part`);
	return `cat > ${part} && chmod 444 ${part} && mv ${part} ${shellQuote(devicePath)}`;
}

export function uiadInstallArgv(adb: string, serial: string, devicePath: string): string[] {
	return [adb, "-s", serial, "shell", uiadInstallCommand(devicePath)];
}

/** Prints `present` when the dex is on the device with the size it should have. */
export function uiadPresentCommand(devicePath: string, bytes: number): string {
	const file = shellQuote(devicePath);
	return `[ -f ${file} ] && [ "$(wc -c < ${file} | tr -d ' ')" = ${bytes} ] && echo present`;
}

/** Runs a host command with `bytes` on its stdin (`adb shell cat > file`). */
export type PushDex = (argv: readonly string[], bytes: Uint8Array) => Promise<{ exitCode: number; output: string }>;

export const bunPushDex: PushDex = async (argv, bytes) => {
	try {
		const proc = Bun.spawn([...argv], { stdin: bytes, stdout: "pipe", stderr: "pipe", timeout: 15_000 });
		const [out, err, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, output: `${out}${err}`.trim() };
	} catch (error) {
		return { exitCode: 127, output: error instanceof Error ? error.message : String(error) };
	}
};

export type EnsureDexDeps = {
	session: AdbSession;
	adb: string;
	serial: string;
	push?: PushDex;
	dex?: UiadDex;
	log?: Logger;
};

/** The dex is on the device (written now if it was not); the result is its path. */
export async function ensureUiadDex(deps: EnsureDexDeps): DriverResult<string> {
	const dex = deps.dex ?? UIAD_DEX;
	const path = uiadDevicePath(dex);
	const present = await deps.session.run(uiadPresentCommand(path, dex.bytes));
	if (present.success && present.data.stdout.includes("present")) return { success: true, data: path };
	const push = deps.push ?? bunPushDex;
	const wrote = await push(uiadInstallArgv(deps.adb, deps.serial, path), Buffer.from(dex.base64, "base64"));
	if (wrote.exitCode !== 0) {
		return driverErr("E_IO", `cannot write warden-uiad to ${deps.serial}:${path}: ${wrote.output.slice(0, 200)}`);
	}
	deps.log?.(`uiad: wrote ${dex.bytes} B to ${path}`);
	return { success: true, data: path };
}

// ---------- who holds the UiAutomation slot ----------

export type Holder = {
	pid: number;
	args: string;
	/** a `warden-uiad` process: a server of ours that nobody is talking to any more */
	ours: boolean;
};

export const HOLDERS_COMMAND = "ps -A -o PID,ARGS";

const FOREIGN_HOLDER = /\binstrument\b|uiautomator|UiAutomation/;

/**
 * The processes in `ps -A -o PID,ARGS` output that can hold the one UiAutomation slot: a `warden-uiad` server (ours),
 * an `am instrument` run (Maestro's driver, agent-device's helper, any test runner) or a `uiautomator` command.
 */
export function parseHolders(ps: string): Holder[] {
	const holders: Holder[] = [];
	for (const line of ps.split("\n")) {
		const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
		const pid = Number(match?.[1]);
		const args = match?.[2];
		if (args === undefined || Number.isNaN(pid)) continue;
		if (args.includes(UIAD_MAIN_CLASS)) holders.push({ pid, args, ours: true });
		else if (FOREIGN_HOLDER.test(args) && !args.startsWith("ps ")) holders.push({ pid, args, ours: false });
	}
	return holders;
}

/** What the failure says when the slot is taken by something that is not ours. */
export function busyError(serial: string, holders: readonly Holder[], cause: DriverError): DriverError {
	const named = holders.length > 0 ? holders.map((h) => `pid ${h.pid}: ${h.args}`).join("; ") : "an unknown process";
	return driverError(
		"E_AX_UNAVAILABLE",
		`another UiAutomation client holds ${serial} (${named}); warden will not touch it. Stop it, or release the device.`,
		{
			retryable: false,
			detail: { reason: "uiautomation_busy", holders, cause: cause.message },
		}
	);
}

export type LaunchDeps = EnsureDexDeps & {
	spawn?: SimdSpawn;
	readyTimeoutMs?: number;
	requestTimeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
};

const STALE_KILL_SETTLE_MS = 300;

/**
 * Start `warden-uiad` on `serial` and wait for it to be ready. A busy slot is the one failure handled here: servers of
 * ours still running (a host that died without its pipe closing, a second warden process on the same device) are
 * killed and the start retried once; a foreign holder is named in the error and left alone.
 */
export async function launchUiad(deps: LaunchDeps): DriverResult<UiadClient> {
	const ensured = await ensureUiadDex(deps);
	if (!ensured.success) return ensured;
	const cmd = uiadLaunchArgv(deps.adb, deps.serial, ensured.data);
	const start = () =>
		startUiad({
			cmd,
			...(deps.spawn ? { spawn: deps.spawn } : {}),
			...(deps.log ? { log: deps.log } : {}),
			...(deps.readyTimeoutMs !== undefined ? { readyTimeoutMs: deps.readyTimeoutMs } : {}),
			...(deps.requestTimeoutMs !== undefined ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
		});
	const first = await start();
	if (first.success || !isBusy(first.error)) return first;

	const listed = await deps.session.run(HOLDERS_COMMAND);
	const holders = listed.success ? parseHolders(listed.data.stdout) : [];
	const stale = holders.filter((h) => h.ours);
	if (stale.length === 0 || holders.some((h) => !h.ours))
		return { success: false, error: busyError(deps.serial, holders, first.error) };
	deps.log?.(`uiad: ${deps.serial} is held by our own server (pid ${stale.map((h) => h.pid).join(", ")}); killing it`);
	await deps.session.run(`kill ${stale.map((h) => h.pid).join(" ")}`);
	await (deps.sleep ?? Bun.sleep)(STALE_KILL_SETTLE_MS);
	const second = await start();
	if (second.success || !isBusy(second.error)) return second;
	const again = await deps.session.run(HOLDERS_COMMAND);
	return {
		success: false,
		error: busyError(deps.serial, again.success ? parseHolders(again.data.stdout) : [], second.error),
	};
}

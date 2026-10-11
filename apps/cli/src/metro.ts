import { realpathSync } from "node:fs";
import type { Exec } from "@delacour/warden-core/exec";
import type { Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { z } from "zod";

/**
 * One owned Metro per run, shared by `warden dev` and `warden e2e`: spawn `expo start` on a leased
 * port, call it ready only once the server on that port is proven to serve this project root (a
 * port can answer for another worktree's Metro), prewarm the bundle, stop it on exit.
 */

export type MetroSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export type MetroProc = { exited: Promise<number>; kill: (signal: MetroSignal) => void };

/** Side effects of the Metro helper, injectable for tests (HTTP goes through `fetch`). */
export type MetroDeps = {
	/** who serves this port, relative to the project root (default: `metroOwner`) */
	probe: (port: number, projectRoot: string) => Promise<MetroOwner>;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	spawn: (cmd: string[], env: Record<string, string | undefined>, cwd: string) => MetroProc;
};

/** Who answers on a Metro port, relative to one project root. */
export type MetroOwner =
	| { kind: "ours" }
	/** a Metro of another checkout */
	| { kind: "foreign"; root: string }
	/** a Metro whose project root could not be established */
	| { kind: "unknown" }
	/** something answers, but not Metro's `/status` */
	| { kind: "not-metro" }
	| { kind: "down" };

const STATUS_RUNNING = "packager-status:running";
const ROOT_HEADER = "X-React-Native-Project-Root";
const PROBE_TIMEOUT_MS = 2_000;
const READY_POLL_MS = 500;
const KILL_GRACE_MS = 15_000;
/** A cold bundle of a large app. */
const PREWARM_TIMEOUT_MS = 5 * 60_000;

/** The URL a simulator (or an emulator behind `adb reverse`) reaches Metro on. */
export function metroUrl(port: number): string {
	return `http://127.0.0.1:${port}`;
}

/** `expo start` for a dev client on `port`, plus the caller's extra args. */
export function metroArgv(port: number, extra: readonly string[] = []): string[] {
	return ["bunx", "expo", "start", "--dev-client", "--port", String(port), ...extra];
}

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

const sameDir = (a: string, b: string) => real(a) === real(b);

function decodeRoot(header: string): string {
	try {
		return decodeURI(header);
	} catch {
		return header;
	}
}

/** cwd of the process listening on `port` (`lsof`), when it can be read. */
async function listenerCwd(exec: Exec, port: number): Promise<string | undefined> {
	const pids = await exec(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
	const pid = pids.exitCode === 0 ? pids.stdout.split("\n").find((line) => /^\d+$/.test(line.trim())) : undefined;
	if (pid === undefined) return undefined;
	const cwd = await exec(["lsof", "-a", "-p", pid.trim(), "-d", "cwd", "-Fn"]);
	if (cwd.exitCode !== 0) return undefined;
	return cwd.stdout
		.split("\n")
		.find((line) => line.startsWith("n"))
		?.slice(1);
}

/**
 * Who serves `port`: Metro's `/status` must say it is running, and its project root (the
 * `X-React-Native-Project-Root` header, else the listening pid's cwd) must be `projectRoot`.
 */
export async function metroOwner(exec: Exec, port: number, projectRoot: string): Promise<MetroOwner> {
	let res: Response;
	try {
		res = await fetch(`${metroUrl(port)}/status`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
	} catch {
		return { kind: "down" };
	}
	const body = await res.text().catch(() => "");
	if (!body.includes(STATUS_RUNNING)) return { kind: "not-metro" };
	const header = res.headers.get(ROOT_HEADER);
	const root = header ? decodeRoot(header) : await listenerCwd(exec, port);
	if (root === undefined || root === "") return { kind: "unknown" };
	return sameDir(root, projectRoot) ? { kind: "ours" } : { kind: "foreign", root };
}

export type MetroOptions = {
	projectRoot: string;
	/** a port the caller holds a lease on */
	port: number;
	env: Record<string, string | undefined>;
	/** extra `expo start` args */
	args?: readonly string[];
	readyTimeoutMs: number;
	/** checked while waiting (SIGINT) */
	aborted?: () => boolean;
};

export type Metro = {
	port: number;
	url: string;
	proc: MetroProc;
	/** SIGTERM, then SIGKILL after the grace period; resolves once it is gone */
	stop: () => Promise<void>;
};

/** SIGTERM `proc`, SIGKILL after the grace period. */
export async function stopMetro(deps: Pick<MetroDeps, "sleep">, proc: MetroProc): Promise<void> {
	const exited = proc.exited.then(() => true);
	const waitExit = () => Promise.race([exited, deps.sleep(KILL_GRACE_MS).then(() => false)]);
	proc.kill("SIGTERM");
	if (await waitExit()) return;
	proc.kill("SIGKILL");
	await waitExit();
}

/** Why the wait for Metro ended without it being ours (`exited`: nothing left to stop). */
type WaitFailure = { error: string; exited?: true };

function timeoutError(o: MetroOptions, unverified: boolean): string {
	const waited = `${Math.round(o.readyTimeoutMs / 1000)}s`;
	return unverified
		? `could not verify that the Metro on :${o.port} serves ${o.projectRoot} within ${waited} (no ${ROOT_HEADER} header, no listener cwd)`
		: `Metro did not answer on :${o.port} within ${waited}`;
}

/** Poll until the port is verified to serve this root; a foreign Metro fails at once. */
async function waitForOurs(
	deps: MetroDeps,
	o: MetroOptions,
	exitCode: () => number | undefined
): Promise<WaitFailure | undefined> {
	const deadline = deps.now() + o.readyTimeoutMs;
	for (;;) {
		if (o.aborted?.()) return { error: "interrupted while waiting for Metro" };
		const owner = await deps.probe(o.port, o.projectRoot);
		if (owner.kind === "ours") return undefined;
		if (owner.kind === "foreign")
			return { error: `port ${o.port} is served by ${owner.root}, not this worktree (${o.projectRoot})` };
		await Promise.resolve();
		const code = exitCode();
		if (code !== undefined) return { error: `Metro exited (${code}) before it was ready`, exited: true };
		if (deps.now() >= deadline) return { error: timeoutError(o, owner.kind === "unknown") };
		await deps.sleep(READY_POLL_MS);
	}
}

/**
 * Start Metro for `projectRoot` on `port` and wait until that port is verified to serve this root.
 * On any failure the spawned Metro is stopped.
 */
export async function startMetro(deps: MetroDeps, o: MetroOptions): AsyncResult<Metro> {
	let proc: MetroProc;
	try {
		proc = deps.spawn(metroArgv(o.port, o.args), { ...o.env, EXPO_NO_TELEMETRY: "1" }, o.projectRoot);
	} catch (error) {
		return err(`could not start Metro: ${error instanceof Error ? error.message : String(error)}`);
	}
	let exitCode: number | undefined;
	void proc.exited.then((code) => {
		exitCode = code;
	});
	const failure = await waitForOurs(deps, o, () => exitCode);
	if (failure) {
		if (!failure.exited) await stopMetro(deps, proc);
		return err(failure.error);
	}
	return ok({ port: o.port, url: metroUrl(o.port), proc, stop: () => stopMetro(deps, proc) });
}

const manifestSchema = z.object({ launchAsset: z.object({ url: z.string().min(1) }) });

/**
 * Build the `platform` bundle once before any device asks for it (the first request is the slow
 * one). No readable manifest → `bundled: false` (nothing to warm); a bundle Metro cannot build is
 * an error carrying Metro's message, since every flow would hit it.
 */
export async function prewarmMetro(url: string, platform: Platform): AsyncResult<{ bundled: boolean }> {
	let bundleUrl: string;
	try {
		const res = await fetch(`${url}/`, {
			headers: { "expo-platform": platform, accept: "application/expo+json,application/json" },
			signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
		});
		const manifest = manifestSchema.safeParse(await res.json());
		if (!res.ok || !manifest.success) return ok({ bundled: false });
		bundleUrl = manifest.data.launchAsset.url;
	} catch {
		return ok({ bundled: false });
	}
	try {
		const res = await fetch(bundleUrl, { signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS) });
		const body = await res.text();
		if (res.ok) return ok({ bundled: true });
		const detail = body.trim().split("\n").slice(0, 3).join(" | ").slice(0, 600);
		return err(`Metro could not build the ${platform} bundle (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
	} catch (error) {
		return err(`Metro bundle request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Relaunch the iOS dev client pointed at Metro. `--initialUrl` is read by expo-dev-launcher at
 * start, unlike `simctl openurl`, which raises an "Open in …?" alert on the device.
 */
export function devClientLaunchArgv(
	udid: string,
	bundleId: string,
	url: string,
	launchArgs: readonly string[] = []
): string[] {
	return [
		"xcrun",
		"simctl",
		"launch",
		"--terminate-running-process",
		udid,
		bundleId,
		"--initialUrl",
		url,
		...launchArgs,
	];
}

/** Android: make the host's Metro port reachable as 127.0.0.1 on the device. */
export function adbReverseArgv(serial: string, port: number): string[] {
	return ["adb", "-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`];
}

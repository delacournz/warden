import { existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import type { AppFramework } from "@delacour/warden-core/builds/native-ids";
import { type Exec, execError } from "@delacour/warden-core/exec";
import type { GitFacts } from "@delacour/warden-core/git-facts";
import { findNodeBin } from "@delacour/warden-core/node-bin";
import type { Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";

/**
 * One owned Metro per run, shared by `warden dev` and `warden e2e`: spawn `expo start` on a leased
 * port, call it ready only once the server on that port is proven to serve this project root (a
 * port can answer for another worktree's Metro), prewarm the bundle, stop it on exit.
 */

export type MetroSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGKILL";

/** The Metro PTY, as a ui drives it: keys in, size changes. */
export type MetroTerminal = {
	write(data: string | Uint8Array): void;
	resize(cols: number, rows: number): void;
};

/** A spawned Metro. `terminal` is set only when it runs in a PTY (`warden dev` TUI); pipe-based spawns (`warden e2e`) have none. */
export type MetroProc = {
	exited: Promise<number>;
	kill: (signal: MetroSignal) => void;
	terminal?: MetroTerminal;
};

/** Side effects of the Metro helper, injectable for tests (HTTP goes through `fetch`). */
export type MetroDeps = {
	/** who serves this port, relative to the project root (default: `metroOwner`) */
	probe: (port: number, projectRoot: string) => Promise<MetroOwner>;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	spawn: (cmd: string[], env: Record<string, string | undefined>, cwd: string) => MetroProc;
	/** the project's own `expo` bin, when it can be run directly (default: none, so `bunx expo`) */
	expoBin?: (projectRoot: string) => string | undefined;
	/** the project's own `react-native` bin, for a bare app (default: none, so `npx react-native`) */
	reactNativeBin?: (projectRoot: string) => string | undefined;
	/** git facts of the project root, for `worktreeEnv` (default: none, so no `WARDEN_WORKTREE`) */
	git?: (projectRoot: string) => GitFacts | undefined;
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
/** Metro takes seconds to come up, so a short poll costs nothing and ends the wait up to 350 ms sooner. */
export const READY_POLL_MS = 150;
const KILL_GRACE_MS = 15_000;
/** A cold bundle of a large app. */
const PREWARM_TIMEOUT_MS = 5 * 60_000;

/** The URL a simulator (or an emulator behind `adb reverse`) reaches Metro on. */
export function metroUrl(port: number): string {
	return `http://127.0.0.1:${port}`;
}

/**
 * `expo start` for a dev client on `port`, plus the caller's extra args; `react-native start` for a bare
 * React Native app. `bin` (the project's own `node_modules/.bin/expo` / `react-native`) runs directly;
 * without it `bunx expo` / `npx react-native` resolves the bin first.
 */
export function metroArgv(
	port: number,
	extra: readonly string[] = [],
	bin?: string,
	framework: AppFramework = "expo"
): string[] {
	if (framework === "react-native") {
		const start = ["start", "--port", String(port), ...extra];
		return bin === undefined ? ["npx", "react-native", ...start] : [bin, ...start];
	}
	const start = ["start", "--dev-client", "--port", String(port), ...extra];
	return bin === undefined ? ["bunx", "expo", ...start] : [bin, ...start];
}

/**
 * The `node_modules/.bin/expo` nearest to `root`, when `node` is installed to run its shebang (bunx
 * supplies its own otherwise); undefined → `bunx expo`. Saves bunx's resolution on every Metro start.
 */
export function resolveExpoBin(
	root: string,
	which: (cmd: string) => string | null | undefined,
	exists: (path: string) => boolean = existsSync
): string | undefined {
	return which("node") ? findNodeBin(root, "expo", exists) : undefined;
}

/** `resolveExpoBin` for any package bin (`react-native` for a bare app). */
export function resolveNodeBin(
	root: string,
	name: string,
	which: (cmd: string) => string | null | undefined,
	exists: (path: string) => boolean = existsSync
): string | undefined {
	return which("node") ? findNodeBin(root, name, exists) : undefined;
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
	/** `react-native` = a bare app: `react-native start` instead of `expo start --dev-client` (default expo) */
	framework?: AppFramework;
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
 * What Metro learns about its checkout: `WARDEN_WORKTREE` (the checkout dir) and `WARDEN_BRANCH`
 * (absent on a detached HEAD), so `app.config.ts` can name the dev server after the worktree in the
 * dev client's launcher. Metro-only: a native build never sees them, so the fingerprint is unchanged.
 */
export function worktreeEnv(facts: GitFacts | undefined): Record<string, string> {
	if (facts === undefined) return {};
	return {
		WARDEN_WORKTREE: basename(facts.toplevel),
		...(facts.branch === "" ? {} : { WARDEN_BRANCH: facts.branch }),
	};
}

/**
 * Start Metro for `projectRoot` on `port` and wait until that port is verified to serve this root.
 * On any failure the spawned Metro is stopped.
 */
export async function startMetro(deps: MetroDeps, o: MetroOptions): AsyncResult<Metro> {
	let proc: MetroProc;
	try {
		proc = deps.spawn(
			o.framework === "react-native"
				? metroArgv(o.port, o.args, deps.reactNativeBin?.(o.projectRoot), "react-native")
				: metroArgv(o.port, o.args, deps.expoBin?.(o.projectRoot)),
			{ ...o.env, ...worktreeEnv(deps.git?.(o.projectRoot)), EXPO_NO_TELEMETRY: "1" },
			o.projectRoot
		);
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

/** A Metro being started in the background; see `launchMetro`. */
export type MetroLaunchHandle = {
	/** settles once Metro is verified ready or failed; never rejects */
	pending: Promise<Result<Metro>>;
	/** set once ready */
	started: Metro | undefined;
	/** give up waiting, settle, stop whatever started */
	stop: () => Promise<void>;
};

/**
 * `startMetro` without waiting: the caller carries on (device claim, app install) and awaits
 * `pending` later. `stop` cancels the readiness poll, so a Metro that never became ready is
 * killed by `startMetro` itself, and stops one that did.
 */
export function launchMetro(deps: MetroDeps, o: MetroOptions): MetroLaunchHandle {
	let cancelled = false;
	const handle: MetroLaunchHandle = {
		started: undefined,
		pending: Promise.resolve(err("Metro not started")),
		stop: async () => {
			cancelled = true;
			await handle.pending;
			const metro = handle.started;
			handle.started = undefined;
			await metro?.stop();
		},
	};
	handle.pending = startMetro(deps, { ...o, aborted: () => cancelled || (o.aborted?.() ?? false) })
		.catch((error: unknown) => err(error instanceof Error ? error.message : String(error)))
		.then((result) => {
			if (result.success) handle.started = result.data;
			return result;
		});
	return handle;
}

/** The manifest's `launchAsset.url` (non-empty), else undefined. Hand-written: no zod on `dev`'s start path (15-2). */
function launchAssetUrl(manifest: unknown): string | undefined {
	const asset =
		typeof manifest === "object" && manifest !== null && !Array.isArray(manifest) && "launchAsset" in manifest
			? manifest.launchAsset
			: undefined;
	if (typeof asset !== "object" || asset === null || Array.isArray(asset) || !("url" in asset)) return undefined;
	return typeof asset.url === "string" && asset.url.length > 0 ? asset.url : undefined;
}

/**
 * Build the `platform` bundle once before any device asks for it (the first request is the slow
 * one). No readable manifest → `bundled: false` (nothing to warm); a bundle Metro cannot build is
 * an error carrying Metro's message, since every spec would hit it. `signal` (a Ctrl-C, a failed
 * claim) ends either request at once, as an error (12-5).
 */
export async function prewarmMetro(
	url: string,
	platform: Platform,
	signal?: AbortSignal
): AsyncResult<{ bundled: boolean }> {
	const bounded = () =>
		signal
			? AbortSignal.any([signal, AbortSignal.timeout(PREWARM_TIMEOUT_MS)])
			: AbortSignal.timeout(PREWARM_TIMEOUT_MS);
	const interrupted = err(`interrupted while building the ${platform} bundle`);
	let bundleUrl: string;
	try {
		const res = await fetch(`${url}/`, {
			headers: { "expo-platform": platform, accept: "application/expo+json,application/json" },
			signal: bounded(),
		});
		const assetUrl = launchAssetUrl(await res.json());
		if (!res.ok || assetUrl === undefined) return ok({ bundled: false });
		bundleUrl = assetUrl;
	} catch {
		return signal?.aborted ? interrupted : ok({ bundled: false });
	}
	try {
		const res = await fetch(bundleUrl, { signal: bounded() });
		const body = await res.text();
		if (res.ok) return ok({ bundled: true });
		const detail = body.trim().split("\n").slice(0, 3).join(" | ").slice(0, 600);
		return err(`Metro could not build the ${platform} bundle (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
	} catch (error) {
		if (signal?.aborted) return interrupted;
		return err(`Metro bundle request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * The app-side launch arguments that point a dev client at Metro. `--initialUrl` is read by
 * expo-dev-launcher at start, unlike `simctl openurl`, which raises an "Open in …?" alert on the device.
 */
export function devClientLaunchArgs(url: string, launchArgs: readonly string[] = []): string[] {
	return ["--initialUrl", url, ...launchArgs];
}

/** Relaunch the iOS dev client pointed at Metro (see `devClientLaunchArgs`). */
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
		...devClientLaunchArgs(url, launchArgs),
	];
}

/** Android: make the host's Metro port reachable as 127.0.0.1 on the device. */
/**
 * Point a bare React Native app (no dev client) at the Metro on `port`. iOS: relaunch it with
 * `-RCT_jsLocation host:port`, which `RCTBundleURLProvider` reads from the defaults argument domain.
 * Android: the debug app asks for 8081, so the device's 8081 is reversed to `port`, then the app is
 * restarted through its launcher activity.
 */
export function bareAppLaunchArgvs(platform: Platform, deviceId: string, bundleId: string, port: number): string[][] {
	if (platform === "ios")
		return [
			[
				"xcrun",
				"simctl",
				"launch",
				"--terminate-running-process",
				deviceId,
				bundleId,
				"-RCT_jsLocation",
				`127.0.0.1:${port}`,
			],
		];
	const adb = ["adb", "-s", deviceId];
	return [
		[...adb, "reverse", "tcp:8081", `tcp:${port}`],
		[...adb, "shell", "am", "force-stop", bundleId],
		[...adb, "shell", "monkey", "-p", bundleId, "-c", "android.intent.category.LAUNCHER", "1"],
	];
}

export function adbReverseArgv(serial: string, port: number): string[] {
	return ["adb", "-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`];
}

/** How long a reverse retry waits for the device to come back (adbd restarting just after boot). */
const ADB_WAIT_MS = 30_000;

/**
 * `adb reverse` the Metro port onto the device, retried once after `adb wait-for-device` (bounded):
 * a device that still cannot reach Metro is an error, since every spec on it would time out (12-7).
 */
export async function reverseMetroPort(exec: Exec, serial: string, port: number): AsyncResult<void> {
	const argv = adbReverseArgv(serial, port);
	if ((await exec(argv)).exitCode === 0) return ok(undefined);
	await exec(["adb", "-s", serial, "wait-for-device"], { timeoutMs: ADB_WAIT_MS });
	const again = await exec(argv);
	return again.exitCode === 0 ? ok(undefined) : err(execError(argv, again));
}

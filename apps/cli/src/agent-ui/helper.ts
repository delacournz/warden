import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseDuration } from "@delacour/warden-core/duration";
import { type PidAlive, processAlive } from "@delacour/warden-core/liveness";
import { wardenHome } from "@delacour/warden-core/store";
import type { Driver, DriverError } from "@delacour/warden-e2e/driver/driver.types";
import { openIosDriver, resolveHelper } from "@delacour/warden-e2e/driver/ios/ios-driver";
import { connectSimd, type SimdClient } from "@delacour/warden-e2e/driver/ios/simd-client";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { driverUiError } from "./driver";
import { type UiError, uiError } from "./output";
import { readState, type UiState, writeState } from "./state";

/** How long a caller waits for a helper (its own spawn or another caller's) to start answering. */
export const SPAWN_WAIT_MS = 5000;
/** `stopHelper` waits this long for the socket to vanish after `shutdown`, then SIGTERMs the pid. */
export const SHUTDOWN_WAIT_MS = 2000;
const POLL_MS = 100;
const STOP_POLL_MS = 50;
const SHUTDOWN_REQUEST_MS = 250;
const KILL_WAIT_MS = 250;
/** a `simd_spawn:<udid>` row older than this belongs to a spawner that hung or died */
const ROW_STALE_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT = "10m";
/** sun_path is 104 bytes on macOS; stay clear of it */
const MAX_SOCKET_PATH = 100;

export type SpawnSpec = { cmd: string[]; logPath: string };

/** Everything impure about the helper lifecycle; tests replace pieces (clock, spawn, connect, kill). */
export type HelperDeps = {
	connect: (socketPath: string) => Promise<Result<SimdClient, DriverError>>;
	/** start the helper detached from this process (no stdio, survives our exit) */
	spawnDetached: (spec: SpawnSpec) => { pid: number };
	pidAlive: PidAlive;
	kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	sleep: (ms: number) => Promise<void>;
	/** wall clock for deadlines and spawn-row ages (not `ctx.now`, which tests freeze) */
	now: () => number;
	/** own pid, written into the spawn row so a crashed spawner is noticed */
	pid: number;
};

export const defaultHelperDeps: HelperDeps = {
	connect: (socketPath) => connectSimd({ socketPath, readyTimeoutMs: 2000, defaultTimeoutMs: 5000 }),
	spawnDetached: ({ cmd, logPath }) => {
		const log = openSync(logPath, "a");
		try {
			const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: log, stderr: log, detached: true });
			proc.unref();
			return { pid: proc.pid };
		} finally {
			closeSync(log);
		}
	},
	pidAlive: processAlive,
	kill: (pid, signal) => {
		try {
			process.kill(pid, signal);
		} catch {
			// already gone
		}
	},
	sleep: (ms) => Bun.sleep(ms),
	now: () => Date.now(),
	pid: process.pid,
};

/** The slice of a command context the helper lifecycle needs. */
export type HelperHost = Pick<CommandContext, "env" | "now"> & Partial<Pick<CommandContext, "store" | "exec">>;

export function simdDir(host: Pick<CommandContext, "env">): string {
	return join(wardenHome(host.env), "simd");
}

/**
 * `$WARDEN_HOME/simd/<udid>.sock`. A unix socket path must fit in 104 bytes, so when `$WARDEN_HOME` is
 * deep (temp dirs) the socket goes to a short per-home path under `/tmp` instead; `state.json` records
 * whichever was used.
 */
export function socketPathFor(host: Pick<CommandContext, "env">, udid: string): string {
	const preferred = join(simdDir(host), `${udid}.sock`);
	if (Buffer.byteLength(preferred) < MAX_SOCKET_PATH) return preferred;
	const tag = Bun.hash(wardenHome(host.env)).toString(36).slice(0, 8);
	return join(process.platform === "darwin" ? "/tmp" : tmpdir(), `wsimd-${tag}-${udid.slice(0, 8)}.sock`);
}

export type HelperInfo = { socketPath: string; pid?: number; spawned: boolean };

export type EnsureHelperOptions = {
	helperPath?: string;
	socketPath?: string;
	/** `10m`-style; the helper exits after this long without a client */
	idleTimeout?: string;
	deps?: HelperDeps;
};

const rowKey = (udid: string) => `simd_spawn:${udid}`;

type SpawnRow = { pid: number; at: number };

function parseRow(text: string | undefined): SpawnRow | undefined {
	if (text === undefined) return undefined;
	try {
		const raw: unknown = JSON.parse(text);
		if (typeof raw === "object" && raw !== null && "pid" in raw && "at" in raw) {
			const { pid, at } = raw;
			if (typeof pid === "number" && typeof at === "number") return { pid, at };
		}
	} catch {
		// a torn row counts as stale
	}
	return undefined;
}

/** Take the right to spawn this device's helper: true if nobody else holds a live, recent row. Atomic across processes. */
function claimSpawnRow(
	host: Required<Pick<HelperHost, "store">> & HelperHost,
	udid: string,
	deps: HelperDeps
): boolean {
	const store = host.store();
	return store.transaction(() => {
		const current = parseRow(store.getMeta(rowKey(udid)));
		const now = deps.now();
		const live = current !== undefined && now - current.at < ROW_STALE_MS && deps.pidAlive(current.pid);
		if (live) return false;
		store.setMeta(rowKey(udid), JSON.stringify({ pid: deps.pid, at: now } satisfies SpawnRow));
		return true;
	});
}

function releaseSpawnRow(host: Required<Pick<HelperHost, "store">> & HelperHost, udid: string, deps: HelperDeps): void {
	const store = host.store();
	store.transaction(() => {
		const current = parseRow(store.getMeta(rowKey(udid)));
		if (current === undefined || current.pid === deps.pid) store.deleteMeta(rowKey(udid));
	});
}

function idleSeconds(idleTimeout: string): Result<number, UiError> {
	const ms = parseDuration(idleTimeout);
	if (!ms.success) return { success: false, error: uiError("usage", `idle timeout: ${ms.error}`) };
	return ok(Math.max(1, Math.round(ms.data / 1000)));
}

function logTail(logPath: string): string {
	try {
		return readFileSync(logPath, "utf8").trim().split("\n").slice(-3).join(" | ");
	} catch {
		return "";
	}
}

function unlinkQuietly(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// not there
	}
}

function unavailable(message: string, hint?: string): { success: false; error: UiError } {
	return { success: false, error: uiError("engine_unavailable", message, hint === undefined ? {} : { hint }) };
}

type Spawned = { pid: number };

/** Start the helper for `udid` (the caller holds the spawn row) and remember `{pid, socket}` in `state.json`. */
function spawnHelper(
	host: HelperHost,
	udid: string,
	socketPath: string,
	opts: EnsureHelperOptions,
	deps: HelperDeps,
	logPath: string
): Result<Spawned, UiError> {
	const idle = idleSeconds(opts.idleTimeout ?? DEFAULT_IDLE_TIMEOUT);
	if (!idle.success) return idle;
	const located = resolveHelper({
		udid,
		exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
		...(opts.helperPath !== undefined ? { helperPath: opts.helperPath } : {}),
		env: { simd: host.env.WARDEN_SIMD, simdSocket: undefined, helperDir: host.env.WARDEN_HELPER_DIR },
		wardenHome: wardenHome(host.env),
	});
	if (!located.success) return { success: false, error: driverUiError(located.error) };
	const resources = join(located.data, "..", "Resources");
	const cmd = [
		located.data,
		"--udid",
		udid,
		"--socket",
		socketPath,
		"--idle-timeout",
		String(idle.data),
		...(existsSync(resources) ? ["--resources", resources] : []),
	];
	unlinkQuietly(socketPath);
	const { pid } = deps.spawnDetached({ cmd, logPath });
	const state = readState(host, udid);
	writeState(host, udid, { ...state, helper: { pid, socket: socketPath } });
	return ok({ pid });
}

/**
 * Make sure a `warden-simd` daemon answers on the device's socket, spawning one if not. Callers race
 * safely: the `simd_spawn:<udid>` row (taken under `store.transaction`) lets exactly one spawn while the
 * rest keep polling the socket (≤ 5 s); a spawner that dies leaves a stale row the next caller takes over.
 */
export async function ensureHelper(
	host: HelperHost & Required<Pick<HelperHost, "store">>,
	udid: string,
	opts: EnsureHelperOptions = {}
): Promise<Result<HelperInfo, UiError>> {
	const deps = opts.deps ?? defaultHelperDeps;
	const socketPath = opts.socketPath ?? socketPathFor(host, udid);
	mkdirSync(dirname(socketPath), { recursive: true });
	mkdirSync(simdDir(host), { recursive: true });
	const logPath = join(simdDir(host), `${udid}.log`);
	const started = deps.now();
	let spawned: Spawned | undefined;
	try {
		for (;;) {
			const attached = await deps.connect(socketPath);
			if (attached.success) {
				await attached.data.close();
				return ok({ socketPath, spawned: spawned !== undefined, ...(spawned ? { pid: spawned.pid } : {}) });
			}
			if (spawned === undefined && claimSpawnRow(host, udid, deps)) {
				// the previous holder may have finished between our failed connect and our claim: look again before replacing its socket
				const again = await deps.connect(socketPath);
				if (again.success) {
					await again.data.close();
					return ok({ socketPath, spawned: false });
				}
				const began = spawnHelper(host, udid, socketPath, opts, deps, logPath);
				if (!began.success) return began;
				spawned = began.data;
			} else if (spawned !== undefined && !deps.pidAlive(spawned.pid)) {
				const tail = logTail(logPath);
				return unavailable(
					`warden-simd exited before it was ready${tail ? `: ${tail}` : ""}`,
					`see ${logPath}; run \`warden doctor\` to check the iOS driver helper`
				);
			}
			if (deps.now() - started >= SPAWN_WAIT_MS) {
				return unavailable(`warden-simd did not answer on ${socketPath} within ${SPAWN_WAIT_MS} ms`, `see ${logPath}`);
			}
			await deps.sleep(POLL_MS);
		}
	} finally {
		if (spawned !== undefined || host.store().getMeta(rowKey(udid)) !== undefined) releaseSpawnRow(host, udid, deps);
	}
}

/** The iOS `Driver` for a leased simulator, over its (possibly just-spawned) helper daemon. Closing it only disconnects. */
export async function connectHelper(
	ctx: CommandContext,
	udid: string,
	opts: EnsureHelperOptions = {}
): Promise<Result<Driver, UiError>> {
	const helper = await ensureHelper(ctx, udid, opts);
	if (!helper.success) return helper;
	const driver = await openIosDriver({
		udid,
		exec: ctx.exec,
		socketPath: helper.data.socketPath,
		...(opts.helperPath !== undefined ? { helperPath: opts.helperPath } : {}),
		now: ctx.now,
	});
	return driver.success ? driver : { success: false, error: driverUiError(driver.error) };
}

export type StopOutcome = { stopped: boolean; how: "none" | "shutdown" | "sigterm" };

async function waitUntil(done: () => boolean, ms: number, deps: HelperDeps): Promise<boolean> {
	const until = deps.now() + ms;
	while (!done()) {
		if (deps.now() >= until) return false;
		await deps.sleep(STOP_POLL_MS);
	}
	return true;
}

/**
 * Stop a device's helper and forget it. Idempotent: nothing running is a no-op. Sends `shutdown`, waits
 * ≤ 2 s for the socket to vanish (or the recorded pid to die), else SIGTERMs the pid; then unlinks the
 * socket and drops `helper` from `state.json`. Never throws.
 */
export async function stopHelper(
	host: Pick<CommandContext, "env" | "now">,
	udid: string,
	opts: { socketPath?: string; deps?: HelperDeps } = {}
): Promise<StopOutcome> {
	const deps = opts.deps ?? defaultHelperDeps;
	try {
		const state = readState(host, udid);
		const record = state.helper;
		const socketPath = opts.socketPath ?? record?.socket ?? socketPathFor(host, udid);
		const running = existsSync(socketPath) || (record !== undefined && deps.pidAlive(record.pid));
		if (!running) {
			forgetHelper(host, udid, state);
			return { stopped: false, how: "none" };
		}
		const gone = () => !existsSync(socketPath) || (record !== undefined && !deps.pidAlive(record.pid));
		const attached = await deps.connect(socketPath);
		if (attached.success) {
			await attached.data.request("shutdown", {}, { timeoutMs: SHUTDOWN_REQUEST_MS });
			await attached.data.close();
		}
		let how: StopOutcome["how"] = "shutdown";
		if (!(await waitUntil(gone, SHUTDOWN_WAIT_MS - (attached.success ? SHUTDOWN_REQUEST_MS : 0), deps))) {
			how = "sigterm";
			if (record !== undefined) deps.kill(record.pid, "SIGTERM");
			await waitUntil(gone, KILL_WAIT_MS, deps);
		}
		unlinkQuietly(socketPath);
		forgetHelper(host, udid, readState(host, udid));
		return { stopped: true, how };
	} catch {
		return { stopped: false, how: "none" };
	}
}

function forgetHelper(host: Pick<CommandContext, "env" | "now">, udid: string, state: UiState): void {
	if (state.helper === undefined) return;
	const { helper: _helper, ...rest } = state;
	writeState(host, udid, rest);
}

/** What `warden ui status` shows for the helper. */
export type HelperStatus = { running: boolean; pid: number | null; socket: string | null };

export function helperStatus(
	host: Pick<CommandContext, "env">,
	udid: string,
	deps: Pick<HelperDeps, "pidAlive"> = defaultHelperDeps
): HelperStatus {
	const record = readState(host, udid).helper;
	if (record === undefined) return { running: false, pid: null, socket: null };
	return { running: deps.pidAlive(record.pid) && existsSync(record.socket), pid: record.pid, socket: record.socket };
}

/**
 * gc: drop helper sockets nobody serves any more. A device whose recorded helper pid is dead loses its
 * socket file and its `state.json` record; so does a `$WARDEN_HOME/simd/<udid>.sock` whose record says dead.
 * Sockets with no record at all are left alone (we can't tell whose they are). Returns removed socket paths.
 */
export function sweepDeadHelpers(
	host: Pick<CommandContext, "env" | "now">,
	deps: Pick<HelperDeps, "pidAlive"> = defaultHelperDeps
): string[] {
	const removed: string[] = [];
	const udids = new Set<string>();
	const sockDir = simdDir(host);
	if (existsSync(sockDir)) {
		for (const name of readdirSync(sockDir)) if (name.endsWith(".sock")) udids.add(basename(name, ".sock"));
	}
	const uiRoot = join(wardenHome(host.env), "ui");
	if (existsSync(uiRoot)) for (const name of readdirSync(uiRoot)) udids.add(name);
	for (const udid of udids) {
		const state = readState(host, udid);
		const record = state.helper;
		if (record === undefined || deps.pidAlive(record.pid)) continue;
		if (existsSync(record.socket)) removed.push(record.socket);
		unlinkQuietly(record.socket);
		forgetHelper(host, udid, state);
	}
	return removed;
}

import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseDuration } from "@delacour/warden-core/duration";
import { type PidAlive, processAlive } from "@delacour/warden-core/liveness";
import { type Store, wardenHome } from "@delacour/warden-core/store";
import type { Owner } from "@delacour/warden-core/types";
import type { Driver, DriverError } from "@delacour/warden-e2e/driver/driver.types";
import { resolveHelper } from "@delacour/warden-e2e/driver/ios/locate-helper";
import type { SimdClient } from "@delacour/warden-e2e/driver/ios/simd-client";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { driverUiError } from "./driver";
import { knownUdids } from "./helper-sweep";
import { type UiError, uiError } from "./output";
import { simdDir } from "./paths";
import { type HelperRecord, readState, type UiState, writeState } from "./state";

/**
 * How long a caller waits for a helper that answers the socket but not its handshake (busy) before replacing it.
 * Waiting on something live (its own still-starting child, another caller's spawn row, a busy helper) goes on up to
 * `SPAWN_LIVE_WAIT_MS`.
 */
export const SPAWN_WAIT_MS = 5000;
/** `stopHelper` waits this long for the socket to vanish after `shutdown`, then SIGTERMs the pid. */
export const SHUTDOWN_WAIT_MS = 2000;
const POLL_MS = 100;
const STOP_POLL_MS = 50;
const SHUTDOWN_REQUEST_MS = 250;
const KILL_WAIT_MS = 250;
/** a `simd_spawn:<udid>` row older than this belongs to a spawner that hung or died */
const ROW_STALE_MS = 15_000;
/** the most an `ensureHelper` call waits in all; a spawner stops the child it started when this runs out */
export const SPAWN_LIVE_WAIT_MS = ROW_STALE_MS;
/** how long `stopHelper` waits for another caller's spawn row before it stops without the row */
const STOP_ROW_WAIT_MS = 1000;
/** how long a helper with no client and no op in flight lives on (`--idle-timeout`); `$WARDEN_SIMD_IDLE_TIMEOUT` overrides */
const DEFAULT_IDLE_TIMEOUT = "10m";
export const IDLE_TIMEOUT_ENV = "WARDEN_SIMD_IDLE_TIMEOUT";
/** how long a fresh spawn may take to print its ready line before the socket poll takes over (an older helper never does) */
const SIGNAL_WAIT_MS = 1500;
/** sun_path is 104 bytes on macOS; stay clear of it */
const MAX_SOCKET_PATH = 100;

export type SpawnSpec = {
	cmd: string[];
	logPath: string;
	/** how long the child may take to print its ready line before the spawner reports `timeout` */
	signalMs: number;
};

/** What the spawner learned from the child's stdout: `up` (its socket is accepting), `closed` (stdout ended without saying so) or `timeout`. */
export type StartOutcome = "up" | "closed" | "timeout";

/** The child's stdout, watched for its ready line. `detach` stops reading (the helper has moved its output to the log by then). */
export type StartSignal = { up: Promise<StartOutcome>; detach: () => void };

export type SpawnResult = { pid: number; signal?: StartSignal };

/** Everything impure about the helper lifecycle; tests replace pieces (clock, spawn, connect, kill). */
export type HelperDeps = {
	connect: (socketPath: string) => Promise<Result<SimdClient, DriverError>>;
	/** start the helper detached from this process (survives our exit); `signal` tells when its socket is up */
	spawnDetached: (spec: SpawnSpec) => SpawnResult;
	pidAlive: PidAlive;
	kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	sleep: (ms: number) => Promise<void>;
	/** wall clock for deadlines and spawn-row ages (not `ctx.now`, which tests freeze) */
	now: () => number;
	/** own pid, written into the spawn row so a crashed spawner is noticed */
	pid: number;
	/** file existence for the helper lookup (tests make the source-tree build invisible) */
	exists?: (path: string) => boolean;
	/** modification time of the helper binary, undefined when it cannot be read (replaced helpers are detected by it) */
	mtime?: (path: string) => number | undefined;
	/** the helper binary's resolved path (symlinks followed); absent: the path as given */
	realpath?: (path: string) => string;
	/** whether the socket file is there; false skips the probe (nothing can answer). Absent: always probe */
	socketExists?: (path: string) => boolean;
};

/**
 * Watch a spawned helper's stdout for the line that says its socket is accepting: the helper's own `ready` event
 * (carries `socket`), or, from an older helper, its `listening on …` log line. Every line is appended to `logPath`
 * (stdout used to go straight to the log file). `up` settles once: `up`, `closed` when the pipe ends first, `timeout`
 * after `timeoutMs`. A current helper points its stdout at the log right after the ready line, so the pipe then
 * ends; `detach` covers an older one whose pipe would stay open.
 */
export function watchStart(
	stdout: ReadableStream<Uint8Array>,
	opts: { logPath: string; timeoutMs: number }
): StartSignal {
	let settle: (outcome: StartOutcome) => void = () => undefined;
	const up = new Promise<StartOutcome>((resolve) => {
		settle = resolve;
	});
	const timer = setTimeout(() => settle("timeout"), opts.timeoutMs);
	const reader = stdout.getReader();
	void pumpLines(
		() => reader.read(),
		(line) => {
			appendQuietly(opts.logPath, `${line}\n`);
			if (isUpLine(line)) settle("up");
		}
	).then(() => settle("closed"));
	return {
		up,
		detach: () => {
			clearTimeout(timer);
			void reader.cancel().catch(() => undefined);
		},
	};
}

type Chunk = { done: boolean; value?: Uint8Array | undefined };

/** Feed each non-blank line of a byte stream (`read` = its reader's) to `onLine` until it ends, is cancelled or breaks. */
async function pumpLines(read: () => Promise<Chunk>, onLine: (line: string) => void): Promise<void> {
	const decoder = new TextDecoder();
	let pending = "";
	try {
		for (;;) {
			const chunk = await read();
			if (chunk.done) break;
			const lines = (pending + decoder.decode(chunk.value, { stream: true })).split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) if (line.trim() !== "") onLine(line);
		}
		if (pending.trim() !== "") onLine(pending);
	} catch {
		// cancelled by detach, or the pipe broke: either way nothing more to read
	}
}

function appendQuietly(path: string, text: string): void {
	try {
		appendFileSync(path, text);
	} catch {
		// the log is best effort
	}
}

function isUpLine(line: string): boolean {
	try {
		const raw: unknown = JSON.parse(line);
		if (typeof raw !== "object" || raw === null || !("event" in raw)) return false;
		if (raw.event === "ready") return "socket" in raw && typeof raw.socket === "string";
		return (
			raw.event === "log" &&
			"message" in raw &&
			typeof raw.message === "string" &&
			raw.message.startsWith("listening on ")
		);
	} catch {
		return false;
	}
}

export const defaultHelperDeps: HelperDeps = {
	connect: async (socketPath) =>
		(await import("@delacour/warden-e2e/driver/ios/simd-client")).connectSimd({ socketPath, readyTimeoutMs: 2000 }),
	spawnDetached: ({ cmd, logPath, signalMs }) => {
		const log = openSync(logPath, "a");
		try {
			const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: log, detached: true });
			proc.unref();
			return { pid: proc.pid, signal: watchStart(proc.stdout, { logPath, timeoutMs: signalMs }) };
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
	mtime: (path) => {
		try {
			return statSync(path).mtimeMs;
		} catch {
			return undefined;
		}
	},
	realpath: (path) => {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	},
	socketExists: existsSync,
};

/** The slice of a command context the helper lifecycle needs. */
export type HelperHost = Pick<CommandContext, "env" | "now"> & Partial<Pick<CommandContext, "store" | "exec">>;

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

export type HelperInfo = {
	socketPath: string;
	pid?: number;
	spawned: boolean;
	/** the connected (handshaken) client, present with `keepClient`: the caller owns it and closes it */
	client?: SimdClient;
};

export type EnsureHelperOptions = {
	helperPath?: string;
	socketPath?: string;
	/** `10m`-style; the helper exits after this long without a client. Default `$WARDEN_SIMD_IDLE_TIMEOUT`, else 10 min */
	idleTimeout?: string;
	/** hand back the client that proved the helper is up instead of closing it, so the driver does not connect again */
	keepClient?: boolean;
	deps?: HelperDeps;
};

/** The same identity `sameOwner` compares: one agent session, one shell pid, one CI run. */
export function ownerKey(owner: Owner): string {
	switch (owner.kind) {
		case "agent":
			return `agent:${owner.sessionId}`;
		case "user":
			return `user:${owner.pid}`;
		case "ci":
			return `ci:${owner.runId}`;
	}
}

/** `WARDEN_SIMD_*` names that configure the client, not the helper process: left out of `simdEnvKey`. */
const CLIENT_ONLY_ENV = new Set(["WARDEN_SIMD", "WARDEN_SIMD_SOCKET"]);

/**
 * A hash of the `WARDEN_SIMD_*` environment a spawned helper inherits (its pacing, stream and trace knobs), so a
 * resident helper can be replaced when it was started with different settings. `WARDEN_SIMD` (which binary, compared
 * by realpath instead) and `WARDEN_SIMD_SOCKET` (a client setting) are left out.
 */
export function simdEnvKey(env: Readonly<Record<string, string | undefined>>): string {
	const entries = Object.entries(env)
		.filter((entry): entry is [string, string] => entry[0].startsWith("WARDEN_SIMD_") && entry[1] !== undefined)
		.filter(([name]) => !CLIENT_ONLY_ENV.has(name))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return Bun.hash(JSON.stringify(entries)).toString(36);
}

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

/** The device's lease right now: its id and its owner as `ownerKey`; undefined when nobody holds one. */
function currentLease(store: Store, udid: string): { id: string; owner: string } | undefined {
	const held = store.findLeaseByResource({ kind: "device", platform: "ios", id: udid, name: udid });
	return held ? { id: held.id, owner: ownerKey(held.owner) } : undefined;
}

const realPath = (deps: HelperDeps, path: string): string => deps.realpath?.(path) ?? path;

/** The helper executable `opts` / the environment point at. */
function locateHelperBinary(
	host: HelperHost,
	udid: string,
	opts: EnsureHelperOptions,
	deps: HelperDeps
): Result<string, DriverError> {
	return resolveHelper({
		udid,
		exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
		...(opts.helperPath !== undefined ? { helperPath: opts.helperPath } : {}),
		env: { simd: host.env.WARDEN_SIMD, simdSocket: undefined, helperDir: host.env.WARDEN_HELPER_DIR },
		wardenHome: wardenHome(host.env),
		...(deps.exists ? { exists: deps.exists } : {}),
	});
}

/**
 * Why the helper already answering on the socket must not be reused, or undefined to reuse it. A resident helper
 * outlives the run that started it, so it is replaced when what it runs differs from what this caller would spawn:
 * the helper binary (realpath + mtime: rebuilt, upgraded, another install) or the `WARDEN_SIMD_*` env it inherited.
 * Who holds the lease does not matter (a new shell pid per `bun run`, a new CI run id, keep the helper). A helper
 * spawned under the device's current lease is never replaced: the run it serves keeps it. A record without those
 * fields (older warden) is not guessed at: the helper is reused.
 */
function staleReason(
	host: HelperHost & Required<Pick<HelperHost, "store">>,
	udid: string,
	opts: EnsureHelperOptions,
	deps: HelperDeps
): string | undefined {
	const record = readState(host, udid).helper;
	if (record === undefined) return undefined;
	const lease = currentLease(host.store(), udid);
	if (lease !== undefined && record.lease === lease.id) return undefined;
	if (record.env !== undefined && record.env !== simdEnvKey(host.env)) {
		return "the helper's WARDEN_SIMD_* environment changed";
	}
	if (record.binary !== undefined && deps.mtime !== undefined) {
		const located = locateHelperBinary(host, udid, opts, deps);
		const path = located.success ? realPath(deps, located.data) : undefined;
		const mtime = path !== undefined ? deps.mtime(path) : undefined;
		if (
			path !== undefined &&
			mtime !== undefined &&
			(path !== realPath(deps, record.binary.path) || mtime !== record.binary.mtimeMs)
		) {
			return "the helper binary changed";
		}
	}
	return undefined;
}

/**
 * Start the helper for `udid` (the caller holds the spawn row) and remember `{pid, socket, owner, binary, env, lease}`
 * in `state.json`. Refuses while the helper recorded on this socket is alive, unless it is `stopped` (the pid the
 * caller just stopped): two helpers on one simulator fight over its quiescence stream.
 */
function spawnHelper(
	host: HelperHost & Required<Pick<HelperHost, "store">>,
	udid: string,
	socketPath: string,
	opts: EnsureHelperOptions,
	deps: HelperDeps,
	logPath: string,
	stopped: number | undefined
): Result<SpawnResult, UiError> {
	const previous = readState(host, udid).helper;
	if (previous?.socket === socketPath && previous.pid !== stopped && deps.pidAlive(previous.pid)) {
		return unavailable(`warden-simd (pid ${previous.pid}) is still running for ${udid}; not starting a second one`);
	}
	const idle = idleSeconds(opts.idleTimeout ?? host.env[IDLE_TIMEOUT_ENV] ?? DEFAULT_IDLE_TIMEOUT);
	if (!idle.success) return idle;
	const located = locateHelperBinary(host, udid, opts, deps);
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
	const spawned = deps.spawnDetached({ cmd, logPath, signalMs: SIGNAL_WAIT_MS });
	const binary = realPath(deps, located.data);
	const mtimeMs = deps.mtime?.(binary);
	const lease = currentLease(host.store(), udid);
	const record: HelperRecord = {
		pid: spawned.pid,
		socket: socketPath,
		...(lease !== undefined ? { owner: lease.owner } : {}),
		...(mtimeMs !== undefined ? { binary: { path: binary, mtimeMs } } : {}),
		env: simdEnvKey(host.env),
		...(lease !== undefined ? { lease: lease.id } : {}),
	};
	writeState(host, udid, { ...readState(host, udid), helper: record });
	return ok(spawned);
}

/** What one `ensureHelper` attempt settled: an answer, another attempt right away, or a pause then another. */
type Step = { kind: "done"; result: Result<HelperInfo, UiError> } | { kind: "retry" } | { kind: "wait" };

const RETRY: Step = { kind: "retry" };
const WAIT: Step = { kind: "wait" };

/** One `ensureHelper` call's fixed inputs and what its attempts have done so far. */
type Attempt = {
	host: HelperHost & Required<Pick<HelperHost, "store">>;
	udid: string;
	socketPath: string;
	logPath: string;
	opts: EnsureHelperOptions;
	deps: HelperDeps;
	spawned?: SpawnResult;
	/** we hold the spawn row (replacing a stale helper or spawning) */
	held: boolean;
	/** a stale helper was stopped once: whatever answers next is used, never stopped again */
	replaced: boolean;
	/** the pid of the recorded helper this call stopped, so `spawnHelper` may start one in its place */
	stopped?: number;
	/** when this call started (`deps.now()`) */
	started: number;
};

async function answered(a: Attempt, client: SimdClient): Promise<Step> {
	const info: HelperInfo = {
		socketPath: a.socketPath,
		spawned: a.spawned !== undefined,
		...(a.spawned ? { pid: a.spawned.pid } : {}),
	};
	if (a.opts.keepClient === true) return { kind: "done", result: ok({ ...info, client }) };
	await client.close();
	return { kind: "done", result: ok(info) };
}

/** Something answers on the socket: use it, unless it is stale and this caller may replace it. */
async function onAnswer(a: Attempt, client: SimdClient): Promise<Step> {
	const stale = a.spawned === undefined && !a.replaced ? staleReason(a.host, a.udid, a.opts, a.deps) : undefined;
	if (stale === undefined) return answered(a, client);
	await client.close();
	if (!a.held && !claimSpawnRow(a.host, a.udid, a.deps)) return WAIT;
	a.held = true;
	a.replaced = true;
	const pid = readState(a.host, a.udid).helper?.pid;
	await stopRecorded(a.host, a.udid, { socketPath: a.socketPath, deps: a.deps });
	a.stopped = pid;
	return RETRY;
}

/** The recorded helper's pid when it is alive, else undefined. */
function liveRecordedPid(a: Attempt): number | undefined {
	const record = readState(a.host, a.udid).helper;
	return record !== undefined && record.socket === a.socketPath && a.deps.pidAlive(record.pid) ? record.pid : undefined;
}

/**
 * The socket accepted but the handshake timed out, and the recorded helper is alive: it is there but busy. Wait
 * for it; once it has been busy for `SPAWN_WAIT_MS`, take the row, stop it, and spawn one in its place.
 */
async function onBusy(a: Attempt, pid: number): Promise<Step> {
	if (a.deps.now() - a.started < SPAWN_WAIT_MS) return WAIT;
	if (!a.held && !claimSpawnRow(a.host, a.udid, a.deps)) return WAIT;
	a.held = true;
	await stopRecorded(a.host, a.udid, { socketPath: a.socketPath, deps: a.deps });
	a.stopped = pid;
	return spawn(a);
}

/** Nothing answers and nothing was spawned yet: spawn, if no one else is, then wait for its ready line. */
async function onSilence(a: Attempt): Promise<Step> {
	if (!a.held && !claimSpawnRow(a.host, a.udid, a.deps)) return WAIT;
	if (!a.held) {
		a.held = true;
		// the previous holder may have finished between our failed connect and our claim: look again before replacing its socket
		if (a.deps.socketExists?.(a.socketPath) !== false) {
			const again = await a.deps.connect(a.socketPath);
			if (again.success) {
				await again.data.close();
				return RETRY;
			}
			const busy = busyPid(a, again.error);
			if (busy !== undefined) return onBusy(a, busy);
		}
	}
	// a recorded helper whose pid is alive but that refuses (or has no socket file) is stopped before another starts
	const recorded = liveRecordedPid(a);
	if (recorded !== undefined && recorded !== a.stopped) {
		await stopRecorded(a.host, a.udid, { socketPath: a.socketPath, deps: a.deps });
		a.stopped = recorded;
	}
	return spawn(a);
}

async function spawn(a: Attempt): Promise<Step> {
	const began = spawnHelper(a.host, a.udid, a.socketPath, a.opts, a.deps, a.logPath, a.stopped);
	if (!began.success) return { kind: "done", result: began };
	a.spawned = began.data;
	return (await began.data.signal?.up) === "up" ? RETRY : WAIT;
}

/** A handshake timeout (the socket accepted, no `ready`) while the recorded helper is alive: its pid, else undefined. */
function busyPid(a: Attempt, error: DriverError): number | undefined {
	return error.code === "E_TIMEOUT" ? liveRecordedPid(a) : undefined;
}

function diedBeforeReady(a: Attempt): Step {
	const tail = logTail(a.logPath);
	return {
		kind: "done",
		result: unavailable(
			`warden-simd exited before it was ready${tail ? `: ${tail}` : ""}`,
			`see ${a.logPath}; run \`warden doctor\` to check the iOS driver helper`
		),
	};
}

async function attempt(a: Attempt): Promise<Step> {
	// no socket file: nothing can answer, so skip the probe and go straight to the spawn arbitration
	if (a.spawned === undefined && a.deps.socketExists?.(a.socketPath) === false) return onSilence(a);
	const attached = await a.deps.connect(a.socketPath);
	if (attached.success) return onAnswer(a, attached.data);
	if (a.spawned === undefined) {
		const busy = busyPid(a, attached.error);
		return busy !== undefined ? onBusy(a, busy) : onSilence(a);
	}
	return a.deps.pidAlive(a.spawned.pid) ? WAIT : diedBeforeReady(a);
}

/**
 * The wait ran out with our own child still not answering: stop it (SIGTERM, its socket, its record) so it does not
 * start late beside whatever the caller falls back to.
 */
function abandonSpawn(a: Attempt, spawned: SpawnResult): void {
	a.deps.kill(spawned.pid, "SIGTERM");
	unlinkQuietly(a.socketPath);
	const state = readState(a.host, a.udid);
	if (state.helper?.pid === spawned.pid) forgetHelper(a.host, a.udid, state);
}

/**
 * Make sure a `warden-simd` daemon answers on the device's socket, spawning one if not, and prove it with one
 * connected, handshaken client. Callers race safely: the `simd_spawn:<udid>` row (taken under `store.transaction`)
 * lets exactly one spawn (or replace a stale helper) while the rest keep polling the socket; a spawner that dies
 * leaves a stale row the next caller takes over. Everyone waits on something live (the spawner on its own child,
 * the rest on the row or a busy helper) for up to 15 s; a spawner that gives up stops the child it started. No socket
 * file means silence (spawn at once); a socket that accepts but does not finish the handshake while the recorded pid
 * is alive is a busy helper, waited for (≤ 5 s) and only then stopped and replaced, never run beside.
 *
 * A fresh helper prints its ready line the moment its socket accepts, so the spawner connects once, right then,
 * instead of polling the socket file; an older helper (no ready line) and a slow start fall back to the poll.
 * `keepClient` returns that one client for the driver to use; without it the client is closed.
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
	const a: Attempt = { host, udid, socketPath, logPath, opts, deps, held: false, replaced: false, started };
	try {
		for (;;) {
			const step = await attempt(a);
			if (step.kind === "done") return step.result;
			if (step.kind === "retry") continue;
			if (deps.now() - started >= SPAWN_LIVE_WAIT_MS) {
				if (a.spawned !== undefined) abandonSpawn(a, a.spawned);
				return unavailable(
					`warden-simd did not answer on ${socketPath} within ${SPAWN_LIVE_WAIT_MS} ms`,
					`see ${logPath}`
				);
			}
			await deps.sleep(POLL_MS);
		}
	} finally {
		a.spawned?.signal?.detach();
		if (a.held || a.spawned !== undefined || host.store().getMeta(rowKey(udid)) !== undefined) {
			releaseSpawnRow(host, udid, deps);
		}
	}
}

/** The iOS `Driver` for a leased simulator, over its (possibly just-spawned) helper daemon. Closing it only disconnects. */
export async function connectHelper(
	ctx: CommandContext,
	udid: string,
	opts: EnsureHelperOptions = {}
): Promise<Result<Driver, UiError>> {
	const helper = await ensureHelper(ctx, udid, { ...opts, keepClient: true });
	if (!helper.success) return helper;
	const { client, socketPath } = helper.data;
	const { openIosDriver } = await import("@delacour/warden-e2e/driver/ios/ios-driver");
	const driver = await openIosDriver({
		udid,
		exec: ctx.exec,
		socketPath,
		...(client ? { client } : {}),
		...(opts.helperPath !== undefined ? { helperPath: opts.helperPath } : {}),
		now: ctx.now,
	});
	if (driver.success) return driver;
	await client?.close();
	return { success: false, error: driverUiError(driver.error) };
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

/** Which file sits at `path` (device + inode + birth time, so a re-created file with a reused inode differs). */
function fileIdentity(path: string): string | undefined {
	try {
		const st = statSync(path);
		return `${st.dev}:${st.ino}:${st.birthtimeMs || st.ctimeMs}`;
	} catch {
		return undefined;
	}
}

type StopHost = Pick<CommandContext, "env" | "now"> & Partial<Pick<CommandContext, "store">>;

/**
 * Stop a device's helper and forget it. Idempotent: nothing running is a no-op. Takes the `simd_spawn:<udid>` row
 * first (waiting ≤ 1 s for a live spawner; without a store, or after that, it goes on without the row), so a
 * concurrent `ensureHelper` cannot spawn into the stop. Sends `shutdown`, waits ≤ 2 s for the socket to go (or the
 * recorded pid to die), else SIGTERMs the pid. Then it unlinks the socket only if it is still the file it found, and
 * drops `helper` from `state.json` only if it still names the pid it stopped: a helper that took the path or the
 * record meanwhile is left alone. Never throws.
 */
export async function stopHelper(
	host: StopHost,
	udid: string,
	opts: { socketPath?: string; deps?: HelperDeps } = {}
): Promise<StopOutcome> {
	const deps = opts.deps ?? defaultHelperDeps;
	const store = host.store;
	const rowHost = store !== undefined ? { ...host, store } : undefined;
	let claimed = false;
	try {
		if (rowHost !== undefined) {
			claimed = await waitUntil(() => claimSpawnRow(rowHost, udid, deps), STOP_ROW_WAIT_MS, deps);
		}
		return await stopRecorded(host, udid, { ...opts, deps });
	} catch {
		return { stopped: false, how: "none" };
	} finally {
		if (claimed && rowHost !== undefined) {
			try {
				releaseSpawnRow(rowHost, udid, deps);
			} catch {
				// never throws
			}
		}
	}
}

/** `stopHelper`'s work, for a caller that already holds the spawn row (or has none to take). */
async function stopRecorded(
	host: StopHost,
	udid: string,
	opts: { socketPath?: string; deps: HelperDeps }
): Promise<StopOutcome> {
	const { deps } = opts;
	const record = readState(host, udid).helper;
	const socketPath = opts.socketPath ?? record?.socket ?? socketPathFor(host, udid);
	const found = fileIdentity(socketPath);
	const running = found !== undefined || (record !== undefined && deps.pidAlive(record.pid));
	if (!running) {
		forgetRecorded(host, udid, record);
		return { stopped: false, how: "none" };
	}
	const gone = () =>
		found === undefined || fileIdentity(socketPath) !== found || (record !== undefined && !deps.pidAlive(record.pid));
	const attached = found !== undefined ? await deps.connect(socketPath) : undefined;
	if (attached?.success) {
		await attached.data.request("shutdown", {}, { timeoutMs: SHUTDOWN_REQUEST_MS });
		await attached.data.close();
	}
	let how: StopOutcome["how"] = "shutdown";
	if (!(await waitUntil(gone, SHUTDOWN_WAIT_MS - (attached?.success ? SHUTDOWN_REQUEST_MS : 0), deps))) {
		how = "sigterm";
		if (record !== undefined) deps.kill(record.pid, "SIGTERM");
		await waitUntil(gone, KILL_WAIT_MS, deps);
	}
	if (found !== undefined && fileIdentity(socketPath) === found) unlinkQuietly(socketPath);
	forgetRecorded(host, udid, record);
	return { stopped: true, how };
}

/** Drop `record` from `state.json`, but only while it is still the recorded helper (a newer one is kept). */
function forgetRecorded(
	host: Pick<CommandContext, "env" | "now">,
	udid: string,
	record: HelperRecord | undefined
): void {
	if (record === undefined) return;
	const state = readState(host, udid);
	if (state.helper?.pid === record.pid) forgetHelper(host, udid, state);
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
	for (const udid of knownUdids(host)) {
		const state = readState(host, udid);
		const record = state.helper;
		if (record === undefined || deps.pidAlive(record.pid)) continue;
		if (existsSync(record.socket)) removed.push(record.socket);
		unlinkQuietly(record.socket);
		forgetHelper(host, udid, state);
	}
	return removed;
}

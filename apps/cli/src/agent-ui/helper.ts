import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseDuration } from "@delacour/warden-core/duration";
import { type PidAlive, processAlive } from "@delacour/warden-core/liveness";
import { type Store, wardenHome } from "@delacour/warden-core/store";
import type { Owner } from "@delacour/warden-core/types";
import type { Driver, DriverError } from "@delacour/warden-e2e/driver/driver.types";
import { openIosDriver, resolveHelper } from "@delacour/warden-e2e/driver/ios/ios-driver";
import { connectSimd, type SimdClient } from "@delacour/warden-e2e/driver/ios/simd-client";
import { ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { driverUiError } from "./driver";
import { type UiError, uiError } from "./output";
import { type HelperRecord, readState, type UiState, writeState } from "./state";

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
	connect: (socketPath) => connectSimd({ socketPath, readyTimeoutMs: 2000 }),
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

/** Who holds the device's lease right now, as `ownerKey`; undefined when nobody does. */
function leaseOwnerKey(store: Store, udid: string): string | undefined {
	const held = store.findLeaseByResource({ kind: "device", platform: "ios", id: udid, name: udid });
	return held ? ownerKey(held.owner) : undefined;
}

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
 * outlives the run that started it, so it is replaced when the device's lease passed to another owner (it was
 * started for them, with their environment, and a stale stream would collide with the new owner's) or when the
 * helper binary was rebuilt or upgraded since. A record without those fields (older warden) or a device with no
 * lease is not guessed at: the helper is reused.
 */
function staleReason(
	host: HelperHost & Required<Pick<HelperHost, "store">>,
	udid: string,
	opts: EnsureHelperOptions,
	deps: HelperDeps
): string | undefined {
	const record = readState(host, udid).helper;
	if (record === undefined) return undefined;
	const owner = leaseOwnerKey(host.store(), udid);
	if (owner !== undefined && record.owner !== undefined && owner !== record.owner) {
		return "the device's lease passed to another owner";
	}
	if (record.binary !== undefined && deps.mtime !== undefined) {
		const located = locateHelperBinary(host, udid, opts, deps);
		const mtime = located.success ? deps.mtime(located.data) : undefined;
		if (
			located.success &&
			mtime !== undefined &&
			(located.data !== record.binary.path || mtime !== record.binary.mtimeMs)
		) {
			return "the helper binary changed";
		}
	}
	return undefined;
}

/** Start the helper for `udid` (the caller holds the spawn row) and remember `{pid, socket, owner, binary}` in `state.json`. */
function spawnHelper(
	host: HelperHost & Required<Pick<HelperHost, "store">>,
	udid: string,
	socketPath: string,
	opts: EnsureHelperOptions,
	deps: HelperDeps,
	logPath: string
): Result<SpawnResult, UiError> {
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
	const mtimeMs = deps.mtime?.(located.data);
	const owner = leaseOwnerKey(host.store(), udid);
	const record: HelperRecord = {
		pid: spawned.pid,
		socket: socketPath,
		...(owner !== undefined ? { owner } : {}),
		...(mtimeMs !== undefined ? { binary: { path: located.data, mtimeMs } } : {}),
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
	await stopHelper(a.host, a.udid, { socketPath: a.socketPath, deps: a.deps });
	return RETRY;
}

/** Nothing answers and nothing was spawned yet: spawn, if no one else is, then wait for its ready line. */
async function onSilence(a: Attempt): Promise<Step> {
	if (!a.held && !claimSpawnRow(a.host, a.udid, a.deps)) return WAIT;
	if (!a.held) {
		a.held = true;
		// the previous holder may have finished between our failed connect and our claim: look again before replacing its socket
		const again = await a.deps.connect(a.socketPath);
		if (again.success) {
			await again.data.close();
			return RETRY;
		}
	}
	const began = spawnHelper(a.host, a.udid, a.socketPath, a.opts, a.deps, a.logPath);
	if (!began.success) return { kind: "done", result: began };
	a.spawned = began.data;
	return (await began.data.signal?.up) === "up" ? RETRY : WAIT;
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
	const attached = await a.deps.connect(a.socketPath);
	if (attached.success) return onAnswer(a, attached.data);
	if (a.spawned === undefined) return onSilence(a);
	return a.deps.pidAlive(a.spawned.pid) ? WAIT : diedBeforeReady(a);
}

/**
 * Make sure a `warden-simd` daemon answers on the device's socket, spawning one if not, and prove it with one
 * connected, handshaken client. Callers race safely: the `simd_spawn:<udid>` row (taken under `store.transaction`)
 * lets exactly one spawn (or replace a stale helper) while the rest keep polling the socket (≤ 5 s); a spawner that
 * dies leaves a stale row the next caller takes over.
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
	const a: Attempt = { host, udid, socketPath, logPath, opts, deps, held: false, replaced: false };
	try {
		for (;;) {
			const step = await attempt(a);
			if (step.kind === "done") return step.result;
			if (step.kind === "retry") continue;
			if (deps.now() - started >= SPAWN_WAIT_MS) {
				return unavailable(`warden-simd did not answer on ${socketPath} within ${SPAWN_WAIT_MS} ms`, `see ${logPath}`);
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

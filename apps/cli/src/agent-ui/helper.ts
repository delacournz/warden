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
import { durationParser } from "@delacour/warden-config/duration";
import type { RemoteClient } from "@delacour/warden-device/remote/remote-client";
import type { ClockRecorder } from "@delacour/warden-driver/clock-recorder";
import type { Driver, DriverError } from "@delacour/warden-driver/driver.types";
import type { NetworkProxyPort } from "@delacour/warden-driver/network-proxy";
import { helperLocator } from "@delacour/warden-driver-ios/locate-helper";
import type { SimdClient } from "@delacour/warden-driver-ios/simd-client";
import { uiPaths } from "@delacour/warden-sdk/ops/paths";
import { BuildsTable } from "@delacour/warden-store/builds-table";
import { liveness, type PidAlive } from "@delacour/warden-store/liveness";
import { type ProcessCommand, processCommand, processIdentity } from "@delacour/warden-store/process-identity";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import type { Owner } from "@delacour/warden-store/types";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { servedIdentity } from "../ios-runner/served-identity";
import { selfCommandHelpers } from "../self-command";
import { DEVICE_LOCKED_HINT, opErrors } from "./driver";
import { uiHelperSweep } from "./helper-sweep";
import { type UiError, uiOutput } from "./output";
import { cliUiPaths } from "./paths";
import { type HelperRecord, type UiState, uiStatePersistence } from "./state";

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
/**
 * how long one request to the helper may take before the client gives up (`E_TIMEOUT`); unset, the client's 10 s. A
 * duration (`60s`). The first `snapshot` on a cold hosted simulator injects the in-sim bridge and can outlast 10 s.
 */
export const REQUEST_TIMEOUT_ENV = "WARDEN_SIMD_TIMEOUT";
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

/** What the lifecycle needs of a connected helper client: ask it to shut down, and hang up. `SimdClient` is one. */
export type HelperClient = {
	request(op: "shutdown", params: Record<string, unknown>, opts: { timeoutMs?: number }): Promise<unknown>;
	close(): Promise<void>;
};

/** Everything impure about the helper lifecycle; tests replace pieces (clock, spawn, connect, kill). */
/** per-connection client options `ensureHelperOf` resolves from `requestTimeout` / the kind's `timeoutEnv` */
export type ConnectOptions = { defaultTimeoutMs?: number };

export type HelperDeps<C extends HelperClient = SimdClient> = {
	connect: (socketPath: string, options?: ConnectOptions) => Promise<Result<C, DriverError>>;
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
	/**
	 * a pid's command line (`ps`), checked for `--udid <udid> --socket <socket>` before the recorded pid is signalled
	 * or counted as the helper: a reused pid is never signalled. Absent (test fakes): liveness alone decides
	 */
	command?: ProcessCommand;
	/** argv that re-runs this warden (the Android host is warden itself). Absent: `selfCommand()` */
	self?: () => string[];
	/** the iPhone runner host's build identity (`IosRunnerIdentityDeps`). Absent: a resident host is never replaced for it */
	runner?: IosRunnerIdentityDeps;
};

/**
 * What `ensureIosRunner` needs to tell whether the resident `__ios-runner-host` serves the runner the current sources
 * would build. Injected so tests never touch xcodebuild or the keychain.
 */
export type IosRunnerIdentityDeps = {
	/** the build identity the current sources, team and Xcode would give; undefined: cannot be told, leave the host */
	expected: () => Promise<string | undefined>;
	/** the identity the host on `socketPath` serves; undefined: none recorded (a host that predates identities) */
	served: (socketPath: string) => string | undefined;
	/** `ownerKey` of the calling session, to tell a lease of its own from someone else's */
	caller: () => Promise<string | undefined>;
	/** the one stderr line when a host is replaced */
	note: (line: string) => void;
};

/** The stderr note when a changed runner makes `ensureIosRunner` replace the host. */
export const RUNNER_CHANGED_NOTE = "runner changed; restarting the iPhone runner host";

type Chunk = { done: boolean; value?: Uint8Array | undefined };

/** The slice of a command context the helper lifecycle needs. */
export type HelperHost = Pick<CommandContext, "env" | "now"> & Partial<Pick<CommandContext, "store" | "exec">>;

export type HelperInfo<C extends HelperClient = SimdClient> = {
	socketPath: string;
	pid?: number;
	spawned: boolean;
	/** the connected (handshaken) client, present with `keepClient`: the caller owns it and closes it */
	client?: C;
};

export type EnsureHelperOptions<C extends HelperClient = SimdClient> = {
	helperPath?: string;
	socketPath?: string;
	/** `10m`-style; the helper exits after this long without a client. Default `$WARDEN_SIMD_IDLE_TIMEOUT`, else 10 min */
	idleTimeout?: string;
	/** `60s`-style; how long one request to the helper may take. Default `$WARDEN_SIMD_TIMEOUT`, else the client's 10 s */
	requestTimeout?: string;
	/** hand back the client that proved the helper is up instead of closing it, so the driver does not connect again */
	keepClient?: boolean;
	deps?: HelperDeps<C>;
};

/** `WARDEN_SIMD_*` names that configure the client, not the helper process: left out of `simdEnvKey`. */
const CLIENT_ONLY_ENV = new Set(["WARDEN_SIMD", "WARDEN_SIMD_SOCKET"]);

/** `WARDEN_ANDROID_*` names that only steer the client (whether to use the host at all): left out of `androidHostEnvKey`. */
const ANDROID_CLIENT_ONLY_ENV = new Set(["WARDEN_ANDROID_HOST"]);

/** The `state.json` field a kind's record lives in. */
type RecordField = "helper" | "androidHost" | "iosRunner";

/**
 * One kind of resident per-device helper process: everything that differs between iOS's `warden-simd` and Android's
 * `warden __android-host`. The lifecycle around it (spawn arbitration, busy / stale replacement, stop, sweep) is
 * shared and lives in this file.
 */
export type HelperKind = {
	/** names it in messages */
	label: string;
	platform: "ios" | "android";
	/** `<rowPrefix>:<id>` is the spawn row in the store's meta table */
	rowPrefix: string;
	dir: (host: Pick<CommandContext, "env">) => string;
	/** prefix of the short `/tmp` socket used when `dir` is too deep */
	socketTag: string;
	field: RecordField;
	envKey: (env: Readonly<Record<string, string | undefined>>) => string;
	/** env var overriding the idle timeout */
	idleEnv: string;
	/** env var setting how long one request may take (none: the client's default) */
	timeoutEnv?: string;
	/** what its command line carries: how a recorded pid is told from a reused one */
	marks: (id: string, socket: string) => string[];
	/** the executable whose realpath + mtime identify what a spawn would run */
	locate: (
		host: HelperHost,
		id: string,
		opts: { helperPath?: string },
		deps: HelperDeps<HelperClient>
	) => Result<string, DriverError>;
	/** the argv that starts it */
	command: (input: { binary: string; id: string; socket: string; idleSeconds: number; self: string[] }) => string[];
	/** what to suggest when it dies before it is ready */
	hint: string;
	/**
	 * how long a start may take (ms): the wait for its ready line, how long its spawn row stays live, and the most
	 * an `ensureHelper` call waits in all. Default `SPAWN_LIVE_WAIT_MS`; the iPhone runner builds, installs and
	 * launches on a phone first
	 */
	startupMs?: number;
};

/** `$WARDEN_ANDROID_HOST_IDLE_TIMEOUT` overrides the Android host's idle timeout (default 10 min). */
export const ANDROID_HOST_IDLE_TIMEOUT_ENV = "WARDEN_ANDROID_HOST_IDLE_TIMEOUT";

/** The hidden subcommand that serves an Android driver (`commands/android-host.ts`). */
export const ANDROID_HOST_SUBCOMMAND = "__android-host";

/** argv that re-runs this warden: the compiled binary, or `bun <cli.ts>` from source (as `autogc.ts`). */
/** `WARDEN_IOS_*` names that only steer the client (which socket to use): left out of `iosRunnerEnvKey`. */
const IOS_RUNNER_CLIENT_ONLY_ENV = new Set(["WARDEN_IOS_RUNNER_SOCKET"]);

/** `$WARDEN_IOS_RUNNER_IDLE_TIMEOUT` overrides the iPhone runner host's idle timeout (default 10 min). */
export const IOS_RUNNER_IDLE_TIMEOUT_ENV = "WARDEN_IOS_RUNNER_IDLE_TIMEOUT";

/** The hidden subcommand that serves a physical iPhone's runner (`commands/ios-runner-host.ts`). */
export const IOS_RUNNER_SUBCOMMAND = "__ios-runner-host";

/** build + install + launch of the runner on a phone: 15-30 s warm, much longer on a first install */
export const IOS_RUNNER_STARTUP_MS = 150_000;

type SpawnRow = { pid: number; at: number };

/** What one `ensureHelper` attempt settled: an answer, another attempt right away, or a pause then another. */
type Step<C extends HelperClient> =
	| { kind: "done"; result: Result<HelperInfo<C>, UiError> }
	| { kind: "retry" }
	| { kind: "wait" };

const RETRY = { kind: "retry" } as const;
const WAIT = { kind: "wait" } as const;

/** One `ensureHelper` call's fixed inputs and what its attempts have done so far. */
type Attempt<C extends HelperClient> = {
	host: HelperHost & Required<Pick<HelperHost, "store">>;
	kind: HelperKind;
	udid: string;
	socketPath: string;
	logPath: string;
	opts: EnsureHelperOptions<C>;
	deps: HelperDeps<C>;
	/** what every `connect` of this attempt passes on to the client */
	connectOptions?: ConnectOptions;
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

/** `warning`: the helper may still be running but could not be stopped (its command line could not be read). */
export type StopOutcome = { stopped: boolean; how: "none" | "shutdown" | "sigterm"; warning?: string };

type StopHost = Pick<CommandContext, "env" | "now"> & Partial<Pick<CommandContext, "store">>;

/** What `warden ui status` shows for the helper. */
export type HelperStatus = { running: boolean; pid: number | null; socket: string | null };

export class UiHelper {
	/**
	 * Watch a spawned helper's stdout for the line that says its socket is accepting: the helper's own `ready` event
	 * (carries `socket`), or, from an older helper, its `listening on …` log line. Every line is appended to `logPath`
	 * (stdout used to go straight to the log file). `up` settles once: `up`, `closed` when the pipe ends first, `timeout`
	 * after `timeoutMs`. A current helper points its stdout at the log right after the ready line, so the pipe then
	 * ends; `detach` covers an older one whose pipe would stay open.
	 */
	watchStart(stdout: ReadableStream<Uint8Array>, opts: { logPath: string; timeoutMs: number }): StartSignal {
		let settle: (outcome: StartOutcome) => void = () => undefined;
		const up = new Promise<StartOutcome>((resolve) => {
			settle = resolve;
		});
		const timer = setTimeout(() => settle("timeout"), opts.timeoutMs);
		const reader = stdout.getReader();
		void this.pumpLines(
			() => reader.read(),
			(line) => {
				this.appendQuietly(opts.logPath, `${line}\n`);
				if (this.isUpLine(line)) settle("up");
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

	/** Feed each non-blank line of a byte stream (`read` = its reader's) to `onLine` until it ends, is cancelled or breaks. */
	private async pumpLines(read: () => Promise<Chunk>, onLine: (line: string) => void): Promise<void> {
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

	private appendQuietly(path: string, text: string): void {
		try {
			appendFileSync(path, text);
		} catch {
			// the log is best effort
		}
	}

	private isUpLine(line: string): boolean {
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

	/**
	 * `$WARDEN_HOME/simd/<udid>.sock`. A unix socket path must fit in 104 bytes, so when `$WARDEN_HOME` is
	 * deep (temp dirs) the socket goes to a short per-home path under `/tmp` instead; `state.json` records
	 * whichever was used.
	 */
	socketPathFor(host: Pick<CommandContext, "env">, udid: string): string {
		return this.socketPathOf(SIMD_KIND, host, udid);
	}

	/** `socketPathFor` for any helper kind: `<kind dir>/<id>.sock`, or a short `/tmp` path when that is too long. */
	socketPathOf(kind: HelperKind, host: Pick<CommandContext, "env">, id: string): string {
		const preferred = join(kind.dir(host), `${uiPaths.fsSafeId(id)}.sock`);
		if (Buffer.byteLength(preferred) < MAX_SOCKET_PATH) return preferred;
		const tag = Bun.hash(storeLocator.wardenHome(host.env)).toString(36).slice(0, 8);
		// the id's own hash, not just its first 8 characters: `192.168.*` / `adb-*` serials share those
		const idTag = `${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}${id.length > 8 ? `-${Bun.hash(id).toString(36).slice(0, 8)}` : ""}`;
		return join(process.platform === "darwin" ? "/tmp" : tmpdir(), `${kind.socketTag}-${tag}-${idTag}.sock`);
	}

	/** The same identity `sameOwner` compares: one agent session, one shell pid, one CI run. */
	ownerKey(owner: Owner): string {
		switch (owner.kind) {
			case "agent":
				return `agent:${owner.sessionId}`;
			case "user":
				return `user:${owner.pid}`;
			case "ci":
				return `ci:${owner.runId}`;
		}
	}

	/**
	 * A hash of the `WARDEN_SIMD_*` environment a spawned helper inherits (its pacing, stream and trace knobs), so a
	 * resident helper can be replaced when it was started with different settings. `WARDEN_SIMD` (which binary, compared
	 * by realpath instead) and `WARDEN_SIMD_SOCKET` (a client setting) are left out.
	 */
	simdEnvKey(env: Readonly<Record<string, string | undefined>>): string {
		const entries = Object.entries(env)
			.filter((entry): entry is [string, string] => entry[0].startsWith("WARDEN_SIMD_") && entry[1] !== undefined)
			.filter(([name]) => !CLIENT_ONLY_ENV.has(name))
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return Bun.hash(JSON.stringify(entries)).toString(36);
	}

	/** `simdEnvKey` for the Android host: the `WARDEN_ANDROID_*` knobs its driver reads (uiad, settext, snapshot…). */
	androidHostEnvKey(env: Readonly<Record<string, string | undefined>>): string {
		const entries = Object.entries(env)
			.filter((entry): entry is [string, string] => entry[0].startsWith("WARDEN_ANDROID_") && entry[1] !== undefined)
			.filter(([name]) => !ANDROID_CLIENT_ONLY_ENV.has(name))
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return Bun.hash(JSON.stringify(entries)).toString(36);
	}

	/** `simdEnvKey` for the iPhone runner host: the `WARDEN_IOS_*` knobs it and its builder read (idle timeout, signing team…). */
	iosRunnerEnvKey(env: Readonly<Record<string, string | undefined>>): string {
		const entries = Object.entries(env)
			.filter((entry): entry is [string, string] => entry[0].startsWith("WARDEN_IOS_") && entry[1] !== undefined)
			.filter(([name]) => !IOS_RUNNER_CLIENT_ONLY_ENV.has(name))
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return Bun.hash(JSON.stringify(entries)).toString(36);
	}

	private rowKey(kind: HelperKind, id: string) {
		return `${kind.rowPrefix}:${id}`;
	}

	private parseRow(text: string | undefined): SpawnRow | undefined {
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
	private claimSpawnRow(
		host: Required<Pick<HelperHost, "store">> & HelperHost,
		kind: HelperKind,
		udid: string,
		deps: Pick<HelperDeps<HelperClient>, "now" | "pidAlive" | "pid">
	): boolean {
		const store = host.store();
		return store.transaction(() => {
			const current = this.parseRow(store.getMeta(this.rowKey(kind, udid)));
			const now = deps.now();
			const live =
				current !== undefined && now - current.at < (kind.startupMs ?? ROW_STALE_MS) && deps.pidAlive(current.pid);
			if (live) return false;
			store.setMeta(this.rowKey(kind, udid), JSON.stringify({ pid: deps.pid, at: now } satisfies SpawnRow));
			return true;
		});
	}

	private releaseSpawnRow(
		host: Required<Pick<HelperHost, "store">> & HelperHost,
		kind: HelperKind,
		udid: string,
		deps: Pick<HelperDeps<HelperClient>, "pid">
	): void {
		const store = host.store();
		store.transaction(() => {
			const current = this.parseRow(store.getMeta(this.rowKey(kind, udid)));
			if (current === undefined || current.pid === deps.pid) store.deleteMeta(this.rowKey(kind, udid));
		});
	}

	/** `undefined` leaves the client's default; the value is a duration, and a bad one is a usage error up front. */
	private requestTimeoutMs(value: string | undefined): Result<number | undefined, UiError> {
		if (value === undefined || value === "") return resultFactory.ok(undefined);
		const ms = durationParser.parse(value);
		if (!ms.success) return { success: false, error: uiOutput.uiError("usage", `${REQUEST_TIMEOUT_ENV}: ${ms.error}`) };
		return resultFactory.ok(Math.max(1, ms.data));
	}

	private idleSeconds(idleTimeout: string): Result<number, UiError> {
		const ms = durationParser.parse(idleTimeout);
		if (!ms.success) return { success: false, error: uiOutput.uiError("usage", `idle timeout: ${ms.error}`) };
		return resultFactory.ok(Math.max(1, Math.round(ms.data / 1000)));
	}

	private logTail(logPath: string): string {
		try {
			return readFileSync(logPath, "utf8").trim().split("\n").slice(-3).join(" | ");
		} catch {
			return "";
		}
	}

	private unlinkQuietly(path: string): void {
		try {
			unlinkSync(path);
		} catch {
			// not there
		}
	}

	/** A host that could not start; one that died on a locked phone is `device_locked`, which no retry can fix. */
	private unavailable(message: string, hint?: string): { success: false; error: UiError } {
		if (message.includes("E_DEVICE_LOCKED")) {
			return { success: false, error: uiOutput.uiError("device_locked", message, { hint: DEVICE_LOCKED_HINT }) };
		}
		return {
			success: false,
			error: uiOutput.uiError("engine_unavailable", message, hint === undefined ? {} : { hint }),
		};
	}

	/** The device's lease right now: its id and its owner as `ownerKey`; undefined when nobody holds one. */
	private currentLease(store: Store, kind: HelperKind, udid: string): { id: string; owner: string } | undefined {
		const held = store.findLeaseByResource({ kind: "device", platform: kind.platform, id: udid, name: udid });
		return held ? { id: held.id, owner: this.ownerKey(held.owner) } : undefined;
	}

	private realPath(deps: HelperDeps<HelperClient>, path: string): string {
		return deps.realpath?.(path) ?? path;
	}

	/** The helper executable `opts` / the environment point at. */
	locateHelperBinary(
		host: HelperHost,
		udid: string,
		opts: { helperPath?: string },
		deps: HelperDeps<HelperClient>
	): Result<string, DriverError> {
		return helperLocator.resolve({
			udid,
			exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
			...(opts.helperPath !== undefined ? { helperPath: opts.helperPath } : {}),
			env: { simd: host.env.WARDEN_SIMD, simdSocket: undefined, helperDir: host.env.WARDEN_HELPER_DIR },
			wardenHome: storeLocator.wardenHome(host.env),
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
	private staleReason(
		host: HelperHost & Required<Pick<HelperHost, "store">>,
		kind: HelperKind,
		udid: string,
		opts: { helperPath?: string },
		deps: HelperDeps<HelperClient>
	): string | undefined {
		const record = uiStatePersistence.readState(host, udid)[kind.field];
		if (record === undefined) return undefined;
		const lease = this.currentLease(host.store(), kind, udid);
		if (lease !== undefined && record.lease === lease.id) return undefined;
		if (record.env !== undefined && record.env !== kind.envKey(host.env)) {
			return "the helper's environment changed";
		}
		if (record.binary !== undefined && deps.mtime !== undefined) {
			const located = kind.locate(host, udid, opts, deps);
			const path = located.success ? this.realPath(deps, located.data) : undefined;
			const mtime = path !== undefined ? deps.mtime(path) : undefined;
			if (
				path !== undefined &&
				mtime !== undefined &&
				(path !== this.realPath(deps, record.binary.path) || mtime !== record.binary.mtimeMs)
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
	private spawnHelper(
		host: HelperHost & Required<Pick<HelperHost, "store">>,
		kind: HelperKind,
		udid: string,
		socketPath: string,
		opts: EnsureHelperOptions<HelperClient>,
		deps: HelperDeps<HelperClient>,
		logPath: string,
		stopped: number | undefined
	): Result<SpawnResult, UiError> {
		const previous = uiStatePersistence.readState(host, udid)[kind.field];
		if (
			previous?.socket === socketPath &&
			previous.pid !== stopped &&
			processIdentity.mayBeRecorded(deps, previous.pid, kind.marks(udid, socketPath))
		) {
			return this.unavailable(
				`${kind.label} (pid ${previous.pid}) is still running for ${udid}; not starting a second one`
			);
		}
		const idle = this.idleSeconds(opts.idleTimeout ?? host.env[kind.idleEnv] ?? DEFAULT_IDLE_TIMEOUT);
		if (!idle.success) return idle;
		const located = kind.locate(host, udid, opts, deps);
		if (!located.success) return { success: false, error: opErrors.driverError(located.error) };
		const self = (deps.self ?? selfCommandHelpers.selfCommand.bind(selfCommandHelpers))();
		const cmd = kind.command({ binary: located.data, id: udid, socket: socketPath, idleSeconds: idle.data, self });
		this.unlinkQuietly(socketPath);
		const spawned = deps.spawnDetached({ cmd, logPath, signalMs: kind.startupMs ?? SIGNAL_WAIT_MS });
		const binary = this.realPath(deps, located.data);
		const mtimeMs = deps.mtime?.(binary);
		const lease = this.currentLease(host.store(), kind, udid);
		const record: HelperRecord = {
			pid: spawned.pid,
			socket: socketPath,
			...(lease !== undefined ? { owner: lease.owner } : {}),
			...(mtimeMs !== undefined ? { binary: { path: binary, mtimeMs } } : {}),
			env: kind.envKey(host.env),
			...(lease !== undefined ? { lease: lease.id } : {}),
		};
		uiStatePersistence.updateState(host, udid, (state) => this.withRecord(state, kind.field, record));
		return resultFactory.ok(spawned);
	}

	/** `state` with `field` set to `record`, or dropped when `record` is undefined. */
	private withRecord(state: UiState, field: RecordField, record: HelperRecord | undefined): UiState {
		const next: UiState = { ...state };
		if (record === undefined) delete next[field];
		else next[field] = record;
		return next;
	}

	private async answered<C extends HelperClient>(a: Attempt<C>, client: C): Promise<Step<C>> {
		const info: HelperInfo<C> = {
			socketPath: a.socketPath,
			spawned: a.spawned !== undefined,
			...(a.spawned ? { pid: a.spawned.pid } : {}),
		};
		if (a.opts.keepClient === true) return { kind: "done", result: resultFactory.ok({ ...info, client }) };
		await client.close();
		return { kind: "done", result: resultFactory.ok(info) };
	}

	/** Something answers on the socket: use it, unless it is stale and this caller may replace it. */
	private async onAnswer<C extends HelperClient>(a: Attempt<C>, client: C): Promise<Step<C>> {
		const checkable = a.spawned === undefined && !a.replaced;
		const runner = checkable ? await this.runnerChange(a) : "same";
		if (runner === "blocked") {
			await client.close();
			return { kind: "done", result: { success: false, error: this.runnerBusy(a) } };
		}
		const stale = checkable && runner === "changed" ? "the runner changed" : undefined;
		const other =
			checkable && stale === undefined ? this.staleReason(a.host, a.kind, a.udid, a.opts, a.deps) : undefined;
		if (stale === undefined && other === undefined) return this.answered(a, client);
		await client.close();
		if (!a.held && !this.claimSpawnRow(a.host, a.kind, a.udid, a.deps)) return WAIT;
		a.held = true;
		a.replaced = true;
		if (stale !== undefined) a.deps.runner?.note(RUNNER_CHANGED_NOTE);
		const pid = uiStatePersistence.readState(a.host, a.udid)[a.kind.field]?.pid;
		const stop = await this.stopRecorded(a.host, a.kind, a.udid, { socketPath: a.socketPath, deps: a.deps });
		// a helper that could not be stopped is still the recorded one: `spawnHelper` refuses to start beside it
		if (stop.warning === undefined) a.stopped = pid;
		return RETRY;
	}

	/**
	 * Whether the iPhone runner host answering on the socket serves another runner build than the current sources would
	 * give. `same`: it does not (or this kind has no identity, or it cannot be told). `changed`: replace it. `blocked`:
	 * it changed, but the phone is leased to a different session, whose run must not be killed under it. A host with no
	 * recorded identity (older warden) counts as changed. The check comes before the lease exemption of `staleReason`:
	 * a run that holds the lease is exactly the one that started the old runner.
	 */
	private async runnerChange<C extends HelperClient>(a: Attempt<C>): Promise<"same" | "changed" | "blocked"> {
		const runner = a.deps.runner;
		if (runner === undefined || a.kind.field !== "iosRunner") return "same";
		const expected = await runner.expected();
		if (expected === undefined || runner.served(a.socketPath) === expected) return "same";
		const lease = this.currentLease(a.host.store(), a.kind, a.udid);
		if (lease === undefined) return "changed";
		const caller = await runner.caller();
		return caller !== undefined && caller === lease.owner ? "changed" : "blocked";
	}

	private runnerBusy<C extends HelperClient>(a: Attempt<C>): UiError {
		return uiOutput.uiError(
			"device_busy",
			`the iPhone runner changed (new warden or edited runner sources), but ${a.udid} is leased to another session whose run uses the old runner host`,
			{
				hint: "wait for that session to finish or release the phone, then run again: the host is restarted on the next call",
			}
		);
	}

	/** The recorded helper's pid when it is alive (and not reused by another program), else undefined. */
	private liveRecordedPid<C extends HelperClient>(a: Attempt<C>): number | undefined {
		const record = uiStatePersistence.readState(a.host, a.udid)[a.kind.field];
		return record !== undefined &&
			record.socket === a.socketPath &&
			processIdentity.mayBeRecorded(a.deps, record.pid, a.kind.marks(a.udid, record.socket))
			? record.pid
			: undefined;
	}

	/**
	 * The socket accepted but the handshake timed out, and the recorded helper is alive: it is there but busy. Wait
	 * for it; once it has been busy for `SPAWN_WAIT_MS`, take the row, stop it, and spawn one in its place.
	 */
	private async onBusy<C extends HelperClient>(a: Attempt<C>, pid: number): Promise<Step<C>> {
		if (a.deps.now() - a.started < SPAWN_WAIT_MS) return WAIT;
		if (!a.held && !this.claimSpawnRow(a.host, a.kind, a.udid, a.deps)) return WAIT;
		a.held = true;
		const stop = await this.stopRecorded(a.host, a.kind, a.udid, { socketPath: a.socketPath, deps: a.deps });
		if (stop.warning === undefined) a.stopped = pid;
		return this.spawn(a);
	}

	/** Nothing answers and nothing was spawned yet: spawn, if no one else is, then wait for its ready line. */
	private async onSilence<C extends HelperClient>(a: Attempt<C>): Promise<Step<C>> {
		if (!a.held && !this.claimSpawnRow(a.host, a.kind, a.udid, a.deps)) return WAIT;
		if (!a.held) {
			a.held = true;
			// the previous holder may have finished between our failed connect and our claim: look again before replacing its socket
			if (a.deps.socketExists?.(a.socketPath) !== false) {
				const again = await a.deps.connect(a.socketPath, a.connectOptions);
				if (again.success) {
					await again.data.close();
					return RETRY;
				}
				const busy = this.busyPid(a, again.error);
				if (busy !== undefined) return this.onBusy(a, busy);
			}
		}
		// a recorded helper whose pid is alive but that refuses (or has no socket file) is stopped before another starts
		const recorded = this.liveRecordedPid(a);
		if (recorded !== undefined && recorded !== a.stopped) {
			const stop = await this.stopRecorded(a.host, a.kind, a.udid, { socketPath: a.socketPath, deps: a.deps });
			if (stop.warning === undefined) a.stopped = recorded;
		}
		return this.spawn(a);
	}

	private async spawn<C extends HelperClient>(a: Attempt<C>): Promise<Step<C>> {
		const began = this.spawnHelper(a.host, a.kind, a.udid, a.socketPath, a.opts, a.deps, a.logPath, a.stopped);
		if (!began.success) return { kind: "done", result: began };
		a.spawned = began.data;
		return (await began.data.signal?.up) === "up" ? RETRY : WAIT;
	}

	/** A handshake timeout (the socket accepted, no `ready`) while the recorded helper is alive: its pid, else undefined. */
	private busyPid<C extends HelperClient>(a: Attempt<C>, error: DriverError): number | undefined {
		return error.code === "E_TIMEOUT" ? this.liveRecordedPid(a) : undefined;
	}

	private diedBeforeReady<C extends HelperClient>(a: Attempt<C>): Step<C> {
		const tail = this.logTail(a.logPath);
		return {
			kind: "done",
			result: this.unavailable(
				`${a.kind.label} exited before it was ready${tail ? `: ${tail}` : ""}`,
				`see ${a.logPath}; ${a.kind.hint}`
			),
		};
	}

	private async attempt<C extends HelperClient>(a: Attempt<C>): Promise<Step<C>> {
		// no socket file: nothing can answer, so skip the probe and go straight to the spawn arbitration
		if (a.spawned === undefined && a.deps.socketExists?.(a.socketPath) === false) return this.onSilence(a);
		const attached = await a.deps.connect(a.socketPath, a.connectOptions);
		if (attached.success) return this.onAnswer(a, attached.data);
		if (a.spawned === undefined) {
			const busy = this.busyPid(a, attached.error);
			return busy !== undefined ? this.onBusy(a, busy) : this.onSilence(a);
		}
		return a.deps.pidAlive(a.spawned.pid) ? WAIT : this.diedBeforeReady(a);
	}

	/**
	 * The wait ran out with our own child still not answering: stop it (SIGTERM, its socket, its record) so it does not
	 * start late beside whatever the caller falls back to.
	 */
	private abandonSpawn<C extends HelperClient>(a: Attempt<C>, spawned: SpawnResult): void {
		// the child this process just spawned: liveness alone says it is still ours
		if (a.deps.pidAlive(spawned.pid)) a.deps.kill(spawned.pid, "SIGTERM");
		this.unlinkQuietly(a.socketPath);
		this.forgetHelper(a.host, a.kind, a.udid, spawned.pid);
	}

	/**
	 * The state one `ensureHelperOf` call threads through its steps: paths (the kind's dir and the socket's parent exist
	 * afterwards), the deps, and the client options every `connect` passes on (`requestTimeout`, else the kind's
	 * `timeoutEnv`; a bad duration is a usage error before anything is touched).
	 */
	private attemptFor<C extends HelperClient>(
		kind: HelperKind,
		host: HelperHost & Required<Pick<HelperHost, "store">>,
		udid: string,
		deps: HelperDeps<C>,
		opts: EnsureHelperOptions<C>
	): Result<Attempt<C>, UiError> {
		const timeout = this.requestTimeoutMs(
			opts.requestTimeout ?? (kind.timeoutEnv !== undefined ? host.env[kind.timeoutEnv] : undefined)
		);
		if (!timeout.success) return timeout;
		const socketPath = opts.socketPath ?? this.socketPathOf(kind, host, udid);
		mkdirSync(dirname(socketPath), { recursive: true });
		mkdirSync(kind.dir(host), { recursive: true });
		const logPath = join(kind.dir(host), `${udid}.log`);
		return resultFactory.ok({
			host,
			kind,
			udid,
			socketPath,
			logPath,
			opts,
			deps,
			...(timeout.data !== undefined ? { connectOptions: { defaultTimeoutMs: timeout.data } } : {}),
			held: false,
			replaced: false,
			started: deps.now(),
		});
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
	readonly ensureHelper = async (
		host: HelperHost & Required<Pick<HelperHost, "store">>,
		udid: string,
		opts: EnsureHelperOptions = {}
	): Promise<Result<HelperInfo, UiError>> => {
		return this.ensureHelperOf(SIMD_KIND, host, udid, opts.deps ?? defaultHelperDeps, opts);
	};

	/** `ensureHelper` for any helper kind: the same arbitration, with that kind's socket, row, record and argv. */
	async ensureHelperOf<C extends HelperClient>(
		kind: HelperKind,
		host: HelperHost & Required<Pick<HelperHost, "store">>,
		udid: string,
		deps: HelperDeps<C>,
		opts: EnsureHelperOptions<C> = {}
	): Promise<Result<HelperInfo<C>, UiError>> {
		const made = this.attemptFor(kind, host, udid, deps, opts);
		if (!made.success) return made;
		const a = made.data;
		const { socketPath, logPath, started } = a;
		const liveWaitMs = kind.startupMs ?? SPAWN_LIVE_WAIT_MS;
		try {
			for (;;) {
				const step = await this.attempt(a);
				if (step.kind === "done") return step.result;
				if (step.kind === "retry") continue;
				if (deps.now() - started >= liveWaitMs) {
					if (a.spawned !== undefined) this.abandonSpawn(a, a.spawned);
					return this.unavailable(
						`${kind.label} did not answer on ${socketPath} within ${liveWaitMs} ms`,
						`see ${logPath}`
					);
				}
				await deps.sleep(POLL_MS);
			}
		} finally {
			a.spawned?.signal?.detach();
			if (a.held || a.spawned !== undefined || host.store().getMeta(this.rowKey(kind, udid)) !== undefined) {
				this.releaseSpawnRow(host, kind, udid, deps);
			}
		}
	}

	/** The iOS `Driver` for a leased simulator, over its (possibly just-spawned) helper daemon. Closing it only disconnects. */
	async connectHelper(
		ctx: CommandContext,
		udid: string,
		opts: EnsureHelperOptions = {},
		extras: { networkProxy?: NetworkProxyPort; clockRecorder?: ClockRecorder } = {}
	): Promise<Result<Driver, UiError>> {
		const helper = await this.ensureHelper(ctx, udid, { ...opts, keepClient: true });
		if (!helper.success) return helper;
		const { client, socketPath } = helper.data;
		const { iosDriverOpener } = await import("@delacour/warden-driver-ios/ios-driver");
		const driver = await iosDriverOpener.open({
			udid,
			exec: ctx.exec,
			socketPath,
			...(client ? { client } : {}),
			...(opts.helperPath !== undefined ? { helperPath: opts.helperPath } : {}),
			...(extras.networkProxy ? { networkProxy: extras.networkProxy } : {}),
			...(extras.clockRecorder ? { clockRecorder: extras.clockRecorder } : {}),
			now: ctx.now,
		});
		if (driver.success) return driver;
		await client?.close();
		return { success: false, error: opErrors.driverError(driver.error) };
	}

	private async waitUntil(
		done: () => boolean,
		ms: number,
		deps: Pick<HelperDeps<HelperClient>, "now" | "sleep">
	): Promise<boolean> {
		const until = deps.now() + ms;
		while (!done()) {
			if (deps.now() >= until) return false;
			await deps.sleep(STOP_POLL_MS);
		}
		return true;
	}

	/** Which file sits at `path` (device + inode + birth time, so a re-created file with a reused inode differs). */
	private fileIdentity(path: string): string | undefined {
		try {
			const st = statSync(path);
			return `${st.dev}:${st.ino}:${st.birthtimeMs || st.ctimeMs}`;
		} catch {
			return undefined;
		}
	}

	/**
	 * Stop a device's helper and forget it. Idempotent: nothing running is a no-op. Takes the `simd_spawn:<udid>` row
	 * first (waiting ≤ 1 s for a live spawner; without a store, or after that, it goes on without the row), so a
	 * concurrent `ensureHelper` cannot spawn into the stop. Sends `shutdown`, waits ≤ 2 s for the socket to go (or the
	 * recorded pid to die), else SIGTERMs the pid. Then it unlinks the socket only if it is still the file it found, and
	 * drops `helper` from `state.json` only if it still names the pid it stopped: a helper that took the path or the
	 * record meanwhile is left alone. Never throws.
	 */
	readonly stopHelper = async (
		host: StopHost,
		udid: string,
		opts: { socketPath?: string; deps?: HelperDeps } = {}
	): Promise<StopOutcome> => {
		return this.stopHelperOf(SIMD_KIND, host, udid, opts.deps ?? defaultHelperDeps, opts);
	};

	/** `stopHelper` for any helper kind. */
	async stopHelperOf<C extends HelperClient>(
		kind: HelperKind,
		host: StopHost,
		udid: string,
		deps: HelperDeps<C>,
		opts: { socketPath?: string } = {}
	): Promise<StopOutcome> {
		const store = host.store;
		const rowHost = store !== undefined ? { ...host, store } : undefined;
		let claimed = false;
		try {
			if (rowHost !== undefined) {
				claimed = await this.waitUntil(() => this.claimSpawnRow(rowHost, kind, udid, deps), STOP_ROW_WAIT_MS, deps);
			}
			return await this.stopRecorded(host, kind, udid, { ...opts, deps });
		} catch {
			return { stopped: false, how: "none" };
		} finally {
			if (claimed && rowHost !== undefined) {
				try {
					this.releaseSpawnRow(rowHost, kind, udid, deps);
				} catch {
					// never throws
				}
			}
		}
	}

	/**
	 * Ask the helper on `socketPath` (when there is a socket) to shut down and wait ≤ 2 s for `gone`; then SIGTERM `pid`
	 * (only if it is still the helper by its `marks`) and wait a little more.
	 */
	private async shutDown<C extends HelperClient>(
		deps: HelperDeps<C>,
		target: { socketPath: string | undefined; pid: number | undefined; marks: string[]; gone: () => boolean }
	): Promise<StopOutcome["how"]> {
		const attached = target.socketPath !== undefined ? await deps.connect(target.socketPath) : undefined;
		if (attached?.success) {
			await attached.data.request("shutdown", {}, { timeoutMs: SHUTDOWN_REQUEST_MS });
			await attached.data.close();
		}
		if (await this.waitUntil(target.gone, SHUTDOWN_WAIT_MS - (attached?.success ? SHUTDOWN_REQUEST_MS : 0), deps)) {
			return "shutdown";
		}
		if (target.pid !== undefined && processIdentity.safeToSignal(deps, target.pid, target.marks))
			deps.kill(target.pid, "SIGTERM");
		await this.waitUntil(target.gone, KILL_WAIT_MS, deps);
		return "sigterm";
	}

	/** `stopHelper`'s work, for a caller that already holds the spawn row (or has none to take). */
	private async stopRecorded<C extends HelperClient>(
		host: StopHost,
		kind: HelperKind,
		udid: string,
		opts: { socketPath?: string; deps: HelperDeps<C> }
	): Promise<StopOutcome> {
		const { deps } = opts;
		const record = uiStatePersistence.readState(host, udid)[kind.field];
		const socketPath = opts.socketPath ?? record?.socket ?? this.socketPathOf(kind, host, udid);
		const found = this.fileIdentity(socketPath);
		// a recorded pid now running another program (reused) is not the helper: never waited on, never signalled
		const marks = kind.marks(udid, record?.socket ?? socketPath);
		// alive but its command line unreadable: it may still be the helper, so it is neither signalled nor forgotten,
		// whether or not its socket file is there (no socket file must not read as "already gone")
		if (record !== undefined && processIdentity.recordedIdentity(deps, record.pid, marks) === "unknown") {
			return {
				stopped: false,
				how: "none",
				warning: `could not stop ${kind.label} (pid ${record.pid}): its command line could not be read, so it was left running`,
			};
		}
		const ours = record !== undefined && processIdentity.mayBeRecorded(deps, record.pid, marks);
		const running = found !== undefined || ours;
		if (!running) {
			this.forgetRecorded(host, kind, udid, record);
			return { stopped: false, how: "none" };
		}
		const gone = () =>
			found === undefined ||
			this.fileIdentity(socketPath) !== found ||
			(record !== undefined && (!ours || !deps.pidAlive(record.pid)));
		const how = await this.shutDown(deps, {
			socketPath: found !== undefined ? socketPath : undefined,
			pid: record?.pid,
			marks,
			gone,
		});
		if (found !== undefined && this.fileIdentity(socketPath) === found) this.unlinkQuietly(socketPath);
		this.forgetRecorded(host, kind, udid, record);
		return { stopped: true, how };
	}

	/** Drop `record` from `state.json`, but only while it is still the recorded helper (a newer one is kept). */
	private forgetRecorded(host: StopHost, kind: HelperKind, udid: string, record: HelperRecord | undefined): void {
		if (record !== undefined) this.forgetHelper(host, kind, udid, record.pid);
	}

	/** Drop the helper record if it still names `pid`, re-read under the store's lock (`updateState`). */
	private forgetHelper(host: StopHost, kind: HelperKind, udid: string, pid: number): void {
		uiStatePersistence.updateState(host, udid, (state) =>
			state[kind.field]?.pid !== pid ? state : this.withRecord(state, kind.field, undefined)
		);
	}

	helperStatus(
		host: Pick<CommandContext, "env">,
		udid: string,
		deps: Pick<HelperDeps, "pidAlive" | "command"> = defaultHelperDeps,
		kind: HelperKind = SIMD_KIND
	): HelperStatus {
		const record = uiStatePersistence.readState(host, udid)[kind.field];
		if (record === undefined) return { running: false, pid: null, socket: null };
		const alive = processIdentity.mayBeRecorded(deps, record.pid, kind.marks(udid, record.socket));
		return { running: alive && existsSync(record.socket), pid: record.pid, socket: record.socket };
	}

	/**
	 * gc: drop helper sockets nobody serves any more. A device whose recorded helper pid is dead loses its
	 * socket file and its `state.json` record; so does a `$WARDEN_HOME/simd/<udid>.sock` whose record says dead.
	 * Sockets with no record at all are left alone (we can't tell whose they are). Returns removed socket paths.
	 */
	sweepDeadHelpers(
		host: Pick<CommandContext, "env" | "now">,
		deps: Pick<HelperDeps, "pidAlive"> = defaultHelperDeps
	): string[] {
		const removed: string[] = [];
		for (const udid of uiHelperSweep.knownUdids(host)) {
			const state = uiStatePersistence.readState(host, udid);
			for (const kind of HELPER_KINDS) {
				const record = state[kind.field];
				if (record === undefined || deps.pidAlive(record.pid)) continue;
				if (existsSync(record.socket)) removed.push(record.socket);
				this.unlinkQuietly(record.socket);
				this.forgetHelper(host, kind, udid, record.pid);
			}
		}
		return removed;
	}

	/** `ensureHelper` for an Android serial: its resident `warden __android-host`. */
	ensureAndroidHost(
		host: HelperHost & Required<Pick<HelperHost, "store">>,
		serial: string,
		opts: EnsureHelperOptions<RemoteClient> = {}
	): Promise<Result<HelperInfo<RemoteClient>, UiError>> {
		return this.ensureHelperOf(ANDROID_HOST_KIND, host, serial, opts.deps ?? defaultAndroidHostDeps, opts);
	}

	/**
	 * The Android `Driver` for a leased emulator, over its (possibly just-spawned) resident host, which keeps the adb
	 * shell, `warden-uiad` and the animation scales between `warden ui` calls. Closing it only disconnects.
	 */
	async connectAndroidHost(
		ctx: CommandContext,
		serial: string,
		opts: EnsureHelperOptions<RemoteClient> = {}
	): Promise<Result<Driver, UiError>> {
		const host = await this.ensureAndroidHost(ctx, serial, { ...opts, keepClient: true });
		if (!host.success) return host;
		const { client } = host.data;
		if (client === undefined) return this.unavailable(`${ANDROID_HOST_KIND.label} answered without a client`);
		return resultFactory.ok(client.driver());
	}

	/** `stopHelper` for an Android serial's resident host. */
	readonly stopAndroidHost = (
		host: StopHost,
		serial: string,
		opts: { socketPath?: string; deps?: HelperDeps<RemoteClient> } = {}
	): Promise<StopOutcome> => {
		return this.stopHelperOf(ANDROID_HOST_KIND, host, serial, opts.deps ?? defaultAndroidHostDeps, opts);
	};

	/**
	 * `ensureHelper` for a physical iPhone: its resident `warden __ios-runner-host`, which keeps `xcodebuild` running the
	 * XCUITest runner on the phone and proxies its wire to `$WARDEN_HOME/ios-runner/<udid>.sock`. The socket speaks the
	 * `warden-simd` protocol, so the client is the same `SimdClient`.
	 */
	ensureIosRunner(
		host: CommandContext,
		udid: string,
		opts: EnsureHelperOptions = {}
	): Promise<Result<HelperInfo, UiError>> {
		return this.ensureHelperOf(IOS_RUNNER_KIND, host, udid, opts.deps ?? this.iosRunnerDeps(host), opts);
	}

	/**
	 * `defaultHelperDeps` plus the runner identity: a resident host that serves an older runner build (new warden, edited
	 * runner sources) is replaced by the next client, unless the phone is leased to another session (`device_busy`).
	 */
	private iosRunnerDeps(host: CommandContext): HelperDeps {
		return {
			...defaultHelperDeps,
			runner: {
				expected: async () => (await import("../ios-runner/identity")).runnerIdentity.expectedRunnerIdentity(host),
				served: (socketPath) => servedIdentity.readServedIdentity(socketPath),
				caller: async () => {
					const { ownerResolver } = await import("@delacour/warden-leasing/owner");
					return this.ownerKey(ownerResolver.resolve(host));
				},
				note: (line) => host.err(line),
			},
		};
	}

	/**
	 * The physical-iPhone `Driver` for a leased phone, over its (possibly just-spawned) runner host. The app under test is
	 * `WARDEN_BUNDLE_ID`, `WARDEN_APP_PATH` is what `clearData` reinstalls, and only bundles warden installed on this phone
	 * (`installs` table) may be uninstalled. Closing it only disconnects; the host stays resident until its idle timeout.
	 */
	async connectIosRunner(
		ctx: CommandContext,
		udid: string,
		opts: EnsureHelperOptions = {}
	): Promise<Result<Driver, UiError>> {
		const host = await this.ensureIosRunner(ctx, udid, { ...opts, keepClient: true });
		if (!host.success) return host;
		const { client, socketPath } = host.data;
		const { iosDeviceDriverOpener } = await import("@delacour/warden-driver-ios/device/device-driver");
		const bundleId = ctx.env.WARDEN_BUNDLE_ID?.trim();
		const appPath = ctx.env.WARDEN_APP_PATH?.trim();
		const driver = await iosDeviceDriverOpener.open({
			udid,
			exec: ctx.exec,
			socketPath,
			...(client ? { client } : {}),
			...(bundleId ? { bundleId } : {}),
			...(appPath ? { appPath } : {}),
			ownedBundles: new BuildsTable(ctx.store()).installedBundleIds("ios", udid),
			now: ctx.now,
		});
		if (driver.success) return driver;
		await client?.close();
		return { success: false, error: opErrors.driverError(driver.error) };
	}

	/** `stopHelper` for a physical iPhone's runner host. */
	readonly stopIosRunner = (
		host: StopHost,
		udid: string,
		opts: { socketPath?: string; deps?: HelperDeps } = {}
	): Promise<StopOutcome> => {
		return this.stopHelperOf(IOS_RUNNER_KIND, host, udid, opts.deps ?? defaultHelperDeps, opts);
	};
}

export const uiHelper = new UiHelper();

export const defaultHelperDeps: HelperDeps<SimdClient> = {
	connect: async (socketPath, options) =>
		(await import("@delacour/warden-driver-ios/simd-client")).simdClients.connect({
			socketPath,
			readyTimeoutMs: 2000,
			...(options?.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: options.defaultTimeoutMs } : {}),
		}),
	spawnDetached: ({ cmd, logPath, signalMs }) => {
		const log = openSync(logPath, "a");
		try {
			const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: log, detached: true });
			proc.unref();
			return { pid: proc.pid, signal: uiHelper.watchStart(proc.stdout, { logPath, timeoutMs: signalMs }) };
		} finally {
			closeSync(log);
		}
	},
	pidAlive: liveness.processAlive,
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
	command: processCommand,
};

export const SIMD_KIND: HelperKind = {
	label: "warden-simd",
	platform: "ios",
	rowPrefix: "simd_spawn",
	dir: cliUiPaths.simdDir,
	socketTag: "wsimd",
	field: "helper",
	envKey: uiHelper.simdEnvKey,
	idleEnv: IDLE_TIMEOUT_ENV,
	timeoutEnv: REQUEST_TIMEOUT_ENV,
	marks: (udid, socket) => [`--udid ${udid}`, `--socket ${socket}`],
	locate: (host, udid, opts, deps) => uiHelper.locateHelperBinary(host, udid, opts, deps),
	command: ({ binary, id, socket, idleSeconds }) => {
		const resources = join(binary, "..", "Resources");
		return [
			binary,
			"--udid",
			id,
			"--socket",
			socket,
			"--idle-timeout",
			String(idleSeconds),
			...(existsSync(resources) ? ["--resources", resources] : []),
		];
	},
	hint: "run `warden doctor` to check the iOS driver helper",
};

export const ANDROID_HOST_KIND: HelperKind = {
	label: "warden android host",
	platform: "android",
	rowPrefix: "android_host_spawn",
	dir: cliUiPaths.androidHostDir,
	socketTag: "wahost",
	field: "androidHost",
	envKey: uiHelper.androidHostEnvKey,
	idleEnv: ANDROID_HOST_IDLE_TIMEOUT_ENV,
	marks: (serial, socket) => [`--serial ${serial}`, `--socket ${socket}`],
	locate: (_host, _serial, _opts, deps) => {
		const self = (deps.self ?? selfCommandHelpers.selfCommand.bind(selfCommandHelpers))();
		const binary = self[self.length - 1];
		return binary === undefined
			? {
					success: false,
					error: { code: "E_HELPER_MISSING", message: "cannot tell how to re-run warden", retryable: false },
				}
			: resultFactory.ok(binary);
	},
	command: ({ id, socket, idleSeconds, self }) => [
		...self,
		ANDROID_HOST_SUBCOMMAND,
		"--serial",
		id,
		"--socket",
		socket,
		"--idle-timeout",
		String(idleSeconds),
	],
	hint: "run with WARDEN_ANDROID_HOST=0 to drive the emulator without the resident host",
};

export const IOS_RUNNER_KIND: HelperKind = {
	label: "warden iOS runner host",
	platform: "ios",
	rowPrefix: "ios_runner_spawn",
	dir: cliUiPaths.iosRunnerDir,
	socketTag: "wirun",
	field: "iosRunner",
	envKey: uiHelper.iosRunnerEnvKey,
	idleEnv: IOS_RUNNER_IDLE_TIMEOUT_ENV,
	marks: (udid, socket) => [`--udid ${udid}`, `--socket ${socket}`],
	locate: (_host, _udid, _opts, deps) => {
		const self = (deps.self ?? selfCommandHelpers.selfCommand.bind(selfCommandHelpers))();
		const binary = self[self.length - 1];
		return binary === undefined
			? {
					success: false,
					error: { code: "E_HELPER_MISSING", message: "cannot tell how to re-run warden", retryable: false },
				}
			: resultFactory.ok(binary);
	},
	command: ({ id, socket, idleSeconds, self }) => [
		...self,
		IOS_RUNNER_SUBCOMMAND,
		"--udid",
		id,
		"--socket",
		socket,
		"--idle-timeout",
		String(idleSeconds),
	],
	hint: "unlock the phone and run `warden doctor`; the last lines of the log say why the runner did not start",
	startupMs: IOS_RUNNER_STARTUP_MS,
};

const HELPER_KINDS: readonly HelperKind[] = [SIMD_KIND, ANDROID_HOST_KIND, IOS_RUNNER_KIND];

export const defaultAndroidHostDeps: HelperDeps<RemoteClient> = {
	...defaultHelperDeps,
	connect: async (socketPath, options) =>
		(await import("@delacour/warden-device/remote/remote-client")).remoteDriverConnector.connect({
			socketPath,
			readyTimeoutMs: 2000,
			...(options?.defaultTimeoutMs !== undefined ? { requestTimeoutMs: options.defaultTimeoutMs } : {}),
		}),
};

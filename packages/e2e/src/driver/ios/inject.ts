import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { injectStatePath as coreInjectStatePath } from "@delacour/warden-core/conditions/inject-state";
import type { Result } from "@delacour/warden-types/result";
import type { DriverError } from "../driver.types";
import { driverError } from "../errors";
import type { ProxyAddress } from "../network-proxy";

/**
 * The injected dylib for iOS simulator apps (`native/ios-inject`): routes NSURLSession through the lease's shaping
 * proxy and reports offline / a clock offset to the app, live, through a state file the dylib watches. This module is
 * the host side: where the dylib is, the launch env that loads it, and the state file protocol. COND-12 (mock clock)
 * reuses all of it and only sets `clockOffsetMs` (shift) or `clockFrozenMs` (hold).
 */

export const INJECT_DYLIB = "libwarden-inject.dylib";
export const INJECT_DYLIB_ENV = "WARDEN_INJECT_DYLIB";

/**
 * The one message of the control channel. `seq` rises with every write (the dylib ignores a state whose `seq` it
 * already applied); a field left out means "off" (`offline` false, `clockOffsetMs` 0), so a message is always the
 * whole state, never a delta. `clockFrozenMs` (ms since the epoch) holds the wall clocks at one instant and wins over
 * `clockOffsetMs`; left out, they run.
 */
export type InjectState = {
	seq: number;
	offline?: boolean;
	clockOffsetMs?: number;
	clockFrozenMs?: number;
	/** one-shot request (A11Y-1): walk the accessibility tree and write `<state>.a11y` before acknowledging this `seq` */
	a11yRead?: boolean;
};

/** What the dylib answers in `<state>.ack` once it applied `seq` (`bundleId`: the app it loaded into). */
export type InjectAck = { seq: number; pid: number; proxy?: boolean; bundleId?: string };

export function encodeInjectState(state: InjectState): string {
	return JSON.stringify({
		seq: state.seq,
		offline: state.offline === true,
		clockOffsetMs: Math.trunc(state.clockOffsetMs ?? 0),
		...(state.clockFrozenMs === undefined ? {} : { clockFrozenMs: Math.trunc(state.clockFrozenMs) }),
		...(state.a11yRead ? { a11yRead: true } : {}),
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseInjectState(text: string): InjectState | undefined {
	try {
		const data: unknown = JSON.parse(text);
		if (!isRecord(data) || typeof data.seq !== "number") return undefined;
		return {
			seq: data.seq,
			offline: data.offline === true,
			clockOffsetMs: typeof data.clockOffsetMs === "number" ? data.clockOffsetMs : 0,
			...(typeof data.clockFrozenMs === "number" ? { clockFrozenMs: data.clockFrozenMs } : {}),
			...(data.a11yRead === true ? { a11yRead: true } : {}),
		};
	} catch {
		return undefined;
	}
}

export function parseInjectAck(text: string): InjectAck | undefined {
	try {
		const data: unknown = JSON.parse(text);
		if (!isRecord(data) || typeof data.seq !== "number" || typeof data.pid !== "number") return undefined;
		return {
			seq: data.seq,
			pid: data.pid,
			proxy: data.proxy === true,
			...(typeof data.bundle === "string" ? { bundleId: data.bundle } : {}),
		};
	} catch {
		return undefined;
	}
}

/** One directory per device: the dylib watches its directory, so two devices never wake each other's app. Core owns the path (release resets the file). */
export const injectStatePath: (wardenHome: string, udid: string) => string = coreInjectStatePath;

/** Where the dylib writes an accessibility read (`a11yRead`): next to the state file. */
export const injectA11yPath = (statePath: string): string => `${statePath}.a11y`;

/** Where the dylib appends accessibility events (A11Y-8): JSON lines next to the state file. */
export const injectEventsPath = (statePath: string): string => `${statePath}.events`;

export const injectAckPath = (statePath: string): string => `${statePath}.ack`;

/**
 * Launch env that loads the dylib. `proxy` is fixed for the life of the process (the lease's proxy keeps its port
 * for the whole lease); everything that changes later goes through the state file.
 */
export function injectLaunchEnv(input: {
	dylib: string;
	statePath: string;
	proxy?: ProxyAddress;
	clockOffsetMs?: number;
	clockFrozenMs?: number;
	debug?: boolean;
}): Record<string, string> {
	return {
		DYLD_INSERT_LIBRARIES: input.dylib,
		WARDEN_INJECT_STATE: input.statePath,
		...(input.proxy ? { WARDEN_NET_PROXY: `${input.proxy.host}:${input.proxy.port}` } : {}),
		...(input.clockOffsetMs ? { WARDEN_CLOCK_OFFSET_MS: String(Math.trunc(input.clockOffsetMs)) } : {}),
		...(input.clockFrozenMs === undefined ? {} : { WARDEN_CLOCK_FROZEN_MS: String(Math.trunc(input.clockFrozenMs)) }),
		...(input.debug ? { WARDEN_INJECT_DEBUG: "1" } : {}),
	};
}

/**
 * Whether a launch loads the dylib. Never without a reason: a run with no condition keeps the plain launch (no
 * dyld insertion, no watcher thread, no proxy hop).
 */
export function shouldInject(input: {
	/** the lease has a live shaping proxy, or a non-trivial network condition was set */
	networkActive: boolean;
	/** a clock offset is set (COND-12) */
	clockActive: boolean;
	/** the caller asked for injection (`LaunchOptions.inject`, a suite that declares `conditions.network`) */
	requested: boolean;
}): boolean {
	return input.networkActive || input.clockActive || input.requested;
}

export type LocateInjectInput = {
	/** `WARDEN_INJECT_DYLIB` (a file) and `WARDEN_HELPER_DIR` (a directory that also holds the dylib) */
	env: Readonly<Record<string, string | undefined>>;
	execPath: string;
	/** directory of this module (`packages/e2e/src/driver/ios`) */
	importDir: string;
	wardenHome: string;
	version?: string;
	exists: (path: string) => boolean;
	realpath?: (path: string) => string;
};

/**
 * Find `libwarden-inject.dylib`. Order mirrors `locateHelper`: `WARDEN_INJECT_DYLIB` → `WARDEN_HELPER_DIR` → next to
 * the running `warden` → `<packages/e2e>/native/dist` → `$WARDEN_HOME/simd/<version>`. A set variable that points at
 * nothing is an error.
 */
export function locateInjectDylib(input: LocateInjectInput): Result<string, DriverError> {
	const tried: string[] = [];
	const missing = (message: string): Result<string, DriverError> => ({
		success: false,
		error: driverError("E_HELPER_MISSING", `${message}; build it with \`bun run --cwd packages/e2e native:inject\``, {
			detail: { tried },
		}),
	});
	const explicit = input.env[INJECT_DYLIB_ENV];
	if (explicit) {
		tried.push(explicit);
		return input.exists(explicit)
			? { success: true, data: explicit }
			: missing(`${INJECT_DYLIB_ENV}=${explicit} does not exist`);
	}
	const helperDir = input.env.WARDEN_HELPER_DIR;
	if (helperDir) {
		const candidate = join(helperDir, INJECT_DYLIB);
		tried.push(candidate);
		return input.exists(candidate)
			? { success: true, data: candidate }
			: missing(`WARDEN_HELPER_DIR=${helperDir} has no ${INJECT_DYLIB}`);
	}
	const real = (path: string): string => {
		try {
			return (input.realpath ?? ((p: string) => p))(path);
		} catch {
			return path;
		}
	};
	const candidates = [
		join(dirname(real(input.execPath)), INJECT_DYLIB),
		resolve(input.importDir, "../../../native/dist", INJECT_DYLIB),
		...(input.version ? [join(input.wardenHome, "simd", input.version, INJECT_DYLIB)] : []),
	];
	for (const candidate of candidates) {
		tried.push(candidate);
		if (input.exists(candidate)) return { success: true, data: candidate };
	}
	return missing(`${INJECT_DYLIB} not found (tried ${tried.join(", ")})`);
}

/** File operations of the state channel, injected. */
export type InjectFs = {
	mkdir(path: string): void;
	/** write `text` to `path` so a reader sees all of it or none (tmp + rename) */
	writeAtomic(path: string, text: string): void;
	read(path: string): string | undefined;
	remove(path: string): void;
	/** is `pid` a live process */
	pidAlive(pid: number): boolean;
};

export const nodeInjectFs: InjectFs = {
	mkdir: (path) => void mkdirSync(path, { recursive: true }),
	writeAtomic(path, text) {
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, text);
		renameSync(tmp, path);
	},
	read(path) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	},
	remove: (path) => rmSync(path, { force: true }),
	pidAlive(pid) {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	},
};

/** The host end of the control channel for one device. */
export type InjectChannel = {
	readonly statePath: string;
	/** Last state written (read back from disk, so another warden process's writes count). */
	current(): InjectState;
	/** Write the whole next state (`seq` assigned here). */
	write(next: Omit<InjectState, "seq">): InjectState;
	/** The injected process that answered last, when it is still alive and is the app under test. */
	attached(): InjectAck | undefined;
	/** Wait until the app acknowledged `seq`; `false` on timeout. */
	acked(seq: number, timeoutMs: number): Promise<boolean>;
	/** Forget the state and ack of a previous app (before a launch). */
	reset(): void;
};

export function createInjectChannel(input: {
	statePath: string;
	fs?: InjectFs;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	/** the app under test; an ack from another app (another injected bundle still running) is ignored. None = any */
	bundleId?: () => string | undefined;
}): InjectChannel {
	const fs = input.fs ?? nodeInjectFs;
	const { statePath, now, sleep } = input;
	const ackPath = injectAckPath(statePath);
	const readState = (): InjectState => {
		const text = fs.read(statePath);
		return (text ? parseInjectState(text) : undefined) ?? { seq: 0 };
	};
	const readAck = (): InjectAck | undefined => {
		const text = fs.read(ackPath);
		const ack = text ? parseInjectAck(text) : undefined;
		if (!ack || !fs.pidAlive(ack.pid)) return undefined;
		const want = input.bundleId?.();
		return want && ack.bundleId && ack.bundleId !== want ? undefined : ack;
	};
	return {
		statePath,
		current: readState,
		write(next) {
			fs.mkdir(dirname(statePath));
			const state: InjectState = { ...next, seq: Math.max(readState().seq + 1, Math.trunc(now())) };
			fs.writeAtomic(statePath, encodeInjectState(state));
			return state;
		},
		attached: readAck,
		async acked(seq, timeoutMs) {
			const deadline = now() + timeoutMs;
			for (;;) {
				const ack = readAck();
				if (ack && ack.seq >= seq) return true;
				if (now() >= deadline) return false;
				await sleep(20);
			}
		},
		reset() {
			fs.remove(ackPath);
			fs.remove(statePath);
			fs.remove(injectEventsPath(statePath));
		},
	};
}

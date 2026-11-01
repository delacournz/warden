import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { injectState } from "@delacour/warden-core/conditions/inject-state";
import type { DriverError } from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import type { ProxyAddress } from "@delacour/warden-driver/network-proxy";
import type { Result } from "@delacour/warden-types/result";

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
export type InjectState = { seq: number; offline?: boolean; clockOffsetMs?: number; clockFrozenMs?: number };

/** What the dylib answers in `<state>.ack` once it applied `seq` (`bundleId`: the app it loaded into). */
export type InjectAck = { seq: number; pid: number; proxy?: boolean; bundleId?: string };

export type InjectLaunchInput = {
	dylib: string;
	statePath: string;
	proxy?: ProxyAddress;
	clockOffsetMs?: number;
	clockFrozenMs?: number;
	debug?: boolean;
};

export type ShouldInjectInput = {
	/** the lease has a live shaping proxy, or a non-trivial network condition was set */
	networkActive: boolean;
	/** a clock offset is set (COND-12) */
	clockActive: boolean;
	/** the caller asked for injection (`LaunchOptions.inject`, a suite that declares `conditions.network`) */
	requested: boolean;
};

export type LocateInjectInput = {
	/** `WARDEN_INJECT_DYLIB` (a file) and `WARDEN_HELPER_DIR` (a directory that also holds the dylib) */
	env: Readonly<Record<string, string | undefined>>;
	execPath: string;
	/** directory of this module (`packages/driver-ios/src`) */
	importDir: string;
	wardenHome: string;
	version?: string;
	exists: (path: string) => boolean;
	realpath?: (path: string) => string;
};

/** The host side of the inject protocol: state encoding, paths, launch env, dylib lookup. Use the shared {@link injectProtocol} singleton. */
export class InjectProtocol {
	encodeState(state: InjectState): string {
		return JSON.stringify({
			seq: state.seq,
			offline: state.offline === true,
			clockOffsetMs: Math.trunc(state.clockOffsetMs ?? 0),
			...(state.clockFrozenMs === undefined ? {} : { clockFrozenMs: Math.trunc(state.clockFrozenMs) }),
		});
	}

	parseState(text: string): InjectState | undefined {
		try {
			const data: unknown = JSON.parse(text);
			if (!this.isRecord(data) || typeof data.seq !== "number") return undefined;
			return {
				seq: data.seq,
				offline: data.offline === true,
				clockOffsetMs: typeof data.clockOffsetMs === "number" ? data.clockOffsetMs : 0,
				...(typeof data.clockFrozenMs === "number" ? { clockFrozenMs: data.clockFrozenMs } : {}),
			};
		} catch {
			return undefined;
		}
	}

	parseAck(text: string): InjectAck | undefined {
		try {
			const data: unknown = JSON.parse(text);
			if (!this.isRecord(data) || typeof data.seq !== "number" || typeof data.pid !== "number") return undefined;
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
	statePath(wardenHome: string, udid: string): string {
		return injectState.path(wardenHome, udid);
	}

	ackPath(statePath: string): string {
		return `${statePath}.ack`;
	}

	/**
	 * Launch env that loads the dylib. `proxy` is fixed for the life of the process (the lease's proxy keeps its port
	 * for the whole lease); everything that changes later goes through the state file.
	 */
	launchEnv(input: InjectLaunchInput): Record<string, string> {
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
	shouldInject(input: ShouldInjectInput): boolean {
		return input.networkActive || input.clockActive || input.requested;
	}

	/**
	 * Find `libwarden-inject.dylib`. Order mirrors `locateHelper`: `WARDEN_INJECT_DYLIB` → `WARDEN_HELPER_DIR` → next to
	 * the running `warden` → `<packages/driver-ios>/native/dist` → `$WARDEN_HOME/simd/<version>`. A set variable that points at
	 * nothing is an error.
	 */
	locateDylib(input: LocateInjectInput): Result<string, DriverError> {
		const tried: string[] = [];
		const explicit = input.env[INJECT_DYLIB_ENV];
		if (explicit) {
			tried.push(explicit);
			return input.exists(explicit)
				? { success: true, data: explicit }
				: this.missing(tried, `${INJECT_DYLIB_ENV}=${explicit} does not exist`);
		}
		const helperDir = input.env.WARDEN_HELPER_DIR;
		if (helperDir) {
			const candidate = join(helperDir, INJECT_DYLIB);
			tried.push(candidate);
			return input.exists(candidate)
				? { success: true, data: candidate }
				: this.missing(tried, `WARDEN_HELPER_DIR=${helperDir} has no ${INJECT_DYLIB}`);
		}
		const candidates = [
			join(dirname(this.real(input, input.execPath)), INJECT_DYLIB),
			resolve(input.importDir, "../native/dist", INJECT_DYLIB),
			...(input.version ? [join(input.wardenHome, "simd", input.version, INJECT_DYLIB)] : []),
		];
		for (const candidate of candidates) {
			tried.push(candidate);
			if (input.exists(candidate)) return { success: true, data: candidate };
		}
		return this.missing(tried, `${INJECT_DYLIB} not found (tried ${tried.join(", ")})`);
	}

	private missing(tried: string[], message: string): Result<string, DriverError> {
		return {
			success: false,
			error: driverErrors.make(
				"E_HELPER_MISSING",
				`${message}; build it with \`bun run --cwd packages/driver-ios native:inject\``,
				{
					detail: { tried },
				}
			),
		};
	}

	private real(input: LocateInjectInput, path: string): string {
		try {
			return (input.realpath ?? ((p: string) => p))(path);
		} catch {
			return path;
		}
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}
}

export const injectProtocol = new InjectProtocol();

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

/** {@link InjectFs} over `node:fs`. */
export class NodeInjectFs implements InjectFs {
	mkdir(path: string): void {
		mkdirSync(path, { recursive: true });
	}

	writeAtomic(path: string, text: string): void {
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, text);
		renameSync(tmp, path);
	}

	read(path: string): string | undefined {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	}

	remove(path: string): void {
		rmSync(path, { force: true });
	}

	pidAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}
}

export const nodeInjectFs: InjectFs = new NodeInjectFs();

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

export type InjectChannelInput = {
	statePath: string;
	fs?: InjectFs;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	/** the app under test; an ack from another app (another injected bundle still running) is ignored. None = any */
	bundleId?: () => string | undefined;
};

/** The state-file {@link InjectChannel}. */
export class FileInjectChannel implements InjectChannel {
	readonly statePath: string;
	private readonly fs: InjectFs;
	private readonly ackPath: string;

	constructor(private readonly input: InjectChannelInput) {
		this.fs = input.fs ?? nodeInjectFs;
		this.statePath = input.statePath;
		this.ackPath = injectProtocol.ackPath(input.statePath);
	}

	current = (): InjectState => {
		const text = this.fs.read(this.statePath);
		return (text ? injectProtocol.parseState(text) : undefined) ?? { seq: 0 };
	};

	write(next: Omit<InjectState, "seq">): InjectState {
		this.fs.mkdir(dirname(this.statePath));
		const state: InjectState = { ...next, seq: Math.max(this.current().seq + 1, Math.trunc(this.input.now())) };
		this.fs.writeAtomic(this.statePath, injectProtocol.encodeState(state));
		return state;
	}

	attached = (): InjectAck | undefined => {
		const text = this.fs.read(this.ackPath);
		const ack = text ? injectProtocol.parseAck(text) : undefined;
		if (!ack || !this.fs.pidAlive(ack.pid)) return undefined;
		const want = this.input.bundleId?.();
		return want && ack.bundleId && ack.bundleId !== want ? undefined : ack;
	};

	async acked(seq: number, timeoutMs: number): Promise<boolean> {
		const deadline = this.input.now() + timeoutMs;
		for (;;) {
			const ack = this.attached();
			if (ack && ack.seq >= seq) return true;
			if (this.input.now() >= deadline) return false;
			await this.input.sleep(20);
		}
	}

	reset(): void {
		this.fs.remove(this.ackPath);
		this.fs.remove(this.statePath);
	}
}

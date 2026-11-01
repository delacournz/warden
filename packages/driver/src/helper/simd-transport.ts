import type { Result } from "@delacour/warden-types/result";
import type { DriverError } from "../driver.types";
import { driverErrors } from "../errors";
import { LineSplitter } from "./simd-protocol";

/**
 * The byte pipe under `simd-client`: a spawned helper's stdio or a unix socket. A transport only
 * frames lines and reports closure; ids, timeouts and respawn live in the client.
 */

export type TransportClose = { exitCode: number | null; stderrTail: string[] };

export type TransportHandlers = {
	onLine(line: string): void;
	/** helper stderr (stdio mode) */
	onDiagnostic(line: string): void;
	onClose(info: TransportClose): void;
};

export type Transport = {
	send(data: string): void;
	/** graceful: stop input, wait for exit up to the grace period, then kill */
	close(): Promise<void>;
};

export type TransportFactory = (handlers: TransportHandlers) => Promise<Result<Transport, DriverError>>;

// ---------- stdio ----------

/** The slice of a child process the stdio transport needs; tests and `simdTransports.spawn` provide it. */
export type SimdProcess = {
	write(data: string): void;
	/** close stdin */
	end(): void;
	kill(): void;
	stdout: ReadableStream<Uint8Array>;
	stderr?: ReadableStream<Uint8Array>;
	exited: Promise<number>;
};

export type SimdSpawn = (cmd: readonly string[]) => SimdProcess;

const STDERR_TAIL = 20;
const DEFAULT_GRACE_MS = 1500;

type StdioOptions = {
	cmd: readonly string[];
	spawn?: SimdSpawn;
	/** how long `close()` waits for the helper to exit after closing stdin before killing it */
	graceMs?: number;
};

// ---------- unix socket ----------

type SocketLike = {
	write(data: string | Uint8Array): number;
	end(): void;
};

/** One spawned helper behind the stdio transport. */
class StdioTransport implements Transport {
	constructor(
		private readonly proc: SimdProcess,
		private readonly exited: Promise<number>,
		private readonly graceMs: number
	) {}

	send(data: string): void {
		this.proc.write(data);
	}

	async close(): Promise<void> {
		try {
			this.proc.end();
		} catch {
			// stdin already closed
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), this.graceMs);
		});
		const outcome = await Promise.race([this.exited.then(() => "exited" as const), timedOut]);
		clearTimeout(timer);
		if (outcome === "timeout") {
			this.proc.kill();
			await this.exited;
		}
	}
}

/** One unix-socket connection behind the socket transport. */
class SocketTransport implements Transport {
	private socket: SocketLike | undefined;
	private queued: Uint8Array = new Uint8Array(0);
	private closedNotified = false;
	private readonly splitter = new LineSplitter();
	private readonly encoder = new TextEncoder();

	constructor(
		private readonly socketPath: string,
		private readonly handlers: TransportHandlers
	) {}

	async connect(): Promise<Result<Transport, DriverError>> {
		try {
			const connected = await Bun.connect({
				unix: this.socketPath,
				socket: {
					open: (s) => {
						this.socket = s;
					},
					data: (_s, chunk) => {
						for (const line of this.splitter.push(chunk)) this.handlers.onLine(line);
					},
					drain: () => {
						this.flush();
					},
					close: () => {
						this.notifyClosed();
					},
					error: () => {
						this.notifyClosed();
					},
					end: () => {
						this.notifyClosed();
					},
				},
			});
			this.socket = connected;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				error: driverErrors.make(
					"E_HELPER_CRASHED",
					`cannot connect to warden-simd socket ${this.socketPath}: ${reason}`,
					{ detail: { socketPath: this.socketPath } }
				),
			};
		}
		return { success: true, data: this };
	}

	send(data: string): void {
		const bytes = this.encoder.encode(data);
		const merged = new Uint8Array(this.queued.length + bytes.length);
		merged.set(this.queued, 0);
		merged.set(bytes, this.queued.length);
		this.queued = merged;
		this.flush();
	}

	async close(): Promise<void> {
		try {
			this.socket?.end();
		} catch {
			// already closed
		}
		this.notifyClosed();
	}

	private notifyClosed(): void {
		if (this.closedNotified) return;
		this.closedNotified = true;
		this.handlers.onClose({ exitCode: null, stderrTail: [] });
	}

	private flush(): void {
		if (!this.socket || this.queued.length === 0) return;
		const written = this.socket.write(this.queued);
		this.queued = written >= this.queued.length ? new Uint8Array(0) : this.queued.slice(Math.max(written, 0));
	}
}

/** Builds the transports under `simd-client`. Use the shared {@link simdTransports} singleton. */
export class SimdTransports {
	readonly spawn: SimdSpawn = (cmd) => {
		const proc = Bun.spawn([...cmd], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		return {
			write(data) {
				proc.stdin.write(data);
				proc.stdin.flush();
			},
			end() {
				proc.stdin.end();
			},
			kill() {
				proc.kill();
			},
			stdout: proc.stdout,
			stderr: proc.stderr,
			exited: proc.exited,
		};
	};

	stdio(opts: StdioOptions): TransportFactory {
		const spawn = opts.spawn ?? this.spawn;
		const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
		return async (handlers) => {
			let proc: SimdProcess;
			try {
				proc = spawn(opts.cmd);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return {
					success: false,
					error: driverErrors.make("E_HELPER_MISSING", `cannot start ${opts.cmd[0]}: ${reason}`, {
						detail: { cmd: opts.cmd },
					}),
				};
			}
			const stderrTail: string[] = [];
			const stdout = this.pump(proc.stdout, handlers.onLine);
			const stderr = proc.stderr
				? this.pump(proc.stderr, (line) => {
						stderrTail.push(line);
						if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
						handlers.onDiagnostic(line);
					})
				: Promise.resolve();
			const exited = proc.exited.catch(() => -1);
			Promise.all([stdout, stderr, exited]).then(([, , exitCode]) => {
				handlers.onClose({ exitCode, stderrTail: [...stderrTail] });
			});
			return { success: true, data: new StdioTransport(proc, exited, graceMs) };
		};
	}

	socket(opts: { socketPath: string }): TransportFactory {
		return (handlers) => new SocketTransport(opts.socketPath, handlers).connect();
	}

	private async pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
		const splitter = new LineSplitter();
		const reader = stream.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				for (const line of splitter.push(value)) onLine(line);
			}
		} catch {
			// a killed child closes its pipes mid-read
		}
		const rest = splitter.rest().trim();
		if (rest) onLine(rest);
	}
}

export const simdTransports = new SimdTransports();

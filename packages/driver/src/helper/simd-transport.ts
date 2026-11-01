import type { Result } from "@delacour/warden-types/result";
import type { DriverError } from "../driver.types";
import { driverError } from "../errors";
import { createLineSplitter } from "./simd-protocol";

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

/** The slice of a child process the stdio transport needs; tests and `bunSpawn` provide it. */
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

export const bunSpawn: SimdSpawn = (cmd) => {
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

async function pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
	const splitter = createLineSplitter();
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

const STDERR_TAIL = 20;
const DEFAULT_GRACE_MS = 1500;

export function stdioTransport(opts: {
	cmd: readonly string[];
	spawn?: SimdSpawn;
	/** how long `close()` waits for the helper to exit after closing stdin before killing it */
	graceMs?: number;
}): TransportFactory {
	const spawn = opts.spawn ?? bunSpawn;
	const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
	return async (handlers) => {
		let proc: SimdProcess;
		try {
			proc = spawn(opts.cmd);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				error: driverError("E_HELPER_MISSING", `cannot start ${opts.cmd[0]}: ${reason}`, {
					detail: { cmd: opts.cmd },
				}),
			};
		}
		const stderrTail: string[] = [];
		const stdout = pump(proc.stdout, handlers.onLine);
		const stderr = proc.stderr
			? pump(proc.stderr, (line) => {
					stderrTail.push(line);
					if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
					handlers.onDiagnostic(line);
				})
			: Promise.resolve();
		const exited = proc.exited.catch(() => -1);
		Promise.all([stdout, stderr, exited]).then(([, , exitCode]) => {
			handlers.onClose({ exitCode, stderrTail: [...stderrTail] });
		});
		return {
			success: true,
			data: {
				send: (data) => proc.write(data),
				async close() {
					try {
						proc.end();
					} catch {
						// stdin already closed
					}
					let timer: ReturnType<typeof setTimeout> | undefined;
					const timedOut = new Promise<"timeout">((resolve) => {
						timer = setTimeout(() => resolve("timeout"), graceMs);
					});
					const outcome = await Promise.race([exited.then(() => "exited" as const), timedOut]);
					clearTimeout(timer);
					if (outcome === "timeout") {
						proc.kill();
						await exited;
					}
				},
			},
		};
	};
}

// ---------- unix socket ----------

type SocketLike = {
	write(data: string | Uint8Array): number;
	end(): void;
};

export function socketTransport(opts: { socketPath: string }): TransportFactory {
	return async (handlers) => {
		const splitter = createLineSplitter();
		const encoder = new TextEncoder();
		let socket: SocketLike | undefined;
		let queued: Uint8Array = new Uint8Array(0);
		let closedNotified = false;
		const notifyClosed = () => {
			if (closedNotified) return;
			closedNotified = true;
			handlers.onClose({ exitCode: null, stderrTail: [] });
		};
		const flush = () => {
			if (!socket || queued.length === 0) return;
			const written = socket.write(queued);
			queued = written >= queued.length ? new Uint8Array(0) : queued.slice(Math.max(written, 0));
		};
		try {
			const connected = await Bun.connect({
				unix: opts.socketPath,
				socket: {
					open(s) {
						socket = s;
					},
					data(_s, chunk) {
						for (const line of splitter.push(chunk)) handlers.onLine(line);
					},
					drain() {
						flush();
					},
					close() {
						notifyClosed();
					},
					error() {
						notifyClosed();
					},
					end() {
						notifyClosed();
					},
				},
			});
			socket = connected;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				error: driverError("E_HELPER_CRASHED", `cannot connect to warden-simd socket ${opts.socketPath}: ${reason}`, {
					detail: { socketPath: opts.socketPath },
				}),
			};
		}
		return {
			success: true,
			data: {
				send(data) {
					const bytes = encoder.encode(data);
					const merged = new Uint8Array(queued.length + bytes.length);
					merged.set(queued, 0);
					merged.set(bytes, queued.length);
					queued = merged;
					flush();
				},
				async close() {
					try {
						socket?.end();
					} catch {
						// already closed
					}
					notifyClosed();
				},
			},
		};
	};
}

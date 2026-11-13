/** Why `warden mcp` is going away: each trigger funnels into one shutdown. */
export type ShutdownReason =
	| { kind: "signal"; signal: "SIGTERM" | "SIGINT" | "SIGHUP" }
	| { kind: "stdin_closed" }
	| { kind: "stdout_closed" }
	| { kind: "parent_gone"; ppid: number }
	| { kind: "transport_closed" }
	| { kind: "error"; message: string };

/** The slice of `process` the lifecycle watches; injected so tests drive every trigger by hand. */
export type LifecycleProcess = {
	stdin: { once(event: "end" | "close", fn: () => void): unknown };
	stdout: { on(event: "error", fn: (error: unknown) => void): unknown };
	once(event: "SIGTERM" | "SIGINT" | "SIGHUP", fn: () => void): unknown;
	on(event: "uncaughtException" | "unhandledRejection", fn: (error: unknown) => void): unknown;
	readonly ppid: number;
	exit(code: number): void;
};

export type LifecycleOptions = {
	/** Stops the server (`server.close()`); bounded by `closeTimeoutMs`, a throw is ignored. */
	close: (reason: ShutdownReason) => Promise<void>;
	pollMs?: number;
	closeTimeoutMs?: number;
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
};

export type McpLifecycle = {
	shutdown(reason: ShutdownReason): Promise<void>;
	stopped(): boolean;
};

/** How often the parent pid is checked: an orphaned `warden mcp` is gone within this. */
export const PPID_POLL_MS = 2000;
const CLOSE_TIMEOUT_MS = 1000;

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

const isEpipe = (error: unknown): boolean =>
	typeof error === "object" && error !== null && "code" in error && error.code === "EPIPE";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Ties `warden mcp` to its client. A stdio server whose client went away (stdin closed, stdout broken, signal, or the
 * parent died and the process was reparented) would otherwise sit forever as an orphan. Every trigger calls one
 * idempotent `shutdown`: stop the server, then exit 0 (1 for an uncaught error). After shutdown begins, stdout errors
 * are swallowed: nothing more is written there.
 */
export function createMcpLifecycle(proc: LifecycleProcess, options: LifecycleOptions): McpLifecycle {
	const setTimer = options.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
	const clearTimer =
		options.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
	const startPpid = proc.ppid;
	let pending: Promise<void> | undefined;
	let timer: unknown;

	const shutdown = (reason: ShutdownReason): Promise<void> => {
		if (pending) return pending;
		clearTimer(timer);
		pending = (async () => {
			const timeout = new Promise<void>((resolve) => setTimeout(resolve, options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS));
			await Promise.race([options.close(reason).catch(() => undefined), timeout]);
			proc.exit(reason.kind === "error" ? 1 : 0);
		})();
		return pending;
	};

	for (const signal of SIGNALS) proc.once(signal, () => void shutdown({ kind: "signal", signal }));
	proc.stdin.once("end", () => void shutdown({ kind: "stdin_closed" }));
	proc.stdin.once("close", () => void shutdown({ kind: "stdin_closed" }));
	proc.stdout.on("error", (error) => {
		if (pending) return;
		void shutdown(isEpipe(error) ? { kind: "stdout_closed" } : { kind: "error", message: messageOf(error) });
	});
	proc.on("uncaughtException", (error) => void shutdown({ kind: "error", message: messageOf(error) }));
	proc.on("unhandledRejection", (error) => void shutdown({ kind: "error", message: messageOf(error) }));

	timer = setTimer(() => {
		const ppid = proc.ppid;
		if (ppid === 1 || ppid !== startPpid) void shutdown({ kind: "parent_gone", ppid });
	}, options.pollMs ?? PPID_POLL_MS);
	if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
		timer.unref();
	}

	return { shutdown, stopped: () => pending !== undefined };
}

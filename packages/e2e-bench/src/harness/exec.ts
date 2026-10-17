import type { AsyncResult } from "@delacour/warden-types/result";

/**
 * The one process-spawning seam of the harness. Adapters and harness modules take an `Exec` and never
 * call `Bun.spawn` themselves, so every module has a colocated `bun test` with a fake.
 */

export type ExecOptions = {
	cwd?: string;
	env?: Record<string, string | undefined>;
	/** kill the process and its process group (SIGTERM, then SIGKILL after 5 s) when it runs longer than this */
	timeoutMs?: number;
	/** every stdout/stderr line as it arrives (for the per-phase log) */
	onLine?: (stream: "stdout" | "stderr", line: string) => void;
	stdin?: string;
	/** called with the child's pid right after spawn (the sampler's root pids) */
	onSpawn?: (pid: number) => void;
};

export type ExecResult = {
	code: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	/** the exec never started (missing binary, spawn error) */
	spawnError?: string;
};

/** A long-running child (a daemon or server) the harness started and must stop. */
export type Child = {
	pid: number;
	/** resolves with the exit code once the process is gone */
	exited: Promise<number>;
	kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT"): void;
};

export type Exec = {
	/** run to completion and collect output */
	run(cmd: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult>;
	/** start and return a handle; output goes to `onLine` */
	start(cmd: string, args: readonly string[], options?: Omit<ExecOptions, "timeoutMs" | "stdin">): Child;
	/** `which`: absolute path or undefined */
	which(cmd: string): string | undefined;
};

const KILL_GRACE_MS = 5_000;

function splitLines(onLine: ExecOptions["onLine"], stream: "stdout" | "stderr") {
	let rest = "";
	return {
		push(chunk: string) {
			const text = rest + chunk;
			const lines = text.split("\n");
			rest = lines.pop() ?? "";
			for (const line of lines) onLine?.(stream, line);
		},
		flush() {
			if (rest !== "") onLine?.(stream, rest);
			rest = "";
		},
	};
}

/** Read `stream` to EOF; `cancel` stops early (a descendant still holding the pipe) and keeps what was read. */
function drain(
	stream: ReadableStream<Uint8Array> | null | undefined,
	sink: ReturnType<typeof splitLines>
): { text: Promise<string>; cancel: () => void } {
	if (!stream) return { text: Promise.resolve(""), cancel: () => undefined };
	const reader = stream.getReader();
	const text = (async () => {
		const decoder = new TextDecoder();
		let all = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				const chunk = decoder.decode(value, { stream: true });
				all += chunk;
				sink.push(chunk);
			}
		} catch {
			// cancelled or broken pipe: keep what arrived
		}
		sink.flush();
		return all;
	})();
	return { text, cancel: () => void reader.cancel().catch(() => undefined) };
}

/** After a timeout kill, how long output may still drain once the child is gone (a grandchild can hold the pipe). */
const DRAIN_GRACE_MS = 250;

/** Process groups of timed-out-capable runs still alive; killed if the bench exits (a forced second Ctrl-C). */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

/** Signal the process group led by `pid` (a `detached` child is its own group leader), never our own. */
function killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
	if (pid <= 1 || pid === process.pid) return;
	try {
		process.kill(-pid, signal);
	} catch {
		// the group is already gone
	}
}

function trackGroup(pid: number): void {
	liveGroups.add(pid);
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const group of liveGroups) killGroup(group, "SIGKILL");
	});
}

function mergedEnv(env: ExecOptions["env"]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries({ ...process.env, ...(env ?? {}) })) if (v !== undefined) out[k] = v;
	return out;
}

/** The real `Exec` over `Bun.spawn`. */
export const realExec: Exec = {
	async run(cmd, args, options = {}) {
		const started = performance.now();
		let proc: ReturnType<typeof Bun.spawn>;
		// With a timeout the child leads its own process group, so the kill reaches its descendants too.
		const grouped = options.timeoutMs !== undefined;
		try {
			proc = Bun.spawn([cmd, ...args], {
				cwd: options.cwd,
				env: mergedEnv(options.env),
				stdout: "pipe",
				stderr: "pipe",
				stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : "ignore",
				detached: grouped,
			});
		} catch (e) {
			return {
				code: -1,
				stdout: "",
				stderr: "",
				durationMs: performance.now() - started,
				timedOut: false,
				spawnError: e instanceof Error ? e.message : String(e),
			};
		}
		const pid = proc.pid;
		options.onSpawn?.(pid);
		if (grouped) trackGroup(pid);
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let killer: ReturnType<typeof setTimeout> | undefined;
		let onKill: () => void = () => undefined;
		const killed = new Promise<void>((resolve) => {
			onKill = resolve;
		});
		if (options.timeoutMs !== undefined) {
			timer = setTimeout(() => {
				timedOut = true;
				killGroup(pid, "SIGTERM");
				killer = setTimeout(() => killGroup(pid, "SIGKILL"), KILL_GRACE_MS);
				onKill();
			}, options.timeoutMs);
		}
		const out = drain(proc.stdout as ReadableStream<Uint8Array> | null, splitLines(options.onLine, "stdout"));
		const err = drain(proc.stderr as ReadableStream<Uint8Array> | null, splitLines(options.onLine, "stderr"));
		const all = Promise.all([out.text, err.text, proc.exited]);
		// after a kill: the child gone plus a short grace, then stop waiting for EOF on the pipes
		const graceAfterKill = killed.then(() => proc.exited).then(() => Bun.sleep(DRAIN_GRACE_MS));
		const finished = await Promise.race([all.then(() => true), graceAfterKill.then(() => false)]);
		if (!finished) {
			out.cancel();
			err.cancel();
		}
		const [stdout, stderr, code] = await all;
		if (timer !== undefined) clearTimeout(timer);
		if (killer !== undefined) clearTimeout(killer);
		liveGroups.delete(pid);
		return { code, stdout, stderr, durationMs: performance.now() - started, timedOut };
	},
	start(cmd, args, options = {}) {
		const proc = Bun.spawn([cmd, ...args], {
			cwd: options.cwd,
			env: mergedEnv(options.env),
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		options.onSpawn?.(proc.pid);
		void drain(proc.stdout as ReadableStream<Uint8Array> | null, splitLines(options.onLine, "stdout")).text;
		void drain(proc.stderr as ReadableStream<Uint8Array> | null, splitLines(options.onLine, "stderr")).text;
		return {
			pid: proc.pid,
			exited: proc.exited,
			kill: (signal = "SIGTERM") => proc.kill(signal),
		};
	},
	which(cmd) {
		return Bun.which(cmd) ?? undefined;
	},
};

export type FakeCall = { cmd: string; args: readonly string[]; options: ExecOptions | undefined };

/** A canned answer for one command; matched by command name then (optionally) an argv predicate. */
export type FakeRule = {
	cmd: string;
	match?: (args: readonly string[]) => boolean;
	result: Partial<ExecResult> | ((args: readonly string[], options: ExecOptions | undefined) => Partial<ExecResult>);
};

/** Feeds a canned result's output through `onLine` the way the real exec would. */
function replay(result: ExecResult, onLine: ExecOptions["onLine"]): void {
	if (onLine === undefined) return;
	for (const line of result.stdout.split("\n")) if (line !== "") onLine("stdout", line);
	for (const line of result.stderr.split("\n")) if (line !== "") onLine("stderr", line);
}

export type FakeExec = Exec & { calls: FakeCall[]; started: FakeCall[]; killed: string[] };

/** An `Exec` answering from `rules` (first match wins; no match = exit 127). `which` finds every `cmd` in `rules`. */
export function fakeExec(rules: readonly FakeRule[] = [], opts: { which?: readonly string[] } = {}): FakeExec {
	const calls: FakeCall[] = [];
	const started: FakeCall[] = [];
	const killed: string[] = [];
	const known = new Set([...rules.map((r) => r.cmd), ...(opts.which ?? [])]);
	const answer = (cmd: string, args: readonly string[], options: ExecOptions | undefined): ExecResult => {
		const rule = rules.find((r) => r.cmd === cmd && (r.match === undefined || r.match(args)));
		const partial =
			rule === undefined
				? { code: 127, stderr: `${cmd}: not found` }
				: typeof rule.result === "function"
					? rule.result(args, options)
					: rule.result;
		return { code: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, ...partial };
	};
	return {
		calls,
		started,
		killed,
		async run(cmd, args, options) {
			calls.push({ cmd, args, options });
			const result = answer(cmd, args, options);
			replay(result, options?.onLine);
			return result;
		},
		start(cmd, args, options) {
			started.push({ cmd, args, options });
			const result = answer(cmd, args, options);
			let resolveExit: (code: number) => void = () => undefined;
			const exited = new Promise<number>((resolve) => {
				resolveExit = resolve;
			});
			return {
				pid: 1000 + started.length,
				exited,
				kill: () => {
					killed.push(cmd);
					resolveExit(result.code);
				},
			};
		},
		which(cmd) {
			return known.has(cmd) ? `/fake/bin/${cmd}` : undefined;
		},
	};
}

/** `run` that fails as a `Result` when the exit code is not 0 (the common adapter case). */
export async function runOk(
	exec: Exec,
	cmd: string,
	args: readonly string[],
	options?: ExecOptions
): AsyncResult<ExecResult> {
	const result = await exec.run(cmd, args, options);
	if (result.spawnError !== undefined) return { success: false, error: `${cmd}: ${result.spawnError}` };
	if (result.timedOut)
		return { success: false, error: `${cmd} ${args.join(" ")} timed out after ${options?.timeoutMs}ms` };
	if (result.code !== 0) {
		const tail = (result.stderr || result.stdout).trim().split("\n").slice(-5).join("\n");
		return { success: false, error: `${cmd} ${args.join(" ")} exited ${result.code}${tail ? `: ${tail}` : ""}` };
	}
	return { success: true, data: result };
}

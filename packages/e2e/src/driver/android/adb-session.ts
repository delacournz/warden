import type { DriverResult, Logger } from "../driver.types";
import { driverErr } from "../errors";

/**
 * One long-lived `adb -s <serial> shell` per driver. Spawning `adb shell <cmd>` per call costs ~50-150 ms
 * of adb round trip; writing to a resident shell costs the command itself. Text commands only: binary
 * output (screenshots) must NEVER go through this session, the pty-less shell is not binary clean, so
 * screenshots use a separate `adb exec-out screencap -p` process (`android-argv.ts: screencapArgv`).
 *
 * Wire format, one line per command:
 *   `(<cmd>) 2>&1 </dev/null; echo "__WDN_<id>_$?__"`
 * stdout is accumulated until the sentinel for that id shows up; the text before it is the output and the
 * number inside it the exit code. `</dev/null` keeps a stdin-reading command from eating the next line.
 *
 * Commands run strictly FIFO, one in flight. A timed-out command's shell state is unknowable, so the
 * process is killed and the next `run` starts a fresh one. A process that dies mid-command fails that
 * command with `E_HELPER_CRASHED` and is respawned on the next `run`; one respawn is allowed in a row
 * (a respawned process that also dies before completing any command makes the session give up, every
 * later `run` fails with `E_HELPER_CRASHED` until a new session is opened). A completed command resets
 * the budget.
 */

/** The slice of a child process the session needs (real: `spawnAdb`; tests may inject their own). */
export type AdbProcess = {
	/** write text to the shell's stdin; throws when the pipe is closed */
	write(data: string): void;
	stdout: ReadableStream<Uint8Array>;
	kill(): void;
	/** resolves with the exit code once the process is gone */
	exited: Promise<number>;
};

export type SpawnAdb = (argv: string[]) => AdbProcess;

/** `Bun.spawn` with stdin/stdout piped and stderr dropped (`2>&1` is inside every command line). */
export function spawnAdb(argv: string[], env?: Record<string, string>): AdbProcess {
	const proc = Bun.spawn(argv, {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
		...(env ? { env: { ...process.env, ...env } } : {}),
	});
	return {
		write(data) {
			proc.stdin.write(data);
			proc.stdin.flush();
		},
		stdout: proc.stdout,
		kill() {
			proc.kill("SIGKILL");
		},
		exited: proc.exited,
	};
}

export type AdbRunResult = { stdout: string; exitCode: number };

export type AdbSessionOptions = {
	/** path of the `adb` binary (`androidTools(env).adb`) */
	adb: string;
	serial: string;
	spawn?: SpawnAdb;
	log?: Logger;
};

export type AdbSession = {
	/** run one shell command line; `timeoutMs` defaults to 10 s */
	run(cmd: string, opts?: { timeoutMs?: number }): DriverResult<AdbRunResult>;
	/** kill the shell; later `run`s fail. Safe to call twice. */
	close(): Promise<void>;
};

export const DEFAULT_ADB_TIMEOUT_MS = 10_000;

/** Consecutive unexpected deaths tolerated before giving up (first death + one respawn that dies too). */
const MAX_CONSECUTIVE_CRASHES = 2;

type Live = { proc: AdbProcess; buffer: string; dead: boolean };

type Outcome = { kind: "done"; result: AdbRunResult } | { kind: "crashed"; tail: string } | { kind: "timeout" };

type InFlight = { prefix: string; settle: (outcome: Outcome) => void };

type StartFailure = { code: "E_HELPER_MISSING" | "E_HELPER_CRASHED"; message: string };

export function openAdbSession(options: AdbSessionOptions): AdbSession {
	const { adb, serial, log } = options;
	const spawn: SpawnAdb = options.spawn ?? ((argv) => spawnAdb(argv));
	const nonce = Math.random().toString(36).slice(2, 8);
	let seq = 0;
	let live: Live | undefined;
	let current: InFlight | undefined;
	let crashes = 0;
	let closed = false;
	let tail: Promise<unknown> = Promise.resolve();

	/** Resolve the in-flight command if its sentinel is complete in the buffer. */
	function check(l: Live): void {
		if (!current) return;
		const start = l.buffer.indexOf(current.prefix);
		if (start < 0) return;
		const afterPrefix = start + current.prefix.length;
		const m = /^(\d+)__(\r?\n)?/.exec(l.buffer.slice(afterPrefix));
		if (!m) return;
		const stdout = l.buffer.slice(0, start);
		l.buffer = l.buffer.slice(afterPrefix + m[0].length);
		const settle = current.settle;
		current = undefined;
		settle({ kind: "done", result: { stdout, exitCode: Number(m[1]) } });
	}

	function onDeath(l: Live): void {
		if (l.dead) return;
		l.dead = true;
		if (live === l) live = undefined;
		crashes++;
		log?.(`adb[${serial}] shell died (consecutive crashes: ${crashes})`);
		if (current) {
			const settle = current.settle;
			current = undefined;
			settle({ kind: "crashed", tail: l.buffer.slice(-200) });
		}
	}

	async function pump(l: Live): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const chunk of l.proc.stdout) {
				if (l.dead) return;
				l.buffer += decoder.decode(chunk, { stream: true });
				check(l);
			}
		} catch {
			// a broken pipe is the same as the process going away
		}
		onDeath(l);
	}

	function start(): Live | StartFailure {
		if (crashes >= MAX_CONSECUTIVE_CRASHES) {
			return {
				code: "E_HELPER_CRASHED",
				message: `adb shell for ${serial} keeps dying; giving up (open a new session)`,
			};
		}
		let proc: AdbProcess;
		try {
			proc = spawn([adb, "-s", serial, "shell"]);
		} catch (error) {
			return {
				code: "E_HELPER_MISSING",
				message: `cannot spawn \`${adb}\`: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const l: Live = { proc, buffer: "", dead: false };
		live = l;
		void pump(l);
		return l;
	}

	async function execute(cmd: string, timeoutMs: number): DriverResult<AdbRunResult> {
		if (closed) return driverErr("E_INTERNAL", `adb session for ${serial} is closed`);
		const started = live && !live.dead ? live : start();
		if ("code" in started) return driverErr(started.code, started.message);
		const l = started;
		seq++;
		const prefix = `__WDN_${nonce}x${seq}_`;
		const line = `(${cmd}) 2>&1 </dev/null; echo "${prefix}$?__"\n`;
		const t0 = Date.now();
		const outcome = await new Promise<Outcome>((resolve) => {
			const timer = setTimeout(() => {
				if (current?.prefix !== prefix) return;
				current = undefined;
				resolve({ kind: "timeout" });
			}, timeoutMs);
			current = {
				prefix,
				settle: (o) => {
					clearTimeout(timer);
					resolve(o);
				},
			};
			try {
				l.proc.write(line);
			} catch {
				onDeath(l);
			}
		});
		if (outcome.kind === "done") {
			crashes = 0;
			log?.(`adb[${serial}] ${cmd} -> ${outcome.result.exitCode} in ${Date.now() - t0}ms`);
			return { success: true, data: outcome.result };
		}
		if (outcome.kind === "timeout") {
			log?.(`adb[${serial}] ${cmd} timed out after ${timeoutMs}ms; restarting shell`);
			l.dead = true;
			if (live === l) live = undefined;
			l.proc.kill();
			return driverErr("E_TIMEOUT", `\`${cmd}\` did not finish within ${timeoutMs}ms on ${serial}`);
		}
		return driverErr("E_HELPER_CRASHED", `adb shell for ${serial} died while running \`${cmd}\``, {
			detail: { tail: outcome.tail },
		});
	}

	return {
		run(cmd, opts) {
			const next = tail.then(() => execute(cmd, opts?.timeoutMs ?? DEFAULT_ADB_TIMEOUT_MS));
			tail = next.catch(() => undefined);
			return next;
		},
		async close() {
			closed = true;
			const l = live;
			live = undefined;
			if (!l) return;
			l.dead = true;
			l.proc.kill();
			if (current) {
				const settle = current.settle;
				current = undefined;
				settle({ kind: "crashed", tail: "" });
			}
			await l.proc.exited.catch(() => 0);
		},
	};
}

import type { DriverResult, Logger } from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import { spanDetails } from "@delacour/warden-driver/trace/span-detail";

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

/**
 * One resident `adb shell` (see the module doc). Commands run strictly FIFO; construct through
 * {@link AdbSessions.open}.
 */
export class AdbShell implements AdbSession {
	private readonly adb: string;
	private readonly serial: string;
	private readonly log: Logger | undefined;
	private readonly spawn: SpawnAdb;
	private readonly nonce = Math.random().toString(36).slice(2, 8);
	private seq = 0;
	private live: Live | undefined;
	private current: InFlight | undefined;
	private crashes = 0;
	private closed = false;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(options: AdbSessionOptions) {
		this.adb = options.adb;
		this.serial = options.serial;
		this.log = options.log;
		this.spawn = options.spawn ?? ((argv) => adbSessions.spawn(argv));
	}

	run(cmd: string, opts?: { timeoutMs?: number }): DriverResult<AdbRunResult> {
		const next = this.tail.then(() => this.execute(cmd, opts?.timeoutMs ?? DEFAULT_ADB_TIMEOUT_MS));
		this.tail = next.catch(() => undefined);
		return next;
	}

	async close(): Promise<void> {
		this.closed = true;
		const l = this.live;
		this.live = undefined;
		if (!l) return;
		l.dead = true;
		l.proc.kill();
		if (this.current) {
			const settle = this.current.settle;
			this.current = undefined;
			settle({ kind: "crashed", tail: "" });
		}
		await l.proc.exited.catch(() => 0);
	}

	/** Resolve the in-flight command if its sentinel is complete in the buffer. */
	private check(l: Live): void {
		if (!this.current) return;
		const start = l.buffer.indexOf(this.current.prefix);
		if (start < 0) return;
		const afterPrefix = start + this.current.prefix.length;
		const m = /^(\d+)__(\r?\n)?/.exec(l.buffer.slice(afterPrefix));
		if (!m) return;
		const stdout = l.buffer.slice(0, start);
		l.buffer = l.buffer.slice(afterPrefix + m[0].length);
		const settle = this.current.settle;
		this.current = undefined;
		settle({ kind: "done", result: { stdout, exitCode: Number(m[1]) } });
	}

	private onDeath(l: Live): void {
		if (l.dead) return;
		l.dead = true;
		if (this.live === l) this.live = undefined;
		this.crashes++;
		this.log?.(`adb[${this.serial}] shell died (consecutive crashes: ${this.crashes})`);
		if (this.current) {
			const settle = this.current.settle;
			this.current = undefined;
			settle({ kind: "crashed", tail: l.buffer.slice(-200) });
		}
	}

	private async pump(l: Live): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const chunk of l.proc.stdout) {
				if (l.dead) return;
				l.buffer += decoder.decode(chunk, { stream: true });
				this.check(l);
			}
		} catch {
			// a broken pipe is the same as the process going away
		}
		this.onDeath(l);
	}

	private start(): Live | StartFailure {
		if (this.crashes >= MAX_CONSECUTIVE_CRASHES) {
			return {
				code: "E_HELPER_CRASHED",
				message: `adb shell for ${this.serial} keeps dying; giving up (open a new session)`,
			};
		}
		let proc: AdbProcess;
		try {
			proc = this.spawn([this.adb, "-s", this.serial, "shell"]);
		} catch (error) {
			return {
				code: "E_HELPER_MISSING",
				message: `cannot spawn \`${this.adb}\`: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const l: Live = { proc, buffer: "", dead: false };
		this.live = l;
		void this.pump(l);
		return l;
	}

	/** Write one wrapped line and wait for its sentinel, the timeout, or the shell dying. */
	private send(l: Live, cmd: string, prefix: string, timeoutMs: number): Promise<Outcome> {
		const line = `(${cmd}) 2>&1 </dev/null; echo "${prefix}$?__"\n`;
		return new Promise<Outcome>((resolve) => {
			const timer = setTimeout(() => {
				if (this.current?.prefix !== prefix) return;
				this.current = undefined;
				resolve({ kind: "timeout" });
			}, timeoutMs);
			this.current = {
				prefix,
				settle: (o) => {
					clearTimeout(timer);
					resolve(o);
				},
			};
			try {
				l.proc.write(line);
			} catch {
				this.onDeath(l);
			}
		});
	}

	private async execute(cmd: string, timeoutMs: number): DriverResult<AdbRunResult> {
		if (this.closed) return driverErrors.err("E_INTERNAL", `adb session for ${this.serial} is closed`);
		const started = this.live && !this.live.dead ? this.live : this.start();
		if ("code" in started) return driverErrors.err(started.code, started.message);
		const l = started;
		this.seq++;
		const prefix = `__WDN_${this.nonce}x${this.seq}_`;
		const t0 = Date.now();
		const outcome = await this.send(l, cmd, prefix, timeoutMs);
		spanDetails.add("adbMs", Date.now() - t0);
		spanDetails.add("adbCalls", 1);
		return this.finish(l, cmd, timeoutMs, outcome, t0);
	}

	private finish(
		l: Live,
		cmd: string,
		timeoutMs: number,
		outcome: Outcome,
		t0: number
	): Awaited<DriverResult<AdbRunResult>> {
		if (outcome.kind === "done") {
			this.crashes = 0;
			this.log?.(`adb[${this.serial}] ${cmd} -> ${outcome.result.exitCode} in ${Date.now() - t0}ms`);
			return { success: true, data: outcome.result };
		}
		if (outcome.kind === "timeout") {
			this.log?.(`adb[${this.serial}] ${cmd} timed out after ${timeoutMs}ms; restarting shell`);
			l.dead = true;
			if (this.live === l) this.live = undefined;
			l.proc.kill();
			return driverErrors.err("E_TIMEOUT", `\`${cmd}\` did not finish within ${timeoutMs}ms on ${this.serial}`);
		}
		return driverErrors.err("E_HELPER_CRASHED", `adb shell for ${this.serial} died while running \`${cmd}\``, {
			detail: { tail: outcome.tail },
		});
	}
}

/** Opens adb sessions and spawns the underlying `adb` process. */
export class AdbSessions {
	/** Open a resident `adb shell` for `options.serial`. */
	open(options: AdbSessionOptions): AdbSession {
		return new AdbShell(options);
	}

	/** `Bun.spawn` with stdin/stdout piped and stderr dropped (`2>&1` is inside every command line). */
	spawn(argv: string[], env?: Record<string, string>): AdbProcess {
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
}

export const adbSessions = new AdbSessions();

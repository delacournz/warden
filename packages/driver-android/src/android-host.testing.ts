import type { Exec, ExecResult } from "@delacour/warden-runtime/exec";
import type { AdbProcess, SpawnAdb } from "./adb-session";

/**
 * In-memory fake of everything the Android driver touches: the resident `adb shell` (rules matched on the
 * command text), host `adb` calls through `exec`, and binary `exec-out`. Records every call. Never spawns.
 */

/** `"hang"`: the command is received and never answers (a wait that outlives its budget, a stalled transport). */
export type ShellReply = string | { stdout: string; exitCode?: number } | "crash" | "hang";

/**
 * First rule whose `match` is a prefix of (or regex-matches) the command wins; later `unshift`s override.
 * A function reply is given the command, so a rule can model state (a fake `settings` store).
 */
export type ShellRule = { match: string | RegExp; reply: ShellReply | ((command: string) => ShellReply) };

export type HostReply = string | { stdout?: string; stderr?: string; exitCode?: number };
export type HostRule = { match: string | RegExp; reply: HostReply | (() => HostReply) };

export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const WRAPPED = /^\((.*)\) 2>&1 <\/dev\/null; echo "(__WDN_.+_)\$\?__"\n$/s;

export type FakeAndroidHostInit = { shell?: ShellRule[]; host?: HostRule[]; screencap?: Uint8Array };

export class FakeAndroidHost {
	/** shell commands received, in order */
	readonly shell: string[] = [];
	/** host argv received through `exec` / `execBinary` */
	readonly host: string[][] = [];
	readonly shellRules: ShellRule[];
	readonly hostRules: HostRule[];
	private spawnCount = 0;
	private readonly png: Uint8Array;

	constructor(init: FakeAndroidHostInit = {}) {
		this.shellRules = [...(init.shell ?? [])];
		this.hostRules = [...(init.host ?? [])];
		this.png = init.screencap ?? PNG_BYTES;
	}

	/** number of times a shell process was spawned */
	spawns(): number {
		return this.spawnCount;
	}

	readonly spawn: SpawnAdb = () => {
		this.spawnCount++;
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		let resolveExit: (code: number) => void = () => undefined;
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		const stdout = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		const proc: AdbProcess = {
			stdout,
			exited,
			write: (data) => {
				const m = WRAPPED.exec(data);
				if (!m) throw new Error(`fake host: unrecognised line ${data}`);
				const cmd = m[1] ?? "";
				this.shell.push(cmd);
				const reply = this.shellReply(cmd);
				if (reply === "crash") {
					controller?.close();
					resolveExit(1);
					return;
				}
				if (reply === "hang") return;
				controller?.enqueue(new TextEncoder().encode(`${reply.stdout}${m[2] ?? ""}${reply.exitCode}__\n`));
			},
			kill() {
				try {
					controller?.close();
				} catch {
					// already closed
				}
				resolveExit(137);
			},
		};
		return proc;
	};

	readonly exec: Exec = async (argv) => {
		this.host.push([...argv]);
		return this.hostReply(argv);
	};

	readonly execBinary = async (argv: readonly string[]): Promise<{ exitCode: number; stdout: Uint8Array }> => {
		this.host.push([...argv]);
		const text = argv.join(" ");
		const rule = this.hostRules.find((r) => this.matches(r, text));
		if (rule) {
			const reply = this.hostReply(argv);
			return { exitCode: reply.exitCode, stdout: new TextEncoder().encode(reply.stdout) };
		}
		return { exitCode: 0, stdout: this.png };
	};

	private matches(rule: { match: string | RegExp }, text: string): boolean {
		return typeof rule.match === "string" ? text.startsWith(rule.match) : rule.match.test(text);
	}

	private shellReply(cmd: string): { stdout: string; exitCode: number } | "crash" | "hang" {
		const rule = this.shellRules.find((r) => this.matches(r, cmd));
		const raw = typeof rule?.reply === "function" ? rule.reply(cmd) : rule?.reply;
		if (raw === "crash" || raw === "hang") return raw;
		if (raw === undefined) return { stdout: "", exitCode: 0 };
		return typeof raw === "string" ? { stdout: raw, exitCode: 0 } : { stdout: raw.stdout, exitCode: raw.exitCode ?? 0 };
	}

	private hostReply(argv: readonly string[]): ExecResult {
		const text = argv.join(" ");
		const rule = this.hostRules.find((r) => this.matches(r, text));
		const raw = typeof rule?.reply === "function" ? rule.reply() : rule?.reply;
		if (raw === undefined) return { exitCode: 0, stdout: "", stderr: "" };
		if (typeof raw === "string") return { exitCode: 0, stdout: raw, stderr: "" };
		return { exitCode: raw.exitCode ?? 0, stdout: raw.stdout ?? "", stderr: raw.stderr ?? "" };
	}
}

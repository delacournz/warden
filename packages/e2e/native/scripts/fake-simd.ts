#!/usr/bin/env bun
/**
 * Fake `warden-simd` for tests: speaks the NDJSON protocol (v1) on stdin/stdout from a JSON script.
 *
 *   bun fake-simd.ts --script <script.json> [--udid <UDID>] [--socket <path>] [...ignored helper flags]
 *
 * With `--socket <path>` it listens on that unix socket instead of using stdio (like the real helper's
 * daemon mode): every connection gets its own `ready` (plus `startup` lines) and answers requests from the
 * same script; `shutdown` closes every connection, removes the socket file and exits 0; the socket file is
 * also removed on SIGTERM / normal exit. A stale file at the path is replaced. `--idle-timeout` is ignored.
 * Once listening it announces itself on stdout like the real helper (see `announce`); stdout stays a pipe.
 *
 * Script shape (all keys optional):
 *   stderr:   lines written to stderr at startup
 *   exitBeforeReady: exit code to exit with right after writing stderr
 *   ready:    false (never send `ready`) | partial `ready` event fields merged over the default
 *   startup:  raw lines written right after `ready` (garbage-line tests)
 *   announce: socket mode, what stdout says once the socket listens: "ready" (default: the helper's process-level
 *             `{"event":"ready","socket","pid",…}` line), "legacy" (an older helper: only a `listening on …` log
 *             line) or "none" (nothing)
 *   fatal:    { error: {code,message,retryable?,detail?}, beforeReady?: boolean } emit `fatal`, exit 3
 *   dieAfter: { requests: N, exitCode?: number, once?: boolean } exit on the Nth request without answering;
 *             `once` leaves a `<script>.died` marker so a respawned process behaves normally
 *   ops:      { [op]: { data?, error?, delayMs?, emitLog?: {level,message}, echo?: boolean, ignore?: boolean,
 *                       fatal?: WireError (emit `fatal` instead of answering, exit 3) } }
 *             unlisted ops answer E_BAD_REQUEST; `shutdown` answers ok and exits 0 unless scripted
 *
 * Requests are handled concurrently, so a slow op answers after a fast one (out-of-order responses).
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

type WireError = { code: string; message: string; retryable?: boolean; detail?: unknown };
type LogLevel = "debug" | "info" | "warn" | "error";

type OpScript = {
	data?: unknown;
	error?: WireError;
	delayMs?: number;
	emitLog?: { level: LogLevel; message: string };
	echo?: boolean;
	ignore?: boolean;
	fatal?: WireError;
};

type Script = {
	exitBeforeReady?: number;
	stderr?: string[];
	ready?: false | Record<string, unknown>;
	startup?: string[];
	announce?: "ready" | "legacy" | "none";
	fatal?: { error: WireError; beforeReady?: boolean };
	dieAfter?: { requests: number; exitCode?: number; once?: boolean };
	ops?: Record<string, OpScript>;
};

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const scriptPath = arg("script");
const udid = arg("udid") ?? "FAKE-UDID";
const script: Script = scriptPath ? (JSON.parse(readFileSync(scriptPath, "utf8")) as Script) : {};
const diedMarker = scriptPath ? `${scriptPath}.died` : undefined;

type Request = { id: string; op: string; [key: string]: unknown };
type Write = (value: unknown) => void;

const socketPath = arg("socket");

function exit(code: number): never {
	if (socketPath) {
		try {
			unlinkSync(socketPath);
		} catch {
			// already gone
		}
	}
	process.exit(code);
}

const defaultReady = {
	event: "ready",
	protocol: 1,
	version: "fake",
	udid,
	hid: { transport: "fake" },
	ax: { default: "axbridge", bridge: "available" },
	screen: { width: 390, height: 844, scale: 3 },
};

let received = 0;

function shouldDie(): boolean {
	const die = script.dieAfter;
	if (!die || received !== die.requests) return false;
	if (die.once && diedMarker) {
		if (existsSync(diedMarker)) return false;
		writeFileSync(diedMarker, String(process.pid));
	}
	return true;
}

/** Banner for one client (stdio: the process; socket: each connection). False = it must not serve requests. */
function greet(write: Write): boolean {
	for (const line of script.stderr ?? []) process.stderr.write(`${line}\n`);
	if (script.exitBeforeReady !== undefined) exit(script.exitBeforeReady);
	if (script.fatal?.beforeReady) {
		write({ event: "fatal", error: script.fatal.error });
		exit(3);
	}
	if (script.ready !== false) write({ ...defaultReady, ...script.ready });
	for (const line of script.startup ?? []) write(line);
	if (script.fatal) {
		write({ event: "fatal", error: script.fatal.error });
		exit(3);
	}
	return true;
}

async function handle(request: Request, write: Write): Promise<void> {
	const op = script.ops?.[request.op];
	if (op?.delayMs) await Bun.sleep(op.delayMs);
	if (op?.emitLog) write({ event: "log", ...op.emitLog, op: request.op, id: request.id });
	if (op?.ignore) return;
	if (op?.fatal) {
		write({ event: "fatal", error: op.fatal });
		return exit(3);
	}
	if (op?.error) return write({ id: request.id, ok: false, error: op.error });
	if (op) {
		const { id: _id, op: _op, ...params } = request;
		return write({ id: request.id, ok: true, data: op.echo ? params : (op.data ?? null) });
	}
	if (request.op === "shutdown") {
		write({ id: request.id, ok: true, data: null });
		return exit(0);
	}
	write({
		id: request.id,
		ok: false,
		error: { code: "E_BAD_REQUEST", message: `fake-simd: no script for op ${request.op}`, retryable: false },
	});
}

function onLine(line: string, write: Write): void {
	if (!line.trim()) return;
	let request: Request;
	try {
		request = JSON.parse(line) as Request;
	} catch {
		write({ event: "log", level: "warn", message: `unparseable request: ${line}` });
		return;
	}
	received += 1;
	if (shouldDie()) exit(script.dieAfter?.exitCode ?? 1);
	void handle(request, write);
}

const decoder = new TextDecoder();

/** Newline-framed reader: feed chunks, get whole lines. */
function lineReader(onWholeLine: (line: string) => void): (chunk: Uint8Array) => void {
	let buffer = "";
	return (chunk) => {
		buffer += decoder.decode(chunk, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) onWholeLine(line);
	};
}

function serveStdio(): Promise<never> {
	const write: Write = (value) => {
		process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
	};
	greet(write);
	return (async () => {
		const feed = lineReader((line) => onLine(line, write));
		for await (const chunk of Bun.stdin.stream()) feed(chunk);
		return exit(0);
	})();
}

type Conn = { write(data: string): number };

function serveSocket(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// nothing stale
	}
	const feeds = new WeakMap<object, (chunk: Uint8Array) => void>();
	Bun.listen<undefined>({
		unix: path,
		socket: {
			open(conn: Conn) {
				const write: Write = (value) => {
					conn.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
				};
				feeds.set(
					conn,
					lineReader((line) => onLine(line, write))
				);
				greet(write);
			},
			data(conn, chunk) {
				feeds.get(conn)?.(chunk);
			},
			close() {},
			error() {},
		},
	});
	process.on("SIGTERM", () => exit(0));
	process.on("SIGINT", () => exit(0));
	announce(path);
}

/** What the real helper prints on stdout once its socket accepts (`Server/Announce.swift`, `main.swift`). */
function announce(path: string): void {
	const mode = script.announce ?? "ready";
	const line = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
	if (mode === "ready") line({ ...defaultReady, socket: path, pid: process.pid });
	if (mode !== "none") {
		line({ event: "log", level: "info", message: `listening on ${path} (idle timeout 600s)` });
	}
}

if (socketPath) serveSocket(socketPath);
else await serveStdio();

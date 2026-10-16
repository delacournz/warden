import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WireError } from "../ios/simd-protocol";
import type { SimdProcess, SimdSpawn } from "../ios/simd-transport";

/**
 * An in-process `warden-uiad` for tests (never spawns, never touches adb): a `SimdSpawn` whose "process" speaks the
 * NDJSON protocol, answering from what the real server said on an API 37 emulator (`fixtures/uiad-session.ndjson`,
 * recorded by `native/android/scripts/record.ts`) unless a test overrides an op. Mirrors what `simd.testing.ts` is for
 * `warden-simd`.
 */

export type FakeRequest = { id: string; op: string } & Record<string, unknown>;

/** What a handler answers: data (`ok:true`), an error, or one of the ways a server goes quiet. */
export type FakeReply = { data: unknown } | { error: WireError } | "silent" | "die";

export type FakeUiadOptions = {
	/** override or add ops; return undefined to fall through to the recorded reply */
	handle?: (request: FakeRequest, nth: number) => FakeReply | undefined;
	/** merged over the recorded health in `ready` */
	health?: Record<string, unknown>;
	/** the protocol number `ready` announces (default the recorded 1) */
	protocol?: number;
	/** send `fatal` instead of `ready`, then exit 3 */
	fatal?: WireError;
	/** never send `ready` and never exit */
	noReady?: boolean;
	/** exit with this code right after start, sending nothing */
	exitBeforeReady?: number;
	/** lines written to stderr at start */
	stderr?: string[];
	/** wait this long before each reply */
	delayMs?: number;
};

export type FakeUiad = {
	spawn: SimdSpawn;
	/** every `cmd` the client asked to spawn, in order */
	commands: string[][];
	/** every request any server received, in order */
	requests: FakeRequest[];
	/** requests of one op */
	of(op: string): FakeRequest[];
	/** servers started so far */
	started(): number;
	/** servers still running */
	running(): number;
	/** kill every running server as if the device dropped it */
	killAll(exitCode?: number): void;
};

type Recorded = { ready: Record<string, unknown>; health: Record<string, unknown>; replies: Map<string, FakeReply> };

let recorded: Recorded | undefined;

/** The recorded session, parsed once: the `ready` event, and the first reply of each op. */
export function recordedSession(): Recorded {
	if (recorded) return recorded;
	const lines = readFileSync(join(import.meta.dir, "fixtures/uiad-session.ndjson"), "utf8")
		.trim()
		.split("\n");
	const ops = new Map<string, string>();
	const replies = new Map<string, FakeReply>();
	let ready: Record<string, unknown> = {};
	for (const line of lines) {
		const json = JSON.parse(line) as Record<string, unknown>;
		if (typeof json.op === "string" && typeof json.id === "string") ops.set(json.id, json.op);
		else if (json.event === "ready") ready = json;
		else if (typeof json.id === "string") keepFirstReply(replies, ops.get(json.id), json);
	}
	recorded = { ready, health: (ready.data ?? {}) as Record<string, unknown>, replies };
	return recorded;
}

function keepFirstReply(replies: Map<string, FakeReply>, op: string | undefined, json: Record<string, unknown>): void {
	if (op === undefined || replies.has(op)) return;
	replies.set(op, json.ok === true ? { data: json.data } : { error: json.error as WireError });
}

const encoder = new TextEncoder();

export function fakeUiad(options: FakeUiadOptions = {}): FakeUiad {
	const session = recordedSession();
	const commands: string[][] = [];
	const requests: FakeRequest[] = [];
	const counts = new Map<string, number>();
	const live = new Set<{ stop: (code: number) => void }>();
	let started = 0;

	const spawn: SimdSpawn = (cmd) => {
		started++;
		commands.push([...cmd]);
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		let finish: (code: number) => void = () => undefined;
		let stopped = false;
		const exited = new Promise<number>((resolve) => {
			finish = resolve;
		});
		const stdout = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		let errController: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stderr = new ReadableStream<Uint8Array>({
			start(c) {
				errController = c;
				for (const line of options.stderr ?? []) c.enqueue(encoder.encode(`${line}\n`));
			},
		});
		const send = (value: unknown): void => {
			if (stopped) return;
			controller?.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
		};
		const stop = (code: number): void => {
			if (stopped) return;
			stopped = true;
			live.delete(handle);
			try {
				controller?.close();
				errController?.close();
			} catch {
				// already closed
			}
			finish(code);
		};
		const handle = { stop };
		live.add(handle);

		const health = { ...session.health, ...options.health };
		const greet = (): void => {
			send({ event: "log", level: "debug", message: "fake uiad starting" });
			if (options.fatal) {
				send({ event: "fatal", error: options.fatal });
				stop(3);
				return;
			}
			send({
				...session.ready,
				...(options.protocol !== undefined ? { protocol: options.protocol } : {}),
				data: health,
			});
		};
		queueMicrotask(() => {
			if (options.exitBeforeReady !== undefined) stop(options.exitBeforeReady);
			else if (!options.noReady) greet();
		});

		const replyTo = (request: FakeRequest, nth: number): FakeReply => {
			const custom = options.handle?.(request, nth);
			if (custom !== undefined) return custom;
			if (request.op === "health") return { data: health };
			if (request.op === "shutdown") return { data: {} };
			return (
				session.replies.get(request.op) ?? {
					error: { code: "E_BAD_REQUEST", message: `unknown op: ${request.op}`, retryable: false },
				}
			);
		};

		const answer = (request: FakeRequest): void => {
			const nth = counts.get(request.op) ?? 0;
			counts.set(request.op, nth + 1);
			requests.push(request);
			const reply = replyTo(request, nth);
			if (reply === "silent") return;
			if (reply === "die") {
				stop(137);
				return;
			}
			const out =
				"data" in reply
					? { id: request.id, ok: true, data: reply.data }
					: { id: request.id, ok: false, error: reply.error };
			const respond = (): void => {
				send(out);
				if (request.op === "shutdown") stop(0);
			};
			if (options.delayMs) setTimeout(respond, options.delayMs);
			else respond();
		};

		const proc: SimdProcess = {
			write(data) {
				if (stopped) throw new Error("fake uiad: stdin is closed");
				for (const line of data.split("\n")) {
					if (line.trim()) answer(JSON.parse(line) as FakeRequest);
				}
			},
			end() {
				stop(0);
			},
			kill() {
				stop(137);
			},
			stdout,
			stderr,
			exited,
		};
		return proc;
	};

	return {
		spawn,
		commands,
		requests,
		of: (op) => requests.filter((r) => r.op === op),
		started: () => started,
		running: () => live.size,
		killAll(exitCode = 137) {
			for (const handle of [...live]) handle.stop(exitCode);
		},
	};
}

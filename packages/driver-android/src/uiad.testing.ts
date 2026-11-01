import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WireError } from "@delacour/warden-driver/helper/simd-protocol";
import type { SimdProcess, SimdSpawn } from "@delacour/warden-driver/helper/simd-transport";

/**
 * An in-process `warden-uiad` for tests (never spawns, never touches adb): a `SimdSpawn` whose "process" speaks the
 * NDJSON protocol, answering from what the real server said on an API 37 emulator (`fixtures/uiad-session.ndjson`,
 * recorded by `native/scripts/record.ts`) unless a test overrides an op. Mirrors what `simd.testing.ts` is for
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

const encoder = new TextEncoder();

/** State shared by every fake server process of one `fakeUiad()`. */
type FakeHost = {
	options: FakeUiadOptions;
	session: Recorded;
	requests: FakeRequest[];
	counts: Map<string, number>;
	live: Set<FakeUiadProcess>;
};

/** One fake server "process": speaks the NDJSON protocol on in-memory streams. */
class FakeUiadProcess implements SimdProcess {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	private errController: ReadableStreamDefaultController<Uint8Array> | undefined;
	private finish: (code: number) => void = () => undefined;
	private stopped = false;
	private readonly health: Record<string, unknown>;

	constructor(private readonly host: FakeHost) {
		const { options, session } = host;
		this.exited = new Promise<number>((resolve) => {
			this.finish = resolve;
		});
		this.stdout = new ReadableStream<Uint8Array>({
			start: (c) => {
				this.controller = c;
			},
		});
		this.stderr = new ReadableStream<Uint8Array>({
			start: (c) => {
				this.errController = c;
				for (const line of options.stderr ?? []) c.enqueue(encoder.encode(`${line}\n`));
			},
		});
		host.live.add(this);
		this.health = { ...session.health, ...options.health };
		queueMicrotask(() => {
			if (options.exitBeforeReady !== undefined) this.stop(options.exitBeforeReady);
			else if (!options.noReady) this.greet();
		});
	}

	readonly write = (data: string): void => {
		if (this.stopped) throw new Error("fake uiad: stdin is closed");
		for (const line of data.split("\n")) {
			if (line.trim()) this.answer(JSON.parse(line) as FakeRequest);
		}
	};

	readonly end = (): void => {
		this.stop(0);
	};

	readonly kill = (): void => {
		this.stop(137);
	};

	stop(code: number): void {
		if (this.stopped) return;
		this.stopped = true;
		this.host.live.delete(this);
		try {
			this.controller?.close();
			this.errController?.close();
		} catch {
			// already closed
		}
		this.finish(code);
	}

	private send(value: unknown): void {
		if (this.stopped) return;
		this.controller?.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
	}

	private greet(): void {
		const { options, session } = this.host;
		this.send({ event: "log", level: "debug", message: "fake uiad starting" });
		if (options.fatal) {
			this.send({ event: "fatal", error: options.fatal });
			this.stop(3);
			return;
		}
		this.send({
			...session.ready,
			...(options.protocol !== undefined ? { protocol: options.protocol } : {}),
			data: this.health,
		});
	}

	private replyTo(request: FakeRequest, nth: number): FakeReply {
		const custom = this.host.options.handle?.(request, nth);
		if (custom !== undefined) return custom;
		if (request.op === "health") return { data: this.health };
		if (request.op === "shutdown") return { data: {} };
		return (
			this.host.session.replies.get(request.op) ?? {
				error: { code: "E_BAD_REQUEST", message: `unknown op: ${request.op}`, retryable: false },
			}
		);
	}

	private answer(request: FakeRequest): void {
		const { counts, requests, options } = this.host;
		const nth = counts.get(request.op) ?? 0;
		counts.set(request.op, nth + 1);
		requests.push(request);
		const reply = this.replyTo(request, nth);
		if (reply === "silent") return;
		if (reply === "die") {
			this.stop(137);
			return;
		}
		const out =
			"data" in reply
				? { id: request.id, ok: true, data: reply.data }
				: { id: request.id, ok: false, error: reply.error };
		const respond = (): void => {
			this.send(out);
			if (request.op === "shutdown") this.stop(0);
		};
		if (options.delayMs) setTimeout(respond, options.delayMs);
		else respond();
	}
}

/** The fake server's handle: what tests inspect and drive. */
class FakeUiadServer implements FakeUiad {
	readonly commands: string[][] = [];
	readonly requests: FakeRequest[] = [];
	private readonly host: FakeHost;
	private startedCount = 0;

	constructor(options: FakeUiadOptions, session: Recorded) {
		this.host = { options, session, requests: this.requests, counts: new Map(), live: new Set() };
	}

	readonly spawn: SimdSpawn = (cmd) => {
		this.startedCount++;
		this.commands.push([...cmd]);
		return new FakeUiadProcess(this.host);
	};

	of(op: string): FakeRequest[] {
		return this.requests.filter((r) => r.op === op);
	}

	started(): number {
		return this.startedCount;
	}

	running(): number {
		return this.host.live.size;
	}

	killAll(exitCode = 137): void {
		for (const handle of [...this.host.live]) handle.stop(exitCode);
	}
}

/** The in-process `warden-uiad` and the recorded session behind it. */
export class UiadTesting {
	private recorded: Recorded | undefined;

	/** The recorded session, parsed once: the `ready` event, and the first reply of each op. */
	recordedSession(): Recorded {
		if (this.recorded) return this.recorded;
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
			else if (typeof json.id === "string") this.keepFirstReply(replies, ops.get(json.id), json);
		}
		this.recorded = { ready, health: (ready.data ?? {}) as Record<string, unknown>, replies };
		return this.recorded;
	}

	fakeUiad(options: FakeUiadOptions = {}): FakeUiad {
		return new FakeUiadServer(options, this.recordedSession());
	}

	private keepFirstReply(replies: Map<string, FakeReply>, op: string | undefined, json: Record<string, unknown>): void {
		if (op === undefined || replies.has(op)) return;
		replies.set(op, json.ok === true ? { data: json.data } : { error: json.error as WireError });
	}
}

export const uiadTesting = new UiadTesting();

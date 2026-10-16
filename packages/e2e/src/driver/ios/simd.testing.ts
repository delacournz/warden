import type { WireError } from "./simd-protocol";
import type { SimdProcess, SimdSpawn } from "./simd-transport";

/** A request as the fake helper received it (`id` and `op` plus the params the client sent). */
export type FakeSimdRequest = { id: string; op: string; timeoutMs?: number; [param: string]: unknown };

/** What the handler answers: `data` (default null) or an `error`. `undefined` = `E_BAD_REQUEST` unknown op. */
export type FakeSimdReply = { data?: unknown } | { error: WireError } | undefined;

export type FakeSimdOptions = {
	ready?: Record<string, unknown>;
	/** the lines written to stdout before `ready` (garbage, logs…) */
	preamble?: string[];
};

export type FakeSimd = {
	/** inject as `spawn` of `spawnSimd` / `openIosDriver` */
	spawn: SimdSpawn;
	/** every request received, in order, across respawns */
	requests: FakeSimdRequest[];
	/** the argv of each spawn */
	spawns: string[][];
	/** requests with this op */
	of(op: string): FakeSimdRequest[];
};

function wireReply(request: FakeSimdRequest, reply: FakeSimdReply): Record<string, unknown> {
	if (reply === undefined) {
		const error = { code: "E_BAD_REQUEST", message: `fakeSimd: no reply for ${request.op}` };
		return { id: request.id, ok: false, error };
	}
	if ("error" in reply) return { id: request.id, ok: false, error: reply.error };
	return { id: request.id, ok: true, data: reply.data ?? null };
}

const READY = {
	event: "ready",
	protocol: 1,
	version: "fake",
	udid: "UDID-1",
	hid: { transport: "fake" },
	ax: { default: "axbridge", bridge: "available" },
	screen: { width: 390, height: 844, scale: 3 },
};

/**
 * In-memory `warden-simd`: an injectable `SimdSpawn` whose "process" answers requests from `handler`
 * synchronously, with no subprocess. Use it to assert the exact requests a driver sends; use
 * `native/scripts/fake-simd.ts` when you need a real process (crashes, delays, stderr).
 */
export function fakeSimd(
	handler: (request: FakeSimdRequest) => FakeSimdReply | Promise<FakeSimdReply>,
	options: FakeSimdOptions = {}
): FakeSimd {
	const requests: FakeSimdRequest[] = [];
	const spawns: string[][] = [];
	const encoder = new TextEncoder();

	const spawn: SimdSpawn = (cmd) => {
		spawns.push([...cmd]);
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		let closed = false;
		let finish: (code: number) => void = () => undefined;
		const exited = new Promise<number>((resolve) => {
			finish = resolve;
		});
		const emit = (value: unknown) => {
			if (!closed)
				controller?.enqueue(encoder.encode(`${typeof value === "string" ? value : JSON.stringify(value)}\n`));
		};
		const stop = (code: number) => {
			if (closed) return;
			closed = true;
			controller?.close();
			finish(code);
		};
		const stdout = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
				for (const line of options.preamble ?? []) emit(line);
				emit({ ...READY, ...options.ready });
			},
		});
		let buffer = "";
		const proc: SimdProcess = {
			stdout,
			exited,
			write(data) {
				buffer += data;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					const request = JSON.parse(line) as FakeSimdRequest;
					requests.push(request);
					void (async () => {
						const reply = await handler(request);
						if (request.op === "shutdown" && reply === undefined) {
							emit({ id: request.id, ok: true, data: null });
							stop(0);
						} else emit(wireReply(request, reply));
					})();
				}
			},
			end: () => stop(0),
			kill: () => stop(137),
		};
		return proc;
	};

	return { spawn, requests, spawns, of: (op) => requests.filter((request) => request.op === op) };
}

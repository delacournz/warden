import { readFileSync } from "node:fs";
import { type FakeSimd, type FakeSimdReply, type FakeSimdRequest, fakeSimd } from "../simd.testing";

/** What the runner's `ready` event carries (`backend` ax, `engine` xcuitest; the shared handshake schema reads the rest). */
export const RUNNER_READY = {
	event: "ready",
	protocol: 1,
	version: "0.1.0",
	udid: "00008140-000A0B0C0D0E0F10",
	hid: { transport: "xcuitest" },
	ax: { default: "ax", bridge: "missing" },
	screen: { width: 440, height: 956, scale: 3 },
	backend: "ax",
	engine: "xcuitest",
};

export type RunnerHandler = (request: FakeSimdRequest) => FakeSimdReply | Promise<FakeSimdReply>;

/** An in-memory `warden-runner`: {@link fakeSimd} with the runner's handshake. */
export function fakeRunner(handler: RunnerHandler): FakeSimd {
	return fakeSimd(handler, { ready: RUNNER_READY });
}

/** One recorded pair of `native/scripts/runner-smoke.ts --record`: the request and the wire response to it. */
export type RecordedPair = { request: { op: string } & Record<string, unknown>; response: Record<string, unknown> };

export const RECORDING_PATH = new URL("../../../../native/scripts/fixtures/runner-smoke.ndjson", import.meta.url)
	.pathname;

export function parseRecording(text: string): RecordedPair[] {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as RecordedPair);
}

export function loadRecording(path = RECORDING_PATH): RecordedPair[] {
	return parseRecording(readFileSync(path, "utf8"));
}

function replyOf(response: Record<string, unknown>): FakeSimdReply {
	const error = response.error;
	if (typeof error === "object" && error !== null) {
		const { code, message, retryable, detail } = error as Record<string, unknown>;
		return {
			error: {
				code: String(code),
				message: String(message),
				...(typeof retryable === "boolean" ? { retryable } : {}),
				...(detail !== undefined ? { detail } : {}),
			},
		};
	}
	return { data: response.data };
}

/**
 * Answers each op with the responses recorded for it, in order, then keeps repeating the last one. An op with no
 * recording is `E_BAD_REQUEST` (the fake's default). `overrides` win per op.
 */
export function recordingHandler(
	pairs: readonly RecordedPair[],
	overrides: Record<string, RunnerHandler> = {}
): RunnerHandler {
	const queues = new Map<string, FakeSimdReply[]>();
	for (const pair of pairs) {
		const queue = queues.get(pair.request.op) ?? [];
		queue.push(replyOf(pair.response));
		queues.set(pair.request.op, queue);
	}
	const taken = new Map<string, number>();
	return (request) => {
		const override = overrides[request.op];
		if (override) return override(request);
		const queue = queues.get(request.op);
		if (!queue) return undefined;
		const index = Math.min(taken.get(request.op) ?? 0, queue.length - 1);
		taken.set(request.op, index + 1);
		return queue[index];
	};
}

/** A fake runner that replays the real-device recording. */
export function replayRunner(overrides: Record<string, RunnerHandler> = {}): FakeSimd {
	return fakeRunner(recordingHandler(loadRecording(), overrides));
}

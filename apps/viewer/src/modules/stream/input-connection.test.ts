import { describe, expect, test } from "bun:test";
import type { InputEvent, InputFrame } from "../../core/api/device.api.ts";
import { createInputConnection } from "./input-connection.ts";

function harness(connectFails = false) {
	const log = { connects: 0, closes: 0, sent: [] as InputFrame[], ready: [] as boolean[], errors: [] as string[] };
	let emit: (e: InputEvent) => void = () => undefined;
	const timers: { fn: () => void; ms: number; live: boolean }[] = [];
	const conn = createInputConnection({
		api: {
			connect: (onEvent) => {
				log.connects += 1;
				emit = onEvent;
				return connectFails ? Promise.reject(new Error("no")) : Promise.resolve();
			},
			send: (frame) => {
				log.sent.push(frame);
				return Promise.resolve();
			},
			close: () => {
				log.closes += 1;
				return Promise.resolve();
			},
		},
		onReadyChange: (r) => log.ready.push(r),
		onError: (m) => log.errors.push(m),
		setTimer: (fn, ms) => {
			const t = { fn, ms, live: true };
			timers.push(t);
			return t;
		},
		clearTimer: (h) => {
			(h as { live: boolean }).live = false;
		},
	});
	const fire = () =>
		timers
			.filter((t) => t.live)
			.at(-1)
			?.fn();
	return { conn, log, timers, fire, emit: (e: InputEvent) => emit(e) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createInputConnection", () => {
	test("ready only after the ready event", () => {
		const h = harness();
		h.conn.start();
		expect(h.conn.isReady()).toBe(false);
		h.emit({ type: "ready" });
		expect(h.conn.isReady()).toBe(true);
		expect(h.log.ready).toEqual([true]);
	});

	test("closed drops ready and reconnects after 1s, then doubles", () => {
		const h = harness();
		h.conn.start();
		h.emit({ type: "ready" });
		h.emit({ type: "closed", reason: "x" });
		expect(h.conn.isReady()).toBe(false);
		expect(h.timers.at(-1)?.ms).toBe(1000);
		h.fire();
		expect(h.log.connects).toBe(2);
		h.emit({ type: "closed", reason: "x" });
		expect(h.timers.at(-1)?.ms).toBe(2000);
	});

	test("ready resets the backoff", () => {
		const h = harness();
		h.conn.start();
		h.emit({ type: "closed", reason: "x" });
		h.fire();
		h.emit({ type: "closed", reason: "x" });
		h.fire();
		h.emit({ type: "ready" });
		h.emit({ type: "closed", reason: "x" });
		expect(h.timers.at(-1)?.ms).toBe(1000);
	});

	test("a failed connect retries with backoff", async () => {
		const h = harness(true);
		h.conn.start();
		await flush();
		expect(h.timers.at(-1)?.ms).toBe(1000);
		h.fire();
		await flush();
		expect(h.timers.at(-1)?.ms).toBe(2000);
	});

	test("error events surface their message", () => {
		const h = harness();
		h.conn.start();
		h.emit({ type: "error", code: "X", message: "bad frame" });
		expect(h.log.errors).toEqual(["bad frame"]);
	});

	test("stop closes, cancels the retry and ignores later events", () => {
		const h = harness();
		h.conn.start();
		h.emit({ type: "closed", reason: "x" });
		h.conn.stop();
		expect(h.log.closes).toBe(1);
		expect(h.timers.at(-1)?.live).toBe(false);
		h.emit({ type: "ready" });
		expect(h.conn.isReady()).toBe(false);
	});

	test("send passes frames to the api", async () => {
		const h = harness();
		h.conn.start();
		await h.conn.send({ type: "goHome" });
		expect(h.log.sent).toEqual([{ type: "goHome" }]);
	});
});

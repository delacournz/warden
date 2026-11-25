import { describe, expect, test } from "bun:test";
import { createTextBatcher } from "./text-batcher.ts";

describe("createTextBatcher", () => {
	function harness() {
		const sent: string[] = [];
		let pending: (() => void) | null = null;
		const batcher = createTextBatcher({
			send: (text) => sent.push(text),
			delayMs: 150,
			setTimer: (fn) => {
				pending = fn;
				return 1;
			},
			clearTimer: () => {
				pending = null;
			},
		});
		return { batcher, sent, fire: () => pending?.(), hasTimer: () => pending !== null };
	}

	test("batches keys until the debounce fires", () => {
		const h = harness();
		h.batcher.push("h");
		h.batcher.push("i");
		expect(h.sent).toEqual([]);
		h.fire();
		expect(h.sent).toEqual(["hi"]);
		expect(h.hasTimer()).toBe(false);
	});

	test("flush sends immediately and cancels the timer", () => {
		const h = harness();
		h.batcher.push("a");
		h.batcher.push("\n");
		h.batcher.flush();
		expect(h.sent).toEqual(["a\n"]);
		expect(h.hasTimer()).toBe(false);
	});

	test("flush with nothing buffered sends nothing", () => {
		const h = harness();
		h.batcher.flush();
		expect(h.sent).toEqual([]);
	});

	test("cancel drops the buffer", () => {
		const h = harness();
		h.batcher.push("x");
		h.batcher.cancel();
		h.batcher.flush();
		expect(h.sent).toEqual([]);
	});
});

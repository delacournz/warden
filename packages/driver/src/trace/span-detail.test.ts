import { describe, expect, test } from "bun:test";
import { addSpanDetail, collectSpanDetail, noteSpanDetail } from "./span-detail";

describe("span detail notes", () => {
	test("notes outside a collector go nowhere", () => {
		expect(() => noteSpanDetail("route", "tty")).not.toThrow();
		expect(() => addSpanDetail("adbMs", 5)).not.toThrow();
	});

	test("a collector gets the notes made while its call runs, across awaits", async () => {
		const notes = {};
		await collectSpanDetail(notes, async () => {
			noteSpanDetail("route", "tty");
			await Promise.resolve();
			addSpanDetail("adbMs", 30);
			await new Promise((resolve) => setTimeout(resolve, 1));
			addSpanDetail("adbMs", 12);
			addSpanDetail("adbCalls", 1);
			addSpanDetail("adbCalls", 1);
		});
		expect(notes).toEqual({ route: "tty", adbMs: 42, adbCalls: 2 });
	});

	test("a nested collector keeps its own notes; the outer one is untouched", async () => {
		const outer = {};
		const inner = {};
		await collectSpanDetail(outer, async () => {
			noteSpanDetail("where", "outer");
			await collectSpanDetail(inner, async () => {
				noteSpanDetail("where", "inner");
			});
		});
		expect(outer).toEqual({ where: "outer" });
		expect(inner).toEqual({ where: "inner" });
	});

	test("concurrent calls do not mix their notes", async () => {
		const a = {};
		const b = {};
		await Promise.all([
			collectSpanDetail(a, async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				noteSpanDetail("who", "a");
			}),
			collectSpanDetail(b, async () => {
				noteSpanDetail("who", "b");
			}),
		]);
		expect(a).toEqual({ who: "a" });
		expect(b).toEqual({ who: "b" });
	});

	test("addSpanDetail over a non-number replaces it", async () => {
		const notes = {};
		await collectSpanDetail(notes, async () => {
			noteSpanDetail("x", "text");
			addSpanDetail("x", 2);
		});
		expect(notes).toEqual({ x: 2 });
	});
});

import { describe, expect, test } from "bun:test";
import { spanDetails } from "./span-detail";

describe("span detail notes", () => {
	test("notes outside a collector go nowhere", () => {
		expect(() => spanDetails.note("route", "tty")).not.toThrow();
		expect(() => spanDetails.add("adbMs", 5)).not.toThrow();
	});

	test("a collector gets the notes made while its call runs, across awaits", async () => {
		const notes = {};
		await spanDetails.collect(notes, async () => {
			spanDetails.note("route", "tty");
			await Promise.resolve();
			spanDetails.add("adbMs", 30);
			await new Promise((resolve) => setTimeout(resolve, 1));
			spanDetails.add("adbMs", 12);
			spanDetails.add("adbCalls", 1);
			spanDetails.add("adbCalls", 1);
		});
		expect(notes).toEqual({ route: "tty", adbMs: 42, adbCalls: 2 });
	});

	test("a nested collector keeps its own notes; the outer one is untouched", async () => {
		const outer = {};
		const inner = {};
		await spanDetails.collect(outer, async () => {
			spanDetails.note("where", "outer");
			await spanDetails.collect(inner, async () => {
				spanDetails.note("where", "inner");
			});
		});
		expect(outer).toEqual({ where: "outer" });
		expect(inner).toEqual({ where: "inner" });
	});

	test("concurrent calls do not mix their notes", async () => {
		const a = {};
		const b = {};
		await Promise.all([
			spanDetails.collect(a, async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				spanDetails.note("who", "a");
			}),
			spanDetails.collect(b, async () => {
				spanDetails.note("who", "b");
			}),
		]);
		expect(a).toEqual({ who: "a" });
		expect(b).toEqual({ who: "b" });
	});

	test("spanDetails.add over a non-number replaces it", async () => {
		const notes = {};
		await spanDetails.collect(notes, async () => {
			spanDetails.note("x", "text");
			spanDetails.add("x", 2);
		});
		expect(notes).toEqual({ x: 2 });
	});
});

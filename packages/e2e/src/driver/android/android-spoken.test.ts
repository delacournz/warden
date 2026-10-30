import { describe, expect, test } from "bun:test";
import type { Element } from "../driver.types";
import { readSpoken, type SpokenDeps } from "./android-spoken";
import { elementOfNode } from "./uiad-screen-reader";

const SCREEN = { width: 1080, height: 2400 };

function row(name: string, state: Record<string, boolean> = {}) {
	const node = {
		class: "android.widget.LinearLayout",
		bounds: [0, 200, 1080, 400],
		clickable: true,
		focusable: true,
		...state,
		children: [{ class: "android.widget.TextView", text: name, bounds: [40, 220, 600, 300] }],
	};
	const parsed = elementOfNode(node, SCREEN);
	if (!parsed.success) throw new Error(parsed.error);
	return parsed.data;
}

const LOG_LINE = (at: string, text: string) =>
	`${at}  5491  5491 V talkback: SpeechControllerImpl: Speaking fragment text="${text}", utteranceId=talkback_6, TtsSpan=null, locale=null, event=type:EVENT_TYPE_ACCESSIBILITY subtype:TYPE_VIEW_ACCESSIBILITY_FOCUSED displayId:0 time:1`;

function deps(
	over: Partial<SpokenDeps> & { events?: { element: Element; at: number }[]; logs?: (string | undefined)[] }
): SpokenDeps {
	const logs = over.logs ?? [undefined];
	let reads = 0;
	return {
		readLog: async () => logs[Math.min(reads++, logs.length - 1)],
		focusEvents: async () => ({ success: true, data: { events: over.events ?? [], cursor: 0 } }),
		now: () => 9,
		sleep: async () => undefined,
		...over,
	};
}

describe("readSpoken", () => {
	test("without verbose logging the lines are composed from the focus events and say so", async () => {
		const out = await readSpoken(deps({ events: [{ element: row("Network & internet"), at: 100 }] }));
		expect(out.success && out.data.lines).toEqual([
			{ text: expect.stringContaining("Network & internet"), at: 100, source: "simulated" },
		]);
		expect(out.success && out.data.cursor).toBe(100);
	});
	test("the cursor skips what was already read", async () => {
		const events = [
			{ element: row("One"), at: 100 },
			{ element: row("Two"), at: 200 },
		];
		const out = await readSpoken(deps({ events }), 100);
		expect(out.success && out.data.lines.map((l) => l.text.includes("Two"))).toEqual([true]);
		expect(out.success && out.data.cursor).toBe(200);
	});
	test("with verbose logging the real lines are used and the events ignored", async () => {
		const log = [LOG_LINE("1761836191.922", "Apps. 7 of 28"), LOG_LINE("1761836193.000", "Display. 8 of 28")].join(
			"\n"
		);
		const out = await readSpoken(
			deps({ logs: [log], events: [{ element: row("Apps"), at: 1761836191900 }] }),
			1761836191000
		);
		expect(out.success && out.data.lines).toEqual([
			{ text: "Apps. 7 of 28", at: 1761836191922, source: "talkback" },
			{ text: "Display. 8 of 28", at: 1761836193000, source: "talkback" },
		]);
		expect(out.success && out.data.cursor).toBe(1761836193000);
	});
	test("a log line that trails its focus event is waited for", async () => {
		const early = LOG_LINE("1.000", "Old");
		const late = `${early}\n${LOG_LINE("5.000", "New")}`;
		const out = await readSpoken(
			deps({ logs: [early, early, late], events: [{ element: row("New"), at: 4900 }] }),
			2000
		);
		expect(out.success && out.data.lines.map((l) => l.text)).toEqual(["New"]);
	});
	test("a failed event read is the error", async () => {
		const out = await readSpoken({
			...deps({}),
			focusEvents: async () => ({ success: false, error: { code: "E_UNSUPPORTED", message: "x", retryable: false } }),
		});
		expect(out.success).toBe(false);
	});
});

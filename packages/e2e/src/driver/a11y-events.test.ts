import { describe, expect, test } from "bun:test";
import { parseA11yEvent, parseInjectEvents, parseUiadA11yEvents } from "./a11y-events";

const line = (o: object): string => `${JSON.stringify(o)}\n`;

describe("parseA11yEvent", () => {
	test("keeps kind, text, at and tags the source", () => {
		expect(parseA11yEvent({ kind: "live-region", text: "count 1", at: 3 }, "uiad")).toEqual({
			kind: "live-region",
			text: "count 1",
			at: 3,
			source: "uiad",
		});
	});
	test("drops empty text and rejects unknown kinds or a missing time", () => {
		expect(parseA11yEvent({ kind: "layout-changed", text: "", at: 1 }, "inject")).toEqual({
			kind: "layout-changed",
			at: 1,
			source: "inject",
		});
		expect(parseA11yEvent({ kind: "shout", at: 1 }, "uiad")).toBeUndefined();
		expect(parseA11yEvent({ kind: "announcement" }, "uiad")).toBeUndefined();
		expect(parseA11yEvent({ kind: "announcement", text: 4, at: 1 }, "uiad")).toBeUndefined();
	});
});

describe("parseUiadA11yEvents", () => {
	test("reads events, cursor and lost", () => {
		const out = parseUiadA11yEvents({ events: [{ kind: "announcement", text: "hi", at: 1 }], cursor: 7, lost: true });
		expect(out).toEqual({
			success: true,
			data: { events: [{ kind: "announcement", text: "hi", at: 1, source: "uiad" }], cursor: 7, lost: true },
		});
	});
	test("a wrong shape or a malformed event is an error, not a guess", () => {
		expect(parseUiadA11yEvents({ cursor: 1 }).success).toBe(false);
		expect(parseUiadA11yEvents({ events: [{ kind: "x", at: 1 }], cursor: 1 }).success).toBe(false);
	});
});

describe("parseInjectEvents", () => {
	test("parses complete lines and returns the byte offset after them", () => {
		const a = line({ kind: "announcement", text: "Saved", at: 1 });
		const b = line({ kind: "screen-changed", at: 2 });
		const out = parseInjectEvents(a + b);
		expect(out.events.map((e) => e.kind)).toEqual(["announcement", "screen-changed"]);
		expect(out.cursor).toBe(Buffer.byteLength(a + b));
	});
	test("a half-written last line waits: the cursor stops before it and the next read gets it whole", () => {
		const a = line({ kind: "announcement", text: "one", at: 1 });
		const partial = `${a}{"kind":"announ`;
		const first = parseInjectEvents(partial);
		expect(first.events).toHaveLength(1);
		expect(first.cursor).toBe(Buffer.byteLength(a));
		const b = line({ kind: "announcement", text: "two", at: 2 });
		const second = parseInjectEvents(a + b, first.cursor);
		expect(second.events.map((e) => e.text)).toEqual(["two"]);
	});
	test("the cursor counts bytes, not characters", () => {
		const a = line({ kind: "announcement", text: "Zapisano ✓ \u{1F600}", at: 1 });
		const out = parseInjectEvents(a + line({ kind: "layout-changed", at: 2 }), Buffer.byteLength(a));
		expect(out.events.map((e) => e.kind)).toEqual(["layout-changed"]);
	});
	test("a corrupt complete line is skipped and passed over", () => {
		const text = `not json\n${line({ kind: "announcement", text: "ok", at: 1 })}`;
		const out = parseInjectEvents(text);
		expect(out.events).toHaveLength(1);
		expect(out.cursor).toBe(Buffer.byteLength(text));
	});
	test("a cursor past the end (the file was reset by a relaunch) restarts from the top", () => {
		const text = line({ kind: "announcement", text: "fresh", at: 1 });
		expect(parseInjectEvents(text, 9999).events).toHaveLength(1);
	});
	test("nothing new keeps the cursor", () => {
		const text = line({ kind: "announcement", text: "x", at: 1 });
		expect(parseInjectEvents(text, Buffer.byteLength(text))).toEqual({ events: [], cursor: Buffer.byteLength(text) });
	});
});

describe("iOS system announcement noise", () => {
	test("AXAnnouncementType* keyboard sounds are dropped", () => {
		const text = `${JSON.stringify({ kind: "announcement", text: "AXAnnouncementTypeKeyboardClickSound", at: 1 })}\n${JSON.stringify({ kind: "announcement", text: "Saved", at: 2 })}\n`;
		expect(parseInjectEvents(text).events.map((e) => e.text)).toEqual(["Saved"]);
	});
});

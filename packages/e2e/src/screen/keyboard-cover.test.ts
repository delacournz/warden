import { describe, expect, test } from "bun:test";
import { el, fakeDriver, snapshotOf } from "../driver/driver.testing";
import { coverOf, dismissKeyboard, scrollPath } from "./keyboard-cover";
import { indexSnapshot } from "./nodes";

const KEYBOARD = el("keyboard", { frame: { x: 0, y: 600, width: 400, height: 300 } });

function entryIn(snapshot: ReturnType<typeof snapshotOf>, id: string) {
	const index = indexSnapshot(snapshot);
	const entry = index.entries.find((e) => e.element.identifier === id);
	if (!entry) throw new Error(`no ${id}`);
	return entry;
}

describe("coverOf", () => {
	test("a target above the keyboard is not covered", () => {
		const snap = snapshotOf([el("button", { id: "ok", frame: { x: 0, y: 100, width: 100, height: 40 } }), KEYBOARD]);
		const entry = entryIn(snap, "ok");
		expect(coverOf(entry, { x: 50, y: 120 }, snap)).toBeUndefined();
	});

	test("no keyboard, no cover", () => {
		const snap = snapshotOf([el("button", { id: "ok", frame: { x: 0, y: 700, width: 100, height: 40 } })]);
		expect(coverOf(entryIn(snap, "ok"), { x: 50, y: 720 }, snap)).toBeUndefined();
	});

	test("a covered target outside any scroll container is cleared by dismissing the keyboard", () => {
		const snap = snapshotOf([el("button", { id: "ok", frame: { x: 0, y: 700, width: 100, height: 40 } }), KEYBOARD]);
		const cover = coverOf(entryIn(snap, "ok"), { x: 50, y: 720 }, snap);
		expect(cover).toMatchObject({ top: 600, shift: 160 });
		expect(cover?.scroller).toBeUndefined();
	});

	test("a covered target in a scroll view reports the free part of it", () => {
		const snap = snapshotOf([
			el("scrollview", {
				frame: { x: 0, y: 50, width: 400, height: 850 },
				children: [el("button", { id: "ok", frame: { x: 0, y: 700, width: 100, height: 40 } })],
			}),
			KEYBOARD,
		]);
		const cover = coverOf(entryIn(snap, "ok"), { x: 50, y: 720 }, snap);
		expect(cover?.scroller).toEqual({ x: 0, y: 50, width: 400, height: 550 });
		expect(cover?.shift).toBe(160);
	});

	test("the keyboard itself is never covered", () => {
		const snap = snapshotOf([KEYBOARD]);
		const key = snap.flat.find((e) => e.role === "keyboard");
		expect(key).toBeDefined();
	});
});

describe("scrollPath", () => {
	test("drags up by the shift inside the free part", () => {
		const path = scrollPath({ x: 0, y: 50, width: 400, height: 550 }, 160);
		expect(path.from).toEqual({ x: 200, y: 588 });
		expect(path.to).toEqual({ x: 200, y: 428 });
	});

	test("a shift taller than the free part is capped to it", () => {
		const path = scrollPath({ x: 0, y: 50, width: 400, height: 200 }, 900);
		expect(path.from.y - path.to.y).toBe(176);
	});
});

describe("dismissKeyboard", () => {
	test("iOS resigns the first responder (never Enter), Android presses back", async () => {
		const ios = fakeDriver({ screens: [snapshotOf([])] });
		await dismissKeyboard(ios);
		expect(ios.callsOf("dismissKeyboard")).toHaveLength(1);
		expect(ios.callsOf("key")).toHaveLength(0);
		const android = fakeDriver({ screens: [snapshotOf([], { platform: "android" })], platform: "android" });
		await dismissKeyboard(android);
		expect(android.callsOf("pressButton")[0]?.button).toBe("back");
	});
});

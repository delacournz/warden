import { describe, expect, test } from "bun:test";
import { el, type FakeDriver, failWith, fakeDriver, snapshotOf } from "../driver/driver.testing";
import {
	CONFIRM_READS,
	confirmFieldValue,
	confirmReadsFor,
	FIELD_POLL_MS,
	type FieldReading,
	FOCUS_POLL_MS,
	FOCUS_POLLS,
	focusAndClear,
	focusClearType,
	STALE_RISK_READS,
	tapToFocus,
} from "./field";
import { indexSnapshot, type NodeEntry } from "./nodes";
import { fakeClock } from "./poll.testing";
import { FIELD_FRAME, fieldFixture } from "./screen.testing";

/** Reads that play back `readings` one per look (the last one repeats). */
function scripted(readings: FieldReading[]) {
	const clock = fakeClock();
	let looks = 0;
	return {
		clock,
		looks: () => looks,
		run: (options: { text: string; budgetMs?: number; reads?: number; maxMs?: number }) =>
			confirmFieldValue<string>({
				text: options.text,
				now: clock.now,
				sleep: clock.sleep,
				budgetMs: options.budgetMs ?? 1000,
				...(options.reads === undefined ? {} : { reads: options.reads }),
				...(options.maxMs === undefined ? {} : { maxMs: options.maxMs }),
				read: async () => {
					const reading = readings[Math.min(looks, readings.length - 1)];
					looks += 1;
					return reading === undefined ? { ok: false, error: "no reading" } : { ok: true, reading };
				},
			}),
	};
}

const value = (text: string): FieldReading => ({ kind: "value", value: text });

describe("confirmFieldValue", () => {
	test("a single matching read is not enough: the next read must agree", async () => {
		const { run, looks, clock } = scripted([value("hi")]);
		expect(await run({ text: "hi" })).toEqual({ status: "confirmed" });
		expect(looks()).toBe(CONFIRM_READS);
		expect(clock.sleeps).toEqual([FIELD_POLL_MS]);
	});

	test("a stale value that matches once and then moves on does not confirm", async () => {
		const { run } = scripted([value("hi"), value("h"), value("hi"), value("hi")]);
		expect(await run({ text: "hi" })).toEqual({ status: "confirmed" });
	});

	test("the value lags and then matches", async () => {
		const { run, looks } = scripted([value(""), value(""), value(""), value("hello")]);
		expect(await run({ text: "hello" })).toEqual({ status: "confirmed" });
		expect(looks()).toBe(5);
	});

	test("a value that never matches is a mismatch carrying what the field holds (the first read counts as a change)", async () => {
		const { run, clock } = scripted([value("hell")]);
		expect(await run({ text: "hello", budgetMs: 500 })).toEqual({ status: "mismatch", held: "hell" });
		expect(clock.elapsed()).toBe(1000);
	});

	test("a value that keeps changing extends the wait, up to maxMs", async () => {
		const growing = Array.from({ length: 26 }, (_, n) => value("x".repeat(n)));
		const free = scripted(growing);
		expect(await free.run({ text: "x".repeat(25), budgetMs: 300 })).toEqual({ status: "confirmed" });
		const capped = scripted(growing);
		expect(await capped.run({ text: "x".repeat(25), budgetMs: 300, maxMs: 800 })).toMatchObject({ status: "mismatch" });
		expect(capped.clock.elapsed()).toBe(800);
	});

	test("more reads can be demanded when the old value could be mistaken for the new one", async () => {
		const { run, looks } = scripted([value("hi")]);
		expect(await run({ text: "hi", reads: STALE_RISK_READS })).toEqual({ status: "confirmed" });
		expect(looks()).toBe(STALE_RISK_READS);
	});

	test("an unreadable field reports its note and resets the run", async () => {
		const { run } = scripted([value("hi"), { kind: "unreadable", note: "(2 matches)" }]);
		expect(await run({ text: "hi", budgetMs: 300 })).toEqual({ status: "mismatch", held: "(2 matches)" });
	});

	test("a failed read ends the wait at once", async () => {
		const { run } = scripted([]);
		expect(await run({ text: "hi" })).toEqual({ status: "failed", error: "no reading" });
	});
});

describe("focusClearType", () => {
	const field = () => fieldFixture({ value: "ab" }).driver;
	const entryOf = (driver: ReturnType<typeof field>) => {
		const found = indexSnapshot(driver.screen).entries.find((candidate) => candidate.element.identifier === "field");
		if (found === undefined) throw new Error("no field");
		return found;
	};

	test("taps the caret spot, backspaces what the field shows plus a spare, then types", async () => {
		const driver = field();
		const clock = fakeClock();
		const result = await focusClearType(driver, clock.sleep, { x: 5, y: 6 }, entryOf(driver), "xy");
		expect(result.success).toBe(true);
		expect(driver.calls.map((call) => call.method)).toEqual(["tap", "elementAtPoint", "key", "key", "key", "typeText"]);
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 5, y: 6 });
	});

	test("a bare coordinate has nothing to clear, and empty text only clears", async () => {
		const driver = field();
		const clock = fakeClock();
		await focusClearType(driver, clock.sleep, { x: 1, y: 2 }, undefined, "z");
		expect(driver.calls.map((call) => call.method)).toEqual(["tap", "typeText"]);
		const other = field();
		await focusAndClear(other, clock.sleep, { x: 1, y: 2 }, entryOf(other));
		expect(other.callsOf("typeText")).toEqual([]);
		expect(other.callsOf("key")).toHaveLength(3);
	});

	test("a failed tap stops before any key", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (call) => (call.method === "tap" ? failWith("E_TIMEOUT") : undefined),
		});
		const clock = fakeClock();
		const result = await focusClearType(driver, clock.sleep, { x: 1, y: 2 }, undefined, "z");
		expect(result.success).toBe(false);
		expect(driver.calls.map((call) => call.method)).toEqual(["tap"]);
	});
});

const POINT = { x: 1, y: 2 };

describe("tapToFocus", () => {
	/** Inside `FIELD_FRAME`, where a hit-test finds the field. */
	const IN_FIELD = { x: FIELD_FRAME.x + 10, y: FIELD_FRAME.y + 10 };

	test("iOS: after the tap that moves focus, hit-tests the tap point until the field reports focus", async () => {
		const { driver } = fieldFixture({ focused: false, focusReads: 2 });
		const clock = fakeClock();
		expect((await tapToFocus(driver, clock.sleep, IN_FIELD, entryOfField(driver))).success).toBe(true);
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "elementAtPoint", "elementAtPoint"]);
		expect(driver.callsOf("elementAtPoint").map((call) => call.point)).toEqual([IN_FIELD, IN_FIELD, IN_FIELD]);
		expect(clock.sleeps).toEqual([FOCUS_POLL_MS, FOCUS_POLL_MS]);
	});

	test("a field that already had focus is not waited on: re-tapping it moves nothing", async () => {
		const { driver } = fieldFixture({ focused: true });
		await tapToFocus(driver, fakeClock().sleep, IN_FIELD, entryOfField(driver));
		expect(methods(driver)).toEqual(["tap"]);
	});

	test("a field that never reports focus is hit-tested FOCUS_POLLS times at most", async () => {
		const { driver } = fieldFixture({ focused: false, neverFocuses: true });
		const clock = fakeClock();
		expect((await tapToFocus(driver, clock.sleep, IN_FIELD, entryOfField(driver))).success).toBe(true);
		expect(driver.callsOf("elementAtPoint")).toHaveLength(FOCUS_POLLS);
		expect(clock.sleeps).toHaveLength(FOCUS_POLLS - 1);
	});

	test("a hit-test that cannot tell (fails, or finds another element there) ends the wait at once", async () => {
		const field = el("textfield", { id: "field", frame: FIELD_FRAME, focused: false });
		const fieldEntry = (driver: FakeDriver) => {
			const found = indexSnapshot(driver.screen).entries.find((candidate) => candidate.element.identifier === "field");
			if (found === undefined) throw new Error("no field");
			return found;
		};
		const clock = fakeClock();
		const broken = fakeDriver({
			screens: [snapshotOf([field])],
			onCall: (call) => (call.method === "elementAtPoint" ? failWith("E_TIMEOUT") : undefined),
		});
		await tapToFocus(broken, clock.sleep, IN_FIELD, fieldEntry(broken));
		expect(methods(broken)).toEqual(["tap", "elementAtPoint"]);
		const before = fakeDriver({ screens: [snapshotOf([field])] });
		const entry = fieldEntry(before);
		const covered = fakeDriver({ screens: [snapshotOf([el("button", { id: "cover", frame: FIELD_FRAME })])] });
		await tapToFocus(covered, clock.sleep, IN_FIELD, entry);
		expect(methods(covered)).toEqual(["tap", "elementAtPoint"]);
		const shifted = fakeDriver({
			screens: [snapshotOf([el("textfield", { id: "next-field", frame: FIELD_FRAME, focused: false })])],
		});
		await tapToFocus(shifted, clock.sleep, IN_FIELD, entry);
		expect(methods(shifted)).toEqual(["tap", "elementAtPoint"]);
		expect(clock.elapsed()).toBe(0);
	});

	test("Android and a bare coordinate are not waited on", async () => {
		const android = fakeDriver({ platform: "android", screens: [snapshotOf([])] });
		await tapToFocus(android, fakeClock().sleep, IN_FIELD, undefined);
		expect(methods(android)).toEqual(["tap"]);
		const { driver } = fieldFixture({ focused: false });
		await tapToFocus(driver, fakeClock().sleep, IN_FIELD, undefined);
		expect(methods(driver)).toEqual(["tap"]);
	});

	test("a failed tap is returned as is", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (call) => (call.method === "tap" ? failWith("E_TIMEOUT") : undefined),
		});
		expect((await tapToFocus(driver, fakeClock().sleep, IN_FIELD, undefined)).success).toBe(false);
		expect(methods(driver)).toEqual(["tap"]);
	});

	test("focusClearType waits for the focus between the tap and the first key", async () => {
		const { driver } = fieldFixture({ value: "ada@example.com", focused: false, focusReads: 1, selectAll: true });
		await focusClearType(driver, fakeClock().sleep, IN_FIELD, entryOfField(driver), "x");
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "elementAtPoint", "selectAll", "typeText"]);
	});
});

function entryOfField(driver: { screen: Parameters<typeof indexSnapshot>[0] }): NodeEntry {
	const found = indexSnapshot(driver.screen).entries.find((candidate) => candidate.element.identifier === "field");
	if (found === undefined) throw new Error("no field");
	return found;
}

const methods = (driver: { calls: readonly { method: string }[] }) => driver.calls.map((call) => call.method);

describe("focusAndClear with select-all", () => {
	test("a filled field: select all and one Backspace, whatever its length", async () => {
		const { driver } = fieldFixture({ value: "ada@example.com", selectAll: true });
		const result = await focusAndClear(driver, fakeClock().sleep, POINT, entryOfField(driver));
		expect(result.success).toBe(true);
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "selectAll", "key"]);
		expect(driver.callsOf("key")).toEqual([{ method: "key", key: "Backspace" }]);
	});

	test("an empty field sends no keys at all", async () => {
		const { driver } = fieldFixture({ selectAll: true });
		await focusAndClear(driver, fakeClock().sleep, POINT, entryOfField(driver));
		expect(methods(driver)).toEqual(["tap", "elementAtPoint"]);
	});

	test("an empty field showing its placeholder as the value sends no keys", async () => {
		const { driver } = fieldFixture({ placeholder: "Email", selectAll: true });
		await focusAndClear(driver, fakeClock().sleep, POINT, entryOfField(driver));
		expect(methods(driver)).toEqual(["tap", "elementAtPoint"]);
		const counted = fieldFixture({ placeholder: "Email" });
		await focusAndClear(counted.driver, fakeClock().sleep, POINT, entryOfField(counted.driver));
		expect(methods(counted.driver)).toEqual(["tap", "elementAtPoint"]);
	});

	test("iOS sends placeholder: null, so a placeholder cannot be told from text: still two keys, never one per character", async () => {
		const { driver } = fieldFixture({ placeholder: "ada@example.com", placeholderMeta: false, selectAll: true });
		expect(entryOfField(driver).element.placeholder).toBeUndefined();
		await focusAndClear(driver, fakeClock().sleep, POINT, entryOfField(driver));
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "selectAll", "key"]);
	});

	test("a secure field showing its placeholder sends no keys", async () => {
		const { driver } = fieldFixture({ secure: true, placeholder: "At least 8 characters", selectAll: true });
		await focusAndClear(driver, fakeClock().sleep, POINT, entryOfField(driver));
		expect(methods(driver)).toEqual(["tap", "elementAtPoint"]);
	});

	test("a secure field holding dots is backspaced by its dots (it cannot be read back to verify a select-all)", async () => {
		const { driver, state } = fieldFixture({ secure: true, value: "abc", selectAll: true });
		await focusAndClear(driver, fakeClock().sleep, POINT, entryOfField(driver));
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "key", "key", "key", "key"]);
		expect(state.value).toBe("");
	});

	test("the counted method skips select-all even when the driver has it", async () => {
		const { driver, state } = fieldFixture({ value: "ab", selectAll: true });
		await focusAndClear(driver, fakeClock().sleep, POINT, entryOfField(driver), "counted");
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "key", "key", "key"]);
		expect(state.value).toBe("");
	});

	test("a driver without select-all backspaces the counted presses", async () => {
		const { driver } = fieldFixture({ value: "ab" });
		await focusAndClear(driver, fakeClock().sleep, POINT, entryOfField(driver));
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "key", "key", "key"]);
	});

	test("a select-all the driver rejects falls back to the counted presses", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([el("textfield", { id: "field", value: "ab", focused: true })])],
			selectAll: true,
			onCall: (call) => (call.method === "selectAll" ? failWith("E_BAD_REQUEST") : undefined),
		});
		const result = await focusAndClear(driver, fakeClock().sleep, POINT, entryOfField(driver));
		expect(result.success).toBe(true);
		expect(methods(driver)).toEqual(["tap", "selectAll", "key", "key", "key"]);
	});
});

describe("focusClearType with select-all types over the selection", () => {
	test("a filled field: select all then type, no Backspace at all", async () => {
		const { driver, state } = fieldFixture({ value: "old text", selectAll: true });
		const result = await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "new");
		expect(result.success).toBe(true);
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "selectAll", "typeText"]);
		expect(driver.callsOf("key")).toEqual([]);
		expect(state.value).toBe("new");
	});

	test("iOS cannot tell a placeholder from text: select all then type, never a Backspace per placeholder character", async () => {
		const { driver, state } = fieldFixture({ placeholder: "ada@example.com", placeholderMeta: false, selectAll: true });
		await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "grace@example.com");
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "selectAll", "typeText"]);
		expect(state.value).toBe("grace@example.com");
	});

	test("an empty field and a placeholder-only field are typed into with no select-all", async () => {
		const empty = fieldFixture({ selectAll: true });
		await focusClearType(empty.driver, fakeClock().sleep, POINT, entryOfField(empty.driver), "x");
		expect(methods(empty.driver)).toEqual(["tap", "elementAtPoint", "typeText"]);
		const placeholder = fieldFixture({ placeholder: "Email", selectAll: true });
		await focusClearType(placeholder.driver, fakeClock().sleep, POINT, entryOfField(placeholder.driver), "x");
		expect(methods(placeholder.driver)).toEqual(["tap", "elementAtPoint", "typeText"]);
	});

	test("empty text still has to delete the selection: select all and one Backspace", async () => {
		const { driver, state } = fieldFixture({ value: "old", selectAll: true });
		await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "");
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "selectAll", "key"]);
		expect(state.value).toBe("");
	});

	test("the counted method presses Backspaces then types, with no select-all", async () => {
		const { driver, state } = fieldFixture({ value: "ab", selectAll: true });
		await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "new", "counted");
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "key", "key", "key", "typeText"]);
		expect(state.value).toBe("new");
	});

	test("a secure field holding dots is still backspaced by its dots before typing", async () => {
		const { driver, state } = fieldFixture({ secure: true, value: "abc", selectAll: true });
		await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "xy");
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "key", "key", "key", "key", "typeText"]);
		expect(state.value).toBe("xy");
	});

	test("a select-all the driver rejects falls back to the counted presses, then types", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([el("textfield", { id: "field", value: "ab", focused: true })])],
			selectAll: true,
			onCall: (call) => (call.method === "selectAll" ? failWith("E_BAD_REQUEST") : undefined),
		});
		const result = await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "new");
		expect(result.success).toBe(true);
		expect(methods(driver)).toEqual(["tap", "selectAll", "key", "key", "key", "typeText"]);
	});

	test("a failed typeText surfaces its error", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([el("textfield", { id: "field", value: "ab", focused: true })])],
			selectAll: true,
			onCall: (call) => (call.method === "typeText" ? failWith("E_TIMEOUT") : undefined),
		});
		const result = await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "new");
		expect(result.success).toBe(false);
		expect(methods(driver)).toEqual(["tap", "selectAll", "typeText"]);
	});
});

describe("focusClearType with setText (Android warden-uiad, opt-in)", () => {
	test("auto never sets text without the opt-in: it selects all and types, as before", async () => {
		const { driver, state } = fieldFixture({ value: "old text", selectAll: true, setText: true });
		const result = await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "new", "auto", {});
		expect(result.success).toBe(true);
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "selectAll", "typeText"]);
		expect(state.value).toBe("new");
	});

	test("WARDEN_ANDROID_SETTEXT=1 opts auto into setText", async () => {
		const { driver, state } = fieldFixture({ value: "old text", selectAll: true, setText: true });
		const env = { WARDEN_ANDROID_SETTEXT: "1" };
		await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "new", "auto", env);
		expect(methods(driver)).toEqual(["tap", "setText"]);
		expect(state.value).toBe("new");
	});

	test("the opt-in does not touch the counted retry", async () => {
		const { driver } = fieldFixture({ value: "ab", selectAll: true, setText: true });
		const env = { WARDEN_ANDROID_SETTEXT: "1" };
		await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "new", "counted", env);
		expect(driver.callsOf("setText")).toEqual([]);
	});

	test("setText on a driver without it (iOS) selects all and types like auto", async () => {
		const { driver, state } = fieldFixture({ value: "old", selectAll: true });
		await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "new", "setText");
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "selectAll", "typeText"]);
		expect(state.value).toBe("new");
	});

	test("a filled field is replaced in one call after the focus tap: no select-all, no typing", async () => {
		const { driver, state } = fieldFixture({ value: "old text", selectAll: true, setText: true });
		const result = await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "new", "setText");
		expect(result.success).toBe(true);
		expect(methods(driver)).toEqual(["tap", "setText"]);
		expect(driver.callsOf("setText")[0]?.text).toBe("new");
		expect(state.value).toBe("new");
	});

	test("empty text empties a filled field in that one call", async () => {
		const { driver, state } = fieldFixture({ value: "old", selectAll: true, setText: true });
		await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "", "setText");
		expect(methods(driver)).toEqual(["tap", "setText"]);
		expect(state.value).toBe("");
	});

	test("an empty field is typed into as before (setText would save nothing there)", async () => {
		const { driver, state } = fieldFixture({ selectAll: true, setText: true });
		await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "x", "setText");
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "typeText"]);
		expect(state.value).toBe("x");
	});

	test("a secure field is not set: it cannot be read back, so it keeps the backspaces and typing", async () => {
		const { driver, state } = fieldFixture({ secure: true, value: "abc", selectAll: true, setText: true });
		await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "xy", "setText");
		expect(driver.callsOf("setText")).toEqual([]);
		expect(state.value).toBe("xy");
	});

	test("the counted retry types, never setText", async () => {
		const { driver, state } = fieldFixture({ value: "ab", selectAll: true, setText: true });
		await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "new", "counted");
		expect(methods(driver)).toEqual(["tap", "elementAtPoint", "key", "key", "key", "typeText"]);
		expect(state.value).toBe("new");
	});

	test("a refused setText falls back to select-all and typing, with no second tap", async () => {
		const { driver, state } = fieldFixture({ value: "old", selectAll: true, setText: "refused" });
		const result = await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "new", "setText");
		expect(result.success).toBe(true);
		expect(methods(driver)).toEqual(["tap", "setText", "selectAll", "typeText"]);
		expect(state.value).toBe("new");
	});

	test("a failed focus tap stops before setText", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([el("textfield", { id: "field", value: "ab" })])],
			setText: true,
			onCall: (call) => (call.method === "tap" ? failWith("E_HID") : undefined),
		});
		const result = await focusClearType(driver, fakeClock().sleep, POINT, entryOfField(driver), "new", "setText");
		expect(result.success).toBe(false);
		expect(methods(driver)).toEqual(["tap"]);
	});
});

describe("confirmReadsFor", () => {
	const entry = (driver: Parameters<typeof entryOfField>[0]) => entryOfField(driver);

	test("a field that held the wanted text needs the longer run", () => {
		const { driver } = fieldFixture({ value: "hi" });
		expect(confirmReadsFor(entry(driver), "hi")).toBe(STALE_RISK_READS);
		expect(confirmReadsFor(entry(driver), "other")).toBe(CONFIRM_READS);
	});

	test("a placeholder equal to the wanted text is not text the field held", () => {
		const { driver } = fieldFixture({ placeholder: "ada@example.com" });
		expect(confirmReadsFor(entry(driver), "ada@example.com")).toBe(CONFIRM_READS);
	});

	test("an empty field, empty text and a bare coordinate need no more than the usual run", () => {
		const { driver } = fieldFixture();
		expect(confirmReadsFor(entry(driver), "x")).toBe(CONFIRM_READS);
		const filled = fieldFixture({ value: "hi" });
		expect(confirmReadsFor(entry(filled.driver), "")).toBe(CONFIRM_READS);
		expect(confirmReadsFor(undefined, "hi")).toBe(CONFIRM_READS);
	});
});

describe("FIELD_POLL_MS", () => {
	test("confirm reads are 50 ms apart", () => {
		expect(FIELD_POLL_MS).toBe(50);
	});
});

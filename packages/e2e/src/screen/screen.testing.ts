import { type ElementSpec, el, type FakeDriver, failWith, fakeDriver, snapshotOf } from "../driver/driver.testing";
import type { Driver, Platform } from "../driver/driver.types";
import { cacheObservations } from "../driver/observation-cache";
import type { ScreenHost } from "./context";
import { type FakeClock, fakeClock } from "./poll.testing";

export type TestHost = ScreenHost & { clock: FakeClock; steps: string[] };

/**
 * A host over a fake driver and a fake clock that records the step labels it is asked to report. `cache` puts the
 * observation cache (`driver/observation-cache.ts`, as the session does) in front of the driver, aged by the fake
 * clock; `driver.callsOf("snapshot")` then counts the snapshots that really reached the device.
 */
export function testHost(
	driver: FakeDriver,
	options: { actionTimeoutMs?: number; assertionTimeoutMs?: number; withSteps?: boolean; cache?: boolean } = {}
): TestHost {
	const steps: string[] = [];
	const clock = fakeClock();
	const seen: Driver = options.cache === true ? cacheObservations(driver, { now: clock.now }) : driver;
	const host: TestHost = {
		driver: async () => seen,
		env: { actionTimeoutMs: options.actionTimeoutMs ?? 1000, assertionTimeoutMs: options.assertionTimeoutMs ?? 5000 },
		clock,
		steps,
	};
	if (options.withSteps !== false) {
		host.step = async (label, fn) => {
			steps.push(label);
			return fn();
		};
	}
	return host;
}

/** A driver showing one screen of `specs` that never changes. */
export function staticDriver(specs: ElementSpec[], platform: Platform = "ios"): FakeDriver {
	return fakeDriver({ screens: [snapshotOf(specs, { platform })], platform });
}

export const FIELD_FRAME = { x: 24, y: 200, width: 300, height: 44 };

/**
 * A single text field that behaves like one: `typeText` appends, Backspace deletes the last character. `dropTypes`
 * makes the first N `typeText` calls silently do nothing (a flaky keyboard); `dropKeys` ignores the first N Backspaces; `dropCall` drops only the Nth (1-based)
 * once, e.g. the last character of a word. `dropTail` makes the first `dropTailCalls` (default 1) `typeText` calls lose their last N characters (a keyboard that drops the tail of a whole string). `lagReads` makes the accessibility value trail the keys: after every key
 * the next N reads (snapshot or hit-test) still show the value from before it. `placeholder` is what an empty field
 * shows as its value (iOS); `placeholderMeta: false` leaves it out of the element's `placeholder`, as React Native on iOS
 * does. `selectAll` gives the driver the select-all capability (the next Backspace or typing replaces the whole text);
 * `selectAllRefused` offers it but selects nothing (a field with its context menu hidden). `focused` is the field's
 * focus before any tap; a tap focuses it, seen from the read after `focusReads` more reads (default 0: the next read),
 * unless `neverFocuses` (a field that never reports focus, as iOS text fields did before `is-editing` counted).
 */
export function fieldFixture(
	options: {
		value?: string;
		secure?: boolean;
		dropTypes?: number;
		dropCall?: number;
		dropTail?: number;
		dropTailCalls?: number;
		dropKeys?: number;
		lagReads?: number;
		focused?: boolean;
		focusReads?: number;
		neverFocuses?: boolean;
		placeholder?: string;
		placeholderMeta?: boolean;
		selectAll?: boolean;
		selectAllRefused?: boolean;
		/** offer `setText` (Android `warden-uiad`): it replaces the whole value; `refused` offers it and fails every call */
		setText?: boolean | "refused";
		/** offer `pasteText` (iOS): it replaces a selection like typing; `refused` offers it and fails every call (pasteboard unconfirmed) */
		pasteText?: boolean | "refused";
		/** a paste lands mangled: only this many leading characters survive (a maxLength field) */
		pasteKeeps?: number;
	} = {}
) {
	const state = {
		value: options.value ?? "",
		drops: options.dropTypes ?? 0,
		keyDrops: options.dropKeys ?? 0,
		tailDrops: options.dropTail === undefined ? 0 : (options.dropTailCalls ?? 1),
		typeCalls: 0,
		shown: options.value ?? "",
		lag: 0,
		reads: 0,
		selected: false,
		focused: options.focused,
		focusIn: -1,
	};
	const lagReads = options.lagReads ?? 0;

	/** A `typeText` call: replaces a selection, then drops, tail-drops or appends per the fixture's flakiness. */
	const typeText = (text: string): void => {
		state.typeCalls += 1;
		if (state.selected) {
			state.value = "";
			state.selected = false;
		}
		if (state.drops > 0) state.drops -= 1;
		else if (state.tailDrops > 0) {
			state.tailDrops -= 1;
			state.value += text.slice(0, Math.max(0, text.length - (options.dropTail ?? 0)));
		} else if (state.typeCalls !== options.dropCall) state.value += text;
		state.lag = lagReads;
	};

	/** A `pasteText` call: replaces a selection, else appends; keeps only `pasteKeeps` characters when set. */
	const pasteText = (text: string): void => {
		const kept = options.pasteKeeps === undefined ? text : text.slice(0, options.pasteKeeps);
		if (state.selected) state.value = "";
		state.selected = false;
		state.value += kept;
		state.lag = lagReads;
	};

	/** A tap: drops any selection and, unless the field never reports focus, schedules focus. */
	const tap = (): void => {
		state.selected = false;
		if (state.focused !== true && options.neverFocuses !== true) state.focusIn = options.focusReads ?? 0;
	};

	/** `setText` (Android): replaces the whole value. */
	const setText = (text: string): void => {
		state.value = text;
		state.selected = false;
		state.lag = lagReads;
	};

	/** A Backspace: ignored while `dropKeys` last, else clears a selection or the last character. */
	const backspace = (): void => {
		if (state.keyDrops > 0) state.keyDrops -= 1;
		else if (state.selected) state.value = "";
		else state.value = state.value.slice(0, -1);
		state.selected = false;
		state.lag = lagReads;
	};

	const driver = fakeDriver({
		screens: () => {
			state.reads += 1;
			if (state.focusIn > 0) state.focusIn -= 1;
			else if (state.focusIn === 0) {
				state.focused = true;
				state.focusIn = -1;
			}
			if (state.lag > 0) state.lag -= 1;
			else state.shown = state.value;
			const empty = state.shown === "";
			const masked = options.secure ? "•".repeat(state.shown.length) : state.shown;
			return snapshotOf([
				el(options.secure ? "securefield" : "textfield", {
					id: "field",
					label: "Email",
					value: empty && options.placeholder !== undefined ? options.placeholder : masked,
					frame: FIELD_FRAME,
					...(options.placeholder !== undefined && options.placeholderMeta !== false
						? { placeholder: options.placeholder }
						: {}),
					...(state.focused === undefined ? {} : { focused: state.focused }),
				}),
			]);
		},
		onCall(call) {
			switch (call.method) {
				case "tap":
					tap();
					return undefined;
				case "setText":
					if (options.setText === "refused") return failWith("E_UNSUPPORTED", "setText needs the warden-uiad server");
					setText(call.text);
					return undefined;
				case "pasteText":
					if (options.pasteText === "refused") return failWith("E_IO", "pasteboard write not confirmed");
					pasteText(call.text);
					return undefined;
				case "selectAll":
					state.selected = options.selectAllRefused !== true;
					return undefined;
				case "typeText":
					typeText(call.text);
					return undefined;
				case "key":
					if (call.key === "Backspace") backspace();
					return undefined;
				default:
					return undefined;
			}
		},
		selectAll: options.selectAll === true || options.selectAllRefused === true,
		setText: options.setText !== undefined && options.setText !== false,
		pasteText: options.pasteText !== undefined && options.pasteText !== false,
	});
	return { driver, state };
}

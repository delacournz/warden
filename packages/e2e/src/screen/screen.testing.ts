import { type ElementSpec, el, type FakeDriver, fakeDriver, snapshotOf } from "../driver/driver.testing";
import type { Platform } from "../driver/driver.types";
import type { ScreenHost } from "./context";
import { type FakeClock, fakeClock } from "./poll.testing";

export type TestHost = ScreenHost & { clock: FakeClock; steps: string[] };

/** A host over a fake driver and a fake clock that records the step labels it is asked to report. */
export function testHost(
	driver: FakeDriver,
	options: { actionTimeoutMs?: number; assertionTimeoutMs?: number; withSteps?: boolean } = {}
): TestHost {
	const steps: string[] = [];
	const host: TestHost = {
		driver: async () => driver,
		env: { actionTimeoutMs: options.actionTimeoutMs ?? 1000, assertionTimeoutMs: options.assertionTimeoutMs ?? 5000 },
		clock: fakeClock(),
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
 * `selectAllRefused` offers it but selects nothing (a field with its context menu hidden).
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
		placeholder?: string;
		placeholderMeta?: boolean;
		selectAll?: boolean;
		selectAllRefused?: boolean;
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
	};
	const lagReads = options.lagReads ?? 0;
	const driver = fakeDriver({
		screens: () => {
			state.reads += 1;
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
					...(options.focused === undefined ? {} : { focused: options.focused }),
				}),
			]);
		},
		onCall(call) {
			if (call.method === "tap") {
				state.selected = false;
			} else if (call.method === "selectAll") {
				state.selected = options.selectAllRefused !== true;
			} else if (call.method === "typeText") {
				state.typeCalls += 1;
				if (state.selected) {
					state.value = "";
					state.selected = false;
				}
				if (state.drops > 0) state.drops -= 1;
				else if (state.tailDrops > 0) {
					state.tailDrops -= 1;
					state.value += call.text.slice(0, Math.max(0, call.text.length - (options.dropTail ?? 0)));
				} else if (state.typeCalls !== options.dropCall) state.value += call.text;
				state.lag = lagReads;
			} else if (call.method === "key" && call.key === "Backspace") {
				if (state.keyDrops > 0) state.keyDrops -= 1;
				else if (state.selected) state.value = "";
				else state.value = state.value.slice(0, -1);
				state.selected = false;
				state.lag = lagReads;
			}
			return undefined;
		},
		selectAll: options.selectAll === true || options.selectAllRefused === true,
	});
	return { driver, state };
}

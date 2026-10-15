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
 * makes the first N `typeText` calls silently do nothing (a flaky keyboard).
 */
export function fieldFixture(
	options: { value?: string; secure?: boolean; dropTypes?: number; focused?: boolean } = {}
) {
	const state = { value: options.value ?? "", drops: options.dropTypes ?? 0 };
	const driver = fakeDriver({
		screens: () =>
			snapshotOf([
				el(options.secure ? "securefield" : "textfield", {
					id: "field",
					label: "Email",
					value: options.secure ? "•".repeat(state.value.length) : state.value,
					frame: FIELD_FRAME,
					...(options.focused === undefined ? {} : { focused: options.focused }),
				}),
			]),
		onCall(call) {
			if (call.method === "typeText") {
				if (state.drops > 0) state.drops -= 1;
				else state.value += call.text;
			} else if (call.method === "key" && call.key === "Backspace") {
				state.value = state.value.slice(0, -1);
			}
			return undefined;
		},
	});
	return { driver, state };
}

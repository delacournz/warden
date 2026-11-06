import { describe, expect, test } from "bun:test";
import type { A11yTarget } from "../a11y/a11y-target";
import type { E2eError } from "../errors";
import { DeviceAssertions } from "./a11y-matchers";

function target(visible: () => boolean, timeoutMs = 200): A11yTarget & { polls: number } {
	const t = {
		polls: 0,
		audit: async () => {
			throw new Error("unused");
		},
		waitForAnnouncement: async () => {
			throw new Error("unused");
		},
		a11yScreen: async () => "SCREEN",
		assertionTimeout: () => timeoutMs,
		step: <T>(_label: string, fn: () => Promise<T>) => fn(),
		keyboardVisible: async () => {
			t.polls += 1;
			return visible();
		},
	};
	return t;
}

async function failure(promise: Promise<unknown>): Promise<E2eError> {
	try {
		await promise;
	} catch (error) {
		return error as E2eError;
	}
	throw new Error("did not reject");
}

describe("toHaveKeyboard", () => {
	test("passes at once when the keyboard is up", async () => {
		const t = target(() => true);
		await new DeviceAssertions(t, { negate: false }).toHaveKeyboard();
		expect(t.polls).toBe(1);
	});

	test("polls until the keyboard shows", async () => {
		let n = 0;
		const t = target(() => ++n >= 3);
		await new DeviceAssertions(t, { negate: false }).toHaveKeyboard();
		expect(t.polls).toBe(3);
	});

	test("fails after the timeout with the screen", async () => {
		const t = target(() => false, 120);
		const error = await failure(new DeviceAssertions(t, { negate: false }).toHaveKeyboard());
		expect(error.code).toBe("ASSERTION");
		expect(error.message).toContain("expect(device).toHaveKeyboard()");
		expect(error.message).toContain("Received: no keyboard on screen");
		expect(error.message).toContain("SCREEN");
	});

	test(".not waits for the keyboard to go and fails if it stays", async () => {
		let n = 0;
		await new DeviceAssertions(
			target(() => ++n < 3),
			{ negate: true }
		).toHaveKeyboard();
		const error = await failure(
			new DeviceAssertions(
				target(() => true, 120),
				{ negate: true }
			).toHaveKeyboard()
		);
		expect(error.message).toContain("expect(device).not.toHaveKeyboard()");
		expect(error.message).toContain("Received: a keyboard on screen");
	});

	test("the timeout option overrides the assertion timeout; unknown options are refused", async () => {
		const t = target(() => false, 5000);
		const started = Date.now();
		await failure(new DeviceAssertions(t, { negate: false }).toHaveKeyboard({ timeout: 100 }));
		expect(Date.now() - started).toBeLessThan(1500);
		const error = await failure(new DeviceAssertions(t, { negate: false }).toHaveKeyboard({ exact: true } as never));
		expect(error.code).toBe("INVALID_ARGUMENT");
	});
});

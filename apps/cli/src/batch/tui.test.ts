import { describe, expect, test } from "bun:test";
import { applyEvent, type BatchView, frameBytes, initialView, plainLine, render } from "./tui";

const DEVICES = [
	{ worker: 0, udid: "U0", name: "warden-iphone-17-1" },
	{ worker: 1, udid: "U1", name: "warden-iphone-17-2" },
];

function midRun(): BatchView {
	let view = initialView(DEVICES, 4, 0);
	view = applyEvent(view, { type: "job-start", at: 0, job: "qa-login", worker: 0, udid: "U0", seq: 0, attempt: 0 });
	view = applyEvent(view, { type: "job-start", at: 0, job: "qa-cart", worker: 1, udid: "U1", seq: 0, attempt: 0 });
	view = applyEvent(view, {
		type: "job-end",
		job: "qa-cart",
		worker: 1,
		udid: "U1",
		seq: 0,
		attempt: 0,
		startedAt: 0,
		endedAt: 4_000,
		exitCode: 2,
		willRetry: false,
	});
	view = applyEvent(view, {
		type: "job-start",
		at: 4_000,
		job: "qa-search",
		worker: 1,
		udid: "U1",
		seq: 1,
		attempt: 0,
	});
	return { ...view, now: 65_000 };
}

describe("render", () => {
	test("header with overall progress + one row per device", () => {
		expect(render(midRun(), { width: 80, color: false })).toMatchSnapshot();
	});

	test("idle devices, retries and the final state", () => {
		let view = midRun();
		view = applyEvent(view, {
			type: "job-end",
			job: "qa-login",
			worker: 0,
			udid: "U0",
			seq: 0,
			attempt: 0,
			startedAt: 0,
			endedAt: 5_000,
			exitCode: 1,
			willRetry: true,
		});
		view = applyEvent(view, {
			type: "job-start",
			at: 5_000,
			job: "qa-login",
			worker: 0,
			udid: "U0",
			seq: 1,
			attempt: 1,
		});
		expect(render({ ...view, now: 9_000 }, { width: 80, color: false })).toContain("qa-login (retry 1)");
		view = applyEvent(view, { type: "worker-idle", worker: 1, udid: "U1", at: 9_000 });
		view = applyEvent(view, { type: "done", ok: false, stopped: false, at: 10_000 });
		expect(render(view, { width: 80, color: false })).toMatchSnapshot();
	});

	test("every line fits the width, even with long names", () => {
		const view = { ...midRun(), devices: midRun().devices.map((d) => ({ ...d, name: "x".repeat(100) })) };
		for (const line of render(view, { width: 50, color: false }).split("\n")) expect(line.length).toBeLessThan(50);
	});

	test("color: ANSI codes but the same visible text", () => {
		const plain = render(midRun(), { width: 80, color: false });
		const colored = render(midRun(), { width: 80, color: true });
		expect(colored).not.toBe(plain);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI
		expect(colored.replace(/\u001b\[[0-9;]*m/g, "")).toBe(plain);
	});
});

describe("frameBytes", () => {
	test("first frame writes as-is; later frames move up over the previous one and clear", () => {
		expect(frameBytes(0, "a\nb")).toBe("a\nb\n");
		expect(frameBytes(2, "c")).toBe("\u001b[2A\r\u001b[0Jc\n");
	});
});

describe("plainLine", () => {
	test("one log line per start / end / done; idle is quiet", () => {
		const view = midRun();
		expect(plainLine(view, { type: "job-start", at: 0, job: "a", worker: 1, udid: "U1", seq: 2, attempt: 0 })).toBe(
			"[1 warden-iphone-17-2] ▶ a"
		);
		expect(
			plainLine(view, {
				type: "job-end",
				job: "a",
				worker: 0,
				udid: "U0",
				seq: 0,
				attempt: 0,
				startedAt: 0,
				endedAt: 12_000,
				exitCode: 3,
				willRetry: true,
			})
		).toBe("[0 warden-iphone-17-1] ✗ a exit 3 12s (retrying)");
		expect(plainLine(view, { type: "worker-idle", worker: 0, udid: "U0", at: 0 })).toBeUndefined();
		expect(plainLine(view, { type: "done", ok: true, stopped: false, at: 0 })).toBe(
			"warden batch: 0/4 passed, 1 failed"
		);
	});
});

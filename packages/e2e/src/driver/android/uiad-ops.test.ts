import { afterEach, describe, expect, test } from "bun:test";
import type { DriverError } from "../driver.types";
import { driverError } from "../errors";
import { collectSpanDetail, type SpanDetail } from "../span-detail";
import type { AdbSession } from "./adb-session";
import { type FakeUiadOptions, fakeUiad, recordedSession } from "./uiad.testing";
import { createUiadBackend } from "./uiad-backend";
import { startUiad } from "./uiad-client";
import { createUiadOps, snapshotFromUiad } from "./uiad-ops";
import { readSnapshotData } from "./uiad-protocol";

const SCREEN = { width: 1080, height: 2400, scale: 2.625 };

const SESSION: AdbSession = {
	async run() {
		return { success: true, data: { stdout: "", exitCode: 0 } };
	},
	async close() {},
};

const BUSY = driverError("E_AX_UNAVAILABLE", "another UiAutomation client holds emulator-5554", {
	retryable: false,
	detail: { reason: "uiautomation_busy" },
});

const open: Array<{ stop(): Promise<void> }> = [];

/** The ops over a real client talking to an in-process server, with a clock that only moves when told to. */
function setup(options: FakeUiadOptions = {}, launchFailure?: DriverError) {
	const fake = fakeUiad(options);
	let t = 1_000;
	const slept: number[] = [];
	const clock = {
		now: () => t,
		sleep: async (ms: number) => {
			slept.push(ms);
			t += ms;
		},
	};
	const lines: string[] = [];
	const backend = createUiadBackend({
		session: SESSION,
		adb: "adb",
		serial: "emulator-5554",
		clock,
		log: (line) => lines.push(line),
		options: {},
		launch: async () =>
			launchFailure
				? { success: false as const, error: launchFailure }
				: startUiad({ cmd: ["adb", "shell", "x"], spawn: fake.spawn, graceMs: 20 }),
	});
	const ops = createUiadOps({ backend, baseScreen: SCREEN, clock, log: (line) => lines.push(line) });
	open.push(ops);
	return { fake, ops, backend, lines, slept };
}

afterEach(async () => {
	await Promise.all(open.splice(0).map((o) => o.stop()));
});

async function value<T>(
	result: Promise<{ success: true; data: T } | { success: false; error: DriverError } | undefined>
): Promise<T> {
	const settled = await result;
	if (settled === undefined) throw new Error("fell back");
	if (!settled.success) throw new Error(`${settled.error.code}: ${settled.error.message}`);
	return settled.data;
}

const wire = (code: string, message = code) => ({ code, message, retryable: false });

describe("snapshot", () => {
	test("is the server's tree as the Elements the dump of the same screen gives", async () => {
		const { ops } = setup();
		const taken = await value(ops.snapshot());
		expect(taken.platform).toBe("android");
		expect(taken.backend).toBe("uiautomator");
		expect(taken.takenAt).toBe(1_000);
		expect(taken.truncated).toBe(false);
		expect(taken.flat.length).toBeGreaterThan(20);
		expect(taken.screen).toMatchObject({ width: 1080, height: 2400 });
	});

	test("takes the rotation from the reply, not from what was measured at open", () => {
		const reply = recordedSession().replies.get("snapshot");
		if (typeof reply !== "object" || !("data" in reply)) throw new Error("no recorded snapshot");
		const data = readSnapshotData(reply.data);
		if (typeof data === "string") throw new Error(data);
		const landscape = snapshotFromUiad({ ...data, screen: { ...data.screen, rotation: 1 } }, SCREEN, 5);
		expect(landscape.screen).toMatchObject({ width: 2400, height: 1080, rotation: 1 });
		expect(landscape.takenAt).toBe(5);
	});

	test("notes which backend answered, and how long the server took, on the span being timed", async () => {
		const { ops } = setup();
		const notes: SpanDetail = {};
		await collectSpanDetail(notes, () => value(ops.snapshot()));
		expect(notes.backend).toBe("uiad");
		expect(typeof notes.uiadMs).toBe("number");
	});

	test("rides out a window that is not there yet, as the dump route does", async () => {
		const { ops, slept, fake } = setup({
			handle: (request, nth) =>
				request.op === "snapshot" && nth < 2
					? { error: { code: "E_AX_UNAVAILABLE", message: "null root node", retryable: true } }
					: undefined,
		});
		await value(ops.snapshot());
		expect(fake.of("snapshot")).toHaveLength(3);
		expect(slept).toEqual([400, 400]);
	});

	test("a window that never comes is the error, and the server stays up (the dump would fail the same way)", async () => {
		const { ops, fake, backend } = setup({
			handle: (request) =>
				request.op === "snapshot"
					? { error: { code: "E_AX_UNAVAILABLE", message: "null root node", retryable: true } }
					: undefined,
		});
		const taken = await ops.snapshot();
		expect(taken?.success).toBe(false);
		if (taken === undefined || taken.success) return;
		expect(taken.error.code).toBe("E_AX_UNAVAILABLE");
		expect(fake.of("snapshot")).toHaveLength(3);
		expect(backend.status()).toBe("up");
	});

	test("a server that dies is stopped and the call falls back to the dump", async () => {
		const { ops, fake, backend } = setup({ handle: (request) => (request.op === "snapshot" ? "die" : undefined) });
		expect(await ops.snapshot()).toBeUndefined();
		expect(fake.running()).toBe(0);
		expect(backend.wanted()).toBe(true);
	});

	test("a server that hangs is ended, not waited for twice", async () => {
		const fake = fakeUiad({ handle: (request) => (request.op === "snapshot" ? "silent" : undefined) });
		let t = 0;
		const clock = { now: () => t++, sleep: async () => undefined };
		const backend = createUiadBackend({
			session: SESSION,
			adb: "adb",
			serial: "s",
			clock,
			options: {},
			launch: async () => startUiad({ cmd: ["x"], spawn: fake.spawn, graceMs: 20, requestTimeoutMs: 30 }),
		});
		const ops = createUiadOps({ backend, baseScreen: SCREEN, clock });
		open.push(ops);
		expect(await ops.snapshot()).toBeUndefined();
		expect(fake.running()).toBe(0);
	});

	test("a slot held by someone else is the answer: the dump needs the same slot and would only say Killed", async () => {
		const { ops } = setup({}, BUSY);
		const taken = await ops.snapshot();
		expect(taken?.success).toBe(false);
		if (taken === undefined || taken.success) return;
		expect(taken.error.message).toContain("another UiAutomation client");
	});

	test("a server that could not start for any other reason leaves the dump to do it", async () => {
		const { ops } = setup({}, driverError("E_HELPER_CRASHED", "exit 1"));
		expect(await ops.snapshot()).toBeUndefined();
	});
});

describe("settle", () => {
	test("is the server's quiet wait, reported as the stream", async () => {
		const { ops, fake } = setup();
		const notes: SpanDetail = {};
		const outcome = await collectSpanDetail(notes, () => value(ops.settle({ quietMs: 250, timeoutMs: 3000 })));
		expect(outcome).toEqual({ quiet: true, waitedMs: 251, via: "stream" });
		expect(fake.of("settle")[0]).toMatchObject({ quietMs: 250, timeoutMs: 3000 });
		expect(notes).toMatchObject({ backend: "uiad", via: "stream" });
	});

	test("keeps the reason a wait gave up", async () => {
		const { ops } = setup({
			handle: (request) =>
				request.op === "settle"
					? { data: { quiet: false, waitedMs: 3000, via: "events", events: 40, reason: "timeout" } }
					: undefined,
		});
		expect(await value(ops.settle({ quietMs: 250, timeoutMs: 3000 }))).toEqual({
			quiet: false,
			waitedMs: 3000,
			via: "stream",
			reason: "timeout",
		});
	});

	test("a server that dies falls back to the dump-based settle", async () => {
		const { ops } = setup({ handle: (request) => (request.op === "settle" ? "die" : undefined) });
		expect(await ops.settle({ quietMs: 250, timeoutMs: 3000 })).toBeUndefined();
	});

	test("a busy slot is the answer", async () => {
		const { ops } = setup({}, BUSY);
		const outcome = await ops.settle({ quietMs: 250, timeoutMs: 3000 });
		expect(outcome?.success).toBe(false);
	});
});

describe("taps and swipes", () => {
	test("a tap is one request with the point", async () => {
		const { ops, fake } = setup();
		await value(ops.tap({ x: 541, y: 2272 }));
		expect(fake.of("tap")).toEqual([expect.objectContaining({ x: 541, y: 2272 })]);
		expect(fake.of("tap")[0]).not.toHaveProperty("count");
		expect(fake.of("tap")[0]).not.toHaveProperty("holdMs");
	});

	test("a multi-tap and a held tap say so", async () => {
		const { ops, fake } = setup();
		await value(ops.tap({ x: 10, y: 20 }, { count: 2 }));
		await value(ops.tap({ x: 10, y: 20 }, { durationMs: 900 }));
		expect(fake.of("tap")[0]).toMatchObject({ count: 2 });
		expect(fake.of("tap")[1]).toMatchObject({ holdMs: 900 });
	});

	test("a long press is a tap that holds, 600 ms unless told", async () => {
		const { ops, fake } = setup();
		await value(ops.longPress({ x: 5, y: 6 }));
		await value(ops.longPress({ x: 5, y: 6 }, 1200));
		expect(fake.of("tap").map((r) => r.holdMs)).toEqual([600, 1200]);
	});

	test("a swipe is one request, 300 ms unless told", async () => {
		const { ops, fake } = setup();
		await value(ops.swipe({ x: 540, y: 1500 }, { x: 540, y: 1100 }));
		await value(ops.swipe({ x: 540, y: 1500 }, { x: 540, y: 1100 }, 800));
		expect(fake.of("swipe").map((r) => r.durationMs)).toEqual([300, 800]);
		expect(fake.of("swipe")[0]).toMatchObject({ x1: 540, y1: 1500, x2: 540, y2: 1100 });
	});

	test("a drag holds before moving and after, in the same request", async () => {
		const { ops, fake } = setup();
		await value(ops.drag({ x: 1, y: 2 }, { x: 3, y: 4 }, { pressMs: 500, durationMs: 600, releaseMs: 40 }));
		expect(fake.of("swipe")[0]).toMatchObject({ pressMs: 500, durationMs: 600, releaseMs: 40, steps: 8 });
	});

	test("a gesture sends the plan's paths and timing, with a timeout that covers its length", async () => {
		const plan = {
			paths: [
				[
					{ x: 1, y: 2 },
					{ x: 3, y: 4 },
				],
				[
					{ x: 5, y: 6 },
					{ x: 7, y: 8 },
				],
			],
			frameMs: 16,
			holdMs: 30,
			releaseMs: 50,
			totalMs: 96,
		};
		const { ops, fake } = setup({
			handle: (request) =>
				request.op === "gesture" ? { data: { frames: 2, pointers: 2, maxLagMs: 1, via: "inject3" } } : undefined,
		});
		await value(ops.gesture(plan));
		expect(fake.of("gesture")[0]).toMatchObject({ paths: plan.paths, frameMs: 16, holdMs: 30, releaseMs: 50 });
	});

	test("a refused gesture (E_HID, E_UNSUPPORTED) falls back; E_INTERNAL is surfaced", async () => {
		const plan = { paths: [[{ x: 1, y: 2 }]], frameMs: 16, holdMs: 0, releaseMs: 0, totalMs: 0 };
		const refused = setup({
			handle: (request) => (request.op === "gesture" ? { error: wire("E_HID", "refused") } : undefined),
		});
		expect(await refused.ops.gesture(plan)).toBeUndefined();
		expect(refused.backend.status()).toBe("up");
		const unsupported = setup({
			handle: (request) => (request.op === "gesture" ? { error: wire("E_UNSUPPORTED", "no") } : undefined),
		});
		expect(await unsupported.ops.gesture(plan)).toBeUndefined();
		const broken = setup({
			handle: (request) =>
				request.op === "gesture" ? { error: wire("E_INTERNAL", "gesture interrupted after 3/9 frames") } : undefined,
		});
		const res = await broken.ops.gesture(plan);
		expect(res?.success).toBe(false);
		if (res === undefined || res.success) return;
		expect(res.error.code).toBe("E_INTERNAL");
	});

	test("an injection the server refuses falls back to `input` for that call and the server stays", async () => {
		const { ops, backend } = setup({
			handle: (request, nth) =>
				request.op === "tap" && nth === 0 ? { error: wire("E_HID", "inject refused") } : undefined,
		});
		expect(await ops.tap({ x: 1, y: 1 })).toBeUndefined();
		expect(backend.status()).toBe("up");
		expect((await ops.tap({ x: 1, y: 1 }))?.success).toBe(true);
	});

	test("a server that dies mid-tap is a failed step, not a second tap: the first may have landed", async () => {
		const { ops, fake } = setup({ handle: (request) => (request.op === "tap" ? "die" : undefined) });
		const tapped = await ops.tap({ x: 1, y: 1 });
		expect(tapped?.success).toBe(false);
		if (tapped === undefined || tapped.success) return;
		expect(tapped.error.code).toBe("E_HELPER_CRASHED");
		expect(fake.of("tap")).toHaveLength(1);
		expect(fake.running()).toBe(0);
	});

	test("a request that never reached a server that had just gone is sent again to a new one", async () => {
		const { ops, fake } = setup();
		await value(ops.tap({ x: 1, y: 1 }));
		fake.killAll();
		await value(ops.tap({ x: 2, y: 2 }));
		expect(fake.started()).toBe(2);
		expect(fake.of("tap").map((r) => r.x)).toEqual([1, 2]);
	});
});

describe("keys", () => {
	test("one key is one request", async () => {
		const { ops, fake } = setup();
		await value(ops.key(67));
		expect(fake.of("key")[0]).toMatchObject({ keyCode: 67 });
		expect(fake.of("key")[0]).not.toHaveProperty("times");
	});

	test("a key waits for the app to take it in, as typed text does", async () => {
		const { ops, fake } = setup();
		await value(ops.key(67));
		expect(fake.requests.map((r) => r.op).slice(-2)).toEqual(["key", "settle"]);
	});

	test("repeated keys are one request with the count and a gap", async () => {
		const { ops, fake } = setup();
		await value(ops.key(20, 2));
		expect(fake.of("key")[0]).toMatchObject({ keyCode: 20, times: 2, gapMs: 30 });
	});

	test("a failed key is surfaced when the server died, and falls back when it refused", async () => {
		const died = setup({ handle: (request) => (request.op === "key" ? "die" : undefined) });
		expect((await died.ops.key(4))?.success).toBe(false);
		const refused = setup({ handle: (request) => (request.op === "key" ? { error: wire("E_HID") } : undefined) });
		expect(await refused.ops.key(4)).toBeUndefined();
	});
});

describe("selectAll", () => {
	test("is the server's selection of the focused field", async () => {
		const { ops, fake } = setup({
			handle: (request) => (request.op === "selectAll" ? { data: { length: 15 } } : undefined),
		});
		await value(ops.selectAll());
		expect(fake.of("selectAll")).toHaveLength(1);
	});

	test("nothing focused is a refusal: the caller presses Backspace per character", async () => {
		const { ops } = setup();
		expect(await ops.selectAll()).toBeUndefined();
	});

	test("a server that died is not an error here: selecting again is harmless, so the shortcut is tried", async () => {
		const { ops } = setup({ handle: (request) => (request.op === "selectAll" ? "die" : undefined) });
		expect(await ops.selectAll()).toBeUndefined();
	});
});

describe("typeText", () => {
	const typed = (text: string, caret: number): FakeUiadOptions => ({
		handle: (request) => (request.op === "typeText" ? { data: { text, caret, caretPlaced: false } } : undefined),
	});

	test("is the server inserting the text into the focused field, whatever characters it has", async () => {
		const { ops, fake } = setup(typed("héllo ☃", 7));
		await value(ops.typeText("héllo ☃"));
		expect(fake.of("typeText")[0]).toMatchObject({ text: "héllo ☃" });
	});

	test("waits for the app to take the text in before it returns: a press right behind it is lost otherwise", async () => {
		const { ops, fake } = setup(typed("abc", 3));
		await value(ops.typeText("abc"));
		expect(fake.requests.map((r) => r.op).slice(-2)).toEqual(["typeText", "settle"]);
		expect(fake.of("settle")[0]).toMatchObject({ quietMs: 80, timeoutMs: 1000 });
	});

	test("a refused text waits for nothing", async () => {
		const { ops, fake } = setup();
		await ops.typeText("nothing focused");
		expect(fake.of("settle")).toEqual([]);
	});

	test("no focused field falls back to `input text`, which types into whatever has the keyboard", async () => {
		const { ops, backend } = setup();
		expect(await ops.typeText("nothing focused")).toBeUndefined();
		expect(backend.status()).toBe("up");
	});

	test("a server that died is a failed step: the text may be in the field", async () => {
		const { ops } = setup({ handle: (request) => (request.op === "typeText" ? "die" : undefined) });
		const result = await ops.typeText("abc");
		expect(result?.success).toBe(false);
	});
});

describe("enabled", () => {
	test("is true until the server is given up on", async () => {
		const { ops, backend } = setup({}, driverError("E_UNSUPPORTED", "protocol"));
		expect(ops.enabled()).toBe(true);
		await ops.snapshot();
		expect(backend.wanted()).toBe(false);
		expect(ops.enabled()).toBe(false);
	});
});

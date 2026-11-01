import { describe, expect, test } from "bun:test";
import { driverFixtures, FakeDriver } from "./driver.testing";
import type { Driver, KeyName } from "./driver.types";
import type { SpanSink } from "./trace/span";
import { spanDetails } from "./trace/span-detail";
import type { TraceEvent } from "./trace/trace-event";
import { driverTracer } from "./traced-driver";
import { deviceTyping } from "./typing";

function sink() {
	const events: TraceEvent[] = [];
	const spans = () => events.flatMap((e) => (e.type === "span" ? [e] : []));
	return { events, spans, write: (event: TraceEvent) => void events.push(event) };
}

const screen = driverFixtures.snapshotOf([driverFixtures.el("button", { id: "go", label: "Go" })]);

describe("driverTracer.trace", () => {
	test("every call becomes a driver.<method> span with its duration and ok", async () => {
		const out = sink();
		let t = 100;
		const driver = driverTracer.trace(new FakeDriver({ screens: [screen] }), {
			trace: () => out,
			now: () => {
				t += 5;
				return t;
			},
		});
		await driver.snapshot();
		await driver.tap({ x: 1, y: 2 });
		expect(out.spans().map((s) => [s.op, s.ok, s.ms])).toEqual([
			["driver.snapshot", true, 5],
			["driver.tap", true, 5],
		]);
	});

	test("the results are the underlying driver's, untouched", async () => {
		const inner = new FakeDriver({ screens: [screen] });
		const driver = driverTracer.trace(inner, { trace: () => sink() });
		const snapshot = await driver.snapshot();
		expect(snapshot.success && snapshot.data).toBe(inner.screen);
	});

	test("a failed Result is an ok:false span with the driver error code", async () => {
		const out = sink();
		const driver = driverTracer.trace(
			new FakeDriver({
				screens: [screen],
				onCall: (c) => (c.method === "snapshot" ? driverFixtures.failWith("E_AX_UNAVAILABLE") : undefined),
			}),
			{ trace: () => out }
		);
		const result = await driver.snapshot();
		expect(result.success).toBe(false);
		expect(out.spans()[0]).toMatchObject({ op: "driver.snapshot", ok: false, code: "E_AX_UNAVAILABLE" });
	});

	test("a rejected call is an ok:false span and still rejects", async () => {
		const out = sink();
		const base = new FakeDriver({ screens: [screen] });
		const broken: Driver = {
			...base,
			async tap() {
				throw new Error("socket closed");
			},
		};
		await expect(driverTracer.trace(broken, { trace: () => out }).tap({ x: 0, y: 0 })).rejects.toThrow("socket closed");
		expect(out.spans()[0]).toMatchObject({ op: "driver.tap", ok: false, code: "ERROR" });
	});

	test("app commands are driver.app.<method>", async () => {
		const out = sink();
		const driver = driverTracer.trace(new FakeDriver({ screens: [screen] }), { trace: () => out });
		await driver.app.launch("com.example.app");
		await driver.app.openUrl("example://x");
		expect(out.spans().map((s) => s.op)).toEqual(["driver.app.launch", "driver.app.openUrl"]);
	});

	test("platform, id and capabilities read through", () => {
		const inner = new FakeDriver({ screens: [screen], platform: "android", id: "emulator-5554" });
		const driver = driverTracer.trace(inner, { trace: () => sink() });
		expect(driver.platform).toBe("android");
		expect(driver.id).toBe("emulator-5554");
		expect(driver.capabilities).toBe(inner.capabilities);
	});

	test("close is forwarded and is not a span", async () => {
		const out = sink();
		const inner = new FakeDriver({ screens: [screen] });
		await driverTracer.trace(inner, { trace: () => out }).close();
		expect(inner.closed).toBe(true);
		expect(out.events).toEqual([]);
	});

	test("optional capabilities a driver offers stay visible (RepeatingKeys) and are traced", async () => {
		const out = sink();
		const base = new FakeDriver({ screens: [screen] });
		const withRepeat = Object.assign(base, {
			pressKeyRepeat: async (_key: KeyName, _times: number): ReturnType<Driver["tap"]> => ({
				success: true,
				data: undefined,
			}),
		});
		const driver = driverTracer.trace(withRepeat, { trace: () => out });
		expect(deviceTyping.canRepeatKeys(driver)).toBe(true);
		if (deviceTyping.canRepeatKeys(driver)) await driver.pressKeyRepeat("Backspace", 12);
		expect(out.spans()[0]?.op).toBe("driver.pressKeyRepeat");
		expect(
			deviceTyping.canRepeatKeys(driverTracer.trace(new FakeDriver({ screens: [screen] }), { trace: () => out }))
		).toBe(false);
	});

	test("the typing capabilities (SelectsAll, RepeatingKeys) stay visible and are spans, and a plain driver offers neither", async () => {
		const out = sink();
		const withBoth = Object.assign(new FakeDriver({ screens: [screen], selectAll: true }), {
			pressKeyRepeat: async (_key: KeyName, _times: number): ReturnType<Driver["tap"]> => ({
				success: true,
				data: undefined,
			}),
		});
		const driver = driverTracer.trace(withBoth, { trace: () => out });
		expect(deviceTyping.canSelectAll(driver)).toBe(true);
		expect(deviceTyping.canRepeatKeys(driver)).toBe(true);
		if (deviceTyping.canSelectAll(driver)) await driver.selectAll();
		if (deviceTyping.canRepeatKeys(driver)) await driver.pressKeyRepeat("Backspace", 3);
		expect(out.spans().map((s) => s.op)).toEqual(["driver.selectAll", "driver.pressKeyRepeat"]);
		expect(withBoth.callsOf("selectAll")).toHaveLength(1);
		const plain = driverTracer.trace(new FakeDriver({ screens: [screen] }), { trace: () => out });
		expect(deviceTyping.canSelectAll(plain)).toBe(false);
		expect(deviceTyping.canRepeatKeys(plain)).toBe(false);
	});

	test("a member that is not async is returned as is, never turned into a promise", () => {
		const base = new FakeDriver({ screens: [screen] });
		const withSync = Object.assign(base, { describeSelf: () => "fake" });
		const driver = driverTracer.trace(withSync, { trace: () => sink() });
		expect(driver.describeSelf()).toBe("fake");
	});

	test("no attempt, no trace: calls go straight through", async () => {
		const inner = new FakeDriver({ screens: [screen] });
		const driver = driverTracer.trace(inner, { trace: () => undefined });
		expect((await driver.snapshot()).success).toBe(true);
		expect(inner.callsOf("snapshot")).toHaveLength(1);
	});

	test("the trace is read per call, so each attempt gets its own spans", async () => {
		const first = sink();
		const second = sink();
		let current: SpanSink = first;
		const driver = driverTracer.trace(new FakeDriver({ screens: [screen] }), { trace: () => current });
		await driver.snapshot();
		current = second;
		await driver.snapshot();
		await driver.snapshot();
		expect(first.spans()).toHaveLength(1);
		expect(second.spans()).toHaveLength(2);
	});

	test("what a driver notes during a call lands in that span's detail", async () => {
		const out = sink();
		const base = new FakeDriver({ screens: [screen] });
		const noting: Driver = {
			...base,
			async snapshot(opts) {
				spanDetails.note("route", "tty");
				return base.snapshot(opts);
			},
		};
		await driverTracer.trace(noting, { trace: () => out }).snapshot();
		expect(out.spans()[0]?.detail).toEqual({ route: "tty" });
	});

	test("a method is the same function on every read", () => {
		const driver = driverTracer.trace(new FakeDriver({ screens: [screen] }), { trace: () => sink() });
		expect(driver.snapshot).toBe(driver.snapshot);
		expect(driver.app).toBe(driver.app);
	});
});

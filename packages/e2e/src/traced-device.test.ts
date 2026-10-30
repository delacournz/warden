import { describe, expect, test } from "bun:test";
import { conditionsOf } from "./conditions/device-conditions";
import { createDevice, type Device } from "./device";
import { el, fakeDriver, snapshotOf } from "./driver/driver.testing";
import type { E2eEnv } from "./env";
import type { FixtureSession } from "./fixture-session";
import { runSpan, type SpanRunner } from "./runner/span";
import type { TraceEvent } from "./runner/trace";
import { traceDevice } from "./traced-device";

const env: E2eEnv = {
	udid: "UDID",
	platform: "ios",
	bundleId: "com.example.app",
	launchArgs: [],
	out: "/tmp/out",
	timeoutMs: 1000,
	actionTimeoutMs: 1000,
	assertionTimeoutMs: 1000,
	logTimestamps: false,
};

function setup(platform: "ios" | "android" = "ios") {
	const events: TraceEvent[] = [];
	const sink = { write: (event: TraceEvent) => void events.push(event) };
	const span: SpanRunner = (op, fn, options) => runSpan(sink, op, fn, options);
	const driver = fakeDriver({
		platform,
		answerAlertOnTap: true,
		screens: [snapshotOf([el("alert", { label: "Title", children: [el("button", { label: "OK" })] })], { platform })],
	});
	const session: FixtureSession = { out: "/tmp/out", span };
	const device = traceDevice(createDevice({ session, driver, env: { ...env, platform } }), span);
	const spans = () => events.flatMap((e) => (e.type === "span" ? [e] : []));
	return { device, driver, spans };
}

describe("traceDevice", () => {
	test("each device call is a device.<name> span, in call order", async () => {
		const { device, spans } = setup();
		await device.home();
		await device.orientation();
		await device.appearance();
		await device.biometrics.status();
		await device.clipboard();
		await device.setClipboard("x");
		await device.snapshot();
		await device.settle();
		await device.hideKeyboard();
		expect(spans().map((s) => s.op)).toEqual([
			"device.home",
			"device.orientation",
			"device.appearance",
			"device.biometrics.status",
			"device.clipboard",
			"device.setClipboard",
			"device.snapshot",
			"device.settle",
			"device.hideKeyboard",
		]);
		expect(spans().every((s) => s.ok)).toBe(true);
	});

	test("condition calls are device.network.* / location.* / clock.* / timeline spans", async () => {
		const { device, spans } = setup();
		await device.network.set("offline");
		await device.network.during("3g", async () => undefined);
		await device.network.fault([]);
		await device.network.status();
		await device.network.reset();
		await device.location.set({ lat: 1, lon: 2 });
		await device.location.scenario("freeway");
		await device.location.clear();
		await device.timeline([]);
		expect(spans().map((s) => s.op)).toEqual([
			"device.network.set",
			"device.network.during",
			"device.network.fault",
			"device.network.status",
			"device.network.reset",
			"device.location.set",
			"device.location.scenario",
			"device.location.clear",
			"device.timeline",
		]);
	});

	test("a failing condition call is an ok:false span", async () => {
		const { device, spans } = setup();
		await expect(device.network.set("5g" as "3g")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		expect(spans()[0]).toMatchObject({ op: "device.network.set", ok: false, code: "INVALID_ARGUMENT" });
	});

	test("the wrapped device keeps its runner hooks", () => {
		const { device } = setup();
		expect(conditionsOf(device)).toBeDefined();
	});

	test("results and arguments pass through", async () => {
		const { device, driver } = setup();
		expect(await device.alert("accept")).toBe(true);
		expect(await device.snapshot()).toContain("alert");
		await device.settle({ quietMs: 100, timeout: 900 });
		expect(driver.callsOf("settle")[0]?.opts).toEqual({ quietMs: 100, timeoutMs: 900 });
	});

	test("alert says whether it found one", async () => {
		const { device, spans } = setup();
		await device.alert("dismiss");
		expect(spans()[0]).toMatchObject({ op: "device.alert", ok: true, detail: { answered: true } });
	});

	test("settle carries the verdict in its span detail", async () => {
		const { device, spans } = setup();
		await device.settle();
		const settle = spans().find((s) => s.op === "device.settle");
		expect(settle?.detail).toMatchObject({ quiet: expect.any(Boolean), waitedMs: expect.any(Number) });
	});

	test("settle's span carries via, reason and frontmostPid when the driver reports them", async () => {
		const events: TraceEvent[] = [];
		const sink = { write: (event: TraceEvent) => void events.push(event) };
		const span: SpanRunner = (op, fn, options) => runSpan(sink, op, fn, options);
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (c) =>
				c.method === "settle"
					? { data: { quiet: false, waitedMs: 8000, via: "stream", reason: "frontmost_mismatch", frontmostPid: 7 } }
					: undefined,
		});
		const device = traceDevice(createDevice({ session: { out: "/tmp/out", span }, driver, env }), span);
		await device.settle();
		expect(events[0]).toMatchObject({
			op: "device.settle",
			detail: { quiet: false, waitedMs: 8000, via: "stream", reason: "frontmost_mismatch", frontmostPid: 7 },
		});
	});

	test("a call that throws is an ok:false span with the error code, and still throws", async () => {
		const { device, spans } = setup("ios");
		await expect(device.back()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		expect(spans()[0]).toMatchObject({ op: "device.back", ok: false, code: "INVALID_ARGUMENT" });
	});

	test("devtools is read through lazily, never touched by wrapping", () => {
		let reads = 0;
		const stub: Device = {
			...setup().device,
			get devtools() {
				reads += 1;
				return undefined;
			},
		} as Device;
		const wrapped = traceDevice(stub, async (_op, fn) => fn());
		expect(reads).toBe(0);
		expect(wrapped.devtools).toBeUndefined();
		expect(reads).toBe(1);
	});

	test("without a span runner the device is returned as is", () => {
		const device = setup().device;
		expect(traceDevice(device, undefined)).toBe(device);
	});
});

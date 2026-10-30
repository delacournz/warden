import { describe, expect, test } from "bun:test";
import type { TransportClose } from "../ios/simd-transport";
import { fakeUiad } from "./uiad.testing";
import { isBusy, startUiad } from "./uiad-client";

const CMD = ["adb", "-s", "emulator-5554", "shell", "exec env CLASSPATH=/data/local/tmp/x.dex app_process / X"];

const start = (fake: ReturnType<typeof fakeUiad>, extra: { readyTimeoutMs?: number; requestTimeoutMs?: number } = {}) =>
	startUiad({ cmd: CMD, spawn: fake.spawn, graceMs: 50, ...extra });

describe("startUiad", () => {
	test("spawns the command and answers with the server's health", async () => {
		const fake = fakeUiad();
		const started = await start(fake);
		if (!started.success) throw new Error(started.error.message);
		expect(fake.commands).toEqual([CMD]);
		expect(started.data.health).toMatchObject({ version: "0.4.0", protocol: 1, sdk: 37 });
		expect(started.data.alive()).toBe(true);
		await started.data.close();
	});

	test("a busy UiAutomation slot is a fatal the caller can recognise", async () => {
		const fake = fakeUiad({
			fatal: {
				code: "E_AX_UNAVAILABLE",
				message: "UiAutomationService already registered!",
				retryable: false,
				detail: { reason: "uiautomation_busy" },
			},
		});
		const started = await start(fake);
		expect(started.success).toBe(false);
		if (started.success) return;
		expect(started.error.code).toBe("E_AX_UNAVAILABLE");
		expect(isBusy(started.error)).toBe(true);
		expect(fake.running()).toBe(0);
	});

	test("a server that exits before ready is a crash that carries its stderr", async () => {
		const fake = fakeUiad({ exitBeforeReady: 1, stderr: ["Error: could not find class Main"] });
		const started = await start(fake);
		expect(started.success).toBe(false);
		if (started.success) return;
		expect(started.error.code).toBe("E_HELPER_CRASHED");
		expect(started.error.message).toContain("exit 1");
		expect(started.error.message).toContain("could not find class Main");
	});

	test("no ready in time is a timeout, and the process is ended", async () => {
		const fake = fakeUiad({ noReady: true });
		const started = await start(fake, { readyTimeoutMs: 30 });
		expect(started.success).toBe(false);
		if (started.success) return;
		expect(started.error.code).toBe("E_TIMEOUT");
		expect(fake.running()).toBe(0);
	});

	test("a protocol this client does not speak is unsupported, and the server is ended", async () => {
		const fake = fakeUiad({ protocol: 2 });
		const started = await start(fake);
		expect(started.success).toBe(false);
		if (started.success) return;
		expect(started.error.code).toBe("E_UNSUPPORTED");
		expect(started.error.message).toContain("protocol 2");
		expect(fake.running()).toBe(0);
	});
});

describe("requests", () => {
	test("snapshot reads the recorded tree; ids count up; one server serves them all", async () => {
		const fake = fakeUiad();
		const started = await start(fake);
		if (!started.success) throw new Error(started.error.message);
		const client = started.data;
		const first = await client.snapshot({ fresh: true });
		const second = await client.snapshot();
		if (!first.success || !second.success) throw new Error("snapshot failed");
		expect(first.data.backend).toBe("uiad");
		expect(first.data.elements[0]?.bounds).toEqual([0, 0, 1080, 2424]);
		expect(fake.of("snapshot").map((r) => r.id)).toEqual(["1", "2"]);
		expect(fake.of("snapshot")[0]).toMatchObject({ fresh: true });
		expect(fake.started()).toBe(1);
		await client.close();
	});

	test("settle and typeText go through their schemas", async () => {
		const fake = fakeUiad();
		const started = await start(fake);
		if (!started.success) throw new Error(started.error.message);
		const settled = await started.data.settle({ quietMs: 250, timeoutMs: 3000 });
		expect(settled).toMatchObject({ success: true, data: { quiet: true, via: "events" } });
		expect(fake.of("settle")[0]).toMatchObject({ quietMs: 250, timeoutMs: 3000 });
		await started.data.close();
	});

	test("an error reply keeps its code and retryable flag", async () => {
		const fake = fakeUiad();
		const started = await start(fake);
		if (!started.success) throw new Error(started.error.message);
		const typed = await started.data.typeText("hello");
		expect(typed.success).toBe(false);
		if (typed.success) return;
		expect(typed.error).toMatchObject({ code: "E_NO_ELEMENT", retryable: false });
		await started.data.close();
	});

	test("a reply that is not the shape of its op is an internal error naming the op", async () => {
		const fake = fakeUiad({ handle: (r) => (r.op === "snapshot" ? { data: { backend: "uiad" } } : undefined) });
		const started = await start(fake);
		if (!started.success) throw new Error(started.error.message);
		const snapshot = await started.data.snapshot();
		expect(snapshot.success).toBe(false);
		if (snapshot.success) return;
		expect(snapshot.error.code).toBe("E_INTERNAL");
		expect(snapshot.error.message).toContain("`snapshot` reply is malformed");
		await started.data.close();
	});

	test("a request that is not answered in time times out and takes the server down", async () => {
		const fake = fakeUiad({ handle: (r) => (r.op === "snapshot" ? "silent" : undefined) });
		const started = await start(fake, { requestTimeoutMs: 40 });
		if (!started.success) throw new Error(started.error.message);
		const snapshot = await started.data.snapshot();
		expect(snapshot).toMatchObject({ success: false, error: { code: "E_TIMEOUT" } });
		expect(started.data.alive()).toBe(false);
		await Bun.sleep(10);
		expect(fake.running()).toBe(0);
		const later = await started.data.snapshot();
		expect(later).toMatchObject({ success: false, error: { code: "E_HELPER_CRASHED" } });
	});
});

describe("a server that dies", () => {
	test("fails the request in flight and tells the death handler", async () => {
		const fake = fakeUiad({ handle: (r) => (r.op === "snapshot" ? "die" : undefined) });
		const started = await start(fake);
		if (!started.success) throw new Error(started.error.message);
		const deaths: TransportClose[] = [];
		started.data.onDeath((info) => deaths.push(info));
		const snapshot = await started.data.snapshot();
		expect(snapshot).toMatchObject({ success: false, error: { code: "E_HELPER_CRASHED" } });
		expect(started.data.alive()).toBe(false);
		expect(deaths).toHaveLength(1);
		expect(deaths[0]?.exitCode).toBe(137);
	});

	test("a death asked for by close() is not reported", async () => {
		const fake = fakeUiad();
		const started = await start(fake);
		if (!started.success) throw new Error(started.error.message);
		const deaths: TransportClose[] = [];
		started.data.onDeath((info) => deaths.push(info));
		await started.data.close();
		expect(deaths).toHaveLength(0);
		expect(fake.of("shutdown")).toHaveLength(1);
		expect(fake.running()).toBe(0);
	});
});

describe("close", () => {
	test("is safe to call twice and sends shutdown once", async () => {
		const fake = fakeUiad();
		const started = await start(fake);
		if (!started.success) throw new Error(started.error.message);
		await started.data.close();
		await started.data.close();
		expect(fake.of("shutdown")).toHaveLength(1);
	});

	test("kills a server that ignores shutdown and stdin EOF", async () => {
		const fake = fakeUiad({ handle: (r) => (r.op === "shutdown" ? "silent" : undefined) });
		const started = await start(fake);
		if (!started.success) throw new Error(started.error.message);
		await started.data.close();
		expect(fake.running()).toBe(0);
	});
});

describe("isBusy", () => {
	test("only the busy-slot reason of an unavailable accessibility service", () => {
		const base = { message: "x", retryable: false };
		expect(isBusy({ ...base, code: "E_AX_UNAVAILABLE", detail: { reason: "uiautomation_busy" } })).toBe(true);
		expect(isBusy({ ...base, code: "E_AX_UNAVAILABLE", detail: { reason: "connect_failed" } })).toBe(false);
		expect(isBusy({ ...base, code: "E_INTERNAL", detail: { reason: "uiautomation_busy" } })).toBe(false);
		expect(isBusy({ ...base, code: "E_AX_UNAVAILABLE" })).toBe(false);
	});
});

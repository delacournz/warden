import { afterEach, describe, expect, test } from "bun:test";
import { type CdpClient, openCdp } from "./cdp";
import { type FakeMetro, startFakeMetro } from "./devtools.testing";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
});

function metro(options?: Parameters<typeof startFakeMetro>[0]): FakeMetro {
	const fake = startFakeMetro(options);
	cleanup.push(() => fake.stop());
	return fake;
}

async function connect(fake: FakeMetro, timeoutMs = 2_000): Promise<CdpClient> {
	const opened = await openCdp(fake.wsUrl(), { timeoutMs });
	if (!opened.success) throw new Error(opened.error.message);
	cleanup.push(() => opened.data.close());
	return opened.data;
}

describe("openCdp", () => {
	test("connects and sends JSON-RPC with increasing ids", async () => {
		const fake = metro({ respond: (r) => (r.method === "Echo.ping" ? { result: { pong: r.params.n } } : undefined) });
		const cdp = await connect(fake);
		const first = await cdp.send("Echo.ping", { n: 1 });
		const second = await cdp.send("Echo.ping", { n: 2 });
		expect(first).toEqual({ success: true, data: { pong: 1 } });
		expect(second).toEqual({ success: true, data: { pong: 2 } });
		expect(fake.requests.map((r) => r.id)).toEqual([1, 2]);
	});

	test("a refused connection is devtools_unavailable", async () => {
		const fake = metro();
		const url = fake.wsUrl();
		await fake.stop();
		const opened = await openCdp(url, { timeoutMs: 1_000 });
		expect(!opened.success && opened.error.code).toBe("devtools_unavailable");
	});

	test("a protocol error reply is cdp_protocol with the message", async () => {
		const fake = metro({
			respond: (r) => (r.method === "Nope.nothing" ? { error: { message: "'Nope.nothing' wasn't found" } } : undefined),
		});
		const cdp = await connect(fake);
		const result = await cdp.send("Nope.nothing");
		expect(!result.success && result.error).toEqual({ code: "cdp_protocol", message: "'Nope.nothing' wasn't found" });
	});

	test("an unanswered request times out as cdp_timeout and does not poison later ones", async () => {
		const fake = metro({ respond: (r) => (r.method === "Hang.forever" ? "silent" : undefined) });
		const cdp = await connect(fake);
		const hung = await cdp.send("Hang.forever", {}, { timeoutMs: 50 });
		expect(!hung.success && hung.error.code).toBe("cdp_timeout");
		expect((await cdp.send("Runtime.enable")).success).toBe(true);
	});

	test("events reach handlers; unsubscribe stops them", async () => {
		const fake = metro();
		const cdp = await connect(fake);
		const seen: unknown[] = [];
		const off = cdp.on("Runtime.consoleAPICalled", (params) => seen.push(params));
		await cdp.send("Runtime.enable");
		fake.emit("Runtime.consoleAPICalled", { type: "log" });
		await Bun.sleep(30);
		off();
		fake.emit("Runtime.consoleAPICalled", { type: "warn" });
		await Bun.sleep(30);
		expect(seen).toEqual([{ type: "log" }]);
	});

	test("a closed socket rejects pending requests with cdp_closed and notifies onClose", async () => {
		const fake = metro({ respond: (r) => (r.method === "Hang.forever" ? "silent" : undefined) });
		const cdp = await connect(fake);
		let closed = 0;
		cdp.onClose(() => closed++);
		const pending = cdp.send("Hang.forever", {}, { timeoutMs: 5_000 });
		await Bun.sleep(20);
		fake.dropAll();
		const result = await pending;
		expect(!result.success && result.error.code).toBe("cdp_closed");
		expect(closed).toBe(1);
		const after = await cdp.send("Runtime.enable");
		expect(!after.success && after.error.code).toBe("cdp_closed");
	});

	test("close() is quiet: no onClose callback, later sends fail", async () => {
		const fake = metro();
		const cdp = await connect(fake);
		let closed = 0;
		cdp.onClose(() => closed++);
		cdp.close();
		await Bun.sleep(30);
		expect(closed).toBe(0);
		const after = await cdp.send("Runtime.enable");
		expect(!after.success && after.error.code).toBe("cdp_closed");
	});
});

describe("bindings", () => {
	const callback = (fake: FakeMetro, payload: unknown, name = "__warden_cb") =>
		fake.emit("Runtime.bindingCalled", { name, payload: JSON.stringify(payload), executionContextId: 1 });

	test("addBinding registers the binding and probes that it was installed", async () => {
		const fake = metro();
		const cdp = await connect(fake);
		const added = await cdp.addBinding("__warden_cb");
		expect(added.success && added.data).toEqual({ available: true });
		expect(fake.requests.map((r) => r.method)).toEqual(["Runtime.addBinding", "Runtime.evaluate"]);
		expect(fake.requests[0]?.params).toEqual({ name: "__warden_cb" });
		expect(fake.requests[1]?.params.expression).toBe("typeof __warden_cb");
	});

	test("evaluateWithBinding resolves on the bindingCalled carrying the requestId", async () => {
		const fake = metro({
			respond: (r) => {
				if (r.method === "Runtime.evaluate" && String(r.params.expression).includes("run-1")) {
					callback(fake, { requestId: "other", result: "no" });
					callback(fake, { requestId: "run-1", result: 42 });
					return { result: { result: { type: "undefined" } } };
				}
				return undefined;
			},
		});
		const cdp = await connect(fake);
		await cdp.addBinding("__warden_cb");
		const result = await cdp.evaluateWithBinding("(function(){ /* run-1 */ })()", "run-1", 1_000);
		expect(result).toEqual({ success: true, data: { requestId: "run-1", result: 42 } });
		expect(fake.requests.at(-1)?.params).toMatchObject({ returnByValue: false, awaitPromise: false });
	});

	test("evaluateWithBinding times out when nothing calls back", async () => {
		const fake = metro();
		const cdp = await connect(fake);
		await cdp.addBinding("__warden_cb");
		const result = await cdp.evaluateWithBinding("void 0", "run-2", 60);
		expect(!result.success && result.error.code).toBe("cdp_timeout");
	});

	test("a throwing script fails at once with eval_failed", async () => {
		const fake = metro({
			respond: (r) =>
				r.method === "Runtime.evaluate" && r.params.expression === "boom()"
					? { result: { exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: boom" } } } }
					: undefined,
		});
		const cdp = await connect(fake);
		await cdp.addBinding("__warden_cb");
		const result = await cdp.evaluateWithBinding("boom()", "run-3", 5_000);
		expect(!result.success && result.error.code).toBe("eval_failed");
		expect(!result.success && result.error.message).toContain("ReferenceError: boom");
	});

	test("legacy Hermes: binding acknowledged but never installed -> binding_unavailable", async () => {
		const fake = metro({
			respond: (r) =>
				r.method === "Runtime.evaluate" && r.params.expression === "typeof __warden_cb"
					? { result: { result: { type: "string", value: "undefined" } } }
					: undefined,
		});
		const cdp = await connect(fake);
		const added = await cdp.addBinding("__warden_cb");
		expect(added.success && added.data).toEqual({ available: false });
		const result = await cdp.evaluateWithBinding("void 0", "run-4", 200);
		expect(!result.success && result.error.code).toBe("binding_unavailable");
	});

	test("a pending binding call rejects with cdp_closed when the socket drops", async () => {
		const fake = metro();
		const cdp = await connect(fake);
		await cdp.addBinding("__warden_cb");
		const pending = cdp.evaluateWithBinding("void 0", "run-5", 5_000);
		await Bun.sleep(20);
		fake.dropAll();
		const result = await pending;
		expect(!result.success && result.error.code).toBe("cdp_closed");
	});
});

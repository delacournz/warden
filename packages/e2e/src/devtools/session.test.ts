import { afterEach, describe, expect, test } from "bun:test";
import { type FakeMetro, fakeTarget, startFakeMetro } from "./devtools.testing";
import { type ConnectDevtoolsOptions, connectDevtools, type DevtoolsSession } from "./session";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
});

function metro(options?: Parameters<typeof startFakeMetro>[0]): FakeMetro {
	const fake = startFakeMetro(options);
	cleanup.push(() => fake.stop());
	return fake;
}

/** Real fetch and WebSocket against the fake; a 5 ms backoff instead of 200 ms. */
function options(fake: FakeMetro, extra: Partial<ConnectDevtoolsOptions> = {}): ConnectDevtoolsOptions {
	return {
		metroUrl: fake.url,
		device: { deviceName: "iPhone A" },
		fetch,
		WebSocket,
		sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
		timeoutMs: 1_000,
		...extra,
	};
}

async function connect(fake: FakeMetro, extra?: Partial<ConnectDevtoolsOptions>): Promise<DevtoolsSession> {
	const connected = await connectDevtools(options(fake, extra));
	if (!connected.success) throw new Error(connected.error.message);
	cleanup.push(() => connected.data.close());
	return connected.data;
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(5);
	}
}

describe("connectDevtools", () => {
	test("runs the Fusebox connect sequence and picks the target", async () => {
		const fake = metro();
		const session = await connect(fake);
		expect(fake.requests.map((r) => r.method)).toEqual([
			"FuseboxClient.setClientMetadata",
			"ReactNativeApplication.enable",
			"Runtime.enable",
			"Runtime.runIfWaitingForDebugger",
			"Runtime.addBinding",
			"Runtime.evaluate",
		]);
		expect(fake.requests[4]?.params).toEqual({ name: "__warden_cb" });
		expect(session.target).toMatchObject({ deviceName: "iPhone A", logicalDeviceId: "dev1", fusebox: true });
		expect(session.bindingAvailable).toBe(true);
	});

	test("optional domains failing does not fail the connect", async () => {
		const fake = metro({
			respond: (r) =>
				r.method === "FuseboxClient.setClientMetadata" || r.method === "ReactNativeApplication.enable"
					? { error: { message: "wasn't found" } }
					: undefined,
		});
		const session = await connect(fake);
		expect(session.target.deviceName).toBe("iPhone A");
	});

	test("Runtime.enable failing fails the connect and closes the socket", async () => {
		const fake = metro({
			respond: (r) => (r.method === "Runtime.enable" ? { error: { message: "nope" } } : undefined),
		});
		const connected = await connectDevtools(options(fake));
		expect(!connected.success && connected.error.code).toBe("cdp_protocol");
		await until(() => fake.connections.length === 0);
	});

	test("no Metro URL (release build) is devtools_unavailable", async () => {
		const fake = metro();
		const connected = await connectDevtools(options(fake, { metroUrl: undefined }));
		expect(!connected.success && connected.error.code).toBe("devtools_unavailable");
	});

	test("Metro down, not Metro, or no targets is devtools_unavailable", async () => {
		const down = metro();
		await down.stop();
		const a = await connectDevtools(options(down));
		expect(!a.success && a.error.code).toBe("devtools_unavailable");
		const b = await connectDevtools(options(metro({ notMetro: true })));
		expect(!b.success && b.error.code).toBe("devtools_unavailable");
		const c = await connectDevtools(options(metro({ targets: [] })));
		expect(!c.success && c.error.code).toBe("devtools_unavailable");
	});

	test("a different device name than anything on a multi-device Metro is device_mismatch", async () => {
		const fake = metro({
			targets: [
				fakeTarget(0, 1),
				fakeTarget(0, 1, { id: "dev2-1", deviceName: "iPhone B", reactNative: { logicalDeviceId: "dev2" } }),
			],
		});
		const connected = await connectDevtools(options(fake, { device: { deviceName: "Pixel" } }));
		expect(!connected.success && connected.error.code).toBe("device_mismatch");
	});
});

describe("evaluate", () => {
	test("returns the value by value and awaits promises only on request", async () => {
		const fake = metro({
			respond: (r) =>
				r.method === "Runtime.evaluate" && r.params.expression === "1 + 1"
					? { result: { result: { type: "number", value: 2 } } }
					: undefined,
		});
		const session = await connect(fake);
		expect(await session.evaluate("1 + 1")).toEqual({ success: true, data: 2 });
		await session.evaluate("1 + 1", { await: true });
		const evaluations = fake.requests.filter((r) => r.params.expression === "1 + 1");
		expect(evaluations.map((r) => r.params.awaitPromise)).toEqual([false, true]);
		expect(evaluations[0]?.params.returnByValue).toBe(true);
	});

	test("undefined results come back as undefined", async () => {
		const fake = metro({
			respond: (r) => (r.params.expression === "void 0" ? { result: { result: { type: "undefined" } } } : undefined),
		});
		const session = await connect(fake);
		expect(await session.evaluate("void 0")).toEqual({ success: true, data: undefined });
	});

	test("surfaces exceptionDetails with the thrown error's description", async () => {
		const details = {
			text: "Uncaught",
			lineNumber: 0,
			exception: { type: "object", subtype: "error", description: "ReferenceError: nope is not defined" },
		};
		const fake = metro({
			respond: (r) => (r.params.expression === "nope" ? { result: { exceptionDetails: details } } : undefined),
		});
		const session = await connect(fake);
		const result = await session.evaluate("nope");
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.message).toBe("ReferenceError: nope is not defined");
		expect(result.error.exceptionDetails).toEqual(details);
	});

	test("a request that gets no answer is an error, not a hang", async () => {
		const fake = metro({ respond: (r) => (r.params.expression === "hang" ? "silent" : undefined) });
		const session = await connect(fake);
		const result = await session.evaluate("hang", { timeoutMs: 50 });
		expect(!result.success && result.error.code).toBe("cdp_timeout");
	});
});

describe("reconnect", () => {
	test("a forced socket close reconnects within 2 s, emits reconnected, evaluate works again", async () => {
		const fake = metro({
			respond: (r) =>
				r.params.expression === "'ok'" ? { result: { result: { type: "string", value: "ok" } } } : undefined,
		});
		const session = await connect(fake);
		const reconnected: string[] = [];
		session.on("reconnected", (target) => reconnected.push(target.id));
		const started = Date.now();
		fake.dropAll();
		await until(() => reconnected.length === 1);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(fake.upgrades).toHaveLength(2);
		expect(await session.evaluate("'ok'")).toEqual({ success: true, data: "ok" });
		const second = fake.requests.slice(6).map((r) => r.method);
		expect(second.slice(0, 3)).toEqual([
			"FuseboxClient.setClientMetadata",
			"ReactNativeApplication.enable",
			"Runtime.enable",
		]);
	});

	test("an evaluate issued while reconnecting waits for the new socket", async () => {
		const fake = metro({
			respond: (r) =>
				r.params.expression === "'ok'" ? { result: { result: { type: "string", value: "ok" } } } : undefined,
		});
		let sleeps = 0;
		const session = await connect(fake, {
			sleep: async () => {
				if (++sleeps === 3) fake.setTargets([fakeTarget(fake.port, 2)]);
				await Bun.sleep(5);
			},
		});
		fake.setTargets([]);
		fake.dropAll();
		await until(() => fake.connections.length === 0);
		await Bun.sleep(20);
		const pending = session.evaluate("'ok'");
		expect(await pending).toEqual({ success: true, data: "ok" });
		expect(sleeps).toBeGreaterThanOrEqual(3);
	});

	test("Runtime.executionContextsCleared reconnects and closes the old socket", async () => {
		const fake = metro();
		const session = await connect(fake);
		const reconnected: string[] = [];
		session.on("reconnected", (target) => reconnected.push(target.id));
		fake.emit("Runtime.executionContextsCleared");
		await until(() => reconnected.length === 1);
		expect(fake.upgrades).toHaveLength(2);
		await until(() => fake.connections.length === 1);
	});

	test("re-selects the target: a reloaded app has a new page id", async () => {
		const fake = metro();
		const session = await connect(fake);
		expect(session.target.id).toBe("dev1-1");
		fake.setTargets([fakeTarget(fake.port, 2)]);
		const reconnected: string[] = [];
		session.on("reconnected", (target) => reconnected.push(target.id));
		fake.dropAll();
		await until(() => reconnected.length === 1);
		expect(session.target.id).toBe("dev1-2");
		expect(fake.upgrades.at(-1)).toContain("page=2");
	});

	test("keeps the same device once it has connected, even when another device appears", async () => {
		const fake = metro();
		const session = await connect(fake, { device: {} });
		const other = fakeTarget(fake.port, 9, {
			id: "dev2-9",
			deviceName: "iPhone B",
			webSocketDebuggerUrl: `ws://localhost:1/inspector/debug?device=dev2&page=9`,
			reactNative: { logicalDeviceId: "dev2", capabilities: { prefersFuseboxFrontend: true } },
		});
		fake.setTargets([fakeTarget(fake.port, 2), other]);
		const reconnected: string[] = [];
		session.on("reconnected", (target) => reconnected.push(target.id));
		fake.dropAll();
		await until(() => reconnected.length === 1);
		expect(session.target.logicalDeviceId).toBe("dev1");
	});

	test("retries with backoff until the target is back", async () => {
		const fake = metro();
		const sleeps: number[] = [];
		const session = await connect(fake, {
			sleep: async (ms) => {
				sleeps.push(ms);
				if (sleeps.length === 3) fake.setTargets([fakeTarget(fake.port, 2)]);
				await Bun.sleep(2);
			},
		});
		fake.setTargets([]);
		const reconnected: string[] = [];
		session.on("reconnected", (target) => reconnected.push(target.id));
		fake.dropAll();
		await until(() => reconnected.length === 1);
		expect(sleeps.slice(0, 3)).toEqual([200, 200, 200]);
	});

	test("gives up after the configured attempts: lost event and devtools_unavailable", async () => {
		const fake = metro();
		const session = await connect(fake, { maxReconnectAttempts: 3 });
		fake.setTargets([]);
		const lost: string[] = [];
		session.on("lost", (error) => lost.push(error.code));
		fake.dropAll();
		await until(() => lost.length === 1);
		expect(lost).toEqual(["devtools_unavailable"]);
		const result = await session.evaluate("1");
		expect(!result.success && result.error.code).toBe("devtools_unavailable");
	});

	test("close() stops reconnecting", async () => {
		const fake = metro();
		const session = await connect(fake);
		session.close();
		await Bun.sleep(50);
		expect(fake.upgrades).toHaveLength(1);
		const result = await session.evaluate("1");
		expect(!result.success && result.error.code).toBe("cdp_closed");
	});
});

describe("reloadJs", () => {
	/** Scripts the reload probe: answers `value`, and (when `cleared`) the JS context then dies like a real reload. */
	function reloadMetro(value: unknown, cleared: boolean): FakeMetro {
		const fake: FakeMetro = metro({
			respond: (r) => {
				if (r.method !== "Runtime.evaluate" || !String(r.params?.expression).includes("reloadAppAsync")) {
					return undefined;
				}
				if (cleared) queueMicrotask(() => fake.emit("Runtime.executionContextsCleared"));
				return { result: { result: { type: typeof value, value } } };
			},
		});
		return fake;
	}

	function reloadEvaluates(fake: FakeMetro) {
		return fake.requests.filter(
			(r) => r.method === "Runtime.evaluate" && String(r.params.expression).includes("reloadAppAsync")
		);
	}

	test("reloads only this device through expo.reloadAppAsync and waits for the reconnect", async () => {
		const fake = reloadMetro("expo", true);
		const lines: string[] = [];
		const session = await connect(fake, { log: (line) => lines.push(line) });
		const reconnected: string[] = [];
		session.on("reconnected", (target) => reconnected.push(target.id));
		const reloaded = await session.reloadJs();
		expect(reloaded).toEqual({ success: true, data: { method: "expo" } });
		expect(reconnected).toHaveLength(1);
		expect(fake.reloadPosts).toBe(0);
		expect(lines).toContain("devtools: reload via expo");
	});

	test("falls to DevSettings when the evaluate answers devsettings", async () => {
		const fake = reloadMetro("devsettings", true);
		const session = await connect(fake);
		expect(await session.reloadJs()).toEqual({ success: true, data: { method: "devsettings" } });
		expect(fake.reloadPosts).toBe(0);
	});

	test("a devsettings reload that never restarts the JS context fails without a broadcast", async () => {
		const fake = reloadMetro("devsettings", false);
		const lines: string[] = [];
		const session = await connect(fake, { reloadWaitMs: 20, log: (line) => lines.push(line) });
		const reloaded = await session.reloadJs();
		expect(!reloaded.success && reloaded.error.code).toBe("reload_failed");
		expect(!reloaded.success && reloaded.error.message).toContain("did not restart within 20 ms");
		expect(fake.reloadPosts).toBe(0);
		expect(lines).toContain("devtools: reload via devsettings not observed after 20 ms");
	});

	test("an expo reload that never restarts fails too", async () => {
		const fake = reloadMetro("expo", false);
		const session = await connect(fake, { reloadWaitMs: 20 });
		const reloaded = await session.reloadJs();
		expect(!reloaded.success && reloaded.error.code).toBe("reload_failed");
		expect(fake.reloadPosts).toBe(0);
	});

	test("POST /reload only when the app has neither reload API", async () => {
		const fake = reloadMetro(false, false);
		const session = await connect(fake, {
			reloadWaitMs: 1_000,
			sleep: (ms) => Bun.sleep(ms === 1_000 ? 400 : Math.min(ms, 5)),
		});
		const reloadPosted = fake.reloadPosts;
		const pending = session.reloadJs();
		await until(() => fake.reloadPosts === reloadPosted + 1);
		fake.emit("Runtime.executionContextsCleared");
		expect(await pending).toEqual({ success: true, data: { method: "http" } });
		expect(fake.reloadPosts).toBe(1);
	});

	test("POST /reload that the app never acts on is reload_failed", async () => {
		const fake = reloadMetro(false, false);
		const session = await connect(fake, { reloadWaitMs: 20 });
		const reloaded = await session.reloadJs();
		expect(!reloaded.success && reloaded.error.code).toBe("reload_failed");
		expect(fake.reloadPosts).toBe(1);
	});

	test("a reload probe that errors fails without a broadcast", async () => {
		const fake = metro({
			respond: (r) =>
				r.method === "Runtime.evaluate" && String(r.params?.expression).includes("reloadAppAsync")
					? { error: { message: "runtime is gone" } }
					: undefined,
		});
		const session = await connect(fake, { reloadWaitMs: 20 });
		const reloaded = await session.reloadJs();
		expect(reloaded).toEqual({
			success: false,
			error: { code: "cdp_protocol", message: "reload probe failed: runtime is gone" },
		});
		expect(fake.reloadPosts).toBe(0);
	});

	test("POST /reload answering non-200 stays devtools_unavailable", async () => {
		const fake = reloadMetro(false, false);
		const real = globalThis.fetch;
		const broken = await connectDevtools({
			...options(fake, { reloadWaitMs: 20 }),
			fetch: (input, init) =>
				String(input).endsWith("/reload") ? Promise.resolve(new Response("nope", { status: 500 })) : real(input, init),
		});
		if (!broken.success) throw new Error(broken.error.message);
		cleanup.push(() => broken.data.close());
		const reloaded = await broken.data.reloadJs();
		expect(!reloaded.success && reloaded.error.code).toBe("devtools_unavailable");
	});

	test("never sends Page.reload and never awaits the evaluate's promise", async () => {
		const fake = reloadMetro("expo", true);
		const session = await connect(fake);
		await session.reloadJs();
		expect(fake.requests.some((r) => r.method === "Page.reload")).toBe(false);
		const evaluates = reloadEvaluates(fake);
		expect(evaluates).toHaveLength(1);
		expect(evaluates[0]?.params.awaitPromise).not.toBe(true);
		expect(evaluates[0]?.params.returnByValue).toBe(true);
	});
});

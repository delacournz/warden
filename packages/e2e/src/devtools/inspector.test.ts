import { describe, expect, test } from "bun:test";
import type { Fetch } from "./devtools.types";
import { type InspectorTarget, listTargets, selectTarget } from "./inspector";

const METRO = "http://127.0.0.1:8081";

type Overrides = Partial<InspectorTarget>;

function target(id: string, overrides: Overrides = {}): InspectorTarget {
	const device = id.split("-")[0];
	return {
		id,
		title: "Hermes React Native",
		description: "com.example.app",
		vm: "Hermes",
		deviceName: "iPhone A",
		appId: "com.example.app",
		webSocketDebuggerUrl: `ws://localhost:9999/inspector/debug?device=${device}&page=${id.split("-")[1]}`,
		...overrides,
	};
}

const fusebox = (id: string, logicalDeviceId: string, overrides: Overrides = {}) =>
	target(id, {
		reactNative: { logicalDeviceId, capabilities: { prefersFuseboxFrontend: true } },
		...overrides,
	});

function route(routes: Record<string, { status?: number; body: string }>): Fetch & { calls: string[] } {
	const calls: string[] = [];
	const fn: Fetch = async (input) => {
		calls.push(input);
		const hit = routes[input.replace(METRO, "")];
		if (!hit) throw new Error("ECONNREFUSED");
		const status = hit.status ?? 200;
		return { ok: status < 400, status, text: async () => hit.body };
	};
	return Object.assign(fn, { calls });
}

describe("listTargets", () => {
	test("needs packager-status:running, then reads /json/list and drops the decoy vm", async () => {
		const fetch = route({
			"/status": { body: "packager-status:running" },
			"/json/list": { body: JSON.stringify([target("d1-1"), target("d1-2", { vm: "don't use" })]) },
		});
		const result = await listTargets(METRO, fetch);
		expect(result.success && result.data.map((t) => t.id)).toEqual(["d1-1"]);
	});

	test("falls back to /json when /json/list is missing", async () => {
		const fetch = route({
			"/status": { body: "packager-status:running" },
			"/json/list": { status: 404, body: "" },
			"/json": { body: JSON.stringify([target("d1-1")]) },
		});
		const result = await listTargets(METRO, fetch);
		expect(result.success && result.data).toHaveLength(1);
		expect(fetch.calls).toContain(`${METRO}/json`);
	});

	test("unreachable Metro and non-Metro servers are devtools_unavailable", async () => {
		const down = await listTargets(METRO, route({}));
		expect(!down.success && down.error.code).toBe("devtools_unavailable");
		const other = await listTargets(METRO, route({ "/status": { body: "<html>nginx</html>" } }));
		expect(!other.success && other.error.code).toBe("devtools_unavailable");
	});

	test("drops malformed entries, keeps the rest", async () => {
		const fetch = route({
			"/status": { body: "packager-status:running" },
			"/json/list": { body: JSON.stringify([{ id: "x" }, 7, target("d1-1")]) },
		});
		const result = await listTargets(METRO, fetch);
		expect(result.success && result.data.map((t) => t.id)).toEqual(["d1-1"]);
	});

	test("a body that is not a list is a protocol error", async () => {
		const fetch = route({ "/status": { body: "packager-status:running" }, "/json/list": { body: "{}" } });
		const result = await listTargets(METRO, fetch);
		expect(!result.success && result.error.code).toBe("devtools_unavailable");
	});
});

describe("selectTarget", () => {
	const pick = (targets: InspectorTarget[], query = {}) => selectTarget(targets, query, METRO);

	test("normalises the ws url to the Metro host and port", () => {
		const result = pick([fusebox("d1-1", "L1")]);
		expect(result.success && result.data.wsUrl).toBe("ws://127.0.0.1:8081/inspector/debug?device=d1&page=1");
		const secure = selectTarget([fusebox("d1-1", "L1")], {}, "https://metro.test:9000");
		expect(secure.success && secure.data.wsUrl.startsWith("wss://metro.test:9000/")).toBe(true);
	});

	test("returns device, app, logical id and fusebox flag", () => {
		const result = pick([fusebox("d1-1", "L1")]);
		expect(result.success && result.data).toMatchObject({
			deviceName: "iPhone A",
			appId: "com.example.app",
			logicalDeviceId: "L1",
			fusebox: true,
			id: "d1-1",
		});
	});

	test("Fusebox beats the legacy bridge target", () => {
		const legacy = target("d1-1", { title: "React Native Bridge" });
		const result = pick([legacy, fusebox("d1-2", "L1")]);
		expect(result.success && result.data.id).toBe("d1-2");
	});

	test("description [C++ connection] counts as Fusebox", () => {
		const cpp = target("d1-2", { description: "com.example.app [C++ connection]" });
		const result = pick([target("d1-1"), cpp]);
		expect(result.success && result.data).toMatchObject({ id: "d1-2", fusebox: true });
	});

	test("legacy: title React Native Bridge beats the first target", () => {
		const result = pick([target("d1-1", { title: "Other" }), target("d1-2", { title: "React Native Bridge" })]);
		expect(result.success && result.data).toMatchObject({ id: "d1-2", fusebox: false });
	});

	test("legacy without bridge title takes the newest; logical id comes from ?device=", () => {
		const result = pick([target("d1-1", { title: "A" }), target("d1-2", { title: "B" })]);
		expect(result.success && result.data).toMatchObject({ id: "d1-2", logicalDeviceId: "d1", fusebox: false });
	});

	test("newest id wins among equal candidates (numeric page id, not string order)", () => {
		const result = pick([fusebox("d1-9", "L1"), fusebox("d1-10", "L1"), fusebox("d1-2", "L1")]);
		expect(result.success && result.data.id).toBe("d1-10");
	});

	test("pinned logicalDeviceId selects its device among several", () => {
		const targets = [
			fusebox("d1-1", "L1", { deviceName: "iPhone A" }),
			fusebox("d2-1", "L2", { deviceName: "iPhone B" }),
		];
		const result = pick(targets, { logicalDeviceId: "L2" });
		expect(result.success && result.data).toMatchObject({ id: "d2-1", logicalDeviceId: "L2" });
	});

	test("pinned logicalDeviceId matches the ?device= of a legacy target", () => {
		const result = pick([target("d1-1"), target("d2-1", { deviceName: "iPhone B" })], { logicalDeviceId: "d2" });
		expect(result.success && result.data.id).toBe("d2-1");
	});

	test("pinned logicalDeviceId has priority over deviceName", () => {
		const targets = [
			fusebox("d1-1", "L1", { deviceName: "iPhone A" }),
			fusebox("d2-1", "L2", { deviceName: "iPhone B" }),
		];
		const result = pick(targets, { logicalDeviceId: "L1", deviceName: "iPhone B" });
		expect(result.success && result.data.id).toBe("d1-1");
	});

	test("unknown pin with several devices is device_mismatch naming them", () => {
		const targets = [fusebox("d1-1", "L1"), fusebox("d2-1", "L2", { deviceName: "iPhone B" })];
		const result = pick(targets, { logicalDeviceId: "gone" });
		expect(!result.success && result.error.code).toBe("device_mismatch");
		expect(!result.success && result.error.message).toContain("iPhone B");
	});

	test("unknown pin with a single device still connects (its id was regenerated)", () => {
		const result = pick([fusebox("d1-1", "L1")], { logicalDeviceId: "stale" });
		expect(result.success && result.data.logicalDeviceId).toBe("L1");
	});

	test("deviceName filters when no pin", () => {
		const targets = [
			fusebox("d1-1", "L1", { deviceName: "iPhone A" }),
			fusebox("d2-1", "L2", { deviceName: "iPhone B" }),
		];
		const result = pick(targets, { deviceName: "iPhone B" });
		expect(result.success && result.data.id).toBe("d2-1");
	});

	test("unknown deviceName with several devices is device_mismatch", () => {
		const targets = [fusebox("d1-1", "L1"), fusebox("d2-1", "L2", { deviceName: "iPhone B" })];
		const result = pick(targets, { deviceName: "Pixel" });
		expect(!result.success && result.error.code).toBe("device_mismatch");
	});

	test("appId breaks ties between apps on one device", () => {
		const targets = [
			fusebox("d1-1", "L1", { appId: "com.other" }),
			fusebox("d1-2", "L1", { appId: "com.example.app" }),
			fusebox("d1-3", "L1", { appId: "com.other" }),
		];
		const result = pick(targets, { deviceName: "iPhone A", appId: "com.example.app" });
		expect(result.success && result.data.id).toBe("d1-2");
	});

	test("an appId nobody has falls back to the device's newest target", () => {
		const result = pick([fusebox("d1-1", "L1"), fusebox("d1-2", "L1")], { appId: "com.missing" });
		expect(result.success && result.data.id).toBe("d1-2");
	});

	test("decoy vm entries never reach selection through listTargets", async () => {
		const fetch = route({
			"/status": { body: "packager-status:running" },
			"/json/list": { body: JSON.stringify([fusebox("d1-9", "L1", { vm: "don't use" }), fusebox("d1-1", "L1")]) },
		});
		const listed = await listTargets(METRO, fetch);
		const result = listed.success ? pick(listed.data) : listed;
		expect(result.success && result.data.id).toBe("d1-1");
	});

	test("no targets is devtools_unavailable", () => {
		const result = pick([]);
		expect(!result.success && result.error.code).toBe("devtools_unavailable");
	});
});

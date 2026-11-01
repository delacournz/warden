import { describe, expect, test } from "bun:test";
import { networkProxyShaping } from "./network-proxy";
import { FakeProxy } from "./network-proxy.testing";

describe("networkProxyShaping.conditionsFor", () => {
	test("a preset shapes with its table row and keeps the faults", () => {
		const faults = [{ match: "api.*", action: { kind: "reset" as const } }];
		const result = networkProxyShaping.conditionsFor({ kind: "preset", preset: "3g" }, faults);
		expect(result.params).toMatchObject({ latencyMs: 100, downKbps: 780, upKbps: 330 });
		expect(result.faults).toEqual(faults);
	});

	test("offline refuses connections", () => {
		expect(networkProxyShaping.conditionsFor({ kind: "offline" }, []).params).toEqual({ offline: "refuse" });
	});
});

describe("networkProxyShaping.faultNotes", () => {
	test("only status faults need a note, and it says https is reset", () => {
		const notes = networkProxyShaping.faultNotes([
			{ match: "api.example.com", action: { kind: "status", code: 503 } },
			{ match: "*.cdn.net", action: { kind: "reset" } },
			{ match: "slow.io", action: { kind: "delay", ms: 500 } },
		]);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("503");
		expect(notes[0]).toContain("api.example.com");
		expect(notes[0]).toContain("https://");
	});

	test("none for no faults", () => {
		expect(networkProxyShaping.faultNotes([])).toEqual([]);
	});
});

describe("FakeProxy", () => {
	test("ensure makes it live, stop clears it", async () => {
		const proxy = new FakeProxy(19_100);
		expect(await proxy.current()).toBeUndefined();
		await proxy.ensure({ kind: "online" }, { params: {}, faults: [] });
		expect(await proxy.current()).toEqual({ host: "127.0.0.1", port: 19_100 });
		await proxy.stop();
		expect(await proxy.current()).toBeUndefined();
	});
});

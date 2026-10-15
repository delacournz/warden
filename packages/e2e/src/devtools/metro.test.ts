import { describe, expect, test } from "bun:test";
import { findMetro, type MetroProbe } from "./metro";

const probeOf =
	(answers: Record<number, MetroProbe>, seen: number[] = []) =>
	async (port: number) => {
		seen.push(port);
		return answers[port] ?? "none";
	};

describe("findMetro precedence", () => {
	const all = {
		flag: "http://flag:1",
		env: "http://env:2",
		stateMetroUrl: "http://state:3",
		portLeases: [8081],
		probe: probeOf({ 8081: "ours" }),
	};

	test("flag wins", async () => {
		expect(await findMetro(all)).toEqual({ url: "http://flag:1", source: "flag" });
	});

	test("env next", async () => {
		expect(await findMetro({ ...all, flag: undefined })).toEqual({ url: "http://env:2", source: "env" });
	});

	test("state next", async () => {
		expect(await findMetro({ ...all, flag: undefined, env: "" })).toEqual({ url: "http://state:3", source: "state" });
	});

	test("leases last, trailing slash trimmed on explicit urls", async () => {
		expect(await findMetro({ ...all, flag: undefined, env: undefined, stateMetroUrl: undefined })).toEqual({
			url: "http://127.0.0.1:8081",
			source: "lease",
		});
		expect((await findMetro({ ...all, flag: "http://x:1//" }))?.url).toBe("http://x:1");
	});

	test("explicit sources skip probing", async () => {
		const seen: number[] = [];
		await findMetro({ ...all, probe: probeOf({}, seen) });
		expect(seen).toEqual([]);
	});
});

describe("findMetro lease probing", () => {
	test("never picks foreign, takes the first ours", async () => {
		const seen: number[] = [];
		const found = await findMetro({
			portLeases: [8081, 8082, 8083],
			probe: probeOf({ 8081: "foreign", 8082: "none", 8083: "ours" }, seen),
		});
		expect(found).toEqual({ url: "http://127.0.0.1:8083", source: "lease" });
		expect(seen).toEqual([8081, 8082, 8083]);
	});

	test("only foreign or none gives undefined", async () => {
		expect(await findMetro({ portLeases: [8081, 8082], probe: probeOf({ 8081: "foreign" }) })).toBeUndefined();
		expect(await findMetro({ portLeases: [], probe: probeOf({}) })).toBeUndefined();
	});
});

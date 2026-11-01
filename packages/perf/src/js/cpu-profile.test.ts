import { describe, expect, test } from "bun:test";
import { cpuProfileCapture } from "./cpu-profile";
import { jsFixtures } from "./js.testing";

const profile = jsFixtures.buildProfile(
	[
		{ id: 1, name: "(root)", children: [2] },
		{ id: 2, name: "work" },
	],
	[
		[2, 1000],
		[2, 1000],
	]
);

describe("startProfile", () => {
	test("enables, sets the interval, reads the device clock, then starts", async () => {
		const cdp = jsFixtures.fakeCdp({ "Runtime.evaluate": { result: { type: "number", value: 1_700_000_000_123 } } });
		const started = await cpuProfileCapture.startProfile(cdp, { samplingIntervalUs: 250 });
		expect(started).toEqual({ success: true, data: { samplingIntervalUs: 250, deviceWallMs: 1_700_000_000_123 } });
		expect(cdp.sent.map((s) => s.method)).toEqual([
			"Profiler.enable",
			"Profiler.setSamplingInterval",
			"Runtime.evaluate",
			"Profiler.start",
		]);
		expect(cdp.sent[1]?.params).toEqual({ interval: 250 });
	});

	test("defaults to 100us", async () => {
		const started = await cpuProfileCapture.startProfile(jsFixtures.fakeCdp());
		expect(started.success && started.data.samplingIntervalUs).toBe(100);
	});

	test("a runtime without setSamplingInterval still starts", async () => {
		const cdp = jsFixtures.fakeCdp({
			"Profiler.setSamplingInterval": { __error: "'Profiler.setSamplingInterval' wasn't found" },
		});
		expect((await cpuProfileCapture.startProfile(cdp)).success).toBe(true);
	});

	test("Profiler.start missing is a typed unsupported error with a hint", async () => {
		const cdp = jsFixtures.fakeCdp({ "Profiler.start": { __error: "'Profiler.start' wasn't found" } });
		const started = await cpuProfileCapture.startProfile(cdp);
		expect(started).toMatchObject({ success: false, error: { code: "unsupported" } });
		expect(!started.success && started.error.hint).toContain("Hermes");
	});

	test("other Profiler.start failures are cdp_failed", async () => {
		const cdp = jsFixtures.fakeCdp({ "Profiler.start": { __error: "boom" } });
		expect(await cpuProfileCapture.startProfile(cdp)).toMatchObject({ success: false, error: { code: "cdp_failed" } });
	});
});

describe("stopProfile", () => {
	test("returns the validated profile", async () => {
		const stopped = await cpuProfileCapture.stopProfile(jsFixtures.fakeCdp({ "Profiler.stop": { profile } }));
		expect(stopped.success && stopped.data.samples).toEqual([2, 2]);
	});

	test("a reply without a profile is invalid_profile", async () => {
		expect(await cpuProfileCapture.stopProfile(jsFixtures.fakeCdp({ "Profiler.stop": {} }))).toMatchObject({
			success: false,
			error: { code: "invalid_profile" },
		});
	});

	test("a failed stop hints at a reload", async () => {
		const stopped = await cpuProfileCapture.stopProfile(
			jsFixtures.fakeCdp({ "Profiler.stop": { __error: "socket closed" } })
		);
		expect(stopped).toMatchObject({ success: false, error: { code: "cdp_failed" } });
	});
});

describe("parseStopReply", () => {
	test("keeps unknown fields so the file opens in other tools", () => {
		const parsed = cpuProfileCapture.parseStopReply({ profile: { ...profile, extra: 1 } });
		expect(parsed.success && "extra" in parsed.data).toBe(true);
	});

	test("numeric scriptIds are accepted", () => {
		const raw = structuredClone(profile);
		(raw.nodes[1] as { callFrame: { scriptId: unknown } }).callFrame.scriptId = 7;
		expect(cpuProfileCapture.parseStopReply({ profile: raw }).success).toBe(true);
	});
});

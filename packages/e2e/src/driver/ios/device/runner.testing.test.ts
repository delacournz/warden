import { describe, expect, test } from "bun:test";
import { loadRecording, recordingHandler } from "./runner.testing";

describe("recordingHandler", () => {
	const pairs = loadRecording();

	test("the real-device recording has the ops the driver needs and no personal UDID", () => {
		const ops = new Set(pairs.map((pair) => pair.request.op));
		for (const op of ["health", "snapshot", "tap", "typeText", "screenshot", "appState", "pinch"])
			expect(ops.has(op)).toBe(true);
		const udids = new Set(JSON.stringify(pairs).match(/[0-9A-F]{8}-[0-9A-F]{16}/g) ?? []);
		expect([...udids]).toEqual(["00008140-000A0B0C0D0E0F10"]);
	});

	test("answers recorded responses in order, repeats the last, and refuses an unrecorded op", async () => {
		const handler = recordingHandler([
			{ request: { op: "tap" }, response: { ok: true, data: { n: 1 } } },
			{ request: { op: "tap" }, response: { ok: false, error: { code: "E_IO", message: "x" } } },
		]);
		const request = { id: "1", op: "tap" };
		expect(await handler(request)).toEqual({ data: { n: 1 } });
		expect(await handler(request)).toEqual({ error: { code: "E_IO", message: "x" } });
		expect(await handler(request)).toEqual({ error: { code: "E_IO", message: "x" } });
		expect(await handler({ id: "2", op: "swipe" })).toBeUndefined();
	});
});

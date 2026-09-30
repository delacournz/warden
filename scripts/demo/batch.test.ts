import { describe, expect, test } from "bun:test";
import { parseBatch } from "./batch";

const valid = {
	batchId: "b1",
	cmd: ["bun", "run-ios.ts", "--attach", "{job}"],
	startedAt: 1000,
	endedAt: 9000,
	ok: true,
	devices: [{ worker: 0, udid: "U0", name: "iPhone 17", video: "dev-0.mp4", videoStartedAt: 1500 }],
	jobs: [{ job: "qa-login", worker: 0, udid: "U0", seq: 0, attempt: 0, startedAt: 2000, endedAt: 4000, exitCode: 0 }],
};

describe("parseBatch", () => {
	test("accepts the record-dir contract", () => {
		const r = parseBatch(valid);
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.devices[0]?.video).toBe("dev-0.mp4");
			expect(r.data.jobs[0]?.job).toBe("qa-login");
		}
	});

	test("accepts a string cmd and string worker ids", () => {
		const r = parseBatch({
			...valid,
			cmd: "bun x",
			devices: [{ ...valid.devices[0], worker: "0" }],
			jobs: [{ ...valid.jobs[0], worker: "0" }],
		});
		expect(r.success).toBe(true);
	});

	test("rejects a non-object", () => {
		expect(parseBatch("nope")).toEqual({ success: false, error: "batch.json: expected an object" });
	});

	test("names the bad field path", () => {
		const r = parseBatch({ ...valid, jobs: [{ ...valid.jobs[0], endedAt: "later" }] });
		expect(r).toEqual({ success: false, error: "batch.json: jobs[0].endedAt must be a number" });
	});

	test("rejects zero devices", () => {
		const r = parseBatch({ ...valid, devices: [] });
		expect(r).toEqual({ success: false, error: "batch.json: devices must not be empty" });
	});

	test("rejects a job on an unknown worker", () => {
		const r = parseBatch({ ...valid, jobs: [{ ...valid.jobs[0], worker: 7 }] });
		expect(r).toEqual({ success: false, error: "batch.json: jobs[0].worker 7 has no device" });
	});

	test("rejects a job that ends before it starts", () => {
		const r = parseBatch({ ...valid, jobs: [{ ...valid.jobs[0], endedAt: 1 }] });
		expect(r).toEqual({ success: false, error: "batch.json: jobs[0] ends before it starts" });
	});
});

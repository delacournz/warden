import { describe, expect, test } from "bun:test";
import { recordArgv, videoName } from "./record";

describe("record", () => {
	test("simctl recordVideo argv, h264, overwrite", () => {
		expect(recordArgv("U1", "/r/dev-0.mp4")).toEqual([
			"xcrun",
			"simctl",
			"io",
			"U1",
			"recordVideo",
			"--codec",
			"h264",
			"--force",
			"/r/dev-0.mp4",
		]);
	});

	test("one file per worker", () => {
		expect(videoName(3)).toBe("dev-3.mp4");
	});
});

import { describe, expect, test } from "bun:test";
import { benchRunSchema, CANONICAL_IDS, parseBenchRun } from "./schema";

describe("bench-results schema", () => {
	test("8 canonical ids", () => {
		expect(CANONICAL_IDS).toHaveLength(8);
	});
	test("parseBenchRun rejects junk and reports the path", () => {
		expect(parseBenchRun("nope").success).toBe(false);
		const r = parseBenchRun(JSON.stringify({ schemaVersion: 1 }));
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error).toContain("id");
	});
	test("accepts a minimal run with an unsupported framework", () => {
		const run = {
			schemaVersion: 1,
			id: "2026-10-16T00-00-00",
			startedAt: "2026-10-16T00:00:00.000Z",
			host: {
				model: "Mac",
				cpu: "M4",
				cores: 14,
				memBytes: 1,
				macos: "26",
				bun: "1.3",
				warden: "0.1",
				loadAvgAtStart: 1,
			},
			device: { platform: "ios", udid: "U" },
			app: { bundleId: "b", appPath: "/a.app", hash: "h", sha256: "s", bytes: 1 },
			options: { runs: 3, retries: 0, rebootBetween: false, frameworks: ["detox"], caffeinated: true },
			frameworks: [{ framework: "detox", status: "unsupported", reason: "RN 0.86" }],
		};
		expect(benchRunSchema.safeParse(run).success).toBe(true);
	});
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgentAggregate } from "./argent-report";

const fixture = readFileSync(join(import.meta.dir, "../fixtures/argent/flow-run-dir.json"), "utf8");

describe("parseArgentAggregate", () => {
	test("reads the 8 real flows of a directory run", () => {
		const r = parseArgentAggregate(fixture);
		if (!r.success) throw new Error(r.error);
		expect(r.data).toHaveLength(8);
		const onboarding = r.data.find((f) => f.nativeName === "onboarding-steps-to-sign-in");
		expect(onboarding?.status).toBe("passed");
		expect(onboarding?.durationMs).toBeGreaterThan(0);
		expect(onboarding?.steps.some((s) => s.kind === "when" && s.status === "skipped")).toBe(true);
		expect(onboarding?.steps[0]?.kind).toBe("launch");
	});
	test("a failed step becomes the flow error", () => {
		const text = JSON.stringify({
			flows: [
				{
					path: "/x/a-b.yaml",
					status: "fail",
					report: {
						flow: "a-b",
						ok: false,
						durationMs: 5,
						steps: [
							{ kind: "tap", status: "pass", target: "id=x", durationMs: 1 },
							{ kind: "await", status: "fail", target: "visible id=y", reason: "no element", durationMs: 4 },
						],
					},
				},
			],
		});
		const r = parseArgentAggregate(text);
		if (!r.success) throw new Error(r.error);
		expect(r.data[0]).toMatchObject({ status: "failed", error: "await visible id=y: no element" });
	});
	test("a flow rejected before running has no report: named by its file", () => {
		const r = parseArgentAggregate(
			JSON.stringify({ flows: [{ path: "/s/bad-flow.yaml", status: "error", error: "invalid" }] })
		);
		if (!r.success) throw new Error(r.error);
		expect(r.data[0]).toMatchObject({ nativeName: "bad-flow", status: "failed", error: "invalid" });
	});
	test("rejects non-JSON and wrong shapes", () => {
		expect(parseArgentAggregate("nope").success).toBe(false);
		expect(parseArgentAggregate("{}").success).toBe(false);
	});
});

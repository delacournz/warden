import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, testContext } from "../testing";
import { perfDiff } from "./diff";
import { sessionDir } from "./paths";
import { SEED_T0, samplesJsonl, seedSession, startupJson } from "./session-fixture.testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const A = "20261024-100000-aaaaaa";
const B = "20261024-100100-bbbbbb";

function setup(a: { cold: number; cpu: number[] }, b: { cold: number; cpu: number[] }) {
	const c = testContext([], { now: () => SEED_T0 + 60_000 });
	ctx = c;
	const files = (s: { cold: number; cpu: number[] }) => ({
		"metrics/startup.json": startupJson(s.cold),
		"metrics/samples.jsonl": samplesJsonl(SEED_T0, s.cpu),
	});
	seedSession(c, { id: A, files: files(a) });
	seedSession(c, { id: B, startMs: SEED_T0 + 60_000, files: files(b) });
	return c;
}

async function run(c: TestContext, a: string, b: string, opts: Parameters<typeof perfDiff>[3] = {}) {
	c.stdout.length = 0;
	c.stderr.length = 0;
	const code = await perfDiff(c, a, b, { json: true, ...opts });
	return { code, doc: JSON.parse(c.stdout.at(-1) ?? "null") };
}

const verdicts = (doc: { result: { metrics: Array<{ key: string; verdict: string }> } }) =>
	Object.fromEntries(doc.result.metrics.map((m) => [m.key, m.verdict]));

describe("warden perf diff", () => {
	test("reports per-metric deltas between two sessions", async () => {
		const c = setup({ cold: 1000, cpu: [10, 20] }, { cold: 1300, cpu: [10, 20] });
		const { code, doc } = await run(c, A, B);
		expect(code).toBe(0);
		expect(doc).toMatchObject({
			ok: true,
			command: "perf diff",
			device: { udid: "U1", platform: "android", name: "pixel" },
			result: { a: A, b: B, thresholdPct: 10, regressions: 1, improvements: 0, failed: false },
		});
		const startup = doc.result.metrics.find((m: { key: string }) => m.key === "startupColdMs");
		expect(startup).toMatchObject({ before: 1000, after: 1300, delta: 300, pct: 30, verdict: "regress" });
		expect(verdicts(doc).cpuP95Pct).toBe("same");
	});

	test("--fail-on regress exits 1 when something regressed, but the envelope is still ok with failed: true", async () => {
		const c = setup({ cold: 1000, cpu: [10, 20] }, { cold: 1300, cpu: [10, 20] });
		const { code, doc } = await run(c, A, B, { failOn: "regress" });
		expect(code).toBe(1);
		expect(doc.ok).toBe(true);
		expect(doc.result.failed).toBe(true);
	});

	test("--fail-on regress exits 0 when nothing regressed (an improvement is not a failure)", async () => {
		const c = setup({ cold: 1500, cpu: [40, 60] }, { cold: 1000, cpu: [10, 20] });
		const { code, doc } = await run(c, A, B, { failOn: "regress" });
		expect(code).toBe(0);
		expect(doc.result).toMatchObject({ regressions: 0, failed: false });
		expect(doc.result.improvements).toBeGreaterThanOrEqual(2);
		expect(verdicts(doc).startupColdMs).toBe("improve");
	});

	test("without --fail-on a regression still exits 0", async () => {
		const c = setup({ cold: 1000, cpu: [10, 20] }, { cold: 2000, cpu: [10, 20] });
		expect((await run(c, A, B)).code).toBe(0);
	});

	test("--threshold sets the regression bar: `10%`, `10` and `50%` parse; a 30% slowdown passes under 50", async () => {
		const c = setup({ cold: 1000, cpu: [10, 20] }, { cold: 1300, cpu: [10, 20] });
		expect((await run(c, A, B, { threshold: "10%" })).doc.result.thresholdPct).toBe(10);
		expect((await run(c, A, B, { threshold: "12.5" })).doc.result.thresholdPct).toBe(12.5);
		const lenient = await run(c, A, B, { threshold: "50%", failOn: "regress" });
		expect(lenient.code).toBe(0);
		expect(lenient.doc.result).toMatchObject({ thresholdPct: 50, regressions: 0 });
		const strict = await run(c, A, B, { threshold: "5", failOn: "regress" });
		expect(strict.code).toBe(1);
	});

	test.each(["abc", "-5", "10 %%", "", "1e3"])("a malformed --threshold %p is a usage error", async (threshold) => {
		const c = setup({ cold: 1000, cpu: [10, 20] }, { cold: 1300, cpu: [10, 20] });
		const { code, doc } = await run(c, A, B, { threshold });
		expect(code).toBe(1);
		expect(doc).toMatchObject({ ok: false, command: "perf diff", error: { code: "usage" } });
		expect(doc.error.message).toContain("--threshold must be a percentage");
	});

	test("--fail-on anything but regress is a usage error", async () => {
		const c = setup({ cold: 1000, cpu: [10, 20] }, { cold: 1300, cpu: [10, 20] });
		const { code, doc } = await run(c, A, B, { failOn: "slower" });
		expect(code).toBe(1);
		expect(doc.error).toMatchObject({ code: "usage", message: '--fail-on must be "regress", got "slower"' });
	});

	test("an unknown session on either side is session_not_found", async () => {
		const c = setup({ cold: 1000, cpu: [10, 20] }, { cold: 1000, cpu: [10, 20] });
		for (const [a, b] of [
			[A, "20260101-000000-abcdef"],
			["nope", B],
		] as const) {
			const { code, doc } = await run(c, a, b);
			expect(code).toBe(1);
			expect(doc).toMatchObject({ ok: false, error: { code: "session_not_found" } });
		}
	});

	test("`latest` and prefixes resolve both sides", async () => {
		const c = setup({ cold: 1000, cpu: [10, 20] }, { cold: 1300, cpu: [10, 20] });
		const { doc } = await run(c, "20261024-1000", "latest");
		expect(doc.result).toMatchObject({ a: A, b: B });
	});

	test("builds the missing reports on the way and leaves report.json behind", async () => {
		const c = setup({ cold: 1000, cpu: [10, 20] }, { cold: 1300, cpu: [10, 20] });
		await run(c, A, B);
		for (const id of [A, B]) expect(existsSync(join(sessionDir(c, id), "report.json"))).toBe(true);
		const again = await run(c, A, B);
		expect(again.doc.result.regressions).toBe(1);
	});

	test("text mode prints the diff lines ending in the regression count", async () => {
		const c = setup({ cold: 1000, cpu: [10, 20] }, { cold: 1300, cpu: [10, 20] });
		const code = await perfDiff(c, A, B, { failOn: "regress" });
		expect(code).toBe(1);
		const text = c.stdout.join("\n");
		expect(text).toContain("REGRESS");
		expect(text.split("\n").at(-1)).toBe("1 regression, 0 improvements");
	});
});

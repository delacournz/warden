import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, testContext } from "../testing";
import { sessionDir } from "./paths";
import { type PerfReportOptions, perfReport as report } from "./report";
import { SEED_T0, samplesJsonl, seedSession } from "./session-fixture.testing";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const OLD = "20261024-100000-aaaaaa";
const MID = "20261024-100100-bbbbbb";
const NEW = "20261024-100200-cccccc";
const dev = (n: number) => ({ platform: "android", id: `emulator-${n}`, name: `pixel-${n}` }) as const;

function setup(booted: Array<ReturnType<typeof dev>> = [dev(5554)]) {
	const c = testContext([], { now: () => SEED_T0 + 60_000 });
	ctx = c;
	asMe(c);
	for (const d of [dev(5554), dev(5556)]) c.db.recordDevice(d, SEED_T0);
	const deps = fakePerfDeps(booted);
	const withCpu = (cpu: number[]) => ({ "metrics/samples.jsonl": samplesJsonl(SEED_T0, cpu) });
	seedSession(c, { id: OLD, udid: "emulator-5554", startMs: SEED_T0, files: withCpu([10, 20]) });
	seedSession(c, { id: MID, udid: "emulator-5556", startMs: SEED_T0 + 60_000, files: withCpu([40, 50]) });
	seedSession(c, { id: NEW, udid: "emulator-5554", startMs: SEED_T0 + 120_000, files: withCpu([70, 80]) });
	return { c, deps };
}

const perfReport = (
	c: TestContext,
	deps: ReturnType<typeof fakePerfDeps>,
	id: string | undefined,
	opts: Partial<PerfReportOptions>
) => report(c, deps, id, { record: false, ...opts });

const lastJson = (c: TestContext) => JSON.parse(c.stdout.at(-1) ?? "null");

describe("warden perf report", () => {
	test("by id: builds report.json + report.md on first read and returns the envelope", async () => {
		const { c, deps } = setup();
		expect(existsSync(join(sessionDir(c, OLD), "report.json"))).toBe(false);
		expect(await perfReport(c, deps, OLD, { json: true })).toBe(0);
		const doc = lastJson(c);
		expect(doc).toMatchObject({
			ok: true,
			command: "perf report",
			device: { udid: "emulator-5554", platform: "android", name: "pixel" },
			result: { sessionId: OLD, dir: sessionDir(c, OLD), report: { version: 1, sessionId: OLD } },
		});
		expect(doc.result.report.metrics.cpuP95Pct).toBe(20);
		expect(doc.durationMs).toBe(0);
		expect(existsSync(join(sessionDir(c, OLD), "report.json"))).toBe(true);
		expect(existsSync(join(sessionDir(c, OLD), "report.md"))).toBe(true);
	});

	test("no id: the newest session for the resolved device, not the newest overall", async () => {
		const { c, deps } = setup([dev(5556)]);
		await perfReport(c, deps, undefined, { json: true });
		expect(lastJson(c).result.sessionId).toBe(MID);
	});

	test("no id and the device has none: falls back to the newest overall", async () => {
		const { c, deps } = setup([]);
		await perfReport(c, deps, undefined, { json: true });
		expect(lastJson(c).result.sessionId).toBe(NEW);
	});

	test("a unique prefix and `latest` resolve; an ambiguous prefix is session_not_found", async () => {
		const { c, deps } = setup();
		await perfReport(c, deps, "20261024-1001", { json: true });
		expect(lastJson(c).result.sessionId).toBe(MID);
		await perfReport(c, deps, "latest", { json: true });
		expect(lastJson(c).result.sessionId).toBe(NEW);
		expect(await perfReport(c, deps, "20261024-10", { json: true })).toBe(1);
		expect(lastJson(c)).toMatchObject({ ok: false, error: { code: "session_not_found" } });
		expect(lastJson(c).error.message).toContain("matches 3 sessions");
	});

	test("an unknown id is session_not_found, exit 1, and writes nothing", async () => {
		const { c, deps } = setup();
		expect(await perfReport(c, deps, "20260101-000000-abcdef", { json: true })).toBe(1);
		expect(lastJson(c)).toMatchObject({ ok: false, command: "perf report", error: { code: "session_not_found" } });
		const text = setup();
		expect(await perfReport(text.c, text.deps, "nope", {})).toBe(1);
		expect(text.c.stderr.join("\n")).toContain("no perf session nope");
	});

	test("no sessions at all is session_not_found", async () => {
		const c = testContext([], {});
		ctx = c;
		asMe(c);
		expect(await perfReport(c, fakePerfDeps([]), undefined, { json: true })).toBe(1);
		expect(lastJson(c)).toMatchObject({ error: { code: "session_not_found", message: "no perf sessions yet" } });
	});

	test("a still-running session is session_active with a stop hint", async () => {
		const { c, deps } = setup();
		seedSession(c, {
			id: "20261024-100300-dddddd",
			udid: "emulator-5554",
			startMs: SEED_T0 + 180_000,
			status: "running",
		});
		expect(await perfReport(c, deps, "20261024-100300-dddddd", { json: true })).toBe(1);
		expect(lastJson(c)).toMatchObject({ ok: false, error: { code: "session_active", hint: "warden perf stop" } });
	});

	test("a written report.json is served as is; --rebuild regenerates it from the files", async () => {
		const { c, deps } = setup();
		await perfReport(c, deps, OLD, { json: true });
		const path = join(sessionDir(c, OLD), "report.json");
		const edited = { ...JSON.parse(readFileSync(path, "utf8")), summary: ["EDITED"] };
		writeFileSync(path, JSON.stringify(edited));
		await perfReport(c, deps, OLD, { json: true });
		expect(lastJson(c).result.report.summary).toEqual(["EDITED"]);
		await perfReport(c, deps, OLD, { json: true, rebuild: true });
		expect(lastJson(c).result.report.summary).not.toEqual(["EDITED"]);
		expect(JSON.parse(readFileSync(path, "utf8")).summary).not.toEqual(["EDITED"]);
	});

	test("text mode prints the markdown report", async () => {
		const { c, deps } = setup();
		expect(await perfReport(c, deps, OLD, {})).toBe(0);
		expect(c.stdout.join("\n")).toContain(`perf session ${OLD}`);
	});

	test("a corrupt session.json is not a session: not found", async () => {
		const { c, deps } = setup();
		writeFileSync(join(sessionDir(c, OLD), "session.json"), "{");
		expect(await perfReport(c, deps, OLD, { json: true })).toBe(1);
		expect(lastJson(c).error.code).toBe("session_not_found");
	});
});

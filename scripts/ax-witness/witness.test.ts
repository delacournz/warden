import { describe, expect, test } from "bun:test";
import {
	classify,
	formatSummary,
	parseJsonl,
	pidForLabel,
	type ReadRecord,
	readyPort,
	type Source,
	summarize,
} from "./witness";

function read(
	round: number,
	source: Source,
	outcome: ReadRecord["outcome"],
	over: Partial<ReadRecord> = {}
): ReadRecord {
	return { kind: "read", round, source, tMs: round * 1000, latencyMs: 200, outcome, ...over };
}

describe("classify", () => {
	test("an ok reply is answered and keeps backend, nodes and the fallback reason", () => {
		const out = classify({
			kind: "reply",
			reply: { ok: true, data: { backend: "ax", nodes: 12, fallback: { reason: "bridge silent" } } },
		});
		expect(out).toEqual({ outcome: "answered", backend: "ax", nodes: 12, fallbackReason: "bridge silent" });
	});

	test("timeout-like codes are silent, other codes are errors", () => {
		for (const code of ["E_TIMEOUT", "E_AX_UNAVAILABLE", "E_APP_NOT_RESPONDING"]) {
			expect(classify({ kind: "reply", reply: { ok: false, error: { code } } }).outcome).toBe("silent");
		}
		expect(classify({ kind: "reply", reply: { ok: false, error: { code: "E_NO_ELEMENT" } } }).outcome).toBe("error");
	});

	test("a runner busy refusal is silent and flagged busy", () => {
		const out = classify({
			kind: "reply",
			reply: {
				ok: false,
				error: { code: "E_TIMEOUT", message: "runner busy: snapshot has held XCUITest for 25849 ms" },
			},
		});
		expect(out).toMatchObject({ outcome: "silent", busy: true });
	});

	test("no reply before the client deadline is a silent CLIENT_TIMEOUT", () => {
		expect(classify({ kind: "client-timeout", waitedMs: 25_000 })).toMatchObject({
			outcome: "silent",
			code: "CLIENT_TIMEOUT",
		});
	});
});

describe("summarize", () => {
	test("no silence at all is no-simd-silence", () => {
		const records = [1, 2, 3].flatMap((n) => [read(n, "simd", "answered"), read(n, "runner", "answered")]);
		const s = summarize(records);
		expect(s.verdict).toBe("no-simd-silence");
		expect(s.streaks).toEqual([]);
		expect(s.rounds).toBe(3);
	});

	test("fewer silent simd reads than minStreak are not a streak", () => {
		const records = [1, 2].flatMap((n) => [read(n, "simd", "silent"), read(n, "runner", "answered")]);
		expect(summarize(records).verdict).toBe("no-simd-silence");
	});

	test("a streak where the runner answered every time is witness-answers", () => {
		const records = [
			read(1, "simd", "answered"),
			read(1, "runner", "answered"),
			...[2, 3, 4].flatMap((n) => [read(n, "simd", "silent", { latencyMs: 10_000 }), read(n, "runner", "answered")]),
			read(5, "simd", "answered"),
		];
		const s = summarize(records);
		expect(s.verdict).toBe("witness-answers");
		expect(s.streaks).toHaveLength(1);
		expect(s.streaks[0]).toMatchObject({
			firstRound: 2,
			lastRound: 4,
			reads: 3,
			runner: { total: 3, answered: 3 },
			verdict: "answered",
			durationMs: 12_000,
		});
		expect(s.longestSimdSilenceMs).toBe(12_000);
	});

	test("a streak where the runner was silent too is witness-silent", () => {
		const records = [1, 2, 3].flatMap((n) => [read(n, "simd", "silent"), read(n, "runner", "silent")]);
		expect(summarize(records).verdict).toBe("witness-silent");
	});

	test("answers and silences mixed is witness-mixed; two streaks are told apart", () => {
		const records = [
			...[1, 2, 3].flatMap((n) => [read(n, "simd", "silent"), read(n, "runner", "answered")]),
			read(4, "simd", "answered"),
			...[5, 6, 7].flatMap((n) => [read(n, "simd", "silent"), read(n, "runner", "silent")]),
		];
		const s = summarize(records);
		expect(s.streaks.map((x) => x.verdict)).toEqual(["answered", "silent"]);
		expect(s.verdict).toBe("witness-mixed");
	});

	test("a streak the runner was never asked during is unread", () => {
		const records = [1, 2, 3].map((n) => read(n, "simd", "silent"));
		expect(summarize(records).streaks[0]?.verdict).toBe("unread");
	});

	test("silence only while the runner was down is witness-unread", () => {
		const records = [1, 2, 3].map((n) => read(n, "simd", "silent"));
		expect(summarize(records).verdict).toBe("witness-unread");
	});

	test("an unread startup streak does not dilute a later answered streak", () => {
		const records = [
			...[1, 2, 3].map((n) => read(n, "simd", "silent")),
			read(4, "simd", "answered"),
			...[5, 6, 7].flatMap((n) => [read(n, "simd", "silent"), read(n, "runner", "answered")]),
		];
		const s = summarize(records);
		expect(s.streaks.map((x) => x.verdict)).toEqual(["unread", "answered"]);
		expect(s.verdict).toBe("witness-answers");
	});

	test("runner startup comes from the notes: ready time, or the failure", () => {
		const ready = summarize([
			{ kind: "note", tMs: 30_000, text: "simd ready (pid 1)" },
			{ kind: "note", tMs: 210_000, text: "runner ready" },
		]);
		expect(ready.runnerStartup).toEqual({ status: "ready", readyMs: 210_000 });

		const failed = summarize([
			read(1, "simd", "silent"),
			{ kind: "note", tMs: 450_000, text: "runner failure: runner not ready after 420 s" },
		]);
		expect(failed.runnerStartup).toEqual({ status: "failed", reason: "runner not ready after 420 s" });
		expect(formatSummary(failed)).toContain("runner never ready: runner not ready after 420 s");

		expect(summarize([read(1, "simd", "answered")]).runnerStartup).toEqual({ status: "unknown" });
	});

	test("busy runner refusals are counted in the streak and the summary text", () => {
		const records = [1, 2, 3].flatMap((n) => [
			read(n, "simd", "silent"),
			read(n, "runner", "silent", n > 1 ? { busy: true } : {}),
		]);
		const s = summarize(records);
		expect(s.streaks[0]?.runner.busy).toBe(2);
		expect(formatSummary(s)).toContain("2 busy");
	});

	test("formatSummary names the verdict", () => {
		const records = [1, 2, 3].flatMap((n) => [read(n, "simd", "silent"), read(n, "runner", "answered")]);
		expect(formatSummary(summarize(records))).toContain("verdict: witness-answers");
	});
});

describe("parsers", () => {
	test("parseJsonl skips blank and torn lines", () => {
		const text = `${JSON.stringify(read(1, "simd", "answered"))}\n\n{"kind":"note","tMs":1,"text":"x"}\n{"kind":"rea`;
		expect(parseJsonl(text).map((r) => r.kind)).toEqual(["read", "note"]);
	});

	test("readyPort reads the port from the ready line", () => {
		expect(readyPort(`2026 WARDEN_RUNNER_READY {"event":"ready","port":8765}`)).toBe(8765);
		expect(readyPort("something else")).toBeUndefined();
	});

	test("pidForLabel finds a launchctl row by label suffix", () => {
		const list = "PID\tStatus\tLabel\n412\t0\tcom.apple.SpringBoard\n-\t0\tcom.apple.other";
		expect(pidForLabel(list, "com.apple.SpringBoard")).toBe(412);
		expect(pidForLabel(list, "com.apple.other")).toBeUndefined();
	});
});

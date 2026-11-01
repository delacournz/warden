import { describe, expect, test } from "bun:test";
import { resultsTesting } from "./results.testing";
import { specProgress } from "./spec-progress";

const specs = ["onboarding", "settings", "sign-in", "todos"].map((id) => ({ id, path: `/app/e2e/${id}.e2e.ts` }));
const file = (id: string) => `/app/e2e/${id}.e2e.ts`;
const identity = (path: string) => path;
const marks = (text: string, final = false) => specProgress.resultsMarks(text, specs, { final, real: identity });

describe("resultsMarks", () => {
	test("a spec is passed once a later result belongs to another file; the last spec waits for the process to end", () => {
		const text = resultsTesting.jsonl(
			resultsTesting.result(file("onboarding"), "welcome"),
			resultsTesting.result(file("onboarding"), "skip"),
			resultsTesting.result(file("settings"), "toggle")
		);
		expect(marks(text)).toEqual({ onboarding: "passed" });
		expect(marks(text, true)).toEqual({ onboarding: "passed", settings: "passed" });
	});

	test("a failed or timed-out test fails its spec at once; a later pass does not undo it", () => {
		const text = resultsTesting.jsonl(
			resultsTesting.result(file("sign-in"), "valid", "passed"),
			resultsTesting.result(file("sign-in"), "invalid", "failed"),
			resultsTesting.result(file("sign-in"), "again", "passed"),
			resultsTesting.result(file("todos"), "slow", "timed-out")
		);
		expect(marks(text)).toEqual({ "sign-in": "failed", todos: "failed" });
	});

	test("skipped tests count as passed once finished; files that are not tracked are ignored", () => {
		const text = resultsTesting.jsonl(
			resultsTesting.result(file("todos"), "later", "skipped"),
			resultsTesting.result("/app/e2e/other.e2e.ts", "x", "failed")
		);
		expect(marks(text, true)).toEqual({ todos: "passed" });
	});

	test("nothing yet, an unparseable file and a truncated last line", () => {
		expect(marks("")).toEqual({});
		expect(marks("not json\n{also not\n", true)).toEqual({});
		const truncated = `${resultsTesting.jsonl(resultsTesting.result(file("onboarding"), "welcome"))}{"file":"${file("settings")}","title":["x"],"sta`;
		expect(marks(truncated, true)).toEqual({ onboarding: "passed" });
	});

	test("a result's file is compared after symlinks are resolved", () => {
		const text = resultsTesting.jsonl(resultsTesting.result("/private/app/e2e/todos.e2e.ts", "t"));
		const real = (path: string) => path.replace(/^\/private/, "");
		expect(specProgress.resultsMarks(text, specs, { final: true, real })).toEqual({ todos: "passed" });
	});
});

describe("specTracker", () => {
	const track = (real = identity) => specProgress.specTracker(specs, real);

	test("results added in pieces give the marks of the whole text at every step", () => {
		const all = [
			resultsTesting.result(file("onboarding"), "welcome"),
			resultsTesting.result(file("settings"), "toggle", "failed"),
			resultsTesting.result("/app/e2e/other.e2e.ts", "x"),
			resultsTesting.result(file("settings"), "again"),
			resultsTesting.result(file("todos"), "add"),
			resultsTesting.result(file("sign-in"), "valid", "timed-out"),
			resultsTesting.result(file("todos"), "later"),
		];
		const tracker = track();
		all.forEach((one, i) => {
			tracker.add([one]);
			for (const final of [false, true])
				expect(tracker.marks(final)).toEqual(marks(resultsTesting.jsonl(...all.slice(0, i + 1)), final));
		});
	});

	test("specOf names the tracked spec of a result, nothing for another file", () => {
		const tracker = track();
		expect(tracker.specOf(resultsTesting.result(file("todos"), "t"))?.id).toBe("todos");
		expect(tracker.specOf(resultsTesting.result("/app/e2e/other.e2e.ts", "t"))).toBeUndefined();
	});

	test("reset forgets every result", () => {
		const tracker = track();
		tracker.add([
			resultsTesting.result(file("onboarding"), "a", "failed"),
			resultsTesting.result(file("settings"), "b"),
		]);
		expect(tracker.marks()).toEqual({ onboarding: "failed" });
		tracker.reset();
		expect(tracker.marks(true)).toEqual({});
		tracker.add([resultsTesting.result(file("todos"), "c")]);
		expect(tracker.marks(true)).toEqual({ todos: "passed" });
	});

	test("a path is resolved once however many results name it", () => {
		const seen: string[] = [];
		const tracker = track((path) => {
			seen.push(path);
			return path;
		});
		const before = seen.length;
		tracker.add(Array.from({ length: 200 }, (_, i) => resultsTesting.result(file("todos"), `t${i}`)));
		expect(seen.length - before).toBe(0);
		tracker.add(Array.from({ length: 200 }, (_, i) => resultsTesting.result("/app/e2e/other.e2e.ts", `t${i}`)));
		expect(seen.length - before).toBe(1);
	});
});

describe("testLine", () => {
	test("✓ / ✗ <spec> › <describe> › <title> (N.NNs)", () => {
		expect(
			specProgress.testLine("todos", resultsTesting.result(file("todos"), "add", "passed", { title: ["list", "add"] }))
		).toBe("✓ todos › list › add (1.25s)");
		expect(specProgress.testLine("todos", resultsTesting.result(file("todos"), "add", "failed"))).toBe(
			"✗ todos › add (1.25s)"
		);
		expect(specProgress.testLine("todos", resultsTesting.result(file("todos"), "add", "timed-out"))).toStartWith("✗ ");
		expect(specProgress.testLine("todos", resultsTesting.result(file("todos"), "add", "skipped"))).toStartWith("- ");
	});
});

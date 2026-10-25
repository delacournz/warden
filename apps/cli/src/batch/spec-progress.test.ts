import { describe, expect, test } from "bun:test";
import { jsonl, result } from "./results.testing";
import { resultsMarks, specTracker, testLine } from "./spec-progress";

const specs = ["onboarding", "settings", "sign-in", "todos"].map((id) => ({ id, path: `/app/e2e/${id}.e2e.ts` }));
const file = (id: string) => `/app/e2e/${id}.e2e.ts`;
const identity = (path: string) => path;
const marks = (text: string, final = false) => resultsMarks(text, specs, { final, real: identity });

describe("resultsMarks", () => {
	test("a spec is passed once a later result belongs to another file; the last spec waits for the process to end", () => {
		const text = jsonl(
			result(file("onboarding"), "welcome"),
			result(file("onboarding"), "skip"),
			result(file("settings"), "toggle")
		);
		expect(marks(text)).toEqual({ onboarding: "passed" });
		expect(marks(text, true)).toEqual({ onboarding: "passed", settings: "passed" });
	});

	test("a failed or timed-out test fails its spec at once; a later pass does not undo it", () => {
		const text = jsonl(
			result(file("sign-in"), "valid", "passed"),
			result(file("sign-in"), "invalid", "failed"),
			result(file("sign-in"), "again", "passed"),
			result(file("todos"), "slow", "timed-out")
		);
		expect(marks(text)).toEqual({ "sign-in": "failed", todos: "failed" });
	});

	test("skipped tests count as passed once finished; files that are not tracked are ignored", () => {
		const text = jsonl(result(file("todos"), "later", "skipped"), result("/app/e2e/other.e2e.ts", "x", "failed"));
		expect(marks(text, true)).toEqual({ todos: "passed" });
	});

	test("nothing yet, an unparseable file and a truncated last line", () => {
		expect(marks("")).toEqual({});
		expect(marks("not json\n{also not\n", true)).toEqual({});
		const truncated = `${jsonl(result(file("onboarding"), "welcome"))}{"file":"${file("settings")}","title":["x"],"sta`;
		expect(marks(truncated, true)).toEqual({ onboarding: "passed" });
	});

	test("a result's file is compared after symlinks are resolved", () => {
		const text = jsonl(result("/private/app/e2e/todos.e2e.ts", "t"));
		const real = (path: string) => path.replace(/^\/private/, "");
		expect(resultsMarks(text, specs, { final: true, real })).toEqual({ todos: "passed" });
	});
});

describe("specTracker", () => {
	const track = (real = identity) => specTracker(specs, real);

	test("results added in pieces give the marks of the whole text at every step", () => {
		const all = [
			result(file("onboarding"), "welcome"),
			result(file("settings"), "toggle", "failed"),
			result("/app/e2e/other.e2e.ts", "x"),
			result(file("settings"), "again"),
			result(file("todos"), "add"),
			result(file("sign-in"), "valid", "timed-out"),
			result(file("todos"), "later"),
		];
		const tracker = track();
		all.forEach((one, i) => {
			tracker.add([one]);
			for (const final of [false, true])
				expect(tracker.marks(final)).toEqual(marks(jsonl(...all.slice(0, i + 1)), final));
		});
	});

	test("specOf names the tracked spec of a result, nothing for another file", () => {
		const tracker = track();
		expect(tracker.specOf(result(file("todos"), "t"))?.id).toBe("todos");
		expect(tracker.specOf(result("/app/e2e/other.e2e.ts", "t"))).toBeUndefined();
	});

	test("reset forgets every result", () => {
		const tracker = track();
		tracker.add([result(file("onboarding"), "a", "failed"), result(file("settings"), "b")]);
		expect(tracker.marks()).toEqual({ onboarding: "failed" });
		tracker.reset();
		expect(tracker.marks(true)).toEqual({});
		tracker.add([result(file("todos"), "c")]);
		expect(tracker.marks(true)).toEqual({ todos: "passed" });
	});

	test("a path is resolved once however many results name it", () => {
		const seen: string[] = [];
		const tracker = track((path) => {
			seen.push(path);
			return path;
		});
		const before = seen.length;
		tracker.add(Array.from({ length: 200 }, (_, i) => result(file("todos"), `t${i}`)));
		expect(seen.length - before).toBe(0);
		tracker.add(Array.from({ length: 200 }, (_, i) => result("/app/e2e/other.e2e.ts", `t${i}`)));
		expect(seen.length - before).toBe(1);
	});
});

describe("testLine", () => {
	test("✓ / ✗ <spec> › <describe> › <title> (N.NNs)", () => {
		expect(testLine("todos", result(file("todos"), "add", "passed", { title: ["list", "add"] }))).toBe(
			"✓ todos › list › add (1.25s)"
		);
		expect(testLine("todos", result(file("todos"), "add", "failed"))).toBe("✗ todos › add (1.25s)");
		expect(testLine("todos", result(file("todos"), "add", "timed-out"))).toStartWith("✗ ");
		expect(testLine("todos", result(file("todos"), "add", "skipped"))).toStartWith("- ");
	});
});

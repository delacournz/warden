import { describe, expect, test } from "bun:test";
import { resultsMarks, testLine } from "./flow-progress";
import { jsonl, result } from "./results.testing";

const flows = ["onboarding", "settings", "sign-in", "todos"].map((id) => ({ id, path: `/app/e2e/${id}.e2e.ts` }));
const file = (id: string) => `/app/e2e/${id}.e2e.ts`;
const identity = (path: string) => path;
const marks = (text: string, final = false) => resultsMarks(text, flows, { final, real: identity });

describe("resultsMarks", () => {
	test("a flow is passed once a later result belongs to another file; the last flow waits for the process to end", () => {
		const text = jsonl(
			result(file("onboarding"), "welcome"),
			result(file("onboarding"), "skip"),
			result(file("settings"), "toggle")
		);
		expect(marks(text)).toEqual({ onboarding: "passed" });
		expect(marks(text, true)).toEqual({ onboarding: "passed", settings: "passed" });
	});

	test("a failed or timed-out test fails its flow at once; a later pass does not undo it", () => {
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
		expect(resultsMarks(text, flows, { final: true, real })).toEqual({ todos: "passed" });
	});
});

describe("testLine", () => {
	test("✓ / ✗ <flow> › <describe> › <title> (N.NNs)", () => {
		expect(testLine("todos", result(file("todos"), "add", "passed", { title: ["list", "add"] }))).toBe(
			"✓ todos › list › add (1.25s)"
		);
		expect(testLine("todos", result(file("todos"), "add", "failed"))).toBe("✗ todos › add (1.25s)");
		expect(testLine("todos", result(file("todos"), "add", "timed-out"))).toStartWith("✗ ");
		expect(testLine("todos", result(file("todos"), "add", "skipped"))).toStartWith("- ");
	});
});

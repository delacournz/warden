import { describe, expect, test } from "bun:test";
import { expandArgv, jobSlug, parseJobLines, parseJobList } from "./expand";

describe("expandArgv", () => {
	test("substitutes {job} {udid} {worker} {seq} in every element, repeatedly", () => {
		expect(
			expandArgv(["run", "--flow={job}", "{udid}", "w{worker}-s{seq}", "{job}/{job}"], {
				job: "qa-login",
				udid: "U1",
				worker: 2,
				seq: 0,
			})
		).toEqual(["run", "--flow=qa-login", "U1", "w2-s0", "qa-login/qa-login"]);
	});

	test("leaves unknown placeholders and literal braces alone", () => {
		expect(expandArgv(["{nope}", "{", "a{b}c"], { job: "j", udid: "u", worker: 0, seq: 1 })).toEqual([
			"{nope}",
			"{",
			"a{b}c",
		]);
	});

	test("a job containing a placeholder is not expanded twice", () => {
		expect(expandArgv(["{job}"], { job: "{udid}", udid: "U", worker: 0, seq: 0 })).toEqual(["{udid}"]);
	});
});

describe("parseJobList", () => {
	test("comma-separated, trimmed, empties dropped", () => {
		expect(parseJobList("a, b,,c ,")).toEqual(["a", "b", "c"]);
		expect(parseJobList("")).toEqual([]);
	});
});

describe("parseJobLines", () => {
	test("one per line, trimmed; blank lines and # comments skipped", () => {
		expect(parseJobLines("a\n  b  \n\n# skip\r\nc\n")).toEqual(["a", "b", "c"]);
		expect(parseJobLines("")).toEqual([]);
	});
});

describe("jobSlug", () => {
	test("filesystem-safe, lowercase, bounded", () => {
		expect(jobSlug("QA Login/Flow #2")).toBe("qa-login-flow-2");
		expect(jobSlug("../../etc")).toBe("etc");
		expect(jobSlug("***")).toBe("job");
		expect(jobSlug("x".repeat(200))).toHaveLength(60);
	});
});

import { describe, expect, test } from "bun:test";
import { batchJobs } from "./expand";

describe("expandArgv", () => {
	test("substitutes {job} {udid} {worker} {seq} in every element, repeatedly", () => {
		expect(
			batchJobs.expandArgv(["run", "--spec={job}", "{udid}", "w{worker}-s{seq}", "{job}/{job}"], {
				job: "qa-login",
				udid: "U1",
				worker: 2,
				seq: 0,
			})
		).toEqual(["run", "--spec=qa-login", "U1", "w2-s0", "qa-login/qa-login"]);
	});

	test("run placeholders ({port} {metroUrl} {leg}) are substituted once known, kept until then", () => {
		const vars = { job: "j", udid: "u", worker: 0, seq: 0 };
		expect(batchJobs.expandArgv(["{port}", "{metroUrl}", "{leg}"], vars)).toEqual(["{port}", "{metroUrl}", "{leg}"]);
		expect(
			batchJobs.expandArgv(["--port={port}", "{metroUrl}/status", "{leg}"], {
				...vars,
				port: 8090,
				metroUrl: "http://127.0.0.1:8090",
				leg: "ipad",
			})
		).toEqual(["--port=8090", "http://127.0.0.1:8090/status", "ipad"]);
		expect(batchJobs.expand("tcp:{port}", { port: 3000 })).toBe("tcp:3000");
	});

	test("leaves unknown placeholders and literal braces alone", () => {
		expect(batchJobs.expandArgv(["{nope}", "{", "a{b}c"], { job: "j", udid: "u", worker: 0, seq: 1 })).toEqual([
			"{nope}",
			"{",
			"a{b}c",
		]);
	});

	test("a job containing a placeholder is not expanded twice", () => {
		expect(batchJobs.expandArgv(["{job}"], { job: "{udid}", udid: "U", worker: 0, seq: 0 })).toEqual(["{udid}"]);
	});
});

describe("parseJobList", () => {
	test("comma-separated, trimmed, empties dropped", () => {
		expect(batchJobs.parseList("a, b,,c ,")).toEqual(["a", "b", "c"]);
		expect(batchJobs.parseList("")).toEqual([]);
	});
});

describe("parseJobLines", () => {
	test("one per line, trimmed; blank lines and # comments skipped", () => {
		expect(batchJobs.parseLines("a\n  b  \n\n# skip\r\nc\n")).toEqual(["a", "b", "c"]);
		expect(batchJobs.parseLines("")).toEqual([]);
	});
});

describe("jobSlug", () => {
	test("filesystem-safe, lowercase, bounded", () => {
		expect(batchJobs.slug("QA Login/Spec #2")).toBe("qa-login-spec-2");
		expect(batchJobs.slug("../../etc")).toBe("etc");
		expect(batchJobs.slug("***")).toBe("job");
		expect(batchJobs.slug("x".repeat(200))).toHaveLength(60);
	});
});

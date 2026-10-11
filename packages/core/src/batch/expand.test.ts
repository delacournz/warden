import { describe, expect, test } from "bun:test";
import { expandArgv, expandText, jobSlug, parseJobLines, parseJobList } from "./expand";

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

	test("run placeholders ({port} {metroUrl} {stateDir} {leg}) are substituted once known, kept until then", () => {
		const vars = { job: "j", udid: "u", worker: 0, seq: 0 };
		expect(expandArgv(["{port}", "{metroUrl}", "{stateDir}", "{leg}"], vars)).toEqual([
			"{port}",
			"{metroUrl}",
			"{stateDir}",
			"{leg}",
		]);
		expect(
			expandArgv(["--port={port}", "{metroUrl}/status", "{stateDir}", "{leg}"], {
				...vars,
				port: 8090,
				metroUrl: "http://127.0.0.1:8090",
				stateDir: "/b/agent-device/0",
				leg: "ipad",
			})
		).toEqual(["--port=8090", "http://127.0.0.1:8090/status", "/b/agent-device/0", "ipad"]);
		expect(expandText("tcp:{port}", { port: 3000 })).toBe("tcp:3000");
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

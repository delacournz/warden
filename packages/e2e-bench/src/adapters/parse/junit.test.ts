import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJunit } from "./junit";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "../fixtures/junit", name), "utf8");

describe("parseJunit", () => {
	test("reads a real run: names, seconds to ms, status", () => {
		const r = parseJunit(fixture("junit-pass.xml"));
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data).toHaveLength(8);
		const settings = r.data.find((c) => c.name === "settings-account-switches-sign-out");
		expect(settings).toEqual({
			name: "settings-account-switches-sign-out",
			classname: "settings-account-switches-sign-out",
			durationMs: expect.any(Number),
			status: "passed",
		});
		expect(settings?.durationMs).toBeGreaterThan(1000);
		expect(r.data.every((c) => c.status === "passed")).toBe(true);
	});

	test("failure child becomes status failed with its message", () => {
		const r = parseJunit(fixture("junit-fail.xml"));
		expect(r.success).toBe(true);
		if (!r.success) return;
		const failedCases = r.data.filter((c) => c.status === "failed");
		expect(failedCases).toHaveLength(4);
		expect(failedCases.find((c) => c.name === "sign-in-valid-credentials")?.error).toBe(
			'Assertion is false: "1 left", id: todos-remaining is visible'
		);
	});

	test("time is seconds with decimals", () => {
		const r = parseJunit('<testsuites><testsuite><testcase name="a" time="1.234"/></testsuite></testsuites>');
		expect(r).toEqual({ success: true, data: [{ name: "a", durationMs: 1234, status: "passed" }] });
	});

	test("error element, skipped element, entities and CDATA", () => {
		const xml = `<testsuite>
<testcase name="e" classname="c" time="2"><error message="boom &amp; &lt;bust&gt;"/></testcase>
<testcase name="s" time="0"><skipped/></testcase>
<testcase name="b" time="1"><failure><![CDATA[line1
line2]]></failure></testcase>
</testsuite>`;
		const r = parseJunit(xml);
		expect(r).toEqual({
			success: true,
			data: [
				{ name: "e", classname: "c", durationMs: 2000, status: "failed", error: "boom & <bust>" },
				{ name: "s", durationMs: 0, status: "skipped" },
				{ name: "b", durationMs: 1000, status: "failed", error: "line1\nline2" },
			],
		});
	});

	test("no testcase elements is an error", () => {
		expect(parseJunit("<testsuites/>").success).toBe(false);
		expect(parseJunit("not xml").success).toBe(false);
	});
});

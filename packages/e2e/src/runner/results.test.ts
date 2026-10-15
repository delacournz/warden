import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openResults, readResults, type TestResult } from "./results";

const dirs: string[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "wdn-results-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const result = (title: string, status: TestResult["status"] = "passed"): TestResult => ({
	file: "/app/e2e/a.e2e.ts",
	title: ["suite", title],
	status,
	durationMs: 12,
	startedAt: 1_760_000_000_000,
	device: { udid: "U1", platform: "ios" },
});

describe("results.jsonl", () => {
	test("append writes one line per result, creating the directory", () => {
		const path = join(tmp(), "nested", "results.jsonl");
		const writer = openResults(path);
		writer.append(result("one"));
		writer.append(result("two", "failed"));
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(readResults(readFileSync(path, "utf8")).map((r) => [r.title[1], r.status])).toEqual([
			["one", "passed"],
			["two", "failed"],
		]);
	});

	test("appends to an existing file", () => {
		const path = join(tmp(), "results.jsonl");
		openResults(path).append(result("one"));
		openResults(path).append(result("two"));
		expect(readResults(readFileSync(path, "utf8"))).toHaveLength(2);
	});

	test("a truncated last line is ignored", () => {
		const full = `${JSON.stringify(result("one"))}\n`;
		const cut = JSON.stringify(result("two")).slice(0, 30);
		expect(readResults(full + cut).map((r) => r.title[1])).toEqual(["one"]);
	});

	test("blank and invalid lines are skipped", () => {
		const text = `\n${JSON.stringify(result("one"))}\n{"status":"nope"}\nnot json\n${JSON.stringify(result("two"))}\n`;
		expect(readResults(text).map((r) => r.title[1])).toEqual(["one", "two"]);
	});

	test("optional fields round-trip", () => {
		const path = join(tmp(), "results.jsonl");
		const full: TestResult = {
			...result("x", "timed-out"),
			only: true,
			error: { message: "boom", code: "TIMEOUT" },
			artifacts: { dir: "/o/a/x-abc123", files: ["failure.png"] },
		};
		openResults(path).append(full);
		appendFileSync(path, "");
		expect(readResults(readFileSync(path, "utf8"))).toEqual([full]);
	});
});

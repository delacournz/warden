import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { jsonl } from "../batch/results.testing";
import type { E2eEvent } from "../e2e/report-output";
import { type Harness, harness } from "./batch.testing";
import { createE2eCommand } from "./e2e";
import { dir, resultsPath, setup, spec, useE2eFixture } from "./e2e.testing";

useE2eFixture();

/** a stack through warden's own code into the spec file, line 22 (`dir` is set per test) */
const stack = (): string =>
	[
		"E2eError: snapshot failed: no frontmost application",
		"    at <anonymous> (/x/node_modules/@delacour/warden-e2e/chunk.mjs:1760:30)",
		`    at <anonymous> (${join(dir, "specs/chats.e2e.ts")}:22:11)`,
	].join("\n");

/** a harness whose job writes one passed and one failed `chats` test and exits 1 */
const failing = (): Harness => {
	const h: Harness = harness({
		exitCodeFor: (env) => {
			if (env.WARDEN_E2E_OUT)
				h.files.set(
					resultsPath(env),
					jsonl(
						spec("chats", "opens", "passed"),
						spec("chats", "sends", "failed", { error: { message: "snapshot failed: x", stack: stack() } })
					)
				);
			return 1;
		},
	});
	return h;
};

const events = (stdout: readonly string[]): E2eEvent[] =>
	stdout
		.join("")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as E2eEvent);

describe("warden e2e output", () => {
	test("--json-lines: one test event per finished test, then the report, and nothing else on stdout", async () => {
		const c = setup(["--files", "src/chat/lazy.tsx", "--json-lines"]);
		expect(await createE2eCommand(failing().deps).run(c)).toBe(1);
		const out = events(c.stdout);
		expect(out.map((e) => e.event)).toEqual(["test", "test", "report"]);
		expect(out[1]).toMatchObject({ event: "test", spec: "chats", title: ["sends"], status: "failed", line: 22 });
		const last = out[2];
		expect(last?.event === "report" && last.report.ok).toBe(false);
	});

	test("the verdict prints test totals, the shared error and where the evidence is", async () => {
		const c = setup(["--files", "src/chat/lazy.tsx"]);
		expect(await createE2eCommand(failing().deps).run(c)).toBe(1);
		const text = c.stderr.join("\n");
		expect(text).toContain("warden e2e: tests 1 passed · 1 failed · 0 skipped");
		expect(text).toContain("warden e2e: evidence in ");
		expect(text).toContain("0/1 spec(s) passed — gate failed");
	});

	test("a spec that passed on its retry prints what its first attempt met, dimmed", async () => {
		const c = setup(["--files", "src/chat/lazy.tsx", "--retry", "1"]);
		let attempt = 0;
		const h: Harness = harness({
			exitCodeFor: (env) => {
				attempt += 1;
				if (env.WARDEN_E2E_OUT)
					h.files.set(
						resultsPath(env),
						attempt === 1
							? jsonl(spec("chats", "sends", "failed", { error: { message: "snapshot failed: x", stack: stack() } }))
							: jsonl(spec("chats", "sends", "passed"))
					);
				return attempt === 1 ? 1 : 0;
			},
		});
		expect(await createE2eCommand(h.deps).run(c)).toBe(0);
		const text = c.stderr.join("\n");
		expect(text).toContain("warden e2e: chats passed on attempt 2 — attempt 1 on ");
		expect(text).toContain(": sends — snapshot failed: x — log ");
		expect(text).toContain("1/1 spec(s) passed — gate passed");
	});

	test("under GitHub Actions: an ::error at the spec line, and the table appended to the step summary", async () => {
		const c = setup(["--files", "src/chat/lazy.tsx"]);
		const summary = join(dir, "summary.md");
		c.env = { ...c.env, GITHUB_ACTIONS: "true", GITHUB_WORKSPACE: dir, GITHUB_STEP_SUMMARY: summary };
		const h = failing();
		h.files.set(summary, "earlier step\n");
		expect(await createE2eCommand(h.deps).run(c)).toBe(1);
		expect(c.stdout.join("")).toContain(
			"::error file=specs/chats.e2e.ts,line=22,title=chats › sends::snapshot failed: x"
		);
		const md = h.files.get(summary) ?? "";
		expect(md.startsWith("earlier step\n### ❌ warden e2e `mobile` (ios): gate failed")).toBe(true);
		expect(md).toContain("| ❌ | chats | sends |");
	});

	test("under GitHub Actions with --json: stdout stays one JSON document, annotations go to stderr", async () => {
		const c = setup(["--files", "src/chat/lazy.tsx", "--json"]);
		c.env = { ...c.env, GITHUB_ACTIONS: "true", GITHUB_WORKSPACE: dir };
		expect(await createE2eCommand(failing().deps).run(c)).toBe(1);
		expect(() => JSON.parse(c.stdout.join(""))).not.toThrow();
		expect(c.stderr.join("\n")).toContain("::error file=specs/chats.e2e.ts,line=22");
	});

	test("outside GitHub Actions: no annotations", async () => {
		const c = setup(["--files", "src/chat/lazy.tsx"]);
		expect(await createE2eCommand(failing().deps).run(c)).toBe(1);
		expect([...c.stdout, ...c.stderr].join("\n")).not.toContain("::error");
	});
});

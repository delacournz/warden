import { describe, expect, test } from "bun:test";
import { FINDING_KINDS, type Finding, SEVERITY_ORDER } from "./findings.types";

describe("Finding", () => {
	test("narrows by kind", () => {
		const f: Finding = {
			kind: "slow-commit",
			severity: "critical",
			costMs: 180,
			evidence: "commit #14 took 180ms",
			fix: "memoize the list rows",
			next: ["warden perf query <id> commits"],
			commitIndex: 14,
		};
		if (f.kind === "slow-commit") expect(f.commitIndex).toBe(14);
		expect(FINDING_KINDS).toContain("slow-commit");
	});

	test("severity order ranks critical first", () => {
		expect(SEVERITY_ORDER.critical).toBeLessThan(SEVERITY_ORDER.warn);
		expect(SEVERITY_ORDER.warn).toBeLessThan(SEVERITY_ORDER.info);
	});
});

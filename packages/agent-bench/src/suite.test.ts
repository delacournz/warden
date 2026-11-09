import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSuites, loadSuite, renderPrompt, SUITES_DIR } from "./suite";
import { DEFAULT_MODEL } from "./suite.schema";

function suiteDir(yml: string, prompt = "Drive {{bundleId}} on {{platform}} {{udid}}."): string {
	const dir = mkdtempSync(join(tmpdir(), "agent-bench-suite-"));
	writeFileSync(join(dir, "s.yml"), yml);
	writeFileSync(join(dir, "s.md"), prompt);
	return dir;
}

const MINIMAL = `
name: s
description: one suite
prompt: s.md
allowedTools: ["Bash(warden *)", Skill]
maxTurns: 10
success:
  - wait: id=todos-screen
`;

describe("loadSuite", () => {
	test("fills the defaults and reads the prompt next to the suite", () => {
		const dir = suiteDir(MINIMAL);
		const loaded = loadSuite(join(dir, "s.yml"));
		expect(loaded.success).toBe(true);
		if (!loaded.success) return;
		expect(loaded.data.suite.model).toBe(DEFAULT_MODEL);
		expect(loaded.data.suite.platform).toBe("ios");
		expect(loaded.data.suite.app).toBe("example");
		expect(loaded.data.suite.failurePatterns).toEqual([]);
		expect(loaded.data.promptTemplate).toContain("{{udid}}");
	});

	test("rejects an unknown key", () => {
		const dir = suiteDir(`${MINIMAL}\nmaxTurn: 3\n`);
		const loaded = loadSuite(join(dir, "s.yml"));
		expect(loaded.success).toBe(false);
	});

	test("rejects a missing prompt file", () => {
		const dir = suiteDir(MINIMAL.replace("s.md", "nope.md"));
		const loaded = loadSuite(join(dir, "s.yml"));
		expect(loaded.success).toBe(false);
		if (!loaded.success) expect(String(loaded.error)).toContain("nope.md");
	});

	test("rejects an is check without a known state", () => {
		const dir = suiteDir(MINIMAL.replace("  - wait: id=todos-screen", "  - is: id=x\n    state: pressed"));
		expect(loadSuite(join(dir, "s.yml")).success).toBe(false);
	});
});

describe("renderPrompt", () => {
	test("fills every placeholder", () => {
		expect(
			renderPrompt("{{bundleId}} {{platform}} {{udid}} {{udid}}", { udid: "U", platform: "ios", bundleId: "b" })
		).toBe("b ios U U");
	});
});

describe("the committed suites", () => {
	test("every suite file loads and names itself after its file", () => {
		const names = listSuites();
		expect(names.length).toBeGreaterThanOrEqual(3);
		for (const name of names) {
			const loaded = loadSuite(join(SUITES_DIR, `${name}.yml`));
			if (!loaded.success) throw new Error(`${name}: ${String(loaded.error)}`);
			expect(loaded.data.suite.name).toBe(name);
		}
		expect(readdirSync(SUITES_DIR).filter((f) => f.endsWith(".yml"))).toHaveLength(names.length);
	});
});

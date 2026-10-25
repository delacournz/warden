import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Drift guard for the release pipeline's workflow files: which branch or tag each one reacts to, and
 * that every third-party action is pinned to a full commit SHA. A trigger that widens by accident
 * (promote on every branch, release on a plain push) or a floating `@v4` is a supply-chain or
 * publish-safety regression, so it fails here rather than in review.
 */
const ROOT = join(import.meta.dir, "..", "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

type Trigger = { branches?: string[]; tags?: string[] } | null;
type Workflow = { on: Record<string, Trigger> };

async function load(file: string): Promise<{ text: string; workflow: Workflow }> {
	const text = await Bun.file(join(WORKFLOWS, file)).text();
	return { text, workflow: Bun.YAML.parse(text) as Workflow };
}

describe("workflow triggers", () => {
	for (const file of ["version.yml", "promote.yml"]) {
		test(`${file} runs on pushes to develop only`, async () => {
			const { workflow } = await load(file);
			expect(Object.keys(workflow.on)).toEqual(["push"]);
			expect(workflow.on.push?.branches).toEqual(["develop"]);
			expect(workflow.on.push?.tags).toBeUndefined();
		});
	}

	test("release.yml runs on v* tags only", async () => {
		const { workflow } = await load("release.yml");
		expect(Object.keys(workflow.on)).toEqual(["push"]);
		expect(workflow.on.push?.tags).toEqual(["v*"]);
		expect(workflow.on.push?.branches).toBeUndefined();
	});

	test("ci.yml is workflow_dispatch only", async () => {
		const { workflow } = await load("ci.yml");
		expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
	});
});

describe("action pins", () => {
	const files = readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file));

	test("there are workflows to check", () => {
		expect(files).toContain("version.yml");
		expect(files).toContain("promote.yml");
	});

	for (const file of files) {
		test(`${file}: every uses: is a full commit SHA with a version comment`, async () => {
			const { text } = await load(file);
			const uses = text.split("\n").filter((line) => /^\s*-?\s*uses:/.test(line));
			for (const line of uses) {
				const target = line.replace(/^\s*-?\s*uses:\s*/, "");
				if (target.startsWith("./")) continue;
				expect(target).toMatch(/@[0-9a-f]{40} # v\d/);
			}
		});
	}
});

describe("pipeline wiring", () => {
	test("ci.yml diffs native changes against develop", async () => {
		const { text } = await load("ci.yml");
		expect(text).toContain("compare/develop...$SHA");
		expect(text).not.toContain("compare/main...");
	});

	test("release.yml refuses a tag that is not on main", async () => {
		const { text } = await load("release.yml");
		expect(text).toContain("merge-base --is-ancestor");
		expect(text).toContain("origin/main");
	});
});

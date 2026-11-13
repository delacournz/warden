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

describe("release.yml publish order", () => {
	type Step = { name?: string; run?: string };
	async function publishSteps(): Promise<Step[]> {
		const text = await Bun.file(join(WORKFLOWS, "release.yml")).text();
		const parsed = Bun.YAML.parse(text) as { jobs: { publish: { steps: Step[] } } };
		return parsed.jobs.publish.steps;
	}

	test("the GitHub release (with the ATF jar asset) goes up before npm, and the run waits until npm serves", async () => {
		const names = (await publishSteps()).map((step) => step.name ?? "");
		const release = names.indexOf("Publish GitHub release");
		const npm = names.indexOf("Publish to npm");
		const wait = names.indexOf("Wait until npm serves every package");
		expect(release).toBeGreaterThanOrEqual(0);
		expect(npm).toBeGreaterThan(release);
		expect(wait).toBeGreaterThan(npm);
	});

	test("the wait asks the registry, not npm's metadata cache", async () => {
		const wait = (await publishSteps()).find((step) => step.name === "Wait until npm serves every package");
		expect(wait?.run).toContain("--prefer-online");
		expect(wait?.run).toContain("dist/npm/warden-e2e/");
	});
});

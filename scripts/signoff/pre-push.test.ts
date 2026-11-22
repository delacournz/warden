import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { prePushArgv } from "./pre-push";
import { SIGNOFF_CHECKS, type SignoffCheck } from "./signoff-checks";

const ROOT = join(import.meta.dir, "..", "..");

describe("prePushArgv", () => {
	test("runs every always-on signoff check's turbo task in one turbo invocation", () => {
		expect(prePushArgv(SIGNOFF_CHECKS)).toEqual(["bunx", "turbo", "run", "typecheck", "check", "test"]);
	});

	test("an always-on check that is not a turbo task is refused, so the hook never quietly checks less", () => {
		const extra: SignoffCheck = {
			context: "x",
			label: "x",
			always: true,
			paths: [],
			workflow: "ci.yml",
			run: [{ argv: ["sh", "-c", "true"] }],
		};
		expect(() => prePushArgv([...SIGNOFF_CHECKS, extra])).toThrow("x");
	});

	test("path-gated checks stay out: pre-push has no diff base", () => {
		const argv = prePushArgv(SIGNOFF_CHECKS);
		expect(argv).not.toContain("native");
		expect(argv).not.toContain("cpu-guard");
	});
});

describe("the pre-push hook", () => {
	test(".pre-commit-config.yaml runs this script at pre-push", async () => {
		const config = Bun.YAML.parse(await Bun.file(join(ROOT, ".pre-commit-config.yaml")).text()) as {
			default_install_hook_types?: string[];
			repos: { hooks: { id: string; entry: string; stages: string[] }[] }[];
		};
		// `prek install` installs only pre-commit by default: a pre-push stage it never installs never runs.
		expect(config.default_install_hook_types).toEqual(["pre-commit", "pre-push"]);
		const hooks = config.repos.flatMap((repo) => repo.hooks).filter((hook) => hook.stages.includes("pre-push"));
		expect(hooks.map((hook) => hook.entry)).toEqual(["bun scripts/signoff/pre-push.ts"]);
	});
});

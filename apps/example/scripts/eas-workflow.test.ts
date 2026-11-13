import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import config from "../warden.config";

/**
 * Guards `.eas/workflows/e2e.yml` against drifting from what it runs: the EAS build profile it reuses must be one
 * `warden builds import --kind simulator-base` accepts (a Release simulator build, no dev client), the suite it runs
 * must exist in `warden.config.ts`, and the runner script it calls must be there and executable.
 */

const APP_DIR = join(import.meta.dir, "..");

/** An EAS workflow expression, `${{ inner }}`, as the YAML holds it. */
const expr = (inner: string): string => `\${{ ${inner} }}`;

type WorkflowInput = { type: string; default?: string | number | boolean; options?: string[] };
type WorkflowStep = { uses?: string; run?: string; with?: Record<string, unknown>; if?: string; id?: string };
type WorkflowJob = {
	type?: string;
	needs?: string[];
	after?: string[];
	if?: string;
	runs_on?: string;
	environment?: string;
	env?: Record<string, string>;
	params?: Record<string, string>;
	steps?: WorkflowStep[];
};
type Workflow = {
	on: { workflow_dispatch: { inputs: Record<string, WorkflowInput> } };
	jobs: Record<string, WorkflowJob>;
};
type EasProfile = {
	developmentClient?: boolean;
	ios?: { simulator?: boolean; buildConfiguration?: string };
	environment?: string;
};
type EasJson = { build: Record<string, EasProfile> };

async function loadWorkflow(): Promise<Workflow> {
	return Bun.YAML.parse(await Bun.file(join(APP_DIR, ".eas/workflows/e2e.yml")).text()) as Workflow;
}

async function loadEasJson(): Promise<EasJson> {
	return (await Bun.file(join(APP_DIR, "eas.json")).json()) as EasJson;
}

function job(workflow: Workflow, id: string): WorkflowJob {
	const found = workflow.jobs[id];
	if (!found) throw new Error(`e2e.yml has no job ${id}`);
	return found;
}

describe("EAS e2e workflow", () => {
	test("reuses a build for the fingerprint and builds only on a miss", async () => {
		const workflow = await loadWorkflow();
		expect(job(workflow, "fingerprint").type).toBe("fingerprint");

		const get = job(workflow, "get_ios_build");
		expect(get.type).toBe("get-build");
		expect(get.params?.fingerprint_hash).toContain("needs.fingerprint.outputs.ios_fingerprint_hash");
		expect(get.params?.profile).toBe(expr("inputs.profile"));

		const build = job(workflow, "build_ios");
		expect(build.type).toBe("build");
		expect(build.needs).toEqual(["get_ios_build"]);
		expect(build.if).toContain("!needs.get_ios_build.outputs.build_id");
		expect(build.params?.profile).toBe(expr("inputs.profile"));
	});

	test("default profile is a build `builds import --kind simulator-base` accepts", async () => {
		const workflow = await loadWorkflow();
		const profileName = workflow.on.workflow_dispatch.inputs.profile?.default;
		expect(typeof profileName).toBe("string");
		const profile = (await loadEasJson()).build[String(profileName)];
		expect(profile).toBeDefined();
		expect(profile?.ios?.simulator).toBe(true);
		expect(profile?.ios?.buildConfiguration).toBe("Release");
		expect(profile?.developmentClient).toBe(false);
	});

	test("e2e job runs on a macOS worker with the reused or fresh build", async () => {
		const workflow = await loadWorkflow();
		const e2e = job(workflow, "e2e_ios");
		expect(e2e.runs_on).toMatch(/^macos-/);
		expect(e2e.after).toEqual(["get_ios_build", "build_ios"]);
		expect(e2e.if).toContain("needs.get_ios_build.outputs.build_id || needs.build_ios.outputs.build_id");
		// bun install needs NPM_TOKEN (@delacournz/* on GitHub Packages), an EAS secret in this environment.
		expect(e2e.environment).toBe("preview");

		const download = e2e.steps?.find((step) => step.uses === "eas/download_build");
		expect(download?.with?.build_id).toBe(
			expr("needs.get_ios_build.outputs.build_id || needs.build_ios.outputs.build_id")
		);
		expect(download?.with?.extensions).toEqual(["app"]);

		const upload = e2e.steps?.find((step) => step.uses === "eas/upload_artifact");
		expect(upload?.if).toBe(expr("always()"));
	});

	test("default suite exists in warden.config.ts", async () => {
		const workflow = await loadWorkflow();
		const suite = workflow.on.workflow_dispatch.inputs.suite?.default;
		expect(Object.keys(config.e2e ?? {})).toContain(String(suite));
	});

	test("installs warden at the spec API's version and caches it per version", async () => {
		const steps = job(await loadWorkflow(), "e2e_ios").steps ?? [];
		const pick = steps.find((step) => step.id === "warden");
		expect(pick?.run).toContain("@delacour/warden-e2e/package.json");

		const key = `warden-cli-darwin-arm64-${expr("steps.warden.outputs.version")}`;
		const restore = steps.find((step) => step.uses === "eas/restore_cache");
		const save = steps.find((step) => step.uses === "eas/save_cache");
		expect(restore?.with?.key).toBe(key);
		expect(save?.with?.key).toBe(key);
		expect(save?.with?.path).toBe(restore?.with?.path);
		expect(save?.if).toBe(expr(`steps.${restore?.id}.outputs.cache_hit != 'true'`));

		const install = steps.find((step) => step.run?.includes("npm install --global"));
		expect(install?.run).toContain(`@delacour/warden@${expr("steps.warden.outputs.version")}`);
		// The native bin dir, not npm's bin/warden link: eas/save_cache restores that link as a copy.
		expect(install?.run).toContain("@delacour/warden-darwin-arm64/bin");
		expect(install?.run).toContain('set-env PATH "$BIN:$PATH"');
	});

	test("runs warden directly: import the EAS build, then the specs", async () => {
		const runs = (job(await loadWorkflow(), "e2e_ios").steps ?? []).flatMap((step) => (step.run ? [step.run] : []));
		const at = (needle: string) => runs.findIndex((run) => run.includes(needle));
		expect(at("warden builds import")).toBeGreaterThan(-1);
		expect(runs[at("warden builds import")]).toContain("--kind simulator-base");
		// `--build-only` is not in a released warden yet; `warden e2e` repacks on its own.
		expect(at("--build-only")).toBe(-1);
		expect(at("--report")).toBeGreaterThan(at("warden builds import"));
		expect(runs.some((run) => run.includes(".sh"))).toBe(false);
	});

	test("the reused profile pulls env vars from the same EAS environment as the e2e job", async () => {
		const workflow = await loadWorkflow();
		const profileName = String(workflow.on.workflow_dispatch.inputs.profile?.default);
		const profile = (await loadEasJson()).build[profileName];
		expect(profile?.environment).toBe(job(workflow, "e2e_ios").environment);
	});
});

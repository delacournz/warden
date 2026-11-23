import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Guards for what the repo's automation trusts: text a job prints is never read as a workflow command, a dispatch
 * input is checked before it reaches the environment or an API path, a pull request from a fork gets no registry
 * token, images and installers are pinned, and no workspace can be published by accident.
 */
const ROOT = join(import.meta.dir, "..", "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const EAS_WORKFLOWS = join(ROOT, "apps", "example", ".eas", "workflows");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

/** Each script run spawns bash plus a few tools: seconds on a loaded runner. */
setDefaultTimeout(30_000);

type Step = { name?: string; id?: string; run?: string; env?: Record<string, string> };
type Job = { if?: string; permissions?: Record<string, string>; env?: Record<string, string>; steps: Step[] };
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

function read(...path: string[]): string {
	return readFileSync(join(ROOT, ...path), "utf8");
}

function workflow(dir: string, file: string): Workflow {
	return Bun.YAML.parse(readFileSync(join(dir, file), "utf8")) as Workflow;
}

function stepNamed(job: Job | undefined, name: string): Step {
	const step = job?.steps.find((candidate) => candidate.name === name);
	if (!step) throw new Error(`no step named ${name}`);
	return step;
}

type Ran = { code: number; stdout: string; stderr: string };

function bash(script: string, env: Record<string, string>): Ran {
	const ran = Bun.spawnSync([BASH, "-e", "-c", script], { env, stdout: "pipe", stderr: "pipe" });
	return { code: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
}

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "warden-hardening-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("e2e action evidence", () => {
	const SCRIPT = join(ROOT, ".github", "actions", "e2e", "evidence.sh");

	/** The lines of `stdout` between a `::stop-commands::<token>` line and its `::<token>::` line. */
	function disarmed(stdout: string): string[] {
		const inside: string[] = [];
		let token: string | undefined;
		for (const line of stdout.split("\n")) {
			if (token === undefined) {
				const stop = /^::stop-commands::(.+)$/.exec(line);
				if (stop) token = stop[1];
			} else if (line === `::${token}::`) {
				token = undefined;
			} else {
				inside.push(line);
			}
		}
		return inside;
	}

	function run(): Ran {
		const ran = Bun.spawnSync([BASH, SCRIPT], {
			env: { HOME: tmp, PATH: process.env.PATH ?? "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		return { code: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
	}

	test("a screen and a log tail are printed with workflow commands switched off", () => {
		const batch = join(tmp, ".warden", "batches", "b1");
		mkdirSync(join(batch, "logs"), { recursive: true });
		writeFileSync(join(batch, "screen-at-failure.txt"), "Sign in\n::error::from the screen\n");
		writeFileSync(join(batch, "logs", "app.log"), "booted\n::add-mask::from the log\n");

		const { code, stdout } = run();
		expect(code).toBe(0);
		const inside = disarmed(stdout);
		expect(inside).toContain("::error::from the screen");
		expect(inside).toContain("::add-mask::from the log");
		// every command line the script itself prints is a group marker or a stop/resume pair
		const outside = stdout.split("\n").filter((line) => line.startsWith("::") && !inside.includes(line));
		for (const line of outside) {
			expect(line).toMatch(/^::(group::.*|endgroup::|stop-commands::warden-.+|warden-.+::)$/);
		}
	});

	test("each file gets its own unguessable token", () => {
		const batch = join(tmp, ".warden", "batches", "b1");
		mkdirSync(join(batch, "logs"), { recursive: true });
		writeFileSync(join(batch, "screen-at-failure.txt"), "one\n");
		writeFileSync(join(batch, "logs", "app.log"), "two\n");

		const tokens = [...run().stdout.matchAll(/^::stop-commands::(.+)$/gm)].map((match) => match[1] ?? "");
		expect(tokens).toHaveLength(2);
		expect(new Set(tokens).size).toBe(2);
		for (const token of tokens) expect(token).toMatch(/^warden-[0-9A-Fa-f-]{36}$/);
	});
});

describe("ci.yml signoff-sha", () => {
	const validate = workflow(WORKFLOWS, "ci.yml").jobs.validate;
	const script = validate?.steps[0]?.run ?? "";

	/**
	 * Runs the validate step against a stub `gh` that answers the pulls lookup with `pulls`. Its first `failures`
	 * calls exit 1 with nothing on stdout, as an API error does.
	 */
	function run(sha: string, pulls: string, failures = 0): Ran & { asked: string } {
		const bin = join(tmp, "bin");
		mkdirSync(bin, { recursive: true });
		rmSync(join(tmp, "asked"), { force: true });
		const asked = join(tmp, "asked");
		writeFileSync(
			join(bin, "gh"),
			`#!/bin/sh\nprintf '%s\\n' "$*" >> "${asked}"\nif [ "$(wc -l < "${asked}")" -le ${failures} ]; then echo "HTTP 502" >&2; exit 1; fi\ncat <<'JSON' | jq -r "$5"\n${pulls}\nJSON\n`
		);
		chmodSync(join(bin, "gh"), 0o755);
		writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(bin, "sleep"), 0o755);
		const ran = bash(script, {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			SHA: sha,
			GITHUB_REPOSITORY: "o/r",
			GH_TOKEN: "t",
		});
		return { ...ran, asked: existsSync(asked) ? readFileSync(asked, "utf8") : "" };
	}

	const SHA = "a".repeat(40);
	const pull = (over: { state?: string; base?: string; head?: string }) =>
		JSON.stringify([
			{ state: over.state ?? "open", base: { ref: over.base ?? "develop" }, head: { sha: over.head ?? SHA } },
		]);

	test("the head of an open pull request passes, whatever its base: a stacked pull request is signed off too", () => {
		for (const base of ["develop", "feature/parent-of-a-stack"]) {
			const stacked = run(SHA, pull({ base }));
			expect(stacked.stderr).toBe("");
			expect(stacked.code).toBe(0);
		}
		const ran = run(SHA, pull({}));
		// the repo's open pull requests, every page: a head that lives in a fork is listed there too
		expect(ran.asked).toContain("--paginate repos/o/r/pulls?state=open&per_page=100");
		expect(ran.asked.trim().split("\n")).toHaveLength(1);
	});

	test("anything but 40 hex characters is refused before the API is asked", () => {
		for (const sha of ["abc", `${SHA}0`, `${SHA}\nx`, `x\n${SHA}`, `${"a".repeat(39)}/`]) {
			const ran = run(sha, pull({}));
			expect(ran.code).not.toBe(0);
			expect(ran.asked).toBe("");
		}
	});

	test("a commit that heads no open pull request is refused", () => {
		const cases = [
			"[]",
			pull({ state: "closed" }),
			// in the pull request, but no longer its head
			pull({ head: "b".repeat(40) }),
		];
		for (const pulls of cases) {
			const ran = run(SHA, pulls);
			expect(ran.code).not.toBe(0);
			expect(ran.stderr).toContain("the head of an open pull request");
			expect(ran.stderr).not.toContain("develop");
			// asked again before giving up: a head pushed seconds ago can be listed late
			expect(ran.asked.trim().split("\n")).toHaveLength(5);
		}
	});

	test("a lookup that fails is asked again, and never counts as an answer", () => {
		const recovered = run(SHA, pull({}), 2);
		expect(recovered.code).toBe(0);
		expect(recovered.asked.trim().split("\n")).toHaveLength(3);

		const down = run(SHA, pull({}), 5);
		expect(down.code).not.toBe(0);
		expect(down.asked.trim().split("\n")).toHaveLength(5);
		expect(down.stderr).toContain("the head of an open pull request");
	});

	test("the job that asks holds only pull-requests: read", () => {
		expect(validate?.permissions).toEqual({ "pull-requests": "read" });
		expect(validate?.steps).toHaveLength(1);
	});
});

describe("registry token on pull requests", () => {
	const SAME_REPO = "github.event.pull_request.head.repo.full_name == github.repository";

	/** Every NPM_TOKEN a step is given, across the workflows that run on a pull request. */
	function pullRequestTokens(): string[] {
		return readdirSync(WORKFLOWS)
			.filter((name) => /\.ya?ml$/.test(name))
			.map((file) => workflow(WORKFLOWS, file))
			.filter((parsed) => "pull_request" in parsed.on || "pull_request_target" in parsed.on)
			.flatMap((parsed) => Object.values(parsed.jobs))
			.flatMap((job) => job.steps ?? [])
			.flatMap((step) => (step.env?.NPM_TOKEN === undefined ? [] : [step.env.NPM_TOKEN]));
	}

	test("no workflow that runs on pull_request hands the job token to an install unconditionally", () => {
		for (const token of pullRequestTokens()) {
			expect(token).toContain(SAME_REPO);
			// `a && token || ''`: the token is the middle operand, never the fallback
			expect(token).toMatch(/&& github\.token \|\| '' \}\}$/);
		}
	});

	test("e2e.yml skips a pull request from a fork: its install needs a token a fork never gets", () => {
		const job = workflow(WORKFLOWS, "e2e.yml").jobs.example;
		expect(job?.if).toBe(`github.event_name != 'pull_request' || ${SAME_REPO}`);
	});

	test("e2e.yml is covered by the rule above", () => {
		expect("pull_request" in workflow(WORKFLOWS, "e2e.yml").on).toBe(true);
		expect(pullRequestTokens().length).toBeGreaterThan(0);
	});

	test("the e2e action's npm-token defaults to nothing for a pull request from a fork", () => {
		const action = Bun.YAML.parse(read(".github", "actions", "e2e", "action.yml")) as {
			inputs: Record<string, { default?: string; description?: string }>;
		};
		const input = action.inputs["npm-token"];
		expect(input?.default).toContain(SAME_REPO);
		expect(input?.default).toMatch(/&& github\.token \|\| '' \}\}$/);
		expect(input?.description).toContain("fork");
	});
});

describe("ax-wedge-hunt.yml xcode input", () => {
	const step = stepNamed(workflow(WORKFLOWS, "ax-wedge-hunt.yml").jobs.hunt, "Select Xcode");

	function run(xcode: string): Ran & { env: string } {
		const bin = join(tmp, "bin");
		mkdirSync(bin, { recursive: true });
		for (const tool of ["xcodebuild", "xcrun"]) {
			writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n");
			chmodSync(join(bin, tool), 0o755);
		}
		const envFile = join(tmp, "github-env");
		writeFileSync(envFile, "");
		const ran = bash(step.run ?? "", {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			XCODE: xcode,
			GITHUB_ENV: envFile,
		});
		return { ...ran, env: readFileSync(envFile, "utf8") };
	}

	test("a path is exported as DEVELOPER_DIR", () => {
		expect(run("/Applications/Xcode_27.2.app").env).toBe(
			"DEVELOPER_DIR=/Applications/Xcode_27.2.app/Contents/Developer\n"
		);
		expect(run("/Applications/Xcode 27.app/Contents/Developer").env).toBe(
			"DEVELOPER_DIR=/Applications/Xcode 27.app/Contents/Developer\n"
		);
	});

	test("anything that is not one absolute path stops the job and writes nothing", () => {
		for (const xcode of ["/Applications/Xcode.app\nBASH_ENV=/tmp/x", "relative/Xcode.app", "/a$(id)", "/a;b"]) {
			const ran = run(xcode);
			expect(ran.code).not.toBe(0);
			expect(ran.env).toBe("");
		}
	});
});

describe("pinned images and installers", () => {
	const bun = (JSON.parse(read("package.json")) as { packageManager: string }).packageManager.replace("bun@", "");

	test("the docs image builds from digests, tags kept for the reader", () => {
		const froms = read("apps", "docs", "Dockerfile")
			.split("\n")
			.filter((line) => line.startsWith("FROM "));
		expect(froms).toHaveLength(2);
		for (const from of froms) expect(from).toMatch(/^FROM oven\/bun:[\w.-]+@sha256:[0-9a-f]{64}( AS \w+)?$/);
		expect(froms[0]).toContain(`oven/bun:${bun}@`);
		expect(froms[1]).toContain(`oven/bun:${bun}-slim@`);
	});

	test("dependabot keeps the docs image's digests current", () => {
		const config = Bun.YAML.parse(read(".github", "dependabot.yml")) as {
			updates: { "package-ecosystem": string; directory: string }[];
		};
		expect(config.updates).toContainEqual(
			expect.objectContaining({ "package-ecosystem": "docker", directory: "/apps/docs" })
		);
	});

	test("EAS jobs install the repo's bun version, never whatever is newest", () => {
		const text = readFileSync(join(EAS_WORKFLOWS, "bench-baseline.yml"), "utf8");
		const installs = text.split("\n").filter((line) => line.includes("bun.sh/install"));
		expect(installs.length).toBeGreaterThan(0);
		for (const line of installs) expect(line).toContain(`| bash -s "bun-v${bun}")`);
	});

	test("the bench installs each framework CLI at an exact version", () => {
		const adds = read("packages", "e2e-bench", "scripts", "eas-bench.sh")
			.split("\n")
			.filter((line) => /^\s*bun add -g /.test(line));
		expect(adds.length).toBeGreaterThan(0);
		for (const line of adds) expect(line).toMatch(/bun add -g (@[\w-]+\/)?[\w-]+@\d+\.\d+\.\d+ /);
	});

	test("EAS workflows never paste a dispatch input into a script", () => {
		/** The opening of a workflow expression, spelled so it is not read as a template placeholder. */
		const OPEN = ["$", "{{"].join("");
		const parsed = workflow(EAS_WORKFLOWS, "idb-libraries.yml");
		const job = parsed.jobs.build_libraries;
		for (const step of job?.steps ?? []) expect(step.run ?? "").not.toContain(OPEN);
		expect(Object.values(job?.env ?? {})).toEqual([`${OPEN} inputs.repository }}`, `${OPEN} inputs.ref }}`]);
	});
});

describe("repo policy files", () => {
	test("every workspace package.json is private", () => {
		const manifests = ["apps", "packages", "scripts"].flatMap((dir) =>
			readdirSync(join(ROOT, dir))
				.map((name) => join(dir, name, "package.json"))
				.filter((path) => existsSync(join(ROOT, path)))
		);
		expect(manifests.length).toBeGreaterThan(10);
		const open = manifests.filter((path) => (JSON.parse(read(path)) as { private?: boolean }).private !== true);
		expect(open).toEqual([]);
	});

	test("SECURITY.md says how to report privately, what is supported and what is in scope", () => {
		const text = read("SECURITY.md");
		expect(text).toContain("https://github.com/delacournz/warden/security/advisories/new");
		expect(text).toMatch(/## Supported versions/);
		expect(text).toMatch(/## Scope/);
	});

	test("CODEOWNERS covers the automation and release paths", () => {
		const lines = read(".github", "CODEOWNERS")
			.split("\n")
			.filter((line) => line.trim() !== "" && !line.startsWith("#"));
		const owned = new Map(lines.map((line) => [line.split(/\s+/)[0] ?? "", line.split(/\s+/).slice(1)]));
		for (const path of [
			"/.github/",
			"/.claude/",
			"/scripts/signoff/",
			"/scripts/release/",
			"/.changeset/config.json",
			"/apps/cli/scripts/",
		]) {
			expect(owned.get(path)?.length).toBeGreaterThan(0);
			for (const owner of owned.get(path) ?? []) expect(owner).toMatch(/^@[\w-]+(\/[\w-]+)?$/);
		}
	});
});

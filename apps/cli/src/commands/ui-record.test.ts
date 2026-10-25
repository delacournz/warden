import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeSuiteRepo } from "@delacour/warden-core/affected/fixture.testing";
import { bunExec } from "@delacour/warden-core/exec";
import { recordingSchema } from "@delacour/warden-e2e/authoring/recording.schema";
import type { DevtoolsFacet } from "@delacour/warden-e2e/devtools/devtools.types";
import { type ElementSpec, el, fakeDriver, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { ok } from "@delacour/warden-types/result";
import type { VerifyInput, VerifyReport } from "../agent-ui/authoring-verify";
import type { DevtoolsDeps } from "../agent-ui/devtools-cli";
import type { UiDeps } from "../agent-ui/driver";
import { recordingFile } from "../agent-ui/paths";
import { readState, updateState } from "../agent-ui/state";
import { OWNER_ENV } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { createUiCommand } from "./ui";

let cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups) cleanup();
	cleanups = [];
});

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";

function login(extra: ElementSpec[] = []): ElementSpec[] {
	return [
		el("window", {
			children: [
				el("text", { label: "Welcome", id: "welcome-title", frame: { x: 0, y: 50, width: 390, height: 44 } }),
				el("textfield", {
					label: "Email",
					id: "email",
					value: "a@b.co",
					frame: { x: 0, y: 100, width: 390, height: 44 },
				}),
				el("button", {
					label: "Sign in",
					id: "sign-in-submit",
					hittable: true,
					frame: { x: 0, y: 150, width: 390, height: 44 },
				}),
				...extra,
			],
		}),
	];
}

type Verifier = (input: VerifyInput) => VerifyReport;

type Harness = {
	c: TestContext;
	run: (...argv: string[]) => Promise<number>;
	doc: () => {
		ok: boolean;
		result: Record<string, unknown>;
		error: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
	};
	/** every spec the verify stub was asked to run */
	verified: VerifyInput[];
	verifier: { current: Verifier };
	journal: () => string;
	read: (path: string) => string;
};

/** `details.verify.outDir` of a verify_failed error, typed for `join`. */
function verifyOutDir(details: Record<string, unknown> | undefined): string {
	const verify = details?.verify;
	if (typeof verify !== "object" || verify === null || typeof (verify as { outDir?: unknown }).outDir !== "string") {
		throw new Error("expected details.verify.outDir");
	}
	return (verify as { outDir: string }).outDir;
}

const passing = (input: VerifyInput): VerifyReport => ({
	passed: true,
	exitCode: 0,
	outDir: input.outDir,
	log: join(input.outDir, "spec.log"),
	results: join(input.outDir, "results.jsonl"),
	tests: [{ title: "sign-in", status: "passed", durationMs: 12, evidence: [] }],
});

const failing = (input: VerifyInput): VerifyReport => ({
	passed: false,
	exitCode: 1,
	outDir: input.outDir,
	log: join(input.outDir, "spec.log"),
	results: join(input.outDir, "results.jsonl"),
	tests: [
		{
			title: "sign-in",
			status: "failed",
			durationMs: 12,
			error: "no element matches id=welcome",
			evidence: [join(input.outDir, "attempt-1", "screen-at-failure.txt")],
		},
	],
});

/** A leased device, a fake driver, the real journal and codegen, and a stubbed spec run; files land under `cwd`. */
function harness(
	options: { cwd?: string; exec?: boolean; screen?: ElementSpec[]; route?: { current: string[] | "release" } } = {}
): Harness {
	const clock = { t: 1_000_000 };
	const driver = fakeDriver({ screens: [snapshotOf(options.screen ?? login())] });
	const verified: VerifyInput[] = [];
	const verifier: { current: Verifier } = { current: passing };
	const deps: UiDeps = {
		driver: async () => ok(driver),
		sleep: async (ms) => {
			clock.t += ms;
		},
		...(options.route ? { devtools: routeDevtools(options.route) } : {}),
		authoring: {
			verify: async (_ctx, input) => {
				verified.push(input);
				return ok(verifier.current(input));
			},
		},
	};
	const c = testContext([], { now: () => clock.t, ...(options.exec ? { exec: bunExec } : {}) });
	cleanups.push(c.cleanup);
	if (options.cwd !== undefined) c.cwd = options.cwd;
	c.env = { ...c.env, ...OWNER_ENV, WARDEN_UI_SECRET_PASSWORD: "hunter22" };
	c.db.insertLease(
		{
			resource: { kind: "device", platform: "ios", id: UDID, name: "sim" },
			owner: { kind: "agent", sessionId: "me", cwd: "/w" },
			ttlMs: 10 * 60 * 60_000,
		},
		clock.t
	);
	const command = createUiCommand(deps);
	return {
		c,
		verified,
		verifier,
		run: (...argv) => {
			c.argv = [...argv, "--udid", UDID];
			c.stdout.length = 0;
			c.stderr.length = 0;
			return command.run(c);
		},
		doc: () => JSON.parse(c.stdout[0] ?? "null"),
		journal: () => readFileSync(recordingFile(c, UDID), "utf8"),
		read: (path) => readFileSync(path, "utf8"),
	};
}

/** Metro and a dev client that answer the route script with `route.current` (the route names, outermost first); "release" has no hook. */
function routeDevtools(route: { current: string[] | "release" }): DevtoolsDeps {
	const facet = {
		evaluate: async () =>
			ok(JSON.stringify(route.current === "release" ? { error: "no-hook" } : { route: route.current })),
		close: () => undefined,
	} as unknown as DevtoolsFacet;
	return {
		open: async () => ok(facet),
		probe: async () => "ours",
		collector: {
			self: () => ["warden"],
			spawnDetached: () => ({ pid: 1 }),
			kill: () => undefined,
			pidAlive: () => false,
		},
	};
}

/** A harness whose working directory is a repo with an `e2e.mobile` suite (specs under `specs/`), so verify has a suite. */
async function suiteHarness(): Promise<Harness> {
	const repo = await makeSuiteRepo();
	cleanups.push(() => rmSync(repo.dir, { recursive: true, force: true }));
	return harness({ cwd: repo.dir, exec: true });
}

/** `start`, then snapshot + press by ref + wait + fill (plain and secure) + a coordinate press; leaves the recording open. */
async function recordSignIn(h: Harness, ...startArgs: string[]): Promise<void> {
	expect(await h.run("record", "start", "sign in", ...startArgs)).toBe(0);
	expect(await h.run("snapshot", "-i")).toBe(0);
	expect(await h.run("record", "note", "enter credentials")).toBe(0);
	expect(await h.run("fill", "id=email", "me@example.com", "--no-verify")).toBe(0);
	expect(await h.run("fill", "id=email", "hunter22", "--secure")).toBe(0);
	expect(await h.run("press", "id=sign-in-submit")).toBe(0);
	expect(await h.run("wait", "id=welcome-title")).toBe(0);
}

describe("record start", () => {
	test("defaults to e2e/<slug>.e2e.ts under the working directory when no suite is configured", async () => {
		const h = harness();
		expect(await h.run("record", "start", "Sign in!", "--json")).toBe(0);
		expect(h.doc().result).toMatchObject({
			outcome: "started",
			name: "Sign in!",
			kind: "spec",
			target: join(h.c.cwd, "e2e", "sign-in.e2e.ts"),
			journal: recordingFile(h.c, UDID),
		});
		expect(readState(h.c, UDID).recording).toMatchObject({ name: "Sign in!", target: { kind: "spec" } });
		const journal = recordingSchema.parse(JSON.parse(h.journal()));
		expect(journal).toMatchObject({ name: "Sign in!", recordedOn: { platform: "ios", device: "sim" }, steps: [] });
	});

	test("defaults to <suite specsDir>/<slug>.e2e.ts from warden config", async () => {
		const repo = await makeSuiteRepo();
		cleanups.push(() => rmSync(repo.dir, { recursive: true, force: true }));
		const h = harness({ cwd: repo.dir, exec: true });
		expect(await h.run("record", "start", "onboarding", "--json")).toBe(0);
		expect(h.doc().result.target).toBe(join(repo.dir, "specs", "onboarding.e2e.ts"));
	});

	test("several suites need --suite; the error lists them", async () => {
		const repo = await makeSuiteRepo();
		cleanups.push(() => rmSync(repo.dir, { recursive: true, force: true }));
		const config = JSON.parse(readFileSync(join(repo.dir, "warden.config.json"), "utf8"));
		config.e2e.web = { ...config.e2e.mobile, specsDir: "web-specs" };
		repo.write("warden.config.json", JSON.stringify(config));
		const h = harness({ cwd: repo.dir, exec: true });
		expect(await h.run("record", "start", "onboarding", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("usage");
		expect(h.doc().error.message).toContain("mobile, web");
		expect(await h.run("record", "start", "onboarding", "--suite", "web", "--json")).toBe(0);
		expect(h.doc().result.target).toBe(join(repo.dir, "web-specs", "onboarding.e2e.ts"));
		expect(readState(h.c, UDID).recording?.suite).toBe("web");
	});

	test("--to with several suites still needs --suite: fails at start, not at `use` or `stop`", async () => {
		const repo = await makeSuiteRepo();
		cleanups.push(() => rmSync(repo.dir, { recursive: true, force: true }));
		const config = JSON.parse(readFileSync(join(repo.dir, "warden.config.json"), "utf8"));
		config.e2e.web = { ...config.e2e.mobile, specsDir: "web-specs" };
		repo.write("warden.config.json", JSON.stringify(config));
		const h = harness({ cwd: repo.dir, exec: true });
		expect(await h.run("record", "start", "x", "--to", "scratch/x.e2e.ts", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("usage");
		expect(h.doc().error.hint).toContain("--suite");
		expect(readState(h.c, UDID).recording).toBeUndefined();
		expect(await h.run("record", "start", "x", "--to", "scratch/x.e2e.ts", "--suite", "web", "--json")).toBe(0);
	});

	test("refuses a second recording and an existing target unless --overwrite", async () => {
		const h = harness();
		const target = join(h.c.cwd, "e2e", "taken.e2e.ts");
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, "// mine\n");
		expect(await h.run("record", "start", "taken", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("target_exists");
		expect(readState(h.c, UDID).recording).toBeUndefined();
		expect(await h.run("record", "start", "taken", "--overwrite")).toBe(0);
		expect(await h.run("record", "start", "other", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("recording_active");
	});

	test("--helper and --to are exclusive; --prerequisite needs --helper; the helper ref is checked", async () => {
		const h = harness();
		expect(await h.run("record", "start", "x", "--to", "a.e2e.ts", "--helper", "e2e/h.ts#signIn", "--json")).toBe(1);
		expect(h.doc().error).toMatchObject({ code: "usage", message: "--helper and --to are exclusive" });
		expect(await h.run("record", "start", "x", "--prerequisite", "fresh install", "--json")).toBe(1);
		expect(h.doc().error.message).toContain("--helper");
		expect(await h.run("record", "start", "x", "--helper", "e2e/h.ts", "--json")).toBe(1);
		expect(h.doc().error.message).toContain("<module>#<function>");
	});

	test("a helper that already exists is refused up front", async () => {
		const h = harness();
		const module = join(h.c.cwd, "e2e", "helpers.ts");
		mkdirSync(dirname(module), { recursive: true });
		writeFileSync(module, "export async function signIn(): Promise<void> {}\n");
		expect(await h.run("record", "start", "x", "--helper", "e2e/helpers.ts#signIn", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("target_exists");
		expect(await h.run("record", "start", "x", "--helper", "e2e/helpers.ts#signOut", "--json")).toBe(0);
	});
});

describe("recording", () => {
	test("actions land in the journal as resolved selectors, never @refs or secrets", async () => {
		const h = harness();
		await recordSignIn(h);
		const raw = h.journal();
		expect(raw).not.toMatch(/@e\d/);
		expect(raw).not.toContain("hunter22");
		const journal = recordingSchema.parse(JSON.parse(raw));
		expect(journal.steps.map((step) => step.kind)).toEqual(["note", "fill", "fill", "press", "wait"]);
		const secure = journal.steps[2];
		expect(secure?.kind === "fill" && secure.text).toEqual({ secret: "PASSWORD" });
		const press = journal.steps[3];
		expect(press?.kind === "press" && press.target.kind === "selector" && press.target.selector).toBe(
			"id=sign-in-submit"
		);
		expect(press?.snapshotHash).toBeDefined();
	});

	test("--no-record skips one action; nothing is journaled when no recording is active", async () => {
		const h = harness();
		expect(await h.run("press", "id=sign-in-submit")).toBe(0);
		expect(existsSync(recordingFile(h.c, UDID))).toBe(false);
		await h.run("record", "start", "x");
		await h.run("press", "id=sign-in-submit", "--no-record");
		expect(recordingSchema.parse(JSON.parse(h.journal())).steps).toHaveLength(0);
	});

	test("note, undo (with a count) and status", async () => {
		const h = harness();
		await recordSignIn(h);
		expect(await h.run("record", "note", "   ")).toBe(1);
		expect(await h.run("record", "status", "--json")).toBe(0);
		const status = h.doc().result;
		expect(status).toMatchObject({
			outcome: "recording",
			recording: { name: "sign in", kind: "spec", steps: 5 },
		});
		expect((status.recording as { last: unknown[] }).last).toHaveLength(5);

		expect(await h.run("record", "undo", "--json")).toBe(0);
		expect(h.doc().result).toMatchObject({ outcome: "undone", steps: 4, removed: [{ i: 4 }] });
		expect(await h.run("record", "undo", "2")).toBe(0);
		expect(h.c.stdout.join("\n")).toContain("removed 2 steps, 2 left");
		expect(await h.run("record", "undo", "0", "--json")).toBe(1);
		expect(await h.run("record", "status")).toBe(0);
		expect(h.c.stdout.join("\n")).toContain('recording "sign in"');
	});

	test("undo on an empty recording is an error; every record command needs a recording", async () => {
		const h = harness();
		for (const sub of ["note x", "undo", "cancel", "stop"]) {
			expect(await h.run("record", ...sub.split(" "), "--json")).toBe(1);
			expect(h.doc().error.code).toBe("no_recording");
		}
		expect(await h.run("record", "status", "--json")).toBe(0);
		expect(h.doc().result).toEqual({ outcome: "idle", recording: null });
		await h.run("record", "start", "x");
		expect(await h.run("record", "undo", "--json")).toBe(1);
		expect(h.doc().error.details?.code).toBe("nothing_to_undo");
	});

	test("cancel drops the journal and the pointer", async () => {
		const h = harness();
		await recordSignIn(h);
		expect(await h.run("record", "cancel", "--json")).toBe(0);
		expect(h.doc().result).toMatchObject({ outcome: "cancelled", name: "sign in", steps: 5 });
		expect(existsSync(recordingFile(h.c, UDID))).toBe(false);
		expect(readState(h.c, UDID).recording).toBeUndefined();
	});

	test("ui status shows the recording; snapshot -i marks interactive elements without a testID only while recording", async () => {
		const h = harness({
			screen: login([el("button", { label: "Skip", frame: { x: 0, y: 200, width: 100, height: 44 } })]),
		});
		expect(await h.run("status", "--json")).toBe(0);
		expect(h.doc().result.recording).toBeNull();
		expect(await h.run("snapshot", "-i")).toBe(0);
		expect(h.c.stdout.join("\n")).not.toContain("[no-id]");

		await h.run("record", "start", "x", "--to", "e2e/x.e2e.ts");
		await h.run("press", "id=sign-in-submit");
		expect(await h.run("status", "--json")).toBe(0);
		expect(h.doc().result.recording).toEqual({ name: "x", target: join(h.c.cwd, "e2e", "x.e2e.ts"), steps: 1 });
		expect(await h.run("status")).toBe(0);
		expect(h.c.stdout.join("\n")).toContain("→");

		expect(await h.run("snapshot", "-i", "--json")).toBe(0);
		const elements = h.doc().result.elements as { name?: string; noId?: true }[];
		expect(elements.filter((element) => element.noId).map((element) => element.name)).toEqual(["Skip"]);
		expect(await h.run("snapshot", "-i")).toBe(0);
		const text = h.c.stdout.join("\n");
		expect(text).toMatch(/"Skip".*\[no-id\]/);
		expect(text).not.toMatch(/sign-in-submit.*\[no-id\]/);
		expect(text).toContain("1 interactive element marked [no-id]");
		expect(await h.run("snapshot")).toBe(0);
		expect(h.c.stdout.join("\n")).not.toContain("[no-id]");
	});
});

describe("record stop", () => {
	test("--no-verify writes the spec, prints lints and clears the recording", async () => {
		const h = harness();
		await recordSignIn(h);
		expect(await h.run("record", "stop", "--no-verify", "--json")).toBe(0);
		const { result } = h.doc();
		const file = join(h.c.cwd, "e2e", "sign-in.e2e.ts");
		expect(result).toMatchObject({
			outcome: "written",
			kind: "spec",
			file,
			steps: 5,
			verify: { status: "skipped", reason: "flag" },
		});
		expect(h.verified).toEqual([]);
		const source = h.read(file);
		expect(source).toContain('import { expect, test } from "@delacour/warden-e2e"');
		expect(source).toContain("// enter credentials");
		expect(source).toContain("process.env.WARDEN_UI_SECRET_PASSWORD");
		expect(source).not.toContain("hunter22");
		expect(existsSync(recordingFile(h.c, UDID))).toBe(false);
		expect(readState(h.c, UDID).recording).toBeUndefined();
	});

	test("verifies by default on this device and reports it; the journal goes with a pass", async () => {
		const h = await suiteHarness();
		await recordSignIn(h);
		expect(await h.run("record", "stop")).toBe(0);
		expect(h.verified).toHaveLength(1);
		const [input] = h.verified;
		expect(input).toMatchObject({ udid: UDID, platform: "ios", specPath: join(h.c.cwd, "specs", "sign-in.e2e.ts") });
		expect(input?.outDir.startsWith(join(h.c.env.WARDEN_HOME ?? "", "ui", UDID, "verify"))).toBe(true);
		expect(h.c.stdout.join("\n")).toContain("verified: 1 test passed");
		expect(existsSync(recordingFile(h.c, UDID))).toBe(false);
	});

	test("a failed verify exits 1 and keeps the file, the journal and the pointer; undo + stop again recovers", async () => {
		const h = await suiteHarness();
		await recordSignIn(h);
		h.verifier.current = failing;
		expect(await h.run("record", "stop", "--json")).toBe(1);
		const { error } = h.doc();
		const file = join(h.c.cwd, "specs", "sign-in.e2e.ts");
		expect(error.code).toBe("verify_failed");
		expect(error.details).toMatchObject({ file, verify: { status: "failed", exitCode: 1 } });
		expect(error.details?.evidence).toContain(join(verifyOutDir(error.details), "attempt-1", "screen-at-failure.txt"));
		expect(existsSync(file)).toBe(true);
		expect(existsSync(recordingFile(h.c, UDID))).toBe(true);
		expect(readState(h.c, UDID).recording?.wrote).toBe(true);

		expect(await h.run("record", "undo")).toBe(0);
		h.verifier.current = passing;
		expect(await h.run("record", "stop", "--json")).toBe(0);
		expect(h.doc().result).toMatchObject({ outcome: "verified", steps: 4 });
		expect(existsSync(recordingFile(h.c, UDID))).toBe(false);
	});

	test("a failed verify prints the failing test and its evidence in text mode", async () => {
		const h = await suiteHarness();
		await recordSignIn(h);
		h.verifier.current = failing;
		expect(await h.run("record", "stop")).toBe(1);
		const err = h.c.stderr.join("\n");
		expect(err).toContain("no element matches id=welcome");
		expect(err).toContain("screen-at-failure.txt");
		expect(err).toContain("record cancel");
	});

	test("verify_unavailable (no suite to verify in) keeps the journal; --no-verify finishes it", async () => {
		const h = harness();
		await recordSignIn(h);
		expect(await h.run("record", "stop", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("verify_unavailable");
		expect(h.doc().error.hint).toContain("--no-verify");
		expect(existsSync(recordingFile(h.c, UDID))).toBe(true);
		expect(await h.run("record", "stop", "--no-verify")).toBe(0);
	});

	test("an empty recording is refused; so is a spec that appeared meanwhile, unless --overwrite", async () => {
		const h = harness();
		await h.run("record", "start", "sign in");
		await h.run("record", "note", "only a note");
		expect(await h.run("record", "stop", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("empty_recording");
		await h.run("press", "id=sign-in-submit");
		const file = join(h.c.cwd, "e2e", "sign-in.e2e.ts");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "// someone else's\n");
		expect(await h.run("record", "stop", "--no-verify", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("target_exists");
		expect(h.read(file)).toBe("// someone else's\n");
		expect(await h.run("record", "stop", "--no-verify", "--overwrite")).toBe(0);
		expect(h.read(file)).toContain("test(");
	});

	test("`record start --overwrite` is remembered: stop replaces the target without asking again", async () => {
		const h = harness();
		const file = join(h.c.cwd, "e2e", "sign-in.e2e.ts");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "// old\n");
		expect(await h.run("record", "start", "sign in", "--overwrite")).toBe(0);
		await h.run("snapshot", "-i");
		await h.run("press", "id=sign-in-submit");
		expect(await h.run("record", "stop", "--no-verify")).toBe(0);
		expect(h.read(file)).toContain("test(");
	});

	test("--ids merges test ids into the module and the spec imports it", async () => {
		const h = harness();
		const ids = join(h.c.cwd, "e2e", "ids.ts");
		mkdirSync(dirname(ids), { recursive: true });
		writeFileSync(ids, 'export const ids = {\n\texisting: "keep-me",\n} as const;\n');
		await recordSignIn(h, "--ids", "e2e/ids.ts");
		expect(await h.run("record", "stop", "--no-verify", "--json")).toBe(0);
		const file = join(h.c.cwd, "e2e", "sign-in.e2e.ts");
		const source = h.read(file);
		expect(source).toContain('import { ids } from "./ids"');
		expect(source).not.toContain("New test ids to add");
		const merged = h.read(ids);
		expect(merged).toContain('existing: "keep-me"');
		expect(merged).toContain('"sign-in-submit"');
		expect((h.doc().result.ids as { file: string; added: Record<string, string> }).added).toMatchObject({
			signInSubmit: "sign-in-submit",
		});
	});

	test("--helper appends an exported function with its prerequisite; verify is skipped for a helper", async () => {
		const h = harness();
		const module = join(h.c.cwd, "e2e", "helpers.ts");
		mkdirSync(dirname(module), { recursive: true });
		writeFileSync(module, 'import { expect } from "@delacour/warden-e2e";\n\nexport const other = 1;\n');
		await recordSignIn(h, "--helper", "e2e/helpers.ts#signIn", "--prerequisite", "app installed, signed out");
		expect(await h.run("record", "stop", "--json")).toBe(0);
		expect(h.doc().result).toMatchObject({
			outcome: "written",
			kind: "helper",
			fn: "signIn",
			verify: { status: "skipped", reason: "helper" },
		});
		expect(h.verified).toEqual([]);
		const source = h.read(module);
		expect(source).toContain("export const other = 1;");
		expect(source).toContain("/** Prerequisite: app installed, signed out */");
		expect(source).toContain("export async function signIn(");
		expect(await h.run("record", "status", "--json")).toBe(0);
		expect(h.doc().result.outcome).toBe("idle");
	});

	test("lints show up in the stop output", async () => {
		const h = harness();
		await h.run("record", "start", "sign in");
		await h.run("press", "120", "340");
		expect(await h.run("record", "stop", "--no-verify", "--json")).toBe(0);
		expect(h.doc().result.lints).toMatchObject([{ code: "coords_target", level: "error", step: 0 }]);
	});
});

describe("record start --help", () => {
	test("documents that the journal outlives a failed stop", async () => {
		const h = harness();
		h.c.argv = ["record", "--help"];
		await createUiCommand({
			driver: async () => ok(fakeDriver({ screens: [snapshotOf(login())] })),
			sleep: async () => {},
		}).run(h.c);
		expect(h.c.stdout.join("\n").replaceAll(/\s+/g, " ")).toContain("kept until a successful stop or cancel");
	});
});

describe("route capture", () => {
	/** a suite repo whose router root has the screens the test navigates between */
	async function routeHarness(route: { current: string[] | "release" }): Promise<Harness> {
		const repo = await makeSuiteRepo();
		cleanups.push(() => rmSync(repo.dir, { recursive: true, force: true }));
		const config = JSON.parse(readFileSync(join(repo.dir, "warden.config.json"), "utf8"));
		config.e2e.mobile.routerRoot = "src/app";
		repo.write("warden.config.json", JSON.stringify(config));
		for (const file of ["welcome", "sign-in", "(tabs)/todos"]) repo.write(`src/app/${file}.tsx`, "export {};\n");
		const h = harness({ cwd: repo.dir, exec: true, route });
		updateState(h.c, UDID, (current) => ({ ...current, metroUrl: "http://127.0.0.1:8081" }));
		return h;
	}

	test("routes seen while recording go to the journal (only when they change) and the config snippet", async () => {
		const route: { current: string[] | "release" } = { current: ["welcome"] };
		const h = await routeHarness(route);
		expect(await h.run("record", "start", "sign in", "--json")).toBe(0);
		expect(readState(h.c, UDID).recording?.routes).toMatchObject({ initial: "welcome", last: "welcome" });
		expect(await h.run("snapshot", "-i")).toBe(0);
		expect(await h.run("press", "id=sign-in-submit")).toBe(0);
		route.current = ["sign-in"];
		expect(await h.run("press", "id=sign-in-submit")).toBe(0);
		expect(await h.run("press", "id=sign-in-submit")).toBe(0);
		route.current = ["(tabs)", "todos"];
		expect(await h.run("record", "stop", "--no-verify", "--json")).toBe(0);
		const { config } = h.doc().result as { config: Record<string, unknown> };
		expect(config).toMatchObject({
			id: "sign-in",
			suite: "mobile",
			routes: ["welcome", "sign-in", "(tabs)/todos"],
			entries: ["src/app/welcome.tsx", "src/app/sign-in.tsx", "src/app/(tabs)/todos.tsx"],
			unresolved: [],
			captured: true,
		});
		expect(config.snippet).toContain('"src/app/(tabs)/todos.tsx",');
	});

	test("the journal records a route on the step that changed it", async () => {
		const route: { current: string[] | "release" } = { current: ["welcome"] };
		const h = await routeHarness(route);
		await h.run("record", "start", "sign in");
		await h.run("snapshot", "-i");
		route.current = ["sign-in"];
		await h.run("press", "id=sign-in-submit");
		await h.run("press", "id=sign-in-submit");
		const steps = recordingSchema.parse(JSON.parse(h.journal())).steps;
		expect(steps.map((step) => step.route)).toEqual(["sign-in", undefined]);
	});

	test("a release build captures nothing: empty entries, a hint, and it stops asking", async () => {
		const route: { current: string[] | "release" } = { current: "release" };
		const h = await routeHarness(route);
		await h.run("record", "start", "sign in");
		await h.run("snapshot", "-i");
		for (let i = 0; i < 4; i++) expect(await h.run("press", "id=sign-in-submit")).toBe(0);
		expect(readState(h.c, UDID).recording?.routes?.misses).toBe(3);
		expect(await h.run("record", "stop", "--no-verify", "--json")).toBe(0);
		const { config } = h.doc().result as {
			config: { captured: boolean; entries: string[]; snippet: string; hints: string[] };
		};
		expect(config).toMatchObject({ captured: false, entries: [] });
		expect(config.snippet).toContain("entries: []");
		expect(config.hints[0]).toContain("by hand");
		expect(h.read(join(h.c.cwd, "specs", "sign-in.e2e.ts"))).toContain("test(");
	});

	test("text output prints the snippet; a helper gets none", async () => {
		const h = await routeHarness({ current: ["welcome"] });
		await h.run("record", "start", "sign in");
		await h.run("snapshot", "-i");
		await h.run("press", "id=sign-in-submit");
		expect(await h.run("record", "stop", "--no-verify")).toBe(0);
		const text = h.c.stdout.join("\n");
		expect(text).toContain("add to e2e.mobile in warden.config.ts:");
		expect(text).toContain('"src/app/welcome.tsx"');

		await h.run("record", "start", "login helper", "--helper", "helpers/login#login", "--prerequisite", "app open");
		await h.run("press", "id=sign-in-submit");
		expect(await h.run("record", "stop", "--json")).toBe(0);
		expect(h.doc().result.config).toBeNull();
	});
});

describe("record use", () => {
	const HELPERS = "export async function signIn(): Promise<void> {}\nexport { signIn as login };\n";

	/** a suite repo with `e2e/helpers.ts`, and a stub that keeps the generated spec the helper ran in */
	async function useHarness(route?: { current: string[] | "release" }): Promise<Harness & { ran: string[] }> {
		const repo = await makeSuiteRepo();
		cleanups.push(() => rmSync(repo.dir, { recursive: true, force: true }));
		if (route) {
			const config = JSON.parse(readFileSync(join(repo.dir, "warden.config.json"), "utf8"));
			config.e2e.mobile.routerRoot = "src/app";
			writeFileSync(join(repo.dir, "warden.config.json"), JSON.stringify(config));
		}
		mkdirSync(join(repo.dir, "e2e"), { recursive: true });
		writeFileSync(join(repo.dir, "e2e", "helpers.ts"), HELPERS);
		const h = harness({ cwd: repo.dir, exec: true, ...(route ? { route } : {}) });
		if (route) updateState(h.c, UDID, (current) => ({ ...current, metroUrl: "http://127.0.0.1:8081" }));
		const ran: string[] = [];
		const inner = h.verifier.current;
		h.verifier.current = (input) => {
			ran.push(readFileSync(input.specPath, "utf8"));
			return inner(input);
		};
		return Object.assign(h, { ran });
	}

	test("runs the helper in a generated spec, records a use step, and stop imports it relative to the spec", async () => {
		const h = await useHarness();
		expect(await h.run("record", "start", "todos")).toBe(0);
		expect(await h.run("record", "use", "e2e/helpers#signIn", "--json")).toBe(0);
		const helpers = join(h.c.cwd, "e2e", "helpers.ts");
		expect(h.doc().result).toMatchObject({ outcome: "used", step: 0, module: helpers, fn: "signIn" });
		expect(h.ran).toHaveLength(1);
		expect(h.ran[0]).toContain('import { signIn } from "');
		expect(h.ran[0]).toContain("await signIn(fixtures);");
		expect(h.verified[0]?.specPath).not.toContain(join(h.c.cwd, "specs"));
		expect(existsSync(h.verified[0]?.specPath ?? "")).toBe(false);
		expect(recordingSchema.parse(JSON.parse(h.journal())).steps).toMatchObject([
			{ kind: "use", module: helpers, fn: "signIn" },
		]);

		expect(await h.run("wait", "id=welcome-title")).toBe(0);
		expect(await h.run("record", "stop", "--no-verify")).toBe(0);
		const spec = h.read(join(h.c.cwd, "specs", "todos.e2e.ts"));
		expect(spec).toContain('import { signIn } from "../e2e/helpers";');
		expect(spec).toContain("await signIn(fixtures);");
	});

	test("an export { x as fn } list counts, and the status line names the helper", async () => {
		const h = await useHarness();
		await h.run("record", "start", "todos");
		expect(await h.run("record", "use", "e2e/helpers.ts#login")).toBe(0);
		expect(await h.run("record", "status")).toBe(0);
		expect(h.c.stdout.join("\n")).toContain("use helpers.ts#login");
	});

	test("a helper call followed by an action without a wait is linted as an unverified navigation", async () => {
		const h = await useHarness();
		await h.run("record", "start", "todos");
		await h.run("record", "use", "e2e/helpers#signIn");
		await h.run("snapshot", "-i");
		await h.run("press", "id=sign-in-submit");
		expect(await h.run("record", "status", "--json")).toBe(0);
		const lints = (h.doc().result.recording as { lints: { code: string; step: number }[] }).lints;
		expect(lints).toContainEqual(expect.objectContaining({ code: "unverified_navigation", step: 0 }));
	});

	test("a failing helper exits 1 with evidence and records nothing", async () => {
		const h = await useHarness();
		await h.run("record", "start", "todos");
		h.verifier.current = failing;
		expect(await h.run("record", "use", "e2e/helpers#signIn", "--json")).toBe(1);
		const { error } = h.doc();
		expect(error.code).toBe("use_failed");
		expect(error.details?.evidence).toContain(join(verifyOutDir(error.details), "attempt-1", "screen-at-failure.txt"));
		expect(recordingSchema.parse(JSON.parse(h.journal())).steps).toEqual([]);
	});

	test("a failing helper prints the failing test and evidence in text mode", async () => {
		const h = await useHarness();
		await h.run("record", "start", "todos");
		h.verifier.current = failing;
		expect(await h.run("record", "use", "e2e/helpers#signIn")).toBe(1);
		expect(h.c.stderr.join("\n")).toContain("screen-at-failure.txt");
	});

	test("no recording, a missing module and a missing export are their own errors and run nothing", async () => {
		const h = await useHarness();
		expect(await h.run("record", "use", "e2e/helpers#signIn", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("no_recording");
		await h.run("record", "start", "todos");
		expect(await h.run("record", "use", "e2e/nope#signIn", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("helper_missing");
		expect(await h.run("record", "use", "e2e/helpers#signOut", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("helper_missing");
		expect(await h.run("record", "use", "e2e/helpers", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("usage");
		expect(h.verified).toEqual([]);
	});

	test("without a suite there is nothing to run the helper in: verify_unavailable, nothing recorded", async () => {
		const h = harness();
		writeFileSync(join(h.c.cwd, "helpers.ts"), HELPERS);
		await h.run("record", "start", "todos");
		expect(await h.run("record", "use", "helpers#signIn", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("verify_unavailable");
		expect(recordingSchema.parse(JSON.parse(h.journal())).steps).toEqual([]);
	});

	test("the route the helper ends on lands on the step, and tracking continues from it", async () => {
		const route: { current: string[] | "release" } = { current: ["welcome"] };
		const h = await useHarness(route);
		await h.run("record", "start", "todos");
		route.current = ["(tabs)", "todos"];
		expect(await h.run("record", "use", "e2e/helpers#signIn")).toBe(0);
		expect(recordingSchema.parse(JSON.parse(h.journal())).steps[0]?.route).toBe("(tabs)/todos");
		expect(readState(h.c, UDID).recording?.routes?.last).toBe("(tabs)/todos");
	});

	test("the screen the helper leaves is snapshotted so earlier refs are stale", async () => {
		const h = await useHarness();
		await h.run("snapshot", "-i");
		const before = readState(h.c, UDID).generation;
		await h.run("record", "start", "todos");
		await h.run("record", "use", "e2e/helpers#signIn");
		expect(readState(h.c, UDID).generation).toBeGreaterThan(before);
	});
});

describe("shared spec options and launch", () => {
	const SHARED = 'export const SPEC_OPTIONS = { launch: "none", systemAlerts: "dismiss" } as const;\n';
	const OPENING = 'export async function signIn(app: App): Promise<void> {\n\tawait app.open({ wait: "quiet" });\n}\n';
	const STATIC = "export async function signIn(): Promise<void> {}\n";

	/** a suite repo whose specs dir has a spec sharing `SPEC_OPTIONS` through `helpers/steps.ts`, plus `e2e/helpers.ts` */
	async function sharedHarness(helper = STATIC): Promise<Harness & { ran: string[] }> {
		const repo = await makeSuiteRepo();
		cleanups.push(() => rmSync(repo.dir, { recursive: true, force: true }));
		mkdirSync(join(repo.dir, "specs", "helpers"), { recursive: true });
		writeFileSync(join(repo.dir, "specs", "helpers", "steps.ts"), SHARED);
		writeFileSync(
			join(repo.dir, "specs", "existing.e2e.ts"),
			'import { SPEC_OPTIONS } from "./helpers/steps";\ntest.use(SPEC_OPTIONS);\n'
		);
		mkdirSync(join(repo.dir, "e2e"), { recursive: true });
		writeFileSync(join(repo.dir, "e2e", "helpers.ts"), helper);
		const h = harness({ cwd: repo.dir, exec: true });
		const ran: string[] = [];
		const inner = h.verifier.current;
		h.verifier.current = (input) => {
			ran.push(readFileSync(input.specPath, "utf8"));
			return inner(input);
		};
		return Object.assign(h, { ran });
	}

	test("a spec the runner launches passes the suite's shared options, overriding the launch they turn off", async () => {
		const h = await sharedHarness();
		await recordSignIn(h);
		expect(await h.run("record", "stop", "--no-verify", "--json")).toBe(0);
		const { result } = h.doc();
		const spec = h.read(join(h.c.cwd, "specs", "sign-in.e2e.ts"));
		expect(spec).toContain('import { SPEC_OPTIONS } from "./helpers/steps";');
		expect(spec).toContain('test.use({ ...SPEC_OPTIONS, launch: "fresh" });');
		expect(result).toMatchObject({
			launch: "fresh",
			options: { name: "SPEC_OPTIONS", module: join(h.c.cwd, "specs", "helpers", "steps.ts") },
		});
	});

	test("a first step that is a use of a helper that opens the app turns the runner's launch off; verify gets the same", async () => {
		const h = await sharedHarness(OPENING);
		expect(await h.run("record", "start", "sign in")).toBe(0);
		expect(await h.run("record", "use", "e2e/helpers#signIn")).toBe(0);
		expect(h.ran[0]).toContain("test.use(SPEC_OPTIONS);");
		await h.run("wait", "id=welcome-title");
		expect(await h.run("record", "stop", "--no-verify")).toBe(0);
		const spec = h.read(join(h.c.cwd, "specs", "sign-in.e2e.ts"));
		expect(spec).toContain("test.use(SPEC_OPTIONS);");
		expect(spec).not.toContain("launch:");
		expect(h.c.stdout.join("\n")).toContain("passes the shared options SPEC_OPTIONS");
	});

	test("without shared options the launch rides on test.use alone", async () => {
		const h = await suiteHarness();
		mkdirSync(join(h.c.cwd, "e2e"), { recursive: true });
		writeFileSync(join(h.c.cwd, "e2e", "helpers.ts"), OPENING);
		await h.run("record", "start", "sign in");
		await h.run("record", "use", "e2e/helpers#signIn");
		await h.run("wait", "id=welcome-title");
		expect(await h.run("record", "stop", "--no-verify", "--json")).toBe(0);
		const spec = h.read(join(h.c.cwd, "specs", "sign-in.e2e.ts"));
		expect(spec).toContain('test.use({ launch: "none" });');
		expect(h.doc().result).toMatchObject({ launch: "none", options: null });
	});

	test("a helper that does not open the app leaves the launch to the runner", async () => {
		const h = await sharedHarness(STATIC);
		await h.run("record", "start", "sign in");
		await h.run("record", "use", "e2e/helpers#signIn");
		expect(h.ran[0]).toContain('test.use({ ...SPEC_OPTIONS, launch: "fresh" });');
	});

	test("--options pins the object, --options none passes nothing, a bad ref is a usage error", async () => {
		const h = await sharedHarness();
		writeFileSync(join(h.c.cwd, "specs", "helpers", "slow.ts"), "export const SLOW = { timeout: 60000 };\n");
		expect(await h.run("record", "start", "sign in", "--options", "nope#X", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("usage");
		expect(await h.run("record", "start", "sign in", "--options", "specs/helpers/slow#SLOW")).toBe(0);
		expect(readState(h.c, UDID).recording?.options).toEqual({
			module: join(h.c.cwd, "specs", "helpers", "slow.ts"),
			name: "SLOW",
		});
		await h.run("snapshot", "-i");
		await h.run("press", "id=sign-in-submit");
		expect(await h.run("record", "stop", "--no-verify")).toBe(0);
		const pinned = h.read(join(h.c.cwd, "specs", "sign-in.e2e.ts"));
		expect(pinned).toContain('import { SLOW } from "./helpers/slow";');
		expect(pinned).toContain("test.use(SLOW);");

		expect(await h.run("record", "start", "plain", "--options", "none")).toBe(0);
		await h.run("press", "id=sign-in-submit");
		expect(await h.run("record", "stop", "--no-verify")).toBe(0);
		expect(h.read(join(h.c.cwd, "specs", "plain.e2e.ts"))).not.toContain("test.use");
	});

	test("two candidate objects: none is passed and the output says how to pick", async () => {
		const h = await sharedHarness();
		writeFileSync(join(h.c.cwd, "specs", "helpers", "slow.ts"), "export const SLOW = { timeout: 60000 };\n");
		writeFileSync(join(h.c.cwd, "specs", "slow.e2e.ts"), 'import { SLOW } from "./helpers/slow";\ntest.use(SLOW);\n');
		await recordSignIn(h);
		expect(await h.run("record", "stop", "--no-verify")).toBe(0);
		expect(h.read(join(h.c.cwd, "specs", "sign-in.e2e.ts"))).not.toContain("test.use");
		expect(h.c.stdout.join("\n")).toContain("several shared spec options fit (SLOW, SPEC_OPTIONS)");
	});
});

describe("helper routes", () => {
	const HELPER_REF = "helpers/login#login";

	/** a suite repo with a router root, the screens below it, and a dev client that answers `route.current` */
	async function routeSuite(route: { current: string[] | "release" }): Promise<Harness> {
		const repo = await makeSuiteRepo();
		cleanups.push(() => rmSync(repo.dir, { recursive: true, force: true }));
		const config = JSON.parse(readFileSync(join(repo.dir, "warden.config.json"), "utf8"));
		config.e2e.mobile.routerRoot = "src/app";
		repo.write("warden.config.json", JSON.stringify(config));
		for (const file of ["welcome", "sign-in", "(tabs)/todos", "(tabs)/settings"]) {
			repo.write(`src/app/${file}.tsx`, "export {};\n");
		}
		const h = harness({ cwd: repo.dir, exec: true, route });
		updateState(h.c, UDID, (current) => ({ ...current, metroUrl: "http://127.0.0.1:8081" }));
		return h;
	}

	/** record `login` as a helper that walks welcome → sign-in → todos, then leave the route on todos */
	async function recordLoginHelper(h: Harness, route: { current: string[] | "release" }): Promise<void> {
		route.current = ["welcome"];
		expect(await h.run("record", "start", "login", "--helper", HELPER_REF, "--prerequisite", "signed out")).toBe(0);
		await h.run("snapshot", "-i");
		route.current = ["sign-in"];
		await h.run("press", "id=sign-in-submit");
		route.current = ["(tabs)", "todos"];
		await h.run("press", "id=sign-in-submit");
		expect(await h.run("record", "stop", "--json")).toBe(0);
	}

	test("a helper recorded with warden gives its routes to the spec that uses it, and the hint goes", async () => {
		const route: { current: string[] | "release" } = { current: ["welcome"] };
		const h = await routeSuite(route);
		await recordLoginHelper(h, route);

		route.current = ["welcome"];
		expect(await h.run("record", "start", "todos")).toBe(0);
		route.current = ["(tabs)", "todos"];
		expect(await h.run("record", "use", HELPER_REF, "--json")).toBe(0);
		const { result } = h.doc();
		expect(result).toMatchObject({
			outcome: "used",
			visited: ["welcome", "sign-in", "(tabs)/todos"],
			routes: "recording",
		});
		const [step] = recordingSchema.parse(JSON.parse(h.journal())).steps;
		expect(step).toMatchObject({ kind: "use", visited: ["welcome", "sign-in", "(tabs)/todos"] });
		expect(step).not.toHaveProperty("partial");

		await h.run("wait", "id=welcome-title");
		route.current = ["(tabs)", "settings"];
		expect(await h.run("record", "stop", "--no-verify", "--json")).toBe(0);
		const { config } = h.doc().result as { config: { routes: string[]; entries: string[]; hints: string[] } };
		expect(config.routes).toEqual(["welcome", "sign-in", "(tabs)/todos", "(tabs)/settings"]);
		expect(config.entries).toEqual([
			"src/app/welcome.tsx",
			"src/app/sign-in.tsx",
			"src/app/(tabs)/todos.tsx",
			"src/app/(tabs)/settings.tsx",
		]);
		expect(config.hints).toEqual([]);
	});

	test("a helper with no recording of its own contributes the reads before and after, and the hint stays", async () => {
		const route: { current: string[] | "release" } = { current: ["welcome"] };
		const h = await routeSuite(route);
		mkdirSync(join(h.c.cwd, "e2e"), { recursive: true });
		writeFileSync(join(h.c.cwd, "e2e", "steps.ts"), "export async function openTodos(): Promise<void> {}\n");
		await h.run("record", "start", "todos");
		route.current = ["(tabs)", "todos"];
		expect(await h.run("record", "use", "e2e/steps#openTodos", "--json")).toBe(0);
		expect(h.doc().result).toMatchObject({ visited: ["welcome", "(tabs)/todos"], routes: "reads" });
		expect(recordingSchema.parse(JSON.parse(h.journal())).steps[0]).toMatchObject({ partial: true });
		await h.run("wait", "id=welcome-title");
		expect(await h.run("record", "stop", "--no-verify", "--json")).toBe(0);
		const { config } = h.doc().result as { config: { entries: string[]; hints: string[] } };
		expect(config.entries).toEqual(["src/app/welcome.tsx", "src/app/(tabs)/todos.tsx"]);
		expect(config.hints.join("\n")).toContain("helper openTodos");
	});

	test("editing the helper function after it was recorded makes its saved routes stale", async () => {
		const route: { current: string[] | "release" } = { current: ["welcome"] };
		const h = await routeSuite(route);
		await recordLoginHelper(h, route);
		const file = join(h.c.cwd, "helpers", "login.ts");
		writeFileSync(
			file,
			`${readFileSync(file, "utf8").replace("await screen", "await screen.getByTestId('x').tap();\n\tawait screen")}`
		);
		await h.run("record", "start", "todos");
		expect(await h.run("record", "use", HELPER_REF, "--json")).toBe(0);
		expect(h.doc().result).toMatchObject({ routes: "reads" });
	});

	test("on a release build nothing is read and nothing is invented", async () => {
		const route: { current: string[] | "release" } = { current: "release" };
		const h = await routeSuite(route);
		mkdirSync(join(h.c.cwd, "e2e"), { recursive: true });
		writeFileSync(join(h.c.cwd, "e2e", "steps.ts"), "export async function openTodos(): Promise<void> {}\n");
		await h.run("record", "start", "todos");
		expect(await h.run("record", "use", "e2e/steps#openTodos", "--json")).toBe(0);
		expect(h.doc().result).toMatchObject({ visited: [], routes: "reads" });
	});
});

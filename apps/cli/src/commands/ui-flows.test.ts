import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type ElementSpec,
	el,
	type FakeDriver,
	fakeDriver,
	snapshotOf,
} from "@delacour/warden-e2e/driver/driver.testing";
import type { Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import { flowSchema } from "@delacour/warden-e2e/flows/flow.schema";
import { ok } from "@delacour/warden-types/result";
import ts from "typescript";
import type { UiDeps } from "../agent-ui/driver";
import { readState } from "../agent-ui/state";
import { OWNER_ENV } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { createUiCommand } from "./ui";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const FLOW = "sign-in";

function login(extra: ElementSpec[] = [], button = true, buttonY = 150): ElementSpec[] {
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
				...(button
					? [
							el("button", {
								label: "Sign in",
								id: "sign-in-submit",
								hittable: true,
								frame: { x: 0, y: buttonY, width: 390, height: 44 },
							}),
						]
					: []),
				...extra,
			],
		}),
	];
}

type Harness = {
	c: TestContext;
	driver: FakeDriver;
	/** run `warden ui <argv> --udid …` */
	run: (...argv: string[]) => Promise<number>;
	/** run `warden ui <argv>` as given (export has no device flags) */
	plain: (...argv: string[]) => Promise<number>;
	doc: () => {
		ok: boolean;
		result: Record<string, unknown>;
		error: { code: string; message: string; details?: Record<string, unknown> };
	};
	flowPath: string;
	read: () => string;
};

/** A leased device, a fake driver, and the real flow recorder (no `record` dep): the files land in a temp cwd. */
function harness(screen: Snapshot = snapshotOf(login())): Harness {
	const clock = { t: 1_000_000 };
	const driver = fakeDriver({ screens: [screen] });
	const deps: UiDeps = {
		driver: async () => ok(driver),
		sleep: async (ms) => {
			clock.t += ms;
		},
	};
	const c = testContext([], { now: () => clock.t });
	ctx = c;
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
	const flowPath = join(c.cwd, ".warden-ui", `${FLOW}.flow.json`);
	const exec = (argv: string[]) => {
		c.argv = argv;
		c.stdout.length = 0;
		c.stderr.length = 0;
		return command.run(c);
	};
	return {
		c,
		driver,
		run: (...argv) => exec([...argv, "--udid", UDID]),
		plain: (...argv) => exec(argv),
		doc: () => JSON.parse(c.stdout[0] ?? "null"),
		flowPath,
		read: () => readFileSync(flowPath, "utf8"),
	};
}

/** Record: snapshot, press @ref, press selector, fill (plain + secure), type, key, open. Leaves the recording stopped. */
async function recordSession(h: Harness): Promise<void> {
	expect(await h.run("record", "start", FLOW)).toBe(0);
	expect(await h.run("snapshot")).toBe(0);
	const ref = /(@e\d+) \[button\] "Sign in"/.exec(h.c.stdout.join("\n"))?.[1];
	expect(ref).toBeDefined();
	expect(await h.run("press", ref ?? "")).toBe(0);
	expect(await h.run("press", "id=sign-in-submit")).toBe(0);
	expect(await h.run("fill", "id=email", "me@example.com", "--no-verify")).toBe(0);
	expect(await h.run("fill", "id=email", "hunter22", "--secure")).toBe(0);
	expect(await h.run("type", "hello", "--submit")).toBe(0);
	expect(await h.run("open", "com.example.app")).toBe(0);
	expect(await h.run("press", "120", "340")).toBe(0);
	expect(await h.run("record", "stop")).toBe(0);
}

describe("record", () => {
	test("start → actions → stop writes a valid flow of resolved selectors, never @refs or secrets", async () => {
		const h = harness();
		await recordSession(h);

		const raw = h.read();
		expect(raw).not.toMatch(/@e\d/);
		expect(raw).not.toContain("hunter22");
		const flow = flowSchema.parse(JSON.parse(raw));
		expect(flow.name).toBe(FLOW);
		expect(flow.recordedOn).toMatchObject({ platform: "ios", device: "sim" });
		expect(flow.steps.map((step) => step.kind)).toEqual([
			"press",
			"press",
			"fill",
			"fill",
			"type",
			"key",
			"open",
			"press",
		]);
		const [byRef, bySelector, plain, secure, , , , coords] = flow.steps;
		for (const step of [byRef, bySelector]) {
			expect(step?.kind === "press" && step.target.kind === "selector" && step.target.selector).toBe(
				"id=sign-in-submit"
			);
			expect(step?.snapshotHash).toBeDefined();
		}
		expect(plain?.kind === "fill" && plain.text).toBe("me@example.com");
		expect(secure?.kind === "fill" && secure.text).toEqual({ secret: "PASSWORD" });
		expect(coords?.kind === "press" && coords.target.kind).toBe("coords");
	});

	test("record stop prints the step count and clears the recording; status follows", async () => {
		const h = harness();
		expect(await h.run("record", "status")).toBe(0);
		expect(h.c.stdout[0]).toBe("not recording");
		await h.run("record", "start", FLOW);
		await h.run("press", "id=sign-in-submit");
		expect(await h.run("record", "status", "--json")).toBe(0);
		expect(h.doc().result).toMatchObject({ recording: { name: FLOW, steps: 1 } });
		expect(readState(h.c, UDID).recording?.name).toBe(FLOW);
		expect(await h.run("record", "stop")).toBe(0);
		expect(h.c.stdout[0]).toContain("1 step");
		expect(readState(h.c, UDID).recording).toBeUndefined();
		expect(await h.run("record", "stop", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("usage");
	});

	test("--no-record skips a step; a second start is refused; an existing file is refused", async () => {
		const h = harness();
		await h.run("record", "start", FLOW);
		await h.run("press", "id=sign-in-submit", "--no-record");
		expect(await h.run("record", "start", "other", "--json")).toBe(1);
		expect(h.doc().error.message).toContain("already recording");
		await h.run("record", "stop");
		expect(JSON.parse(h.read()).steps).toHaveLength(0);
		expect(await h.run("record", "start", FLOW, "--json")).toBe(1);
		expect(h.doc().error.message).toContain("already exists");
	});
});

describe("replay", () => {
	test("passes on the screen it was recorded on, with a ✓ line per step", async () => {
		const h = harness();
		await recordSession(h);
		h.driver.calls.length = 0;
		expect(await h.run("replay", h.flowPath)).toBe(0);
		const lines = h.c.stdout.filter((line) => line.startsWith("✓"));
		expect(lines).toHaveLength(8);
		expect(lines[0]).toMatch(/^✓ 0 press id=sign-in-submit \(\d+ ms\)$/);
		expect(h.c.stdout.at(-1)).toContain("replayed 8 steps");
		expect(h.driver.callsOf("tap").length).toBeGreaterThanOrEqual(3);
		expect(h.driver.callsOf("typeText").map((call) => call.text)).toEqual(["me@example.com", "hunter22", "hello"]);
		expect(h.driver.callsOf("app.launch")[0]?.bundleId).toBe("com.example.app");
	});

	test("--json: one envelope with the steps", async () => {
		const h = harness();
		await recordSession(h);
		expect(await h.run("replay", h.flowPath, "--json")).toBe(0);
		expect(h.c.stdout).toHaveLength(1);
		expect(h.doc().result).toMatchObject({ status: "passed", steps: 8, updated: false, drift: [] });
		expect((h.doc().result.events as unknown[]).length).toBe(8);
	});

	test("a missing secret fails the step without typing anything", async () => {
		const h = harness();
		await recordSession(h);
		delete h.c.env.WARDEN_UI_SECRET_PASSWORD;
		h.driver.calls.length = 0;
		expect(await h.run("replay", h.flowPath, "--json")).toBe(1);
		expect(h.doc().error.message).toContain("missing_secret");
		expect(h.driver.callsOf("typeText").map((call) => call.text)).toEqual(["me@example.com"]);
	});

	test("a vanished element is a replay_divergence naming the step, exit 1, with a screen excerpt", async () => {
		const h = harness();
		await recordSession(h);
		h.driver.set(snapshotOf(login([], false)));
		expect(await h.run("replay", h.flowPath, "--json")).toBe(1);
		const { error } = h.doc();
		expect(error.code).toBe("replay_divergence");
		expect(error.details).toMatchObject({ step: 0, kind: "press" });
		expect(String(error.details?.snapshot)).toContain("id=email");
		h.driver.set(snapshotOf(login([], false)));
		expect(await h.run("replay", h.flowPath)).toBe(1);
		expect(h.c.stderr.join("\n")).toContain("screen at step 0");
	});

	test("a button that moved far from its recorded spot diverges; --from skips ahead of it", async () => {
		const h = harness();
		await recordSession(h);
		h.driver.set(snapshotOf(login([], true, 400)));
		expect(await h.run("replay", h.flowPath, "--json")).toBe(1);
		expect(h.doc().error.message).toContain("moved");
		expect(await h.run("replay", h.flowPath, "--from", "7", "--json")).toBe(0);
		expect(h.doc().result).toMatchObject({ steps: 1 });
	});

	test("a changed screen is a drift warning, not a failure", async () => {
		const h = harness();
		await recordSession(h);
		h.driver.set(
			snapshotOf(login([el("text", { label: "Promo", id: "promo", frame: { x: 0, y: 300, width: 390, height: 40 } })]))
		);
		expect(await h.run("replay", h.flowPath, "--json")).toBe(0);
		expect((h.doc().result.drift as unknown[]).length).toBeGreaterThan(0);
		expect(await h.run("replay", h.flowPath)).toBe(0);
		expect(h.c.stdout.join("\n")).toContain("drift:");
	});

	test("the file is untouched unless --update-snapshots", async () => {
		const h = harness();
		await recordSession(h);
		const before = h.read();
		h.driver.set(snapshotOf(login([], true, 170)));
		expect(await h.run("replay", h.flowPath)).toBe(0);
		expect(h.read()).toBe(before);
		expect(await h.run("replay", h.flowPath, "--update-snapshots", "--json")).toBe(0);
		expect(h.doc().result).toMatchObject({ updated: true });
		const after = flowSchema.parse(JSON.parse(h.read()));
		const first = after.steps[0];
		expect(first?.kind === "press" && first.target.kind === "selector" && first.target.landmark.frame.y).toBe(170);
	});

	test("a file that is not a flow is a clean failure", async () => {
		const h = harness();
		writeFileSync(join(h.c.cwd, "bad.flow.json"), '{"v":2}');
		expect(await h.run("replay", "bad.flow.json", "--json")).toBe(1);
		expect(h.doc().error.code).toBe("failed");
		expect(await h.run("replay", "missing.flow.json", "--json")).toBe(1);
	});
});

/** Typecheck `file` the way a project spec would be: `@delacour/warden-e2e` resolves to the package source. */
function typecheck(file: string): string[] {
	const repo = join(dirname(import.meta.path), "..", "..", "..", "..");
	const options: ts.CompilerOptions = {
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		types: ["bun"],
		typeRoots: [join(repo, "node_modules", "@types")],
		baseUrl: repo,
		paths: { "@delacour/warden-e2e": ["packages/e2e/src/index.ts"] },
		customConditions: ["@delacour/warden-source"],
	};
	const program = ts.createProgram([file], options);
	return ts
		.getPreEmitDiagnostics(program)
		.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

describe("export", () => {
	test("writes a spec that typechecks and refuses to overwrite it without --force", async () => {
		const h = harness();
		await recordSession(h);
		expect(await h.plain("export", h.flowPath, "--to", "e2e/sign-in.e2e.ts")).toBe(0);
		const spec = join(h.c.cwd, "e2e", "sign-in.e2e.ts");
		const text = readFileSync(spec, "utf8");
		expect(text).toContain('test("sign-in"');
		expect(text).toContain("screen.getByTestId(ids.signInSubmit).tap()");
		expect(text).toContain("process.env.WARDEN_UI_SECRET_PASSWORD");
		expect(text).not.toContain("hunter22");
		expect(h.c.stdout.join("\n")).toContain("FIXME");
		expect(typecheck(spec)).toEqual([]);

		expect(await h.plain("export", h.flowPath, "--to", "e2e/sign-in.e2e.ts", "--json")).toBe(1);
		expect(h.doc().error.message).toContain("already exists");
		expect(await h.plain("export", h.flowPath, "--to", "e2e/sign-in.e2e.ts", "--force", "--json")).toBe(0);
		expect(h.doc()).toMatchObject({ ok: true, command: "export", result: { steps: 8 } });
	}, 60_000);

	test("--ids merges test ids into the module and prints what was added", async () => {
		const h = harness();
		await recordSession(h);
		const idsFile = join(h.c.cwd, "e2e", "ids.ts");
		mkdirSync(join(h.c.cwd, "e2e"), { recursive: true });
		writeFileSync(idsFile, 'export const ids = { signIn: "sign-in-submit" } as const;\n');

		expect(await h.plain("export", h.flowPath, "--to", "e2e/sign-in.e2e.ts", "--ids", "e2e/ids.ts", "--force")).toBe(0);
		const out = h.c.stdout.join("\n");
		expect(out).toContain("updated e2e/ids.ts");
		expect(out).toContain('+ email: "email"');
		expect(out).not.toContain("+ signIn");
		const ids = readFileSync(idsFile, "utf8");
		expect(ids).toContain('signIn: "sign-in-submit"');
		expect(ids).toContain('email: "email"');
		const spec = readFileSync(join(h.c.cwd, "e2e", "sign-in.e2e.ts"), "utf8");
		expect(spec).toContain('import { ids } from "./ids";');
		expect(spec).toContain("screen.getByTestId(ids.signIn)");

		expect(await h.plain("export", h.flowPath, "--to", "e2e/sign-in.e2e.ts", "--ids", "e2e/ids.ts", "--force")).toBe(0);
		expect(h.c.stdout.join("\n")).not.toContain("updated e2e/ids.ts");
	}, 60_000);

	test("a flow that does not exist fails cleanly", async () => {
		const h = harness();
		expect(await h.plain("export", "nope.flow.json", "--to", "e2e/x.e2e.ts", "--json")).toBe(1);
		expect(h.doc().ok).toBe(false);
		expect(existsSync(join(h.c.cwd, "e2e", "x.e2e.ts"))).toBe(false);
	});
});

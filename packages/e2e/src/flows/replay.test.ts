import { describe, expect, test } from "bun:test";
import { ok } from "@delacour/warden-types/result";
import { el, fakeDriver, snapshotOf } from "../driver/driver.testing";
import type { Element, Snapshot } from "../driver/driver.types";
import { snapshotHash } from "../driver/settle";
import type { Flow, NewStep } from "./flow.schema";
import { flowOf } from "./flow.testing";
import { targetFromElement } from "./record";
import { type ReplayDeps, replayFlow } from "./replay";
import { recordingActors } from "./replay.testing";

const SIGN_IN = { x: 24, y: 300, width: 342, height: 48 };

function screen(overrides: { signIn?: Partial<{ x: number; y: number }> | null; extra?: boolean } = {}): Snapshot {
	const specs = [
		el("text", { id: "title", label: "Welcome", frame: { x: 24, y: 100, width: 342, height: 40 } }),
		el("textfield", { id: "email", frame: { x: 24, y: 200, width: 342, height: 44 } }),
	];
	if (overrides.signIn !== null) {
		specs.push(el("button", { id: "sign-in", label: "Sign in", frame: { ...SIGN_IN, ...overrides.signIn } }));
	}
	if (overrides.extra) specs.push(el("button", { id: "sign-in", label: "Sign in" }));
	return snapshotOf(specs);
}

function elementNamed(snapshot: Snapshot, identifier: string): Element {
	const found = snapshot.flat.find((element) => element.identifier === identifier);
	if (!found) throw new Error(`no element ${identifier}`);
	return found;
}

/** Record against `base`: press sign-in, fill email, wait for the title. */
function recorded(base: Snapshot = screen(), extras: NewStep[] = []): Flow {
	const hash = snapshotHash(base);
	return flowOf([
		{ kind: "press", at: 1, target: targetFromElement(elementNamed(base, "sign-in"), base), snapshotHash: hash },
		{
			kind: "fill",
			at: 2,
			target: targetFromElement(elementNamed(base, "email"), base),
			text: "me@example.com",
			snapshotHash: hash,
		},
		{ kind: "wait", at: 3, target: targetFromElement(elementNamed(base, "title"), base) },
		...extras,
	]);
}

function harness(current: Snapshot, overrides: Partial<ReplayDeps> = {}) {
	const driver = fakeDriver({ screens: [current] });
	const calls: string[] = [];
	const texts: string[] = [];
	const logs: string[] = [];
	const settles: { quietMs?: number; timeoutMs?: number }[] = [];
	let clock = 0;
	const deps: ReplayDeps = {
		driver,
		snapshot: () => driver.snapshot(),
		act: recordingActors(driver, calls, texts),
		settle: async (options) => {
			settles.push(options);
			return ok(undefined);
		},
		now: () => {
			clock += 5;
			return clock;
		},
		log: (line) => void logs.push(line),
		...overrides,
	};
	return { deps, driver, calls, texts, logs, settles };
}

describe("replayFlow", () => {
	test("passes on an unchanged screen and taps where the element is", async () => {
		const { deps, driver, calls } = harness(screen());
		const outcome = await replayFlow(recorded(), deps);
		expect(outcome).toMatchObject({ status: "passed", steps: 3, warnings: [] });
		expect(calls).toEqual(["0 press", "1 fill", "2 wait"]);
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 195, y: 324 });
	});

	test("never hands back a rewritten flow unless updateSnapshots", async () => {
		const flow = recorded();
		const before = JSON.stringify(flow);
		const { deps } = harness(screen());
		const outcome = await replayFlow(flow, deps);
		expect(outcome.status === "passed" && outcome.updated).toBeUndefined();
		expect(JSON.stringify(flow)).toBe(before);
	});

	test("falls to the next chain entry when an id no longer matches exactly one element", async () => {
		const base = screen();
		const flow = recorded(base);
		const crowded = screen({ extra: true });
		const { deps } = harness(snapshotOf(crowded.elements.map(toSpec)));
		const outcome = await replayFlow(flow, deps);
		// two "sign-in" ids and two "Sign in" labels: nothing is exactly one, but the path (index 2) still names the button
		expect(outcome.status).toBe("passed");
	});

	test("an id that moved to a new label still resolves by role + label", async () => {
		const flow = recorded();
		const renamed = snapshotOf([
			el("text", { id: "title", label: "Welcome", frame: { x: 24, y: 100, width: 342, height: 40 } }),
			el("textfield", { id: "email", frame: { x: 24, y: 200, width: 342, height: 44 } }),
			el("button", { label: "Sign in", frame: SIGN_IN }),
		]);
		const resolved: string[] = [];
		const { deps } = harness(renamed, {
			act: {
				...recordingActors(fakeDriver({ screens: [renamed] }), []),
				press: async (_step, ctx) => {
					resolved.push(ctx.targets.target?.via ?? "none");
					return ok(undefined);
				},
			},
		});
		const outcome = await replayFlow(flow, deps);
		expect(outcome.status).toBe("passed");
		expect(resolved).toEqual(["role-label"]);
	});

	test("a vanished selector is a replay_divergence naming the step and carrying a screen excerpt", async () => {
		const { deps, calls } = harness(screen({ signIn: null }));
		const flow = recorded();
		const outcome = await replayFlow(flow, deps);
		expect(outcome.status).toBe("diverged");
		if (outcome.status !== "diverged") return;
		expect(outcome.code).toBe("replay_divergence");
		expect(outcome.step).toBe(0);
		expect(outcome.kind).toBe("press");
		expect(outcome.reason).toContain("id=sign-in");
		expect(outcome.snapshot).toContain("id=email");
		expect(calls).toEqual([]);
	});

	test("divergence on a later step stops there; earlier steps already ran", async () => {
		const base = screen();
		const hash = snapshotHash(base);
		const flow = flowOf([
			{ kind: "press", at: 1, target: targetFromElement(elementNamed(base, "sign-in"), base), snapshotHash: hash },
			{ kind: "press", at: 2, target: targetFromElement(elementNamed(base, "sign-in"), base) },
			{ kind: "home", at: 3 },
		]);
		const { deps, calls, driver } = harness(base, {
			act: {
				...recordingActors(fakeDriver({ screens: [base] }), []),
				press: async (step) => {
					calls.push(`${step.i} press`);
					if (step.i === 0) driver.set(screen({ signIn: null }));
					return ok(undefined);
				},
			},
		});
		const outcome = await replayFlow(flow, deps);
		expect(outcome).toMatchObject({ status: "diverged", step: 1 });
		expect(calls).toEqual(["0 press"]);
	});

	test("the landmark must be the same role within 40 pt", async () => {
		const near = harness(screen({ signIn: { y: 330 } }));
		expect((await replayFlow(recorded(), near.deps)).status).toBe("passed");

		const far = harness(screen({ signIn: { y: 420 } }));
		const outcome = await replayFlow(recorded(), far.deps);
		expect(outcome.status).toBe("diverged");
		if (outcome.status === "diverged") expect(outcome.reason).toContain("moved 120 pt");

		const base = screen();
		const asLink = snapshotOf([
			el("text", { id: "title", label: "Welcome", frame: { x: 24, y: 100, width: 342, height: 40 } }),
			el("textfield", { id: "email", frame: { x: 24, y: 200, width: 342, height: 44 } }),
			el("link", { id: "sign-in", label: "Sign in", frame: SIGN_IN }),
		]);
		const flow = recorded(base);
		const wrongRole = await replayFlow(flow, harness(asLink).deps);
		expect(wrongRole.status).toBe("diverged");
		if (wrongRole.status === "diverged") expect(wrongRole.reason).toContain("link");
	});

	test("a changed screen is a drift warning, not a failure", async () => {
		const flow = recorded();
		const changed = snapshotOf([
			...screen().elements.map(toSpec),
			el("text", { label: "New banner", frame: { x: 0, y: 0, width: 390, height: 20 } }),
		]);
		const { deps, logs } = harness(changed);
		const outcome = await replayFlow(flow, deps);
		expect(outcome.status).toBe("passed");
		if (outcome.status !== "passed") return;
		expect(outcome.warnings.map((warning) => warning.step)).toEqual([0, 1]);
		expect(outcome.warnings[0]?.expected).toBe(flow.steps[0]?.snapshotHash ?? "");
		expect(logs.some((line) => line.startsWith("drift step 0"))).toBe(true);
	});

	test("--from skips earlier steps", async () => {
		const { deps, calls } = harness(screen(), { from: 2 });
		const outcome = await replayFlow(recorded(), deps);
		expect(outcome).toMatchObject({ status: "passed", steps: 1 });
		expect(calls).toEqual(["2 wait"]);
	});

	test("updateSnapshots returns a refreshed flow: new hash, new landmark; the input stays put", async () => {
		const flow = recorded();
		const moved = screen({ signIn: { y: 320 } });
		const { deps } = harness(moved, { updateSnapshots: true });
		const outcome = await replayFlow(flow, deps);
		expect(outcome.status).toBe("passed");
		if (outcome.status !== "passed" || !outcome.updated) throw new Error("expected an updated flow");
		const first = outcome.updated.steps[0];
		expect(first?.snapshotHash).toBe(snapshotHash(moved));
		const target = first?.kind === "press" ? first.target : undefined;
		expect(target?.kind === "selector" && target.landmark.frame.y).toBe(320);
		const original = flow.steps[0];
		expect(original?.kind === "press" && original.target.kind === "selector" && original.target.landmark.frame.y).toBe(
			300
		);
	});

	test("replays the recorded --settle after the action", async () => {
		const base = screen();
		const flow = flowOf([
			{
				kind: "press",
				at: 1,
				target: targetFromElement(elementNamed(base, "sign-in"), base),
				settle: { quietMs: 250, timeoutMs: 3000 },
			},
			{ kind: "home", at: 2 },
		]);
		const { deps, settles } = harness(base);
		await replayFlow(flow, deps);
		expect(settles).toEqual([{ quietMs: 250, timeoutMs: 3000 }]);
	});

	test("secrets are looked up in env; a missing one fails the step before anything runs", async () => {
		const base = screen();
		const flow = flowOf([
			{
				kind: "fill",
				at: 1,
				target: targetFromElement(elementNamed(base, "email"), base),
				text: { secret: "PASSWORD" },
			},
		]);

		const missing = harness(base);
		const failed = await replayFlow(flow, missing.deps);
		expect(failed).toMatchObject({ status: "failed", step: 0, error: { code: "missing_secret" } });
		expect(missing.calls).toEqual([]);

		const present = harness(base, { env: { WARDEN_UI_SECRET_PASSWORD: "hunter2" } });
		await replayFlow(flow, present.deps);
		expect(present.texts).toEqual(["hunter2"]);
	});

	test("an action that fails ends the replay as failed with the executor's error", async () => {
		const { deps } = harness(screen(), {
			act: {
				...recordingActors(fakeDriver({ screens: [screen()] }), []),
				fill: async () => ({ success: false, error: { code: "E_HID", message: "keyboard unavailable" } }),
			},
		});
		const outcome = await replayFlow(recorded(), deps);
		expect(outcome).toMatchObject({ status: "failed", step: 1, kind: "fill", error: { code: "E_HID" } });
	});

	test("steps without targets or a recorded hash never take a snapshot; coordinate targets need none either", async () => {
		const flow = flowOf([
			{ kind: "home", at: 1 },
			{ kind: "press", at: 2, target: { kind: "coords", x: 10, y: 20, warning: "by coordinates" } },
		]);
		const { deps, driver, logs } = harness(screen());
		const outcome = await replayFlow(flow, deps);
		expect(outcome.status).toBe("passed");
		expect(driver.callsOf("snapshot")).toHaveLength(0);
		expect(driver.callsOf("tap")[0]?.point).toEqual({ x: 10, y: 20 });
		expect(logs.some((line) => line.includes("by coordinates"))).toBe(true);
	});

	test("a snapshot failure on a step with a target is a failed step", async () => {
		const { deps } = harness(screen(), {
			snapshot: async () => ({ success: false, error: { code: "E_AX_UNAVAILABLE", message: "no ax" } }),
		});
		const outcome = await replayFlow(recorded(), deps);
		expect(outcome).toMatchObject({ status: "failed", step: 0, error: { code: "E_AX_UNAVAILABLE" } });
	});
});

/** Re-spec a built element so `snapshotOf` can lay a tree out again (identifier → id). */
function toSpec(element: Element): ReturnType<typeof el> {
	return el(element.role, {
		...(element.label !== undefined && { label: element.label }),
		...(element.identifier !== undefined && { id: element.identifier }),
		frame: element.frame,
		children: element.children.map(toSpec),
	});
}

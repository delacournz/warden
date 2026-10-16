import { afterEach, describe, expect, test } from "bun:test";
import { el, failWith, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import type { Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import { readLastSnapshot, readState } from "../agent-ui/state";
import { cleanupHarnesses, doc, type Harness, harness, LOGIN, UDID } from "./ui.testing";

afterEach(cleanupHarnesses);

const SPINNER = [el("text", { label: "Loading" })];
const DONE = [el("text", { label: "Welcome back" }), el("button", { label: "Continue", id: "continue" })];

/** A screen source that shows `before` for the first `n` snapshots and `after` from then on. */
function after(n: number, before: Parameters<typeof snapshotOf>[0], then: Parameters<typeof snapshotOf>[0]) {
	let looks = 0;
	return () => snapshotOf(looks++ < n ? before : then);
}

const snapshotCalls = (h: Harness) => h.driver.callsOf("snapshot").length;

describe("wait <selector>", () => {
	test("already there: matches at once, stores the screen and prints the fresh @ref", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("wait", "id=sign-in-submit", "--json")).toBe(0);
		const out = doc(h.c);
		expect(out).toMatchObject({
			ok: true,
			command: "wait",
			generation: 1,
			result: { matched: true, ref: "@e4", waitedMs: 0, element: { role: "button", id: "sign-in-submit" } },
		});
		expect(readLastSnapshot(h.c, UDID)?.generation).toBe(1);
		expect(readState(h.c, UDID).generation).toBe(1);
	});

	test("text output: the element line with its ref and how long it took", async () => {
		const h = harness(after(2, SPINNER, DONE));
		expect(await h.run("wait", "id=continue")).toBe(0);
		expect(h.c.stdout.join("\n")).toBe('waited 200 ms: @e2 [button] "Continue" id=continue enabled (0,50 390×44)');
	});

	test("polls every 100 ms and reports the time it took", async () => {
		const h = harness(after(3, SPINNER, DONE));
		expect(await h.run("wait", "id=continue", "--json")).toBe(0);
		expect(doc(h.c).result.waitedMs).toBe(300);
		expect(snapshotCalls(h)).toBe(4);
	});

	test("the ref printed by wait works for the next action without another snapshot", async () => {
		const h = harness(after(1, SPINNER, DONE));
		await h.run("wait", "id=continue", "--json");
		const ref: string = doc(h.c).result.ref;
		const before = snapshotCalls(h);
		expect(await h.run("press", ref)).toBe(0);
		expect(snapshotCalls(h)).toBe(before);
		expect(h.driver.callsOf("tap")).toHaveLength(1);
	});

	test("never appears: wait_target_absent after --timeout, deadline within one tick", async () => {
		const h = harness([snapshotOf(SPINNER)]);
		expect(await h.run("wait", "id=continue", "--timeout", "1000", "--json")).toBe(1);
		const error = doc(h.c).error;
		expect(error.code).toBe("wait_target_absent");
		expect(error.details.matched).toBe(false);
		expect(error.details.reason).toBe("wait_target_absent");
		expect(error.details.waitedMs).toBeGreaterThanOrEqual(1000);
		expect(error.details.waitedMs).toBeLessThanOrEqual(1100);
		expect(snapshotCalls(h)).toBe(11);
	});

	test("backs off to 250 ms after the first second", async () => {
		const h = harness([snapshotOf(SPINNER)]);
		expect(await h.run("wait", "id=continue", "--timeout", "3000", "--json")).toBe(1);
		expect(doc(h.c).error.details.waitedMs).toBe(3000);
		expect(snapshotCalls(h)).toBe(19);
	});

	test("an element that shows up after the first second is seen on a 250 ms tick", async () => {
		const h = harness(after(12, SPINNER, DONE));
		expect(await h.run("wait", "id=continue", "--json")).toBe(0);
		expect(doc(h.c).result.waitedMs).toBe(1500);
		expect(snapshotCalls(h)).toBe(13);
	});

	test("wait absent and wait text back off the same way", async () => {
		const gone = harness(after(12, SPINNER, DONE));
		expect(await gone.run("wait", "absent", "text=Loading", "--json")).toBe(0);
		expect(doc(gone.c).result.waitedMs).toBe(1500);
		const shown = harness(after(12, SPINNER, DONE));
		expect(await shown.run("wait", "text", "Welcome back", "--json")).toBe(0);
		expect(doc(shown.c).result.waitedMs).toBe(1500);
	});

	test("a deadline inside the slow phase still ends exactly on it", async () => {
		const h = harness([snapshotOf(SPINNER)]);
		await h.run("wait", "id=continue", "--timeout", "1100", "--json");
		expect(doc(h.c).error.details.waitedMs).toBe(1100);
		expect(snapshotCalls(h)).toBe(12);
	});

	test("the default timeout is 5000 ms", async () => {
		const h = harness([snapshotOf(SPINNER)]);
		expect(await h.run("wait", "id=continue", "--json")).toBe(1);
		const waited = doc(h.c).error.details.waitedMs;
		expect(waited).toBeGreaterThanOrEqual(5000);
		expect(waited).toBeLessThanOrEqual(5100);
	});

	test("a timeout that is not a multiple of 100 ends exactly at the deadline", async () => {
		const h = harness([snapshotOf(SPINNER)]);
		await h.run("wait", "id=continue", "--timeout", "250", "--json");
		expect(doc(h.c).error.details.waitedMs).toBe(250);
	});

	test("on the tree but hidden: wait_target_hidden", async () => {
		const h = harness([snapshotOf([el("button", { label: "Continue", id: "continue", hidden: true })])]);
		expect(await h.run("wait", "id=continue", "--timeout", "200", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("wait_target_hidden");
	});

	test("off the screen counts as not visible", async () => {
		const far = el("button", { label: "Far", id: "far", frame: { x: 0, y: 2000, width: 390, height: 44 } });
		const h = harness([snapshotOf([far])]);
		expect(await h.run("wait", "id=far", "--timeout", "100", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("wait_target_hidden");
	});

	test("a bad selector is a usage error before any snapshot", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("wait", "colour=red", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
		expect(snapshotCalls(h)).toBe(0);
	});

	test("an engine failure exits 3, not 1", async () => {
		const h = harness([snapshotOf(LOGIN)], {
			onCall: (call) => (call.method === "snapshot" ? failWith("E_AX_UNAVAILABLE") : undefined),
		});
		expect(await h.run("wait", "id=email", "--json")).toBe(3);
		expect(doc(h.c).error.code).toBe("engine_unavailable");
	});
});

describe("wait absent", () => {
	test("returns once nothing visible matches, and stores the screen", async () => {
		const h = harness(after(2, SPINNER, DONE));
		expect(await h.run("wait", "absent", "text=Loading", "--json")).toBe(0);
		const out = doc(h.c);
		expect(out.result).toEqual({ matched: true, waitedMs: 200 });
		expect(out.generation).toBe(1);
		expect(h.c.stdout).toHaveLength(1);
	});

	test("text output", async () => {
		const h = harness([snapshotOf(DONE)]);
		expect(await h.run("wait", "absent", "text=Loading")).toBe(0);
		expect(h.c.stdout.join("\n")).toBe("gone after 0 ms");
	});

	test("still visible at the deadline: wait_target_present", async () => {
		const h = harness([snapshotOf(SPINNER)]);
		expect(await h.run("wait", "absent", "text=Loading", "--timeout", "300", "--json")).toBe(1);
		const error = doc(h.c).error;
		expect(error.code).toBe("wait_target_present");
		expect(error.details.waitedMs).toBe(300);
	});

	test("a hidden element counts as absent", async () => {
		const h = harness([snapshotOf([el("text", { label: "Loading", hidden: true })])]);
		expect(await h.run("wait", "absent", "text=Loading")).toBe(0);
	});

	test("needs a selector", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("wait", "absent", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
	});
});

describe("wait text", () => {
	test("finds the innermost element showing the text and prints its ref", async () => {
		const h = harness(after(1, SPINNER, DONE));
		expect(await h.run("wait", "text", "Welcome back", "--json")).toBe(0);
		expect(doc(h.c).result).toMatchObject({ matched: true, ref: "@e1", waitedMs: 100, element: { role: "text" } });
	});

	test("also matches a value", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("wait", "text", "a@b.co", "--json")).toBe(0);
		expect(doc(h.c).result.element.id).toBe("email");
	});

	test("hidden text does not count; a miss is wait_text_absent", async () => {
		const h = harness([snapshotOf([el("text", { label: "Welcome back", hidden: true })])]);
		expect(await h.run("wait", "text", "Welcome back", "--timeout", "200", "--json")).toBe(1);
		const error = doc(h.c).error;
		expect(error.code).toBe("wait_text_absent");
		expect(error.details.waitedMs).toBe(200);
	});

	test("needs text", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("wait", "text", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
	});
});

describe("wait stable", () => {
	test("returns once the screen has held still for the quiet period (default 250 ms)", async () => {
		let n = 0;
		const h = harness(() => snapshotOf([el("text", { label: n++ < 3 ? `tick ${n}` : "still" })]));
		expect(await h.run("wait", "stable", "--json")).toBe(0);
		const out = doc(h.c);
		expect(out.result.matched).toBe(true);
		expect(out.result.waitedMs).toBeGreaterThanOrEqual(250);
		expect(out.generation).toBe(1);
	});

	test("an explicit quiet period", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("wait", "stable", "500", "--json")).toBe(0);
		expect(doc(h.c).result.waitedMs).toBeGreaterThanOrEqual(500);
		expect(doc(h.c).result.waitedMs).toBeLessThanOrEqual(600);
	});

	test("a screen that never holds still: wait_not_stable at the deadline", async () => {
		let n = 0;
		const h = harness(() => snapshotOf([el("text", { label: `tick ${n++}` })]));
		expect(await h.run("wait", "stable", "--timeout", "600", "--json")).toBe(1);
		const error = doc(h.c).error;
		expect(error.code).toBe("wait_not_stable");
		expect(error.details.waitedMs).toBeGreaterThanOrEqual(600);
		expect(error.details.waitedMs).toBeLessThanOrEqual(700);
	});

	test("the number must be a positive integer", async () => {
		const h = harness([snapshotOf(LOGIN)]);
		expect(await h.run("wait", "stable", "soon", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
	});
});

const FORM: Parameters<typeof snapshotOf>[0] = [
	el("window", {
		children: [
			el("button", { label: "Sign in", id: "sign-in-submit", hittable: true }),
			el("button", { label: "Cancel", id: "cancel", enabled: false }),
			el("switch", { label: "Remember me", id: "remember", checked: true }),
			el("cell", { label: "Row", id: "row", selected: true }),
			el("textfield", { label: "Email", id: "email", value: "a@b.co", focused: true }),
			el("text", { label: "Hidden note", id: "note", hidden: true }),
		],
	}),
];

describe("is", () => {
	const cases: [string, string, boolean][] = [
		["id=sign-in-submit", "visible", true],
		["id=note", "visible", false],
		["id=sign-in-submit", "hittable", true],
		["id=email", "hittable", false],
		["id=sign-in-submit", "enabled", true],
		["id=cancel", "enabled", false],
		["id=remember", "checked", true],
		["id=sign-in-submit", "checked", false],
		["id=row", "selected", true],
		["id=cancel", "selected", false],
		["id=email", "focused", true],
		["id=sign-in-submit", "focused", false],
	];
	for (const [selector, state, expected] of cases) {
		test(`${selector} ${state}: ${expected} exits ${expected ? 0 : 1}`, async () => {
			const h = harness([snapshotOf(FORM)]);
			expect(await h.run("is", selector, state)).toBe(expected ? 0 : 1);
			expect(h.c.stdout.join("\n")).toBe(String(expected));
		});
	}

	test("--json: a false answer is still ok:true with one document, exit 1", async () => {
		const h = harness([snapshotOf(FORM)]);
		expect(await h.run("is", "id=cancel", "enabled", "--json")).toBe(1);
		expect(doc(h.c)).toMatchObject({
			ok: true,
			command: "is",
			result: { matched: false, state: "enabled", reason: "not_enabled", waitedMs: 0, element: { id: "cancel" } },
		});
	});

	test("--json true", async () => {
		const h = harness([snapshotOf(FORM)]);
		expect(await h.run("is", "id=sign-in-submit", "visible", "--json")).toBe(0);
		const result = doc(h.c).result;
		expect(result).toMatchObject({ matched: true, state: "visible" });
		expect(result.reason).toBeUndefined();
	});

	test("nothing matches: false with reason target_absent, exit 1", async () => {
		const h = harness([snapshotOf(FORM)]);
		expect(await h.run("is", "id=nope", "visible", "--json")).toBe(1);
		const out = doc(h.c);
		expect(out.ok).toBe(true);
		expect(out.result).toMatchObject({ matched: false, reason: "target_absent" });
		expect(out.result.element).toBeUndefined();
	});

	test("takes one look and never waits", async () => {
		const h = harness([snapshotOf(FORM)]);
		await h.run("is", "id=nope", "visible");
		expect(snapshotCalls(h)).toBe(1);
		expect(h.clock.t).toBe(1_000_000);
	});

	test("a selector made of several words", async () => {
		const h = harness([snapshotOf(FORM)]);
		expect(await h.run("is", "role=button", "label=Cancel", "enabled")).toBe(1);
	});

	test("unknown state / missing selector: usage, exit 1", async () => {
		const h = harness([snapshotOf(FORM)]);
		expect(await h.run("is", "id=email", "shiny", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
		expect(await h.run("is", "visible", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
	});

	test("an engine failure is the only way past exit 1", async () => {
		const h = harness([snapshotOf(FORM)], {
			onCall: (call) => (call.method === "snapshot" ? failWith("E_HELPER_CRASHED") : undefined),
		});
		expect(await h.run("is", "id=email", "visible", "--json")).toBe(3);
		expect(doc(h.c).error.code).toBe("engine_unavailable");
	});
});

describe("get", () => {
	const screen = (): Snapshot => snapshotOf(LOGIN);

	test("text, value, label, id, role", async () => {
		const h = harness([screen()]);
		const get = async (selector: string, prop: string) => {
			expect(await h.run("get", selector, prop)).toBe(0);
			return h.c.stdout.join("\n");
		};
		expect(await get("id=sign-in-submit", "text")).toBe("Sign in");
		expect(await get("id=email", "value")).toBe("a@b.co");
		expect(await get("id=email", "label")).toBe("Email");
		expect(await get('label="Sign in"', "id")).toBe("sign-in-submit");
		expect(await get("id=sign-in-submit", "role")).toBe("button");
	});

	test("frame prints x y width height; --json has the object", async () => {
		const h = harness([screen()]);
		expect(await h.run("get", "id=sign-in-submit", "frame")).toBe(0);
		expect(h.c.stdout.join("\n")).toBe("0 150 390 44");
		await h.run("get", "id=sign-in-submit", "frame", "--json");
		expect(doc(h.c).result).toMatchObject({
			matched: true,
			property: "frame",
			value: { x: 0, y: 150, width: 390, height: 44 },
		});
	});

	test("text of a container falls back to what is inside", async () => {
		const h = harness([
			snapshotOf([
				el("cell", { id: "row", children: [el("text", { label: "Ada" }), el("text", { label: "Lovelace" })] }),
			]),
		]);
		await h.run("get", "id=row", "text");
		expect(h.c.stdout.join("\n")).toBe("Ada Lovelace");
	});

	test("count: how many match, 0 is not an error", async () => {
		const h = harness([snapshotOf(FORM)]);
		expect(await h.run("get", "role=button", "count")).toBe(0);
		expect(h.c.stdout.join("\n")).toBe("2");
		expect(await h.run("get", "id=nope", "count", "--json")).toBe(0);
		expect(doc(h.c).result).toMatchObject({ matched: false, property: "count", value: 0 });
	});

	test("no match: target_not_found, exit 1", async () => {
		const h = harness([screen()]);
		expect(await h.run("get", "id=nope", "text", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("target_not_found");
	});

	test("unknown property / no selector: usage", async () => {
		const h = harness([screen()]);
		expect(await h.run("get", "id=email", "colour", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
		expect(await h.run("get", "count", "--json")).toBe(1);
		expect(doc(h.c).error.code).toBe("usage");
	});

	test("does not bump the generation", async () => {
		const h = harness([screen()]);
		await h.run("get", "id=email", "value");
		expect(readState(h.c, UDID).generation).toBe(0);
	});
});

import { describe, expect, test } from "bun:test";
import { el, fakeDriver, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import type { Snapshot } from "@delacour/warden-e2e/driver/driver.types";
import { snapshotHash } from "@delacour/warden-e2e/driver/settle";
import type { StoredSnapshot } from "./state";
import { parseTarget, REF_MAX_AGE_MS, resolveTarget, type Target } from "./target";

const T0 = 1_000_000;

function stored(snapshot: Snapshot, takenAt = T0, generation = 4): StoredSnapshot {
	return { generation, takenAt, hash: snapshotHash(snapshot), snapshot };
}

function unwrapTarget(text: string): Target {
	const parsed = parseTarget(text);
	if (!parsed.success) throw new Error(parsed.error.message);
	return parsed.data;
}

describe("parseTarget", () => {
	test("@eN, `x y`, selectors", () => {
		expect(unwrapTarget("@e12")).toEqual({ kind: "ref", ref: "@e12" });
		expect(unwrapTarget("120 340.5")).toEqual({ kind: "point", point: { x: 120, y: 340.5 } });
		expect(unwrapTarget("120,340")).toEqual({ kind: "point", point: { x: 120, y: 340 } });
		expect(unwrapTarget('id=go label="Sign in" nth=1')).toMatchObject({
			kind: "selector",
			selector: { id: { value: "go" }, label: { value: "Sign in" }, nth: 1 },
		});
	});

	test("garbage is a usage error with the grammar as hint", () => {
		const parsed = parseTarget("@e0");
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.code).toBe("usage");
			expect(parsed.error.hint).toContain("@eN");
		}
	});
});

describe("resolveTarget: coordinates", () => {
	test("a point needs no snapshot and no driver call", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([])] });
		const res = await resolveTarget(unwrapTarget("10 20"), { lastSnapshot: undefined, now: T0, verify: false, driver });
		expect(res).toEqual({ success: true, data: { kind: "point", point: { x: 10, y: 20 } } });
		expect(driver.calls).toEqual([]);
	});
});

describe("resolveTarget: @eN", () => {
	const screen = () =>
		snapshotOf([
			el("text", { label: "Title" }),
			el("button", { label: "Sign in", id: "go", frame: { x: 20, y: 300, width: 200, height: 40 } }),
		]);

	test("recent ref: taken from the stored snapshot, no device call; tap point = frame centre", async () => {
		const driver = fakeDriver({ screens: [screen()] });
		const res = await resolveTarget(unwrapTarget("@e2"), {
			lastSnapshot: stored(screen()),
			now: T0 + REF_MAX_AGE_MS,
			verify: false,
			driver,
		});
		expect(res).toMatchObject({ success: true, data: { ref: "@e2", point: { x: 120, y: 320 } } });
		expect(driver.calls).toEqual([]);
	});

	test("older than 30 s: re-verified by id against a fresh snapshot, using the fresh frame", async () => {
		const moved = snapshotOf([
			el("text", { label: "Title" }),
			el("text", { label: "Banner" }),
			el("button", { label: "Sign in", id: "go", frame: { x: 20, y: 400, width: 200, height: 40 } }),
		]);
		const driver = fakeDriver({ screens: [moved] });
		const res = await resolveTarget(unwrapTarget("@e2"), {
			lastSnapshot: stored(screen()),
			now: T0 + REF_MAX_AGE_MS + 1,
			verify: false,
			driver,
		});
		expect(res).toMatchObject({ success: true, data: { verified: true, point: { x: 120, y: 420 } } });
		expect(driver.callsOf("snapshot")).toHaveLength(1);
	});

	test("--verify re-checks a recent ref too", async () => {
		const driver = fakeDriver({ screens: [screen()] });
		const res = await resolveTarget(unwrapTarget("@e2"), {
			lastSnapshot: stored(screen()),
			now: T0,
			verify: true,
			driver,
		});
		expect(res).toMatchObject({ success: true, data: { verified: true } });
	});

	test("falls back to role+label, then path, when there is no id", async () => {
		const plain = snapshotOf([el("text", { label: "Title" }), el("button", { label: "Done" })]);
		const reordered = snapshotOf([
			el("button", { label: "Done", frame: { x: 0, y: 500, width: 100, height: 40 } }),
			el("text", { label: "Title" }),
		]);
		const byLabel = await resolveTarget(unwrapTarget("@e2"), {
			lastSnapshot: stored(plain),
			now: T0,
			verify: true,
			driver: fakeDriver({ screens: [reordered] }),
		});
		expect(byLabel).toMatchObject({ success: true, data: { point: { x: 50, y: 520 } } });

		const relabelled = snapshotOf([el("text", { label: "Title" }), el("button", { label: "Finished" })]);
		const byPath = await resolveTarget(unwrapTarget("@e2"), {
			lastSnapshot: stored(plain),
			now: T0,
			verify: true,
			driver: fakeDriver({ screens: [relabelled] }),
		});
		expect(byPath.success).toBe(true);
	});

	test("after 30 s on a different screen: stale_ref (exit 4) with the snapshot-again hint", async () => {
		const other = snapshotOf([el("text", { label: "Settings" }), el("switch", { label: "Dark mode", id: "dark" })]);
		const res = await resolveTarget(unwrapTarget("@e2"), {
			lastSnapshot: stored(screen()),
			now: T0 + 31_000,
			verify: false,
			driver: fakeDriver({ screens: [other] }),
		});
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.code).toBe("stale_ref");
			expect(res.error.hint).toBe("run `warden ui snapshot` again");
			expect(res.error.message).toContain("@e2");
			expect(res.error.message).toContain("no longer on screen");
		}
	});

	test("a ref beyond the stored snapshot, or with no snapshot at all, is stale_ref", async () => {
		const driver = fakeDriver({ screens: [screen()] });
		const missing = await resolveTarget(unwrapTarget("@e9"), {
			lastSnapshot: stored(screen()),
			now: T0,
			verify: false,
			driver,
		});
		expect(!missing.success && missing.error.code).toBe("stale_ref");
		const none = await resolveTarget(unwrapTarget("@e1"), { lastSnapshot: undefined, now: T0, verify: false, driver });
		expect(!none.success && none.error.code).toBe("stale_ref");
	});

	test("a driver failure while verifying surfaces as a ui error", async () => {
		const driver = fakeDriver({
			screens: [screen()],
			onCall: () => ({ error: { code: "E_HELPER_CRASHED", message: "boom", retryable: true } }),
		});
		const res = await resolveTarget(unwrapTarget("@e2"), {
			lastSnapshot: stored(screen()),
			now: T0,
			verify: true,
			driver,
		});
		expect(!res.success && res.error.code).toBe("engine_unavailable");
	});
});

describe("resolveTarget: selectors", () => {
	const SCREEN = snapshotOf([
		el("button", { label: "Save as…", id: "save-as", frame: { x: 0, y: 0, width: 300, height: 60 } }),
		el("button", { label: "Save", id: "save", frame: { x: 0, y: 100, width: 100, height: 40 } }),
		el("button", { label: "Save all", frame: { x: 0, y: 200, width: 100, height: 40 }, hidden: true }),
		el("button", { label: "Save", frame: { x: 0, y: 300, width: 100, height: 40 } }),
	]);
	const resolveIn = (text: string) =>
		resolveTarget(unwrapTarget(text), {
			lastSnapshot: undefined,
			now: T0,
			verify: false,
			driver: fakeDriver({ screens: [SCREEN] }),
		});

	test("always matched against a fresh snapshot", async () => {
		const driver = fakeDriver({ screens: [SCREEN] });
		await resolveTarget(unwrapTarget("id=save"), { lastSnapshot: undefined, now: T0, verify: false, driver });
		expect(driver.callsOf("snapshot")).toHaveLength(1);
	});

	test("ambiguity resolves to the most specific visible match: exact text first, then smallest frame, then reading order", async () => {
		const exact = await resolveIn("label=save");
		expect(exact).toMatchObject({ success: true, data: { element: { identifier: "save" }, point: { x: 50, y: 120 } } });
		const first = await resolveIn("role=button");
		expect(first).toMatchObject({ success: true, data: { element: { identifier: "save" } } });
	});

	test("hidden matches lose to visible ones", async () => {
		const res = await resolveIn("label=all");
		expect(res).toMatchObject({ success: true, data: { element: { label: "Save all" } } });
	});

	test("nth= picks the n-th match in reading order, including ties", async () => {
		const second = await resolveIn("label=save nth=1");
		expect(second).toMatchObject({ success: true, data: { element: { identifier: "save" } } });
		const last = await resolveIn("label=save nth=3");
		expect(last).toMatchObject({ success: true, data: { element: { label: "Save", frame: { y: 300 } } } });
	});

	test("nothing matched, or nth out of range: target_not_found (exit 1) with a hint", async () => {
		const none = await resolveIn("id=nope");
		expect(none.success).toBe(false);
		if (!none.success) {
			expect(none.error.code).toBe("target_not_found");
			expect(none.error.message).toBe("id=nope matched nothing");
			expect(none.error.hint).toContain("snapshot");
		}
		const far = await resolveIn("id=save nth=2");
		expect(!far.success && far.error.message).toBe("id=save nth=2: only 1 match, no nth=2");
	});
});

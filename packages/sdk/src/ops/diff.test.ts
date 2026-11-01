import { describe, expect, test } from "bun:test";
import { driverFixtures } from "@delacour/warden-driver/testing/driver";
import { diffSnapshots, renderDiff } from "./diff";

describe("diffSnapshots", () => {
	test("identical screens: everything unchanged", () => {
		const screen = () =>
			driverFixtures.snapshotOf([
				driverFixtures.el("button", { label: "Sign in", id: "go" }),
				driverFixtures.el("text", { label: "Hi" }),
			]);
		const diff = diffSnapshots(screen(), screen());
		expect(diff).toEqual({ added: [], removed: [], unchanged: 2 });
		expect(renderDiff(diff)).toEqual(["= 2 unchanged"]);
	});

	test("keyed by id: a relabelled element is a -/+ pair, the rest is untouched even when reordered", () => {
		const hi = { label: "Hi", frame: { x: 0, y: 100, width: 390, height: 44 } };
		const at = (y: number) => ({ x: 0, y, width: 390, height: 44 });
		const before = driverFixtures.snapshotOf([
			driverFixtures.el("button", { label: "Sign in", id: "go", frame: at(0) }),
			driverFixtures.el("text", hi),
		]);
		const after = driverFixtures.snapshotOf([
			driverFixtures.el("text", hi),
			driverFixtures.el("button", { label: "Sign out", id: "go", frame: at(0) }),
		]);
		const diff = diffSnapshots(before, after);
		expect(diff.removed.map((e) => e.line)).toEqual(['[button] "Sign in" id=go enabled (0,0 390×44)']);
		expect(diff.added.map((e) => e.line)).toEqual(['[button] "Sign out" id=go enabled (0,0 390×44)']);
		expect(diff.unchanged).toBe(1);
	});

	test("falls back to role+label when there is no id", () => {
		const before = driverFixtures.snapshotOf([driverFixtures.el("text", { label: "Count", value: "1" })]);
		const after = driverFixtures.snapshotOf([driverFixtures.el("text", { label: "Count", value: "2" })]);
		const diff = diffSnapshots(before, after);
		expect(diff.removed).toHaveLength(1);
		expect(diff.added).toHaveLength(1);
		expect(diff.unchanged).toBe(0);
		expect(diff.added[0]?.line).toContain('value="2"');
	});

	test("falls back to path when neither id nor label exist", () => {
		const frame = { x: 0, y: 0, width: 100, height: 40 };
		const before = driverFixtures.snapshotOf([driverFixtures.el("other", { frame })]);
		const moved = driverFixtures.snapshotOf([driverFixtures.el("other", { frame: { ...frame, x: 10 } })]);
		const diff = diffSnapshots(before, moved);
		expect(diff.removed).toHaveLength(1);
		expect(diff.added).toHaveLength(1);
		expect(diff.unchanged).toBe(0);
		expect(diffSnapshots(before, driverFixtures.snapshotOf([driverFixtures.el("other", { frame })])).unchanged).toBe(1);
	});

	test("a changed element is -/+ (new line carries its ref); an untouched one is counted", () => {
		const before = driverFixtures.snapshotOf([
			driverFixtures.el("text", { label: "Old" }),
			driverFixtures.el("button", { label: "Keep", id: "keep" }),
		]);
		const after = driverFixtures.snapshotOf([
			driverFixtures.el("text", { label: "New" }),
			driverFixtures.el("button", { label: "Keep", id: "keep" }),
		]);
		const refs = new Map(after.flat.map((e, i) => [e.id, `@e${i + 1}`]));
		expect(renderDiff(diffSnapshots(before, after, refs))).toEqual([
			'- [text] "Old" enabled (0,0 390×44)',
			'+ @e1 [text] "New" enabled (0,0 390×44)',
			"= 1 unchanged",
		]);
	});

	test("duplicate ids pair in document order", () => {
		const row = (label: string) => driverFixtures.el("cell", { id: "row", label });
		const before = driverFixtures.snapshotOf([row("a"), row("b")]);
		const after = driverFixtures.snapshotOf([row("a"), row("b"), row("c")]);
		const diff = diffSnapshots(before, after);
		expect(diff.unchanged).toBe(2);
		expect(diff.added.map((e) => e.line)).toEqual(['[listitem] "c" id=row enabled (0,100 390×44)']);
		expect(diff.removed).toEqual([]);
	});
});

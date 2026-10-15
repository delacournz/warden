import { describe, expect, test } from "bun:test";
import { el, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { diffSnapshots, renderDiff } from "./diff";

describe("diffSnapshots", () => {
	test("identical screens: everything unchanged", () => {
		const screen = () => snapshotOf([el("button", { label: "Sign in", id: "go" }), el("text", { label: "Hi" })]);
		const diff = diffSnapshots(screen(), screen());
		expect(diff).toEqual({ added: [], removed: [], unchanged: 2 });
		expect(renderDiff(diff)).toEqual(["= 2 unchanged"]);
	});

	test("keyed by id: a relabelled element is a -/+ pair, the rest is untouched even when reordered", () => {
		const hi = { label: "Hi", frame: { x: 0, y: 100, width: 390, height: 44 } };
		const at = (y: number) => ({ x: 0, y, width: 390, height: 44 });
		const before = snapshotOf([el("button", { label: "Sign in", id: "go", frame: at(0) }), el("text", hi)]);
		const after = snapshotOf([el("text", hi), el("button", { label: "Sign out", id: "go", frame: at(0) })]);
		const diff = diffSnapshots(before, after);
		expect(diff.removed.map((e) => e.line)).toEqual(['[button] "Sign in" id=go enabled (0,0 390×44)']);
		expect(diff.added.map((e) => e.line)).toEqual(['[button] "Sign out" id=go enabled (0,0 390×44)']);
		expect(diff.unchanged).toBe(1);
	});

	test("falls back to role+label when there is no id", () => {
		const before = snapshotOf([el("text", { label: "Count", value: "1" })]);
		const after = snapshotOf([el("text", { label: "Count", value: "2" })]);
		const diff = diffSnapshots(before, after);
		expect(diff.removed).toHaveLength(1);
		expect(diff.added).toHaveLength(1);
		expect(diff.unchanged).toBe(0);
		expect(diff.added[0]?.line).toContain('value="2"');
	});

	test("falls back to path when neither id nor label exist", () => {
		const frame = { x: 0, y: 0, width: 100, height: 40 };
		const before = snapshotOf([el("other", { frame })]);
		const moved = snapshotOf([el("other", { frame: { ...frame, x: 10 } })]);
		const diff = diffSnapshots(before, moved);
		expect(diff.removed).toHaveLength(1);
		expect(diff.added).toHaveLength(1);
		expect(diff.unchanged).toBe(0);
		expect(diffSnapshots(before, snapshotOf([el("other", { frame })])).unchanged).toBe(1);
	});

	test("a changed element is -/+ (new line carries its ref); an untouched one is counted", () => {
		const before = snapshotOf([el("text", { label: "Old" }), el("button", { label: "Keep", id: "keep" })]);
		const after = snapshotOf([el("text", { label: "New" }), el("button", { label: "Keep", id: "keep" })]);
		const refs = new Map(after.flat.map((e, i) => [e.id, `@e${i + 1}`]));
		expect(renderDiff(diffSnapshots(before, after, refs))).toEqual([
			'- [text] "Old" enabled (0,0 390×44)',
			'+ @e1 [text] "New" enabled (0,0 390×44)',
			"= 1 unchanged",
		]);
	});

	test("duplicate ids pair in document order", () => {
		const row = (label: string) => el("cell", { id: "row", label });
		const before = snapshotOf([row("a"), row("b")]);
		const after = snapshotOf([row("a"), row("b"), row("c")]);
		const diff = diffSnapshots(before, after);
		expect(diff.unchanged).toBe(2);
		expect(diff.added.map((e) => e.line)).toEqual(['[listitem] "c" id=row enabled (0,100 390×44)']);
		expect(diff.removed).toEqual([]);
	});
});

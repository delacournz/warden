import { describe, expect, test } from "bun:test";
import type { Snapshot } from "../driver/driver.types";
import { el, snap } from "./element.testing";
import { indexSnapshot } from "./nodes";
import { describeEntry, renderEntryLine, renderHeader, renderSnapshot } from "./render";

function login(): Snapshot {
	return snap([
		el("application", { frame: { x: 0, y: 0, width: 390, height: 844 } }, [
			el("text", { label: "Welcome back", frame: { x: 24, y: 120, width: 200, height: 24 } }),
			el("textfield", {
				identifier: "email",
				label: "Email",
				value: "me@example.com",
				frame: { x: 24, y: 200, width: 345, height: 44 },
				hittable: true,
			}),
			el("securefield", {
				identifier: "password",
				label: "Password",
				value: "••••",
				frame: { x: 24, y: 260, width: 345, height: 44 },
				hittable: true,
			}),
			el("button", {
				identifier: "sign-in-submit",
				label: "Sign in",
				value: "go",
				frame: { x: 24, y: 332, width: 345, height: 48 },
				hittable: true,
			}),
			el("switch", {
				identifier: "remember",
				label: "Remember me",
				value: "1",
				frame: { x: 300, y: 400, width: 51, height: 31 },
				enabled: false,
			}),
			el("other", { identifier: "footer", frame: { x: 0, y: 800, width: 390, height: 44 } }, [
				el("text", { label: "v1.0.0", frame: { x: 150, y: 810, width: 90, height: 20 } }),
			]),
		]),
	]);
}

const refs = new Map<string, string>([
	["0.1", "@e1"],
	["0.2", "@e2"],
	["0.3", "@e3"],
	["0.4", "@e4"],
	["0.5", "@e5"],
]);

describe("renderEntryLine", () => {
	const index = indexSnapshot(login());
	const byId = (id: string) => {
		const entry = index.byId.get(id);
		if (entry === undefined) throw new Error(id);
		return entry;
	};

	test("matches the warden ui line format", () => {
		expect(renderEntryLine(byId("0.3"), { ref: "@e3" })).toBe(
			'@e3 [button] "Sign in" id=sign-in-submit value="go" enabled hittable (24,332 345×48)'
		);
	});

	test("without a ref the line starts at the role", () => {
		expect(renderEntryLine(byId("0.0"))).toBe('[text] "Welcome back" enabled (24,120 200×24)');
	});

	test("secure values are never printed, state words follow", () => {
		expect(renderEntryLine(byId("0.2"), { ref: "@e2" })).toBe(
			'@e2 [textbox] "Password" id=password enabled hittable secure (24,260 345×44)'
		);
	});

	test("checked and disabled", () => {
		expect(renderEntryLine(byId("0.4"), { ref: "@e4" })).toBe(
			'@e4 [switch] "Remember me" id=remember value="1" disabled checked (300,400 51×31)'
		);
	});

	test("indent", () => {
		expect(renderEntryLine(byId("0.0"), { indent: 2 }).startsWith("    [text]")).toBe(true);
	});

	test("quotes escape, long names are truncated, awkward ids are quoted", () => {
		const entry = indexSnapshot(
			snap([
				el("button", {
					label: `say "hi"\n${"x".repeat(200)}`,
					identifier: "has space",
					frame: { x: 0.4, y: 1.6, width: 9.5, height: 10 },
				}),
			])
		).entries[0];
		if (entry === undefined) throw new Error("no entry");
		const line = renderEntryLine(entry);
		expect(line).toContain('"say \\"hi\\"\\nxxx');
		expect(line).toContain('…"');
		expect(line).toContain('id="has space"');
		expect(line.endsWith("(0,2 10×10)")).toBe(true);
	});

	test("hidden and expanded/collapsed words", () => {
		const entry = indexSnapshot(snap([el("other", { value: "menu item, expanded", hidden: true })])).entries[0];
		if (entry === undefined) throw new Error("no entry");
		expect(renderEntryLine(entry)).toBe("[menuitem] enabled hidden expanded (0,0 100×40)");
	});
});

describe("renderSnapshot", () => {
	test("interactive-only golden output", () => {
		const rendered = renderSnapshot(login(), { interactiveOnly: true, refs });
		expect(rendered.lines).toEqual([
			'@e1 [textbox] "Email" id=email value="me@example.com" enabled hittable (24,200 345×44)',
			'@e2 [textbox] "Password" id=password enabled hittable secure (24,260 345×44)',
			'@e3 [button] "Sign in" id=sign-in-submit value="go" enabled hittable (24,332 345×48)',
			'@e4 [switch] "Remember me" id=remember value="1" disabled checked (300,400 51×31)',
			"@e5 [other] id=footer enabled (0,800 390×44)",
		]);
		expect(rendered.shown).toBe(5);
		expect(rendered.total).toBe(8);
		expect(rendered.omitted).toBe(0);
	});

	test("full tree is indented by depth", () => {
		const rendered = renderSnapshot(login(), { interactiveOnly: false, refs });
		expect(rendered.lines).toEqual([
			"[other] enabled (0,0 390×844)",
			'  [text] "Welcome back" enabled (24,120 200×24)',
			'  @e1 [textbox] "Email" id=email value="me@example.com" enabled hittable (24,200 345×44)',
			'  @e2 [textbox] "Password" id=password enabled hittable secure (24,260 345×44)',
			'  @e3 [button] "Sign in" id=sign-in-submit value="go" enabled hittable (24,332 345×48)',
			'  @e4 [switch] "Remember me" id=remember value="1" disabled checked (300,400 51×31)',
			"  @e5 [other] id=footer enabled (0,800 390×44)",
			'    [text] "v1.0.0" enabled (150,810 90×20)',
		]);
		expect(rendered.shown).toBe(8);
	});

	test("interactive-only drops hidden elements even with an identifier", () => {
		const snapshot = snap([
			el("button", { identifier: "a", label: "A" }),
			el("button", { identifier: "b", hidden: true }),
		]);
		expect(renderSnapshot(snapshot, { interactiveOnly: true, refs: new Map() }).lines).toEqual([
			'[button] "A" id=a enabled (0,0 100×40)',
		]);
	});

	test("maxLines truncates and says how many are left", () => {
		const rendered = renderSnapshot(login(), { interactiveOnly: true, refs, maxLines: 2 });
		expect(rendered.lines).toHaveLength(3);
		expect(rendered.lines[2]).toBe("… 3 more (use --all)");
		expect(rendered.shown).toBe(2);
		expect(rendered.omitted).toBe(3);
	});

	test("maxLines at or above the count does not truncate", () => {
		const rendered = renderSnapshot(login(), { interactiveOnly: true, refs, maxLines: 5 });
		expect(rendered.lines).toHaveLength(5);
		expect(rendered.omitted).toBe(0);
	});

	test("an empty screen renders no lines", () => {
		expect(renderSnapshot(snap([]), { interactiveOnly: true, refs: new Map() })).toEqual({
			lines: [],
			shown: 0,
			total: 0,
			omitted: 0,
		});
	});
});

describe("renderHeader", () => {
	const snapshot = login();

	test("platform, backend, screen, generation and counts", () => {
		const rendered = renderSnapshot(snapshot, { interactiveOnly: true, refs });
		expect(renderHeader({ snapshot, rendered, interactiveOnly: true, generation: 12 })).toBe(
			"# ios axbridge 390×844@3x gen 12 · 5 of 8 elements (interactive)"
		);
	});

	test("full tree, truncated tree and modal", () => {
		const rendered = renderSnapshot(snapshot, { interactiveOnly: false, refs });
		expect(
			renderHeader({ snapshot: { ...snapshot, truncated: true, modal: { pid: 1 } }, rendered, interactiveOnly: false })
		).toBe("# ios axbridge 390×844@3x · 8 of 8 elements (all) · truncated by backend · modal present");
	});
});

describe("describeEntry", () => {
	test("is the line without ref, state or frame", () => {
		const index = indexSnapshot(login());
		const entry = index.byId.get("0.3");
		if (entry === undefined) throw new Error("no entry");
		expect(describeEntry(entry)).toBe('[button] "Sign in" id=sign-in-submit');
	});
});

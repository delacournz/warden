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

	test("a field showing its placeholder prints placeholder=, not value=", () => {
		const fields = indexSnapshot(
			snap([
				el("textfield", {
					label: "Email",
					identifier: "sign-in-email",
					value: "ada@example.com",
					placeholder: "ada@example.com",
					frame: { x: 21, y: 210, width: 360, height: 42 },
				}),
				el("textfield", {
					label: "Email",
					value: "grace@example.com",
					placeholder: "ada@example.com",
					frame: { x: 21, y: 260, width: 360, height: 42 },
				}),
			])
		).entries;
		expect(fields.map((entry) => renderEntryLine(entry))).toEqual([
			'[textbox] "Email" id=sign-in-email placeholder="ada@example.com" enabled (21,210 360×42)',
			'[textbox] "Email" value="grace@example.com" placeholder="ada@example.com" enabled (21,260 360×42)',
		]);
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
			entries: [],
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

	test("the cli style: generation first, no platform, no mode, counts only when elements were cut", () => {
		const cut = renderSnapshot(snapshot, { interactiveOnly: true, refs });
		expect(renderHeader({ snapshot, rendered: cut, interactiveOnly: true, generation: 4, style: "cli" })).toBe(
			"generation 4 · axbridge · 390×844@3x · 5 of 8 elements"
		);
		const all = renderSnapshot(snapshot, { interactiveOnly: false, refs });
		expect(
			renderHeader({
				snapshot: { ...snapshot, truncated: true },
				rendered: all,
				interactiveOnly: false,
				generation: 5,
				style: "cli",
			})
		).toBe("generation 5 · axbridge · 390×844@3x · 8 elements, truncated");
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

describe("render a11y option", () => {
	const snapshot = snap([
		el("button", {
			identifier: "archive",
			label: "Archive",
			frame: { x: 0, y: 0, width: 100, height: 40 },
			a11y: {
				hint: "Moves it",
				actions: ["Snooze", "Delete"],
				a11yFocused: true,
				important: false,
				liveRegion: "polite",
			},
		}),
		el("text", {
			label: "plain",
			frame: { x: 0, y: 40, width: 10, height: 10 },
			a11y: { important: true, focusable: true },
		}),
		el("text", { label: "bare", frame: { x: 0, y: 50, width: 10, height: 10 } }),
	]);
	const lines = (a11y: boolean): string[] =>
		renderSnapshot(snapshot, { interactiveOnly: false, refs: new Map(), a11y }).lines;

	test("appends hint, actions, focus, importance and live region", () => {
		expect(lines(true)[0]).toEndWith(
			'(0,0 100×40) hint="Moves it" actions=["Snooze","Delete"] a11y-focused not-important live=polite'
		);
	});

	test("adds nothing for important elements, elements without a11y, or when the option is off", () => {
		expect(lines(true)[1]).toEndWith("(0,40 10×10)");
		expect(lines(true)[2]).toEndWith("(0,50 10×10)");
		expect(lines(false)[0]).toEndWith("(0,0 100×40)");
	});
});

const KEY_FRAME = { x: 0, y: 546, width: 402, height: 328 };

function key(label: string, x: number, props: Partial<Parameters<typeof el>[1]> = {}) {
	return el("button", { label, frame: { x, y: 597, width: 39, height: 54 }, hittable: true, ...props });
}

/**
 * The sign-in screen with the iOS software keyboard up, as the bridge reads it: the app window holds an empty
 * `inputView` placeholder (`role: keyboard`) at the keyboard's frame; the keys sit in the keyboard's own window, under a
 * container of the same frame (suggestion bar, the `UIKeyboardLayoutStar Preview` with the keys, emoji / dictation).
 */
function withKeyboard(keyboardFrame = KEY_FRAME, returnKey = true): Snapshot {
	return snap(
		[
			el("application", { frame: { x: 0, y: 0, width: 402, height: 874 } }, [
				el("window", { frame: { x: 0, y: 0, width: 402, height: 874 } }, [
					el("textfield", {
						identifier: "sign-in-email",
						label: "Email",
						frame: { x: 21, y: 210, width: 360, height: 42 },
						hittable: true,
						focused: true,
					}),
					el("button", {
						identifier: "sign-in-submit",
						label: "Sign in",
						frame: { x: 20, y: 700, width: 362, height: 44 },
						hittable: true,
					}),
					el("other", { frame: keyboardFrame }, [
						el("keyboard", { identifier: "inputView", frame: keyboardFrame, hittable: true }),
					]),
				]),
				el("window", { frame: { x: 0, y: 0, width: 402, height: 874 } }, [
					el("other", { frame: keyboardFrame }, [
						el("other", { identifier: "SystemInputAssistantView", frame: { ...keyboardFrame, height: 44 } }, [
							el("button", {
								label: "Passwords",
								frame: { x: 30, y: keyboardFrame.y, width: 342, height: 44 },
								hittable: true,
							}),
						]),
						el(
							"other",
							{
								identifier: "UIKeyboardLayoutStar Preview",
								frame: { x: 0, y: keyboardFrame.y + 44, width: 402, height: 226 },
							},
							[
								key("Padding-Left", 0, { frame: { x: 0, y: 590, width: 0, height: 0 }, hittable: false }),
								key("Padding-Right", 0, { frame: { x: 0, y: 590, width: 0, height: 0 }, hittable: false }),
								key("q", 5),
								key("w", 44),
								key("shift", 5, { identifier: "shift" }),
								...(returnKey
									? [
											key("return", 301, {
												identifier: "Return",
												frame: { x: 301, y: 759, width: 99, height: 54 },
											}),
										]
									: []),
							]
						),
						el("other", { frame: { x: 0, y: 590, width: 402, height: 284 } }, [
							key("Dictate", 325, { identifier: "dictation" }),
						]),
					]),
				]),
			]),
		],
		{ screen: { width: 402, height: 874, scale: 3 } }
	);
}

/** `@eN` for every element, in preorder. */
function allRefs(snapshot: Snapshot): Map<string, string> {
	return new Map(snapshot.flat.map((element, at) => [element.id, `@e${at + 1}`]));
}

describe("render keyboard fold", () => {
	test("-i folds the keyboard (placeholder + the keyboard window's keys) into one line with the return key's ref", () => {
		const snapshot = withKeyboard();
		const refs = allRefs(snapshot);
		const out = renderSnapshot(snapshot, { interactiveOnly: true, refs });
		const returnRef = refs.get(snapshot.flat.find((e) => e.identifier === "Return")?.id ?? "");
		expect(out.lines).toEqual([
			'@e3 [textbox] "Email" id=sign-in-email enabled hittable focused (21,210 360×42)',
			'@e4 [button] "Sign in" id=sign-in-submit enabled hittable (20,700 362×44)',
			`${returnRef} [keyboard] return="return" visible (0,546 402×328) 6 keys (--keys)`,
		]);
		expect(out.shown).toBe(3);
		expect(out.keyboard?.keys).toBe(6);
		expect(out.keyboard?.returnKey?.element.identifier).toBe("Return");
		expect(out.entries.map((entry) => entry.element.identifier)).toEqual([
			"sign-in-email",
			"sign-in-submit",
			"inputView",
		]);
	});

	test("app elements behind the keyboard stay listed (only the keyboard's own subtrees fold)", () => {
		const out = renderSnapshot(withKeyboard(), { interactiveOnly: true, refs: new Map() });
		expect(out.lines).toContain('[button] "Sign in" id=sign-in-submit enabled hittable (20,700 362×44)');
	});

	test("an app view the size of the keyboard with no keyboard marker inside is not folded", () => {
		const snapshot = snap([
			el("application", {}, [
				el("keyboard", { identifier: "inputView", frame: KEY_FRAME }),
				el("other", { identifier: "composer", frame: KEY_FRAME }, [
					el("button", { identifier: "send", label: "Send", frame: { x: 300, y: 560, width: 80, height: 40 } }),
				]),
			]),
		]);
		const out = renderSnapshot(snapshot, { interactiveOnly: true, refs: new Map() });
		expect(out.lines).toEqual([
			"[keyboard] visible (0,546 402×328) 0 keys (--keys)",
			"[other] id=composer enabled (0,546 402×328)",
			'[button] "Send" id=send enabled (300,560 80×40)',
		]);
	});

	test("keys nested under the keyboard element (a backend that reports the keyboard itself) fold too", () => {
		const snapshot = snap([
			el("application", {}, [
				el("keyboard", { frame: KEY_FRAME }, [key("q", 5), key("go", 301, { identifier: "Go" })]),
			]),
		]);
		const out = renderSnapshot(snapshot, { interactiveOnly: true, refs: new Map([["0.0.1", "@e4"]]) });
		expect(out.lines).toEqual(['@e4 [keyboard] return="go" visible (0,546 402×328) 2 keys (--keys)']);
	});

	test("--keys (keys: true) lists every key as before", () => {
		const out = renderSnapshot(withKeyboard(), { interactiveOnly: true, refs: new Map(), keys: true });
		expect(out.keyboard).toBeUndefined();
		expect(out.lines).toContain('[button] "return" id=Return enabled hittable (301,759 99×54)');
		expect(out.lines).toContain('[button] "q" enabled hittable (5,597 39×54)');
		expect(out.lines.some((line) => line.includes("[keyboard]"))).toBe(false);
	});

	test("the full tree (no -i) keeps every key", () => {
		const out = renderSnapshot(withKeyboard(), { interactiveOnly: false, refs: new Map() });
		expect(out.keyboard).toBeUndefined();
		expect(out.lines.some((line) => line.includes('"Padding-Left"'))).toBe(true);
		expect(out.lines.some((line) => line.includes('"q"'))).toBe(true);
	});

	test("no return key: the line has no ref (a tap on the keyboard would land on a key)", () => {
		const out = renderSnapshot(withKeyboard(KEY_FRAME, false), { interactiveOnly: true, refs: new Map() });
		expect(out.lines.at(-1)).toBe("[keyboard] visible (0,546 402×328) 5 keys (--keys)");
	});

	test("a keyboard slid off the bottom (kept in the tree) folds as offscreen", () => {
		const out = renderSnapshot(withKeyboard({ x: 0, y: 874, width: 402, height: 328 }), {
			interactiveOnly: true,
			refs: new Map(),
		});
		expect(out.lines.at(-1)).toBe('[keyboard] return="return" offscreen (0,874 402×328) 6 keys (--keys)');
	});
});

describe("render -i zero-area elements", () => {
	test("a 0×0, not hittable element without a testID is left out; one with a testID stays", () => {
		const snapshot = snap([
			el("application", {}, [
				el("button", { label: "Spacer", frame: { x: 0, y: 590, width: 0, height: 0 } }),
				el("other", { identifier: "screen-ready", frame: { x: 0, y: 0, width: 0, height: 0 } }),
				el("button", { label: "OK", frame: { x: 10, y: 10, width: 80, height: 40 }, hittable: true }),
			]),
		]);
		const out = renderSnapshot(snapshot, { interactiveOnly: true, refs: new Map() });
		expect(out.lines).toEqual([
			"[other] id=screen-ready enabled (0,0 0×0)",
			'[button] "OK" enabled hittable (10,10 80×40)',
		]);
	});
});

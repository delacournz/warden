import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateHelper, generateSpec, idKey, mergeIdsModule, parseIdsModule } from "./codegen";
import { ids as goldenIds } from "./codegen.golden/ids";
import { allStepsRecording, recordingOf, selectorTarget } from "./recording.testing";

const GOLDEN = join(import.meta.dir, "codegen.golden");

/** Compare with the golden file; `UPDATE_GOLDEN=1 bun test` rewrites it. The golden is typechecked by `tsc`. */
function expectGolden(name: string, actual: string): void {
	const path = join(GOLDEN, name);
	if (process.env.UPDATE_GOLDEN === "1" || !existsSync(path)) writeFileSync(path, actual);
	expect(actual).toBe(readFileSync(path, "utf8"));
}

/** `importFrom` for specs written next to the goldens, so `tsc` resolves them without the package self-reference. */
const LOCAL = "../../index";

const press = (selector: string, role: Parameters<typeof selectorTarget>[1] = "button") =>
	({ kind: "press", at: 1, target: selectorTarget(selector, role) }) as const;

function specFor(...steps: Parameters<typeof recordingOf>[0]): string {
	return generateSpec(recordingOf(steps)).source;
}

describe("goldens", () => {
	test("a recording with every step kind", () => {
		const { source: spec } = generateSpec(allStepsRecording(), { importFrom: LOCAL });
		expectGolden("all-steps.e2e.ts", spec);
	});

	test("the default import is the published package name and resolves from inside the package", () => {
		const { source: spec } = generateSpec(recordingOf([press('label="Sign in"')]));
		expectGolden("default-import.e2e.ts", spec);
	});

	test("ids imported from a module: known keys are reused, new ones are generated", () => {
		const recording = recordingOf([
			press("id=sign-in-submit"),
			{ kind: "fill", at: 2, target: selectorTarget("id=email", "textbox"), text: "me@example.com" },
			press("id=sign-in-submit"),
		]);
		const result = generateSpec(recording, {
			ids: { signIn: "sign-in-submit" },
			idsImport: "./ids",
			importFrom: LOCAL,
		});
		expectGolden("with-ids.e2e.ts", result.source);
		expect(result.ids).toEqual({ ...goldenIds });
	});
});

describe("test.use options", () => {
	const useSignIn = { kind: "use", at: 1, module: join(GOLDEN, "helper-module.ts"), fn: "signIn" } as const;
	const file = join(GOLDEN, "launch-none.e2e.ts");
	const wait = { kind: "wait", at: 2, target: selectorTarget("id=todos-screen", "other") } as const;
	const shared = { module: join(GOLDEN, "spec-options.ts"), name: "SPEC_OPTIONS", launch: "none" } as const;

	test("a recording that opens the app itself turns the runner's launch off", () => {
		const { source } = generateSpec(recordingOf([useSignIn, wait]), { importFrom: LOCAL, file, launch: "none" });
		expectGolden("launch-none.e2e.ts", source);
	});

	test("the suite's shared options are imported and passed; their launch already covers the recording", () => {
		const { source } = generateSpec(recordingOf([useSignIn, wait]), {
			importFrom: LOCAL,
			file: join(GOLDEN, "shared-options.e2e.ts"),
			specOptions: shared,
			launch: "none",
		});
		expectGolden("shared-options.e2e.ts", source);
	});

	test("shared options merge into the import of the same module, names in case-insensitive order", () => {
		const recording = recordingOf([{ ...useSignIn, module: shared.module, fn: "zeta" }, wait]);
		const { source } = generateSpec(recording, { file, specOptions: shared });
		expect(source).toContain('import { SPEC_OPTIONS, zeta } from "./spec-options";');
	});

	test("shared options whose launch differs from the need are spread with the override", () => {
		const recording = recordingOf([press("id=save")]);
		const { source } = generateSpec(recording, {
			file,
			specOptions: { ...shared, launch: "none" },
			launch: "fresh",
		});
		expect(source).toContain('test.use({ ...SPEC_OPTIONS, launch: "fresh" });');
		const bare = generateSpec(recording, {
			file,
			specOptions: { module: shared.module, name: "OPTS" },
			launch: "none",
		});
		expect(bare.source).toContain('test.use({ ...OPTS, launch: "none" });');
	});

	test("shared options without a launch opinion are passed as they are", () => {
		const { source } = generateSpec(recordingOf([press("id=save")]), {
			file,
			specOptions: { ...shared, launch: undefined },
		});
		expect(source).toContain("test.use(SPEC_OPTIONS);");
	});

	test("the default launch needs no line", () => {
		expect(generateSpec(recordingOf([press("id=save")]), { launch: "fresh" }).source).not.toContain("test.use");
		expect(specFor(press("id=save"))).not.toContain("test.use");
	});

	test("a spec that needs no ids still gets the options after the imports", () => {
		const { source } = generateSpec(recordingOf([press("label=Save")]), { file, launch: "none" });
		expect(source.split("\n").slice(1, 5)).toEqual([
			'import { test } from "@delacour/warden-e2e";',
			"",
			'test.use({ launch: "none" });',
			"",
		]);
	});
});

describe("use steps", () => {
	const useSignIn = { kind: "use", at: 1, module: join(GOLDEN, "helper-module.ts"), fn: "signIn" } as const;
	const file = join(GOLDEN, "use-helper.e2e.ts");

	test("a helper call imports the module relative to the spec and passes the fixtures on", () => {
		const recording = recordingOf([
			useSignIn,
			{ kind: "wait", at: 2, target: selectorTarget("id=todos-screen", "other") },
			press("id=add-todo"),
			{ kind: "screen", type: "screenshot", at: 4, name: "todos" },
		]);
		const { source } = generateSpec(recording, { importFrom: LOCAL, file });
		expectGolden("use-helper.e2e.ts", source);
	});

	test("imports from the same module are merged, one name per helper", () => {
		const recording = recordingOf([useSignIn, { ...useSignIn, fn: "signOut" }, useSignIn]);
		const { source } = generateSpec(recording, { file });
		expect(source).toContain('import { signIn, signOut } from "./helper-module";');
		expect(source.match(/await signIn\(fixtures\);/g)).toHaveLength(2);
		expect(source).toContain("async (fixtures) => {");
	});

	test("the import follows the spec's final path, above or below the module", () => {
		const recording = recordingOf([useSignIn]);
		const nested = generateSpec(recording, { file: join(GOLDEN, "deep", "er", "x.e2e.ts") }).source;
		expect(nested).toContain('from "../../helper-module"');
		const parent = generateSpec(recording, { file: join(GOLDEN, "..", "x.e2e.ts") }).source;
		expect(parent).toContain('from "./codegen.golden/helper-module"');
	});

	test("a module that is not absolute is imported as written", () => {
		const recording = recordingOf([{ ...useSignIn, module: "../helpers/steps" }]);
		expect(generateSpec(recording, { file }).source).toContain('from "../helpers/steps"');
	});

	test("relative imports are sorted by specifier (what the organize-imports lint wants)", () => {
		const recording = recordingOf([useSignIn, press("id=save")]);
		const { source } = generateSpec(recording, { file, idsImport: "./ids", idsMerged: true });
		expect(source.indexOf('from "./helper-module"')).toBeLessThan(source.indexOf('from "./ids"'));
	});

	test("the ids import and a helper module that share a specifier are one import", () => {
		const recording = recordingOf([useSignIn, press("id=save")]);
		const { source } = generateSpec(recording, { file, idsImport: "./helper-module", idsMerged: true });
		expect(source).toContain('import { ids, signIn } from "./helper-module";');
		expect(source).toContain("const { screen } = fixtures;");
	});

	test("without a use step the callback keeps destructuring", () => {
		expect(specFor(press("id=save"))).toContain("async ({ screen }) => {");
	});

	test("a helper that calls another helper takes the fixtures object and imports it", () => {
		const recording = recordingOf([useSignIn, press("id=save")]);
		const helperFile = join(GOLDEN, "composed.ts");
		const generated = generateHelper(recording, { name: "afterSignIn", importFrom: LOCAL, file: helperFile });
		if (!generated.success) throw new Error(generated.error.message);
		expect(generated.data.source).toContain('import { signIn } from "./helper-module";');
		expect(generated.data.source).toContain(
			"export async function afterSignIn(fixtures: TestFixtures): Promise<void> {"
		);
		expect(generated.data.source).toContain("const { screen } = fixtures;\n\tawait signIn(fixtures);");
	});

	test("a helper never imports itself", () => {
		const recording = recordingOf([useSignIn]);
		const generated = generateHelper(recording, { name: "again", file: join(GOLDEN, "helper-module.ts") });
		if (!generated.success) throw new Error(generated.error.message);
		expect(generated.data.source).not.toContain('from "./helper-module"');
	});
});

describe("ids", () => {
	test("camelCases test ids into identifiers", () => {
		expect(idKey("sign-in-submit")).toBe("signInSubmit");
		expect(idKey("todos_screen")).toBe("todosScreen");
		expect(idKey("Todo.Row 2")).toBe("todoRow2");
		expect(idKey("2fa-code")).toBe("id2faCode");
		expect(idKey("---")).toBe("id");
	});

	test("generated keys never clash with provided ones", () => {
		const recording = recordingOf([press("id=sign-in"), press("id=signIn")]);
		const { ids } = generateSpec(recording, { ids: { signIn: "something-else" } });
		expect(ids).toEqual({ signIn: "something-else", signIn2: "sign-in", signIn3: "signIn" });
	});

	test("an inline ids map is emitted only when a test id is used", () => {
		expect(specFor(press("label=Save", "button"))).not.toContain("const ids");
		const used = generateSpec(recordingOf([press("id=save")]));
		expect(used.source).toContain('const ids = {\n\tsave: "save",\n} as const;');
		expect(used.source).toContain("screen.getByTestId(ids.save).tap()");
	});

	test("idsImport replaces the inline map and lists the new keys", () => {
		const { source: spec } = generateSpec(recordingOf([press("id=save")]), { idsImport: "../ids" });
		expect(spec).toContain('import { ids } from "../ids";');
		expect(spec).not.toContain("const ids");
		expect(spec).toContain("New test ids to add to ../ids: save");
	});

	test("idsMerged leaves out the add-these-ids comment", () => {
		const { source } = generateSpec(recordingOf([press("id=save")]), { idsImport: "../ids", idsMerged: true });
		expect(source).toContain('import { ids } from "../ids";');
		expect(source).not.toContain("New test ids");
	});
});

describe("locators", () => {
	test.each([
		["id=save", "screen.getByTestId(ids.save).tap()"],
		['label="Sign in"', 'screen.getByLabel("Sign in").tap()'],
		["text=Done", 'screen.getByText("Done").tap()'],
		["value=42", 'screen.getByValue("42").tap()'],
		['role=button label="Sign in"', 'screen.getByRole("button", "Sign in").tap()'],
		["role=button text=Save", 'screen.getByRole("button", "Save").tap()'],
		["role=switch", 'screen.getByRole("switch").tap()'],
		["role=switch nth=1", 'screen.getByRole("switch").nth(1).tap()'],
		["id=row nth=2", "screen.getByTestId(ids.row).nth(2).tap()"],
	])("%s", (selector, expected) => {
		expect(specFor(press(selector, "other"))).toContain(`await ${expected};`);
	});

	test.each([
		["text=/^\\d+$/", 'screen.locator("text=/^\\\\d+$/")'],
		["role=widget", 'screen.locator("role=widget")'],
		["editable=true", 'screen.locator("editable=true")'],
		["id=a label=b", 'screen.locator("id=a label=b")'],
		["id=a role=button", 'screen.locator("id=a role=button")'],
	])("%s falls back to screen.locator", (selector, expected) => {
		expect(specFor(press(selector, "other"))).toContain(`await ${expected}.tap();`);
	});

	test("an unparseable selector still exports as screen.locator", () => {
		expect(specFor(press("not a selector"))).toContain('screen.locator("not a selector")');
	});
});

describe("steps", () => {
	const target = selectorTarget("id=field", "textbox");

	test("a secret is read from WARDEN_UI_SECRET_<NAME> and never written out", () => {
		const { source: spec } = generateSpec(recordingOf([{ kind: "fill", at: 1, target, text: { secret: "PASSWORD" } }]));
		expect(spec).toContain("const passwordSecret = process.env.WARDEN_UI_SECRET_PASSWORD;");
		expect(spec).toContain('throw new Error("set WARDEN_UI_SECRET_PASSWORD to run this spec")');
		expect(spec).toContain(".fill(passwordSecret);");
	});

	test("a fill recorded with via type passes it on; a plain fill has no options", () => {
		const { source: spec } = generateSpec(
			recordingOf([
				{ kind: "fill", at: 1, target, text: "a@b.co" },
				{ kind: "fill", at: 2, target, text: "c@d.co", via: "type" },
			])
		);
		expect(spec).toContain('.fill("a@b.co");');
		expect(spec).toContain('.fill("c@d.co", { via: "type" });');
	});

	test("one declaration per secret, reused across steps", () => {
		const { source: spec } = generateSpec(
			recordingOf([
				{ kind: "fill", at: 1, target, text: { secret: "PASSWORD" } },
				{ kind: "fill", at: 2, target, text: { secret: "PASSWORD" } },
			])
		);
		expect(spec.match(/const passwordSecret/g)).toHaveLength(1);
		expect(spec.match(/\.fill\(passwordSecret\)/g)).toHaveLength(2);
	});

	test("a coordinate press is a FIXME plus screen.tapAt", () => {
		const spec = specFor({ kind: "press", at: 1, target: { kind: "coords", x: 120, y: 340, warning: "by hand" } });
		expect(spec).toContain("// FIXME: recorded by coordinates (by hand)");
		expect(spec).toContain("await screen.tapAt({ x: 120, y: 340 });");
	});

	test("what the spec API cannot say at a point throws instead of passing silently", () => {
		const spec = specFor({ kind: "fill", at: 1, target: { kind: "coords", x: 1, y: 2, warning: "w" }, text: "x" });
		expect(spec).toContain("// FIXME: recorded by coordinates; the spec API has no fill without an element");
		expect(spec).toContain('throw new Error("FIXME: fill without an element (recorded by coordinates)")');
	});

	test("untargeted typing and keys are FIXME throws", () => {
		const spec = specFor({ kind: "type", at: 1, text: "x" }, { kind: "key", at: 2, key: "Escape" });
		expect(spec).toContain("// FIXME: recorded without a target; the spec API has no typing without a target field");
		expect(spec).toContain("the spec API has no key press without a target field");
	});

	test("wait and is become matchers; attach/detach use waitFor", () => {
		const spec = specFor(
			{ kind: "wait", at: 1, target, timeoutMs: 4000 },
			{ kind: "wait", at: 2, target, state: "hidden" },
			{ kind: "wait", at: 3, target, state: "attached" },
			{ kind: "is", at: 4, target, state: "unchecked" },
			{ kind: "is", at: 5, target, state: "enabled", not: true }
		);
		expect(spec).toContain("await expect(screen.getByTestId(ids.field)).toBeVisible({ timeout: 4000 });");
		expect(spec).toContain("await expect(screen.getByTestId(ids.field)).toBeHidden();");
		expect(spec).toContain('await screen.getByTestId(ids.field).waitFor({ state: "attached" });');
		expect(spec).toContain("await expect(screen.getByTestId(ids.field)).toBeChecked({ checked: false });");
		expect(spec).toContain("await expect(screen.getByTestId(ids.field)).not.toBeEnabled();");
	});

	test("get is an auto-waiting assertion on the property, not a one-shot read", () => {
		const text = specFor({ kind: "get", at: 1, target, property: "text", expected: "Hello" });
		expect(text).toContain('await expect(screen.getByTestId(ids.field)).toHaveText("Hello");');
		const value = specFor({ kind: "get", at: 1, target, property: "value", expected: "a@b.c" });
		expect(value).toContain('await expect(screen.getByTestId(ids.field)).toHaveValue("a@b.c");');
	});

	test("scroll --until is scrollUntilVisible; a plain scroll is a swipe", () => {
		const spec = specFor(
			{ kind: "scroll", at: 1, direction: "down", until: target, maxSwipes: 3 },
			{ kind: "scroll", at: 2 }
		);
		expect(spec).toContain(
			'await screen.scrollUntilVisible(screen.getByTestId(ids.field), { direction: "down", maxSwipes: 3 });'
		);
		expect(spec).toContain('await screen.swipe({ direction: "down" });');
	});

	test("open: the app, or a link from outside it", () => {
		const spec = specFor(
			{ kind: "open", at: 1, app: "com.example", url: "example://x", args: ["--a"] },
			{ kind: "open", at: 2, url: "https://example.com" }
		);
		expect(spec).toContain('await app.open({ url: "example://x", args: ["--a"], wait: "quiet" });');
		expect(spec).toContain('await device.openLink("https://example.com");');
	});

	test("alert, reload and the device steps", () => {
		const spec = specFor(
			{ kind: "alert", at: 1, action: { button: "Allow" } },
			{ kind: "alert", at: 2, action: "dismiss" },
			{ kind: "reload", at: 3 },
			{ kind: "screen", type: "screenshot", at: 4 }
		);
		expect(spec).toContain('await device.alert({ button: "Allow" });');
		expect(spec).toContain('await device.alert("dismiss");');
		expect(spec).toContain("await device.devtools.reloadJs();");
		expect(spec).toContain('await device.screenshot("step-3");');
	});

	test("a recorded --settle becomes device.settle; notes become comments", () => {
		const spec = specFor({ kind: "home", at: 1, settle: { quietMs: 300 }, note: "leave\nthe app" });
		expect(spec).toContain("// leave the app");
		expect(spec).toContain("await device.settle({ quietMs: 300 });");
	});

	test("only the fixtures a recording uses are destructured, and expect is imported only when needed", () => {
		const home = specFor({ kind: "home", at: 1 });
		expect(home).toContain('import { test } from "@delacour/warden-e2e";');
		expect(home).toContain('test("sign in", async ({ device }) => {');
		const empty = specFor();
		expect(empty).toContain('test("sign in", async () => {\n\t// no steps were recorded\n});');
	});

	test("is deterministic", () => {
		expect(generateSpec(allStepsRecording()).source).toBe(generateSpec(allStepsRecording()).source);
	});
});

describe("notes", () => {
	const field = selectorTarget("id=email", "textbox");
	const recording = recordingOf([
		{ kind: "note", at: 1, text: "Open the app on the sign-in screen" },
		{ kind: "wait", at: 2, target: selectorTarget("id=sign-in-screen", "other") },
		{ kind: "note", at: 3, text: "Fill in\nthe credentials" },
		{ kind: "fill", at: 4, target: field, text: "me@example.com" },
		press("id=sign-in-submit"),
		{ kind: "note", at: 6, text: "Lands on the home screen" },
		{ kind: "wait", at: 7, target: selectorTarget("id=home-screen", "other") },
		{ kind: "note", at: 8, text: "Nothing else to check" },
	]);

	test("a note is a comment above the next step; between steps it gets a blank line before it", () => {
		const { source } = generateSpec(recording, { importFrom: LOCAL });
		expectGolden("notes.e2e.ts", source);
	});

	test("a note at the very end is a trailing comment, not a step", () => {
		const { source } = generateSpec(recording);
		expect(source).toContain("\t// Nothing else to check\n});");
	});

	test("a recording of notes only has no statements", () => {
		const { source } = generateSpec(recordingOf([{ kind: "note", at: 1, text: "just a thought" }]));
		expect(source).toContain('test("sign in", async () => {\n\t// just a thought\n});');
	});
});

describe("title", () => {
	test("options.title beats the recording title beats the name", () => {
		const titled = recordingOf([{ kind: "home", at: 1 }], { title: "Sign in with email" });
		expect(generateSpec(titled).source).toContain('test("Sign in with email"');
		expect(generateSpec(titled, { title: "Signs in" }).source).toContain('test("Signs in"');
		expect(generateSpec(recordingOf([{ kind: "home", at: 1 }])).source).toContain('test("sign in"');
	});
});

describe("helpers", () => {
	const recording = recordingOf([
		{ kind: "note", at: 1, text: "Open the sign-in form" },
		press("id=sign-in-open"),
		{ kind: "wait", at: 3, target: selectorTarget("id=sign-in-form", "other") },
		{ kind: "fill", at: 4, target: selectorTarget("id=email", "textbox"), text: "me@example.com" },
		{ kind: "fill", at: 5, target: selectorTarget("id=password", "textbox"), text: { secret: "PASSWORD" } },
		press("id=sign-in-submit"),
	]);

	test("a new helpers module: banner, imports, inline ids, documented exported function", () => {
		const result = generateHelper(recording, {
			name: "signIn",
			prerequisite: "the app is open on the welcome screen",
			importFrom: LOCAL,
		});
		if (!result.success) throw new Error(result.error.message);
		expectGolden("helper-module.ts", result.data.source);
		expect(result.data.replaced).toBe(false);
		expect(Object.keys(result.data.ids)).toContain("signInOpen");
	});

	test("appended to an existing module: imports and ids are merged, the existing code is kept", () => {
		const existing = [
			'import { type TestFixtures } from "../../index";',
			"",
			"const ids = {",
			'\tsignInOpen: "sign-in-open",',
			"} as const;",
			"",
			"/** Prerequisite: nothing. */",
			"export async function openApp({ app }: TestFixtures): Promise<void> {",
			'\tawait app.open({ wait: "quiet" });',
			"}",
			"",
		].join("\n");
		const result = generateHelper(recording, {
			name: "signIn",
			prerequisite: "on welcome",
			existing,
			importFrom: LOCAL,
		});
		if (!result.success) throw new Error(result.error.message);
		expectGolden("helper-merged.ts", result.data.source);
		expect(result.data.source).toContain("export async function openApp");
		expect(result.data.source.match(/signInOpen:/g)).toHaveLength(1);
	});

	test("an existing export of the same name is refused without force and replaced in place with it", () => {
		const first = generateHelper(recording, { name: "signIn", prerequisite: "old" });
		if (!first.success) throw new Error(first.error.message);
		const again = generateHelper(recording, { name: "signIn", existing: first.data.source });
		expect(!again.success && again.error.code).toBe("helper_exists");
		const forced = generateHelper(recording, {
			name: "signIn",
			prerequisite: "new",
			existing: first.data.source,
			force: true,
		});
		if (!forced.success) throw new Error(forced.error.message);
		expect(forced.data.replaced).toBe(true);
		expect(forced.data.source).toContain("/** Prerequisite: new */");
		expect(forced.data.source).not.toContain("Prerequisite: old");
		expect(forced.data.source.match(/export async function signIn/g)).toHaveLength(1);
	});

	test("an export that is not a function declaration cannot be replaced, even with force", () => {
		const result = generateHelper(recording, {
			name: "signIn",
			existing: "export const signIn = async () => {};\n",
			force: true,
		});
		expect(!result.success && result.error.code).toBe("helper_unreplaceable");
	});

	test("the function name must be an identifier", () => {
		const result = generateHelper(recording, { name: "sign-in" });
		expect(!result.success && result.error.code).toBe("bad_name");
	});

	test("ids from an ids module: imported, never declared inline", () => {
		const result = generateHelper(recording, { name: "signIn", idsImport: "./ids" });
		if (!result.success) throw new Error(result.error.message);
		expect(result.data.source).toContain('import { ids } from "./ids";');
		expect(result.data.source).not.toContain("const ids");
	});

	test("a helper that touches no fixture takes no parameter and imports no type", () => {
		const result = generateHelper(recordingOf([{ kind: "note", at: 1, text: "nothing to do" }]), { name: "noop" });
		if (!result.success) throw new Error(result.error.message);
		expect(result.data.source).toContain("export async function noop(): Promise<void> {");
		expect(result.data.source).not.toContain("import");
	});

	test("without a prerequisite the doc comment names the recording", () => {
		const result = generateHelper(recordingOf([{ kind: "home", at: 1 }]), { name: "goHome" });
		if (!result.success) throw new Error(result.error.message);
		expect(result.data.source).toContain('/** Replays the recording "sign in". */');
	});

	test("a prerequisite cannot close its own doc comment", () => {
		const result = generateHelper(recordingOf([{ kind: "home", at: 1 }]), { name: "goHome", prerequisite: "a */ b" });
		if (!result.success) throw new Error(result.error.message);
		expect(result.data.source).toContain("/** Prerequisite: a * / b */");
	});
});

describe("ids modules", () => {
	test("a new module declares an exported ids map", () => {
		const merged = mergeIdsModule(undefined, { signIn: "sign-in-submit", "odd-key": "odd" });
		expect(merged).toEqual({
			success: true,
			data: 'export const ids = {\n\tsignIn: "sign-in-submit",\n\t"odd-key": "odd",\n} as const;\n',
		});
	});

	test("merging inserts only the missing keys and keeps everything else", () => {
		const existing =
			'// shared ids\nexport const ids = {\n\tsignIn: "sign-in-submit",\n} as const;\n\nexport const other = 1;\n';
		const merged = mergeIdsModule(existing, { signIn: "changed", email: "email" });
		if (!merged.success) throw new Error(merged.error.message);
		expect(merged.data).toBe(
			'// shared ids\nexport const ids = {\n\tsignIn: "sign-in-submit",\n\temail: "email",\n} as const;\n\nexport const other = 1;\n'
		);
		expect(mergeIdsModule(merged.data, { email: "email" })).toEqual({ success: true, data: merged.data });
	});

	test("a module without an ids map cannot be merged into", () => {
		const merged = mergeIdsModule("export const other = 1;\n", { a: "a" });
		expect(!merged.success && merged.error.code).toBe("ids_unreadable");
	});

	test("parseIdsModule reads the pairs back, quoted keys included", () => {
		const source = mergeIdsModule(undefined, { signIn: "sign-in-submit", "odd-key": 'has "quotes"' });
		if (!source.success) throw new Error(source.error.message);
		expect(parseIdsModule(source.data)).toEqual({ signIn: "sign-in-submit", "odd-key": 'has "quotes"' });
		expect(parseIdsModule("export const nothing = 1;\n")).toEqual({});
	});
});

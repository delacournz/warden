import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportFlow, idKey } from "./export";
import { ids as goldenIds } from "./export.golden/ids";
import { allStepsFlow, flowOf, selectorTarget } from "./flow.testing";

const GOLDEN = join(import.meta.dir, "export.golden");

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

function specFor(...steps: Parameters<typeof flowOf>[0]): string {
	return exportFlow(flowOf(steps)).spec;
}

describe("goldens", () => {
	test("a flow with every step kind", () => {
		const { spec } = exportFlow(allStepsFlow(), { importFrom: LOCAL });
		expectGolden("all-steps.e2e.ts", spec);
	});

	test("the default import is the published package name and resolves from inside the package", () => {
		const { spec } = exportFlow(flowOf([press('label="Sign in"')]));
		expectGolden("default-import.e2e.ts", spec);
	});

	test("ids imported from a module: known keys are reused, new ones are generated", () => {
		const flow = flowOf([
			press("id=sign-in-submit"),
			{ kind: "fill", at: 2, target: selectorTarget("id=email", "textbox"), text: "me@example.com" },
			press("id=sign-in-submit"),
		]);
		const result = exportFlow(flow, { ids: { signIn: "sign-in-submit" }, idsImport: "./ids", importFrom: LOCAL });
		expectGolden("with-ids.e2e.ts", result.spec);
		expect(result.ids).toEqual({ ...goldenIds });
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
		const flow = flowOf([press("id=sign-in"), press("id=signIn")]);
		const { ids } = exportFlow(flow, { ids: { signIn: "something-else" } });
		expect(ids).toEqual({ signIn: "something-else", signIn2: "sign-in", signIn3: "signIn" });
	});

	test("an inline ids map is emitted only when a test id is used", () => {
		expect(specFor(press("label=Save", "button"))).not.toContain("const ids");
		const used = exportFlow(flowOf([press("id=save")]));
		expect(used.spec).toContain('const ids = {\n\tsave: "save",\n} as const;');
		expect(used.spec).toContain("screen.getByTestId(ids.save).tap()");
	});

	test("idsImport replaces the inline map and lists the new keys", () => {
		const { spec } = exportFlow(flowOf([press("id=save")]), { idsImport: "../ids" });
		expect(spec).toContain('import { ids } from "../ids";');
		expect(spec).not.toContain("const ids");
		expect(spec).toContain("New test ids to add to ../ids: save");
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
		const { spec } = exportFlow(flowOf([{ kind: "fill", at: 1, target, text: { secret: "PASSWORD" } }]));
		expect(spec).toContain("const passwordSecret = process.env.WARDEN_UI_SECRET_PASSWORD;");
		expect(spec).toContain('throw new Error("set WARDEN_UI_SECRET_PASSWORD to run this flow")');
		expect(spec).toContain(".fill(passwordSecret);");
	});

	test("one declaration per secret, reused across steps", () => {
		const { spec } = exportFlow(
			flowOf([
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

	test("get reads the property and compares", () => {
		const spec = specFor({ kind: "get", at: 1, target, property: "text", expected: "Hello" });
		expect(spec).toContain('expect(await screen.getByTestId(ids.field).text()).toBe("Hello");');
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
		expect(spec).toContain('await app.open({ url: "example://x", args: ["--a"] });');
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

	test("only the fixtures a flow uses are destructured, and expect is imported only when needed", () => {
		const home = specFor({ kind: "home", at: 1 });
		expect(home).toContain('import { test } from "@delacour/warden-e2e";');
		expect(home).toContain('test("sign in", async ({ device }) => {');
		const empty = specFor();
		expect(empty).toContain('test("sign in", async () => {\n\t// no steps were recorded\n});');
	});

	test("is deterministic", () => {
		expect(exportFlow(allStepsFlow()).spec).toBe(exportFlow(allStepsFlow()).spec);
	});
});

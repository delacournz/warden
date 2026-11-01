import { describe, expect, test } from "bun:test";
import { specTargets } from "./spec-target";

describe("authoring targets", () => {
	test("slugOf", () => {
		expect(specTargets.slugOf("  Sign in! (v2) ")).toBe("sign-in-v2");
		expect(specTargets.slugOf("!!!")).toBe("");
	});

	test("parseHelperRef needs module#fn, adds .ts, checks the name", () => {
		expect(specTargets.parseHelperRef("e2e/helpers#signIn")).toEqual({
			success: true,
			data: { module: "e2e/helpers.ts", fn: "signIn" },
		});
		expect(specTargets.parseHelperRef("e2e/helpers.tsx#signIn")).toMatchObject({ data: { module: "e2e/helpers.tsx" } });
		expect(specTargets.parseHelperRef("e2e/helpers.ts").success).toBe(false);
		expect(specTargets.parseHelperRef("#x").success).toBe(false);
		expect(specTargets.parseHelperRef("a.ts#1x").success).toBe(false);
	});

	test("exportsName finds functions and consts, not look-alikes", () => {
		const source = "export async function signIn() {}\nexport const other = 1;\nconst hidden = 2;\n";
		expect(specTargets.exportsName(source, "signIn")).toBe(true);
		expect(specTargets.exportsName(source, "other")).toBe(true);
		expect(specTargets.exportsName(source, "sign")).toBe(false);
		expect(specTargets.exportsName(source, "hidden")).toBe(false);
	});

	test("importPath is relative without an extension", () => {
		expect(specTargets.importPath("/p/e2e/a.e2e.ts", "/p/e2e/ids.ts")).toBe("./ids");
		expect(specTargets.importPath("/p/e2e/sub/a.e2e.ts", "/p/e2e/ids.ts")).toBe("../ids");
		expect(specTargets.importPath("/p/e2e/a.e2e.ts", "/p/e2e/shared/ids.ts")).toBe("./shared/ids");
	});

	test("functionSource cuts a function declaration out, braces in params, strings and comments included", () => {
		const source = [
			"export async function a({ app }: TestFixtures): Promise<void> {",
			'\tawait x("}"); // }',
			"\t/* } */ if (y) { await z(); }",
			"}",
			"export function b() {}",
		].join("\n");
		expect(specTargets.functionSource(source, "a")).toBe(source.split("\nexport function b")[0]);
		expect(specTargets.functionSource(source, "b")).toBe("export function b() {}");
		expect(specTargets.functionSource(source, "c")).toBeUndefined();
		expect(specTargets.functionSource("export function broken() { {", "broken")).toBeUndefined();
	});

	test("functionSource reads an arrow function const", () => {
		const source = "export const launch = async (app: App): Promise<void> => {\n\tawait app.open();\n};\n";
		expect(specTargets.functionSource(source, "launch")).toContain("await app.open();");
	});

	test("helperOpensApp: direct, through a same-module helper, and not through an import", () => {
		const source = [
			'import { other } from "./other";',
			'export async function launch(app: App) { await app.open({ wait: "quiet" }); }',
			"export async function openSignIn(app: App, screen: Screen) {",
			"\tawait launch(app, screen);",
			"\tawait screen.getByTestId(ids.x).tap();",
			"}",
			"export async function signIn({ screen }: TestFixtures) { await screen.getByTestId(ids.x).tap(); }",
			"export async function viaImport(app: App) { await other(app); }",
			"export async function viaFixtures(fixtures: TestFixtures) { await fixtures.app.open(); }",
			"export async function loop(app: App) { await loop(app); }",
		].join("\n");
		expect(specTargets.helperOpensApp(source, "launch")).toBe(true);
		expect(specTargets.helperOpensApp(source, "openSignIn")).toBe(true);
		expect(specTargets.helperOpensApp(source, "viaFixtures")).toBe(true);
		expect(specTargets.helperOpensApp(source, "signIn")).toBe(false);
		expect(specTargets.helperOpensApp(source, "viaImport")).toBe(false);
		expect(specTargets.helperOpensApp(source, "loop")).toBe(false);
		expect(specTargets.helperOpensApp(source, "missing")).toBe(false);
	});
});

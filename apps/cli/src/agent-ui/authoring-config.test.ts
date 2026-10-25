import { describe, expect, test } from "bun:test";
import type { Suite } from "@delacour/warden-core/affected/affected";
import type { RecordedStep } from "@delacour/warden-e2e/authoring/recording.schema";
import {
	helpersWithGaps,
	renderSnippet,
	type SpecConfigInput,
	specConfigFor,
	stepRoutes,
	visitedRoutes,
} from "./authoring-config";

const suite = (routerRoot?: string): Suite =>
	({
		name: "mobile",
		configDir: "/p",
		config: { specsDir: "e2e", ...(routerRoot ? { routerRoot } : {}) },
	}) as unknown as Suite;

const input = (over: Partial<SpecConfigInput> = {}): SpecConfigInput => ({
	file: "/p/e2e/sign-in.e2e.ts",
	routes: ["welcome", "sign-in"],
	suite: suite("src/app"),
	devicePlatform: "ios",
	resolveRoutes: (routes) => ({
		entries: routes.filter((r) => r !== "ghost").map((r) => `src/app/${r}.tsx`),
		unresolved: routes.filter((r) => r === "ghost"),
	}),
	specId: (file, dir) => file.replace(`${dir}/`, "").replace(".e2e.ts", ""),
	...over,
});

describe("renderSnippet", () => {
	test("one entry per line; quotes ids that are not identifiers", () => {
		expect(renderSnippet("sign-in", ["src/app/welcome.tsx", "src/app/sign-in.tsx"])).toBe(
			'specs: {\n\t"sign-in": {\n\t\tentries: [\n\t\t\t"src/app/welcome.tsx",\n\t\t\t"src/app/sign-in.tsx",\n\t\t],\n\t},\n},'
		);
		expect(renderSnippet("todos", ["a.tsx"])).toContain("\ttodos: {");
	});

	test("no entries: an empty list with the hint to fill it", () => {
		expect(renderSnippet("todos", [])).toBe(
			"specs: {\n\ttodos: { entries: [] }, // TODO: the screens this spec drives\n},"
		);
	});
});

describe("specConfigFor with a helper", () => {
	test("hints that the helper's screens are not in the entries", () => {
		expect(specConfigFor(input({ helperGaps: ["signIn"] })).hints.join("\n")).toContain("helper signIn");
		expect(specConfigFor(input({ helperGaps: [] })).hints).toEqual([]);
		expect(specConfigFor(input()).hints).toEqual([]);
	});
});

describe("visitedRoutes", () => {
	test("initial, steps, final; each once, in order", () => {
		expect(visitedRoutes("welcome", [undefined, "sign-in", "welcome"], "(tabs)/todos")).toEqual([
			"welcome",
			"sign-in",
			"(tabs)/todos",
		]);
		expect(visitedRoutes(undefined, [], undefined)).toEqual([]);
	});
});

describe("specConfigFor", () => {
	test("routes become entries under the spec's id", () => {
		const config = specConfigFor(input());
		expect(config.id).toBe("sign-in");
		expect(config.suite).toBe("mobile");
		expect(config.entries).toEqual(["src/app/welcome.tsx", "src/app/sign-in.tsx"]);
		expect(config.captured).toBe(true);
		expect(config.hints).toEqual([]);
		expect(config.snippet).toContain('"src/app/welcome.tsx"');
	});

	test("no routes captured: empty entries and a hint", () => {
		const config = specConfigFor(input({ routes: [] }));
		expect(config.captured).toBe(false);
		expect(config.entries).toEqual([]);
		expect(config.snippet).toContain("entries: []");
		expect(config.hints[0]).toContain("fill `entries` by hand");
	});

	test("unresolved routes are listed and hinted", () => {
		const config = specConfigFor(input({ routes: ["welcome", "ghost"] }));
		expect(config.unresolved).toEqual(["ghost"]);
		expect(config.hints[0]).toContain("ghost");
	});

	test("no routerRoot: routes are kept, entries empty, hint says to set it", () => {
		const config = specConfigFor(input({ suite: suite() }));
		expect(config.routes).toEqual(["welcome", "sign-in"]);
		expect(config.entries).toEqual([]);
		expect(config.hints[0]).toContain("routerRoot");
	});

	test("no suite: the id comes from the file name", () => {
		const config = specConfigFor(input({ suite: undefined, file: "/p/e2e/onboarding.e2e.ts" }));
		expect(config.id).toBe("onboarding");
		expect(config.suite).toBeUndefined();
	});
});

describe("helper routes", () => {
	const use = (fn: string, extra: Record<string, unknown> = {}) =>
		({ i: 0, at: 1, kind: "use", module: "/m.ts", fn, ...extra }) as RecordedStep;
	const press = { i: 1, at: 2, kind: "home", route: "sign-in" } as RecordedStep;

	test("a use step brings its helper's routes before the route it ended on", () => {
		const steps = [use("signIn", { visited: ["welcome", "sign-in"], route: "(tabs)/todos" }), press];
		expect(stepRoutes(steps)).toEqual(["welcome", "sign-in", "(tabs)/todos", "sign-in"]);
		expect(visitedRoutes(undefined, stepRoutes(steps), undefined)).toEqual(["welcome", "sign-in", "(tabs)/todos"]);
	});

	test("a helper with a recording of its own leaves no gap; one with only reads, or none, does", () => {
		expect(helpersWithGaps([use("a", { visited: ["welcome"] })])).toEqual([]);
		expect(helpersWithGaps([use("a", { visited: ["welcome"], partial: true }), use("b"), use("a")])).toEqual([
			"a",
			"b",
		]);
		expect(helpersWithGaps([press])).toEqual([]);
	});
});

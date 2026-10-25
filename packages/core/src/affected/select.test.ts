import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "../types";
import { type E2eSuiteConfig, e2eSuiteSchema } from "./affected.schema";
import { graphOf, makeFixtureRepo } from "./fixture.testing";
import type { ChangedFile } from "./git";
import { type Reason, selectSpecs } from "./select";
import { scanSpecs } from "./specs";

let dir: string;
let write: (path: string, text: string) => void;

beforeEach(() => {
	({ dir, write } = makeFixtureRepo());
	write("specs/chats.e2e.ts", "export {};\n");
	write("specs/settings.e2e.ts", 'import "./shared/sign-in";\n');
	write("specs/shared/sign-in.ts", "export {};\n");
	write("specs/store-ios-01.e2e.ts", "export {};\n");
	write("specs/smoke.e2e.ts", "export {};\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function suite(overrides: Partial<Record<keyof E2eSuiteConfig, unknown>> = {}): E2eSuiteConfig {
	return e2eSuiteSchema.parse({
		specsDir: "specs",
		routerRoot: "src/app",
		runAll: ["bun.lock", "ios/**"],
		ignore: ["**/*.md"],
		unmapped: "skip",
		specs: {
			chats: { entries: ["src/app/(app)/chats.tsx"] },
			settings: { entries: ["src/app/(app)/settings.tsx"], required: false },
			"store-*": { paths: ["src/assets/**"] },
		},
		...overrides,
	});
}

async function select(changed: string[], platform: Platform = "ios", s = suite()) {
	const graph = await graphOf({ platform, repoRoot: dir });
	const changes: ChangedFile[] = changed.map((path) => ({ path, status: "modified" }));
	return selectSpecs({
		suite: s,
		configDir: dir,
		platform,
		changes,
		specs: scanSpecs(join(dir, "specs")).specs,
		imports: graph.imports,
	});
}

const ids = (sel: { selected: { id: string }[] }) => sel.selected.map((f) => f.id).sort();
const kinds = (reasons: Reason[]) => reasons.map((r) => r.kind);

describe("selectSpecs", () => {
	test("a file deep in a screen's import graph selects only that screen's spec, with the chain", async () => {
		const sel = await select(["packages/ui/src/button.tsx"]);
		expect(ids(sel)).toEqual(["chats"]);
		expect(sel.selected[0]?.reasons).toEqual([
			{
				kind: "import",
				file: "packages/ui/src/button.tsx",
				chain: [
					"src/app/(app)/chats.tsx",
					"src/chat/list.tsx",
					"packages/ui/src/index.ts",
					"packages/ui/src/button.tsx",
				],
			},
		]);
		expect(sel.skipped.sort()).toEqual(["settings", "smoke", "store-ios-01"]);
	});

	test("maxDepth (suite, overridden per spec) cuts long import chains", async () => {
		const shallow = suite({ maxDepth: 2 });
		expect(ids(await select(["packages/ui/src/button.tsx"], "ios", shallow))).toEqual([]);
		expect(ids(await select(["src/chat/lazy.tsx"], "ios", shallow))).toEqual(["chats"]);
		const deep = suite({ maxDepth: 2, specs: { chats: { entries: ["src/app/(app)/chats.tsx"], maxDepth: 5 } } });
		expect(ids(await select(["packages/ui/src/button.tsx"], "ios", deep))).toEqual(["chats"]);
	});

	test("platform files only select specs on their platform", async () => {
		expect(ids(await select(["src/chat/row.ios.tsx"], "ios"))).toEqual(["chats"]);
		expect(ids(await select(["src/chat/row.ios.tsx"], "android"))).toEqual([]);
		expect(ids(await select(["src/chat/android-only.tsx"], "android"))).toEqual(["chats"]);
	});

	test("router layouts above an entry count: the root layout's imports select every routed spec", async () => {
		expect(ids(await select(["src/providers.tsx"]))).toEqual(["chats", "settings"]);
	});

	test("paths globs, spec + fragment files", async () => {
		const sel = await select(["src/assets/logo.png", "specs/shared/sign-in.ts"]);
		expect(ids(sel)).toEqual(["chats", "settings", "store-ios-01"]);
		const settings = sel.selected.find((f) => f.id === "settings");
		expect(settings?.required).toBe(false);
		expect(kinds(settings?.reasons ?? [])).toEqual(["spec-file"]);
	});

	test("runAll selects every spec for the platform (store-ios is ios-only)", async () => {
		expect(ids(await select(["bun.lock"], "android"))).toEqual(["chats", "settings", "smoke"]);
	});

	test("always + unmapped: run; ignored and unreached files", async () => {
		const sel = await select(["README.md", "src/unused.ts"], "ios", suite({ always: ["smo*"], unmapped: "run" }));
		expect(ids(sel)).toEqual(["smoke"]);
		expect(kinds(sel.selected[0]?.reasons ?? [])).toEqual(["always", "unmapped"]);
		expect(sel.unreached).toEqual(["src/unused.ts"]);
	});

	test("a missing entry is a warning", async () => {
		const s = suite({ specs: { chats: { entries: ["src/app/nope.tsx"] } } });
		const sel = await select(["src/chat/list.tsx"], "ios", s);
		expect(sel.warnings).toEqual(["chats: entry src/app/nope.tsx does not exist"]);
	});
});

describe("include / exclude / only / scope / unmatched", () => {
	test("exclude drops specs by id glob; include keeps only matching ones", async () => {
		write("specs/online/lb.e2e.ts", "export {};\n");
		const all = await select(["bun.lock"]);
		expect(ids(all)).toContain("online/lb");
		const excl = await select(["bun.lock"], "ios", suite({ exclude: ["online/**"] }));
		expect(ids(excl)).not.toContain("online/lb");
		expect(excl.skipped).not.toContain("online/lb");
		const incl = await select(["bun.lock"], "ios", suite({ include: ["online/**"] }));
		expect(ids(incl)).toEqual(["online/lb"]);
	});

	test("only: all selects every candidate without a diff; specs selects ids / globs, in scan order", async () => {
		const sel = (only: Parameters<typeof selectSpecs>[0]["only"], s = suite()) =>
			selectSpecs({
				suite: s,
				configDir: dir,
				platform: "ios",
				changes: [],
				specs: scanSpecs(join(dir, "specs")).specs,
				only,
			});
		const all = sel({ mode: "all" });
		expect(all.selected.map((f) => f.id)).toEqual(["chats", "settings", "smoke", "store-ios-01"]);
		expect(kinds(all.selected[0]?.reasons ?? [])).toEqual(["all"]);
		const some = sel({ mode: "specs", patterns: ["smoke", "chat*"] });
		expect(some.selected.map((f) => f.id)).toEqual(["chats", "smoke"]);
		expect(kinds(some.selected[0]?.reasons ?? [])).toEqual(["requested"]);
		expect(sel({ mode: "specs", patterns: ["nope"] }).warnings.join()).toContain('"nope" matches no spec');
		expect(sel({ mode: "all" }, suite({ exclude: ["smoke"] })).selected.map((f) => f.id)).toEqual([
			"chats",
			"settings",
			"store-ios-01",
		]);
	});

	test("unmatched run-all: a counted change that reaches no spec selects every spec; skip (default) doesn't", async () => {
		expect(ids(await select(["src/brand-new/area.ts"]))).toEqual([]);
		const sel = await select(["src/brand-new/area.ts"], "ios", suite({ unmatched: "run-all" }));
		expect(ids(sel)).toEqual(["chats", "settings", "smoke", "store-ios-01"]);
		expect(sel.selected[0]?.reasons).toEqual([{ kind: "unmatched", file: "src/brand-new/area.ts" }]);
		// ignored files never count
		expect(ids(await select(["README.md"], "ios", suite({ unmatched: "run-all" })))).toEqual([]);
		// a change that reached a spec is not unmatched
		expect(ids(await select(["src/settings/form.tsx"], "ios", suite({ unmatched: "run-all" })))).toEqual(["settings"]);
	});

	test("scope limits which changed files count at all", async () => {
		const s = suite({ unmatched: "run-all", scope: ["src/**"] });
		expect(ids(await select(["docs/x.ts"], "ios", s))).toEqual([]);
		expect(ids(await select(["src/brand-new/area.ts"], "ios", s))).toEqual([
			"chats",
			"settings",
			"smoke",
			"store-ios-01",
		]);
		// runAll globs outside scope don't fire either
		expect(ids(await select(["bun.lock"], "ios", s))).toEqual([]);
	});
});

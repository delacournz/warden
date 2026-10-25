import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Recording } from "@delacour/warden-e2e/authoring/recording.schema";
import {
	findSharedSpecOptions,
	neededLaunch,
	reloadOptions,
	resolveOptionsRef,
	useOptionObjects,
} from "./authoring-options";

let dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

function specsDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "warden-options-"));
	dirs.push(dir);
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
	return dir;
}

const STEPS = [
	'export const SPEC_OPTIONS = { launch: "none", systemAlerts: "dismiss" } as const;',
	"export async function launch() {}",
].join("\n");
const SPEC = 'import { SPEC_OPTIONS } from "./helpers/steps";\ntest.use(SPEC_OPTIONS);\n';

describe("useOptionObjects", () => {
	test("only objects whose keys are all test.use options count", () => {
		const source = [
			'export const SPEC_OPTIONS = { launch: "none", systemAlerts: "dismiss" } as const;',
			"export const TIMEOUTS: UseOptions = {\n\ttimeout: 5,\n\tactionTimeout: 2,\n};",
			"export const ids = { welcome: 'welcome-screen' } as const;",
			'export const MIXED = { launch: "none", other: 1 };',
			"export const EMPTY = {};",
			"const hidden = { launch: 'none' };",
		].join("\n");
		expect(useOptionObjects(source)).toEqual([{ name: "SPEC_OPTIONS", launch: "none" }, { name: "TIMEOUTS" }]);
	});
});

describe("findSharedSpecOptions", () => {
	test("one candidate that a spec imports and passes to test.use is found, with its launch", () => {
		const dir = specsDir({ "helpers/steps.ts": STEPS, "sign-in.e2e.ts": SPEC });
		expect(findSharedSpecOptions(dir)).toEqual({
			kind: "found",
			options: { module: join(dir, "helpers", "steps.ts"), name: "SPEC_OPTIONS", launch: "none" },
		});
	});

	test("a spread into test.use counts, and so does an import with an extension", () => {
		const dir = specsDir({
			"helpers/steps.ts": STEPS,
			"a.e2e.ts": 'import { SPEC_OPTIONS } from "./helpers/steps.ts";\ntest.use({ ...SPEC_OPTIONS, timeout: 9 });\n',
		});
		expect(findSharedSpecOptions(dir).kind).toBe("found");
	});

	test("an object no spec passes to test.use is not shared", () => {
		const dir = specsDir({
			"helpers/steps.ts": STEPS,
			"a.e2e.ts": 'import { SPEC_OPTIONS } from "./helpers/steps";\n',
			"b.e2e.ts": "test.use(SPEC_OPTIONS);\n",
		});
		expect(findSharedSpecOptions(dir)).toEqual({ kind: "none" });
	});

	test("specs, tests and node_modules are not candidates; no specs means none", () => {
		const dir = specsDir({
			"x.e2e.ts": STEPS,
			"helpers/steps.test.ts": STEPS,
			"node_modules/pkg/index.ts": STEPS,
		});
		expect(findSharedSpecOptions(dir)).toEqual({ kind: "none" });
		expect(findSharedSpecOptions(join(dir, "missing"))).toEqual({ kind: "none" });
	});

	test("two shared objects are ambiguous: nothing is guessed", () => {
		const dir = specsDir({
			"helpers/steps.ts": STEPS,
			"helpers/other.ts": "export const SLOW = { timeout: 60000 };\n",
			"a.e2e.ts": `${SPEC}import { SLOW } from "./helpers/other";\ntest.use(SLOW);\n`,
		});
		expect(findSharedSpecOptions(dir)).toEqual({ kind: "ambiguous", names: ["SLOW", "SPEC_OPTIONS"] });
	});
});

describe("resolveOptionsRef", () => {
	test("a module#name that exports an options object; the extension is optional", () => {
		const dir = specsDir({ "helpers/steps.ts": STEPS });
		expect(resolveOptionsRef("helpers/steps#SPEC_OPTIONS", dir)).toEqual({
			success: true,
			data: { module: join(dir, "helpers", "steps.ts"), name: "SPEC_OPTIONS", launch: "none" },
		});
	});

	test("a missing module, a missing export and a non-options export are errors", () => {
		const dir = specsDir({ "steps.ts": `${STEPS}\nexport const ids = { a: "b" } as const;\n` });
		expect(resolveOptionsRef("nope#X", dir)).toMatchObject({ success: false });
		expect(resolveOptionsRef("steps#MISSING", dir)).toMatchObject({ success: false });
		expect(resolveOptionsRef("steps#ids", dir)).toMatchObject({ success: false });
		expect(resolveOptionsRef("steps", dir)).toMatchObject({ success: false });
	});

	test("reloadOptions re-reads the launch from disk", () => {
		const dir = specsDir({ "steps.ts": 'export const OPTS = { launch: "fresh" };\n' });
		const options = { module: join(dir, "steps.ts"), name: "OPTS" };
		expect(reloadOptions(options)).toEqual({ ...options, launch: "fresh" });
		writeFileSync(options.module, "export const OPTS = { timeout: 3 };\n");
		expect(reloadOptions(options)).toEqual(options);
	});
});

describe("neededLaunch", () => {
	const recording = (steps: unknown[]): Recording => ({ steps }) as unknown as Recording;
	const helper = (module: string) =>
		module === "/h.ts"
			? "export async function a(app) { await app.open(); }\nexport async function b() {}\n"
			: undefined;

	test("an open of the app, or a use of a helper that opens it, means the recording launches the app", () => {
		expect(neededLaunch(recording([{ kind: "open" }]), helper)).toBe("none");
		expect(
			neededLaunch(
				recording([
					{ kind: "note", text: "x" },
					{ kind: "open", app: "com.x" },
				]),
				helper
			)
		).toBe("none");
		expect(neededLaunch(recording([{ kind: "use", module: "/h.ts", fn: "a" }]), helper)).toBe("none");
	});

	test("a bare deep link, a helper that does not open, or anything else leaves the launch to the runner", () => {
		expect(neededLaunch(recording([{ kind: "open", url: "app://x" }]), helper)).toBe("fresh");
		expect(neededLaunch(recording([{ kind: "use", module: "/h.ts", fn: "b" }]), helper)).toBe("fresh");
		expect(neededLaunch(recording([{ kind: "use", module: "/gone.ts", fn: "a" }]), helper)).toBe("fresh");
		expect(neededLaunch(recording([{ kind: "press" }, { kind: "open" }]), helper)).toBe("fresh");
		expect(neededLaunch(recording([]), helper)).toBe("fresh");
	});
});

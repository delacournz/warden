import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "../exec";
import { computeAffected } from "./affected";
import { DEFAULT_E2E_RUNNER } from "./affected.defaults";
import { makeSuiteRepo } from "./fixture.testing";

let dir: string;
let write: (path: string, text: string) => void;

beforeEach(async () => {
	({ dir, write } = await makeSuiteRepo());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("computeAffected", () => {
	test("git changes vs base → selection for the suite's platform; imports cached to disk", async () => {
		write("src/settings/form.tsx", "export const changed = 1;\n");
		const cacheDir = join(dir, ".cache");
		const res = await computeAffected({ exec: bunExec, cwd: join(dir, "src"), cacheDir });
		if (!res.success) throw new Error(res.error);
		expect(res.data.suite.name).toBe("mobile");
		expect(res.data.base).toBe("main");
		expect(res.data.changes).toEqual([{ path: "src/settings/form.tsx", status: "modified" }]);
		expect(res.data.selections.map((s) => s.platform)).toEqual(["ios"]);
		expect(res.data.selections[0]?.selected.map((f) => f.id)).toEqual(["settings"]);
		expect(readdirSync(cacheDir)).toHaveLength(1);
	});

	test("--files instead of git, relative to cwd", async () => {
		const res = await computeAffected({ exec: bunExec, cwd: join(dir, "src"), files: ["chat/lazy.tsx"] });
		if (!res.success) throw new Error(res.error);
		expect(res.data.base).toBeUndefined();
		expect(res.data.selections[0]?.selected.map((f) => f.id)).toEqual(["chats"]);
	});

	test("unknown suite", async () => {
		const res = await computeAffected({ exec: bunExec, cwd: dir, suite: "web" });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain('no e2e suite "web"');
	});
});

describe("computeAffected without e2e suites (an Expo app with an e2e/ dir)", () => {
	let app: string;
	beforeEach(() => {
		app = mkdtempSync(join(tmpdir(), "warden-default-suite-"));
		writeFileSync(join(app, "app.json"), JSON.stringify({ expo: { slug: "fresh", ios: { bundleIdentifier: "x.y" } } }));
	});
	afterEach(() => rmSync(app, { recursive: true, force: true }));

	test("the default suite: every flow in e2e/, one runner for a 2-sim pool, the dev client on warden's Metro", async () => {
		mkdirSync(join(app, "e2e/helpers"), { recursive: true });
		writeFileSync(join(app, "e2e/a.e2e.ts"), "export {};\n");
		writeFileSync(join(app, "e2e/b.e2e.ts"), "export {};\n");
		writeFileSync(join(app, "e2e/helpers/ids.ts"), "export {};\n");
		const res = await computeAffected({ exec: bunExec, cwd: join(app, "e2e") });
		if (!res.success) throw new Error(res.error);
		const { suite } = res.data;
		expect(suite).toMatchObject({ name: "fresh", implicit: true, configDir: app, cwd: app, projectRoot: app });
		expect(suite.config).toMatchObject({
			flowsDir: "e2e",
			runner: DEFAULT_E2E_RUNNER,
			mode: "single",
			platform: "ios",
			count: 2,
			app: true,
			metro: { enabled: true, open: true },
		});
		expect(res.data.base).toBeUndefined();
		expect(res.data.selections.map((s) => s.platform)).toEqual(["ios"]);
		expect(res.data.selections[0]?.selected.map((f) => f.id)).toEqual(["a", "b"]);
	});

	test("a project with a dev variant installs it", async () => {
		mkdirSync(join(app, "e2e"));
		writeFileSync(
			join(app, "warden.config.json"),
			JSON.stringify({
				projects: [
					{ name: "fresh", bundleId: { ios: "x.y" }, build: { configuration: "Release" }, variants: { dev: {} } },
				],
			})
		);
		const res = await computeAffected({ exec: bunExec, cwd: app });
		if (!res.success) throw new Error(res.error);
		expect(res.data.suite.config.app).toEqual({ variant: "dev" });
	});

	test("no e2e/ dir → an error pointing at warden init", async () => {
		const res = await computeAffected({ exec: bunExec, cwd: app });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("warden init");
	});

	test("a named suite still needs a config", async () => {
		mkdirSync(join(app, "e2e"));
		const res = await computeAffected({ exec: bunExec, cwd: app, suite: "mobile" });
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("warden.config.ts");
	});
});

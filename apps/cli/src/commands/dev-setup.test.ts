import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectContext } from "@delacour/warden-core/builds/ensure";
import { fakeExec, type ScriptedUi, scriptedUi, testContext } from "../testing";
import { describeIssue, diagnoseDev, offerDevSetup } from "./dev-setup";

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

function app(packageJson: unknown, lockfile = "yarn.lock"): string {
	dir = mkdtempSync(join(tmpdir(), "warden-dev-setup-"));
	const root = join(dir, "apps", "mobile");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify(packageJson));
	writeFileSync(join(dir, lockfile), "");
	return root;
}

function context(root: string, over: Partial<ProjectContext> = {}): ProjectContext {
	return {
		project: {
			name: "wallet",
			root,
			bundleId: { ios: "com.x.dev" },
			framework: "expo",
			build: { ios: "b", android: "b" },
			buildConfiguration: "Debug",
			cacheDirs: [],
			origin: "app.config",
			source: "auto",
		},
		projectKey: "k",
		...over,
	};
}

describe("diagnoseDev", () => {
	test("a missing expo-dev-client is a package issue with the checkout's installer", () => {
		const root = app({ dependencies: { expo: "58.0.0" } });
		const issues = diagnoseDev(context(root));
		expect(issues).toEqual([
			{ kind: "package", root, packages: ["expo-dev-client"], command: ["yarn", "expo", "install", "expo-dev-client"] },
		]);
		expect(describeIssue(issues[0] as never)).toContain("run: yarn expo install expo-dev-client");
	});

	test("an app resolved through expo config gets the warden.config.ts offer; a configured one does not", () => {
		const root = app({ dependencies: { "expo-dev-client": "1" } });
		expect(diagnoseDev(context(root))).toEqual([]);
		expect(diagnoseDev(context(root, { appConfig: { slug: "wallet" } }))).toEqual([
			{ kind: "config", root, name: "wallet", bundleId: { ios: "com.x.dev" } },
		]);
		writeFileSync(join(root, "warden.config.ts"), "export default {}");
		expect(diagnoseDev(context(root, { appConfig: { slug: "wallet" } }))).toEqual([]);
	});
});

describe("offerDevSetup", () => {
	test("without a terminal the blocking issue is the error, named with its command", async () => {
		const root = app({ dependencies: {} });
		const c = testContext([]);
		const res = await offerDevSetup(c, diagnoseDev(context(root, { appConfig: {} })), { interactive: false });
		expect(res).toEqual({ success: false, error: expect.stringContaining("yarn expo install expo-dev-client") });
		expect(c.stderr.some((l) => l.includes("warden init"))).toBe(true);
	});

	test("accepting runs the install in the app root and reports changed", async () => {
		const root = app({ dependencies: {} });
		const calls: string[][] = [];
		const cwds: Array<string | undefined> = [];
		const c = testContext([], {
			exec: async (cmd, opts) => {
				calls.push([...cmd]);
				cwds.push(opts?.cwd);
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		c.ui = scriptedUi({ interactive: true, confirm: [true] });
		const res = await offerDevSetup(c, diagnoseDev(context(root)), { interactive: true });
		expect(res).toEqual({ success: true, data: "changed" });
		expect(calls).toEqual([["yarn", "expo", "install", "expo-dev-client"]]);
		expect(cwds).toEqual([root]);
		expect((c.ui as ScriptedUi).events.some((e) => e.startsWith("confirm: expo-dev-client isn't in"))).toBe(true);
	});

	test("declining the install is the error; a failing install reports its exit and output", async () => {
		const root = app({ dependencies: {} });
		const declined = testContext([]);
		declined.ui = scriptedUi({ interactive: true, confirm: [false] });
		const no = await offerDevSetup(declined, diagnoseDev(context(root)), { interactive: true });
		expect(no.success).toBe(false);
		const failing = testContext([], { exec: fakeExec([["yarn expo install", { exitCode: 1, stderr: "ECONNRESET" }]]) });
		failing.ui = scriptedUi({ interactive: true, confirm: [true] });
		const res = await offerDevSetup(failing, diagnoseDev(context(root)), { interactive: true });
		expect(res).toEqual({ success: false, error: expect.stringContaining("ECONNRESET") });
	});

	test("accepting the config offer writes a warden.config.ts with the project and no e2e block", async () => {
		const root = app({ dependencies: { "expo-dev-client": "1" } });
		const calls: string[][] = [];
		const c = testContext([], { exec: fakeExec([], calls) });
		c.ui = scriptedUi({ interactive: true, confirm: [true] });
		const res = await offerDevSetup(c, diagnoseDev(context(root, { appConfig: { slug: "wallet" } })), {
			interactive: true,
		});
		expect(res).toEqual({ success: true, data: "changed" });
		const written = readFileSync(join(root, "warden.config.ts"), "utf8");
		expect(written).toContain('name: "wallet"');
		expect(written).toContain('ios: "com.x.dev"');
		expect(written).not.toContain("e2e:");
		expect(calls.filter((cmd) => cmd[1] === "prettier")).toEqual([]);
		const again = testContext([]);
		again.ui = scriptedUi({ interactive: true, confirm: [false] });
		expect(await offerDevSetup(again, diagnoseDev(context(root, { appConfig: {} })), { interactive: true })).toEqual({
			success: true,
			data: "unchanged",
		});
	});
});

describe("formatting the written config", () => {
	test("a checkout with a prettier config gets the file run through its prettier; errors are a note only", async () => {
		const root = app({ dependencies: { "expo-dev-client": "1" } });
		writeFileSync(join(root, "..", "..", ".prettierrc.json"), "{}");
		const calls: string[][] = [];
		const cwds: Array<string | undefined> = [];
		const c = testContext([], {
			exec: async (cmd, opts) => {
				calls.push([...cmd]);
				cwds.push(opts?.cwd);
				return { exitCode: 2, stdout: "", stderr: "boom" };
			},
		});
		c.ui = scriptedUi({ interactive: true, confirm: [true] });
		const res = await offerDevSetup(c, diagnoseDev(context(root, { appConfig: {} })), { interactive: true });
		expect(res).toEqual({ success: true, data: "changed" });
		expect(calls).toEqual([["yarn", "prettier", "--write", join(root, "warden.config.ts")]]);
		expect(cwds).toEqual([root]);
		expect(c.stderr.some((l) => l.includes("prettier --write") && l.includes("exit 2"))).toBe(true);
		expect(readFileSync(join(root, "warden.config.ts"), "utf8")).toContain('name: "wallet"');
	});
});

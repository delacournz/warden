import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../exec";
import type { BundleOutput } from "./repack.types";
import { applyIosRepack } from "./repack-ios";

let dir: string;
let base: string;
let outDir: string;
let bundle: BundleOutput;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-repack-ios-"));
	base = join(dir, "base", "App.app");
	mkdirSync(join(base, "assets", "old"), { recursive: true });
	writeFileSync(join(base, "Info.plist"), "plist");
	writeFileSync(join(base, "assets", "old", "gone.png"), "x");
	outDir = join(dir, "out");
	mkdirSync(outDir);
	const scratch = join(dir, "scratch");
	mkdirSync(join(scratch, "assets", "assets", "new"), { recursive: true });
	writeFileSync(join(scratch, "assets", "assets", "new", "fresh.png"), "y");
	writeFileSync(join(scratch, "main.jsbundle"), "NEW-JS");
	writeFileSync(join(scratch, "main.jsbundle.map"), "{}");
	bundle = {
		bundle: join(scratch, "main.jsbundle"),
		assetsDir: join(scratch, "assets"),
		sourcemap: join(scratch, "main.jsbundle.map"),
		hermes: false,
	};
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Opts = {
	entitlements?: string;
	cloneFails?: boolean;
	signFails?: boolean;
	idAfter?: string;
};

const done: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

/** `cp` copies for real; `-c` (clone) can be made to fail */
function fakeCp(opts: Opts, args: string[]): ExecResult {
	if (args[0] === "-c" && opts.cloneFails) return { ...done, exitCode: 1, stderr: "clone unsupported" };
	const [from, to] = args.slice(-2) as [string, string];
	cpSync(from, to, { recursive: true });
	return done;
}

/** `plutil -extract` answers the bundle id (changed after the repack when `idAfter` is set); `-create` writes the file */
function fakePlutil(opts: Opts, args: string[]): ExecResult {
	if (args[0] === "-extract") {
		const afterRepack = args.at(-1)?.startsWith(outDir) === true;
		return { ...done, stdout: `${afterRepack ? (opts.idAfter ?? "com.x.app") : "com.x.app"}\n` };
	}
	if (args[0] === "-create") {
		writeFileSync(args[2] ?? "", "");
		return done;
	}
	return done;
}

/** `codesign -d` prints the entitlements; `--force` signs (or fails) */
function fakeCodesign(opts: Opts, args: string[]): ExecResult {
	if (args[0] === "-d") {
		return { ...done, stdout: opts.entitlements ?? '<?xml version="1.0"?><plist><dict></dict></plist>' };
	}
	if (args[0] === "--force") return opts.signFails ? { ...done, exitCode: 1, stderr: "no identity" } : done;
	return done;
}

/** a fake host: `cp` copies for real (nothing else touches the machine); plutil / codesign answer from `opts` */
function host(opts: Opts, calls: string[][]): Exec {
	const tools: Record<string, (opts: Opts, args: string[]) => ExecResult> = {
		cp: fakeCp,
		plutil: fakePlutil,
		codesign: fakeCodesign,
	};
	return async (cmd) => {
		calls.push([...cmd]);
		const [bin = "", ...args] = cmd;
		return tools[bin]?.(opts, args) ?? done;
	};
}

const run = (opts: Opts = {}) => {
	const calls: string[][] = [];
	return applyIosRepack({ exec: host(opts, calls), baseArtifact: base, outDir, bundle }).then((res) => ({
		res,
		calls,
	}));
};

describe("applyIosRepack", () => {
	test("clones the base, swaps bundle + assets, keeps the map beside the app, re-signs ad-hoc", async () => {
		const { res, calls } = await run();
		const app = join(outDir, "App.app");
		expect(res).toEqual({ success: true, data: { artifact: app } });
		expect(readFileSync(join(app, "main.jsbundle"), "utf8")).toBe("NEW-JS");
		expect(existsSync(join(app, "assets", "old", "gone.png"))).toBe(false);
		expect(existsSync(join(app, "assets", "new", "fresh.png"))).toBe(true);
		expect(existsSync(join(app, "main.jsbundle.map"))).toBe(false);
		expect(existsSync(join(outDir, "main.jsbundle.map"))).toBe(true);
		expect(calls.some((c) => c.join(" ").startsWith("cp -c -R"))).toBe(true);
		const sign = calls.find((c) => c[1] === "--force");
		expect(sign).toEqual(["codesign", "--force", "--sign", "-", "--timestamp=none", app]);
		expect(existsSync(join(outDir, ".entitlements.plist"))).toBe(false);
	});

	test("a base that kept its own embedded bundle (an imported CI build) gets this JS, not the stale one", async () => {
		writeFileSync(join(base, "main.jsbundle"), "OLD-EMBEDDED-JS");
		mkdirSync(join(base, "EXUpdates.bundle"), { recursive: true });
		writeFileSync(join(base, "EXUpdates.bundle", "app.manifest"), "{}");
		const { res, calls } = await run();
		expect(res.success).toBe(true);
		const app = join(outDir, "App.app");
		expect(readFileSync(join(app, "main.jsbundle"), "utf8")).toBe("NEW-JS");
		expect(existsSync(join(app, "assets", "old", "gone.png"))).toBe(false);
		expect(readFileSync(join(base, "main.jsbundle"), "utf8")).toBe("OLD-EMBEDDED-JS");
		expect(calls.some((c) => c.includes("EXUpdatesEnabled"))).toBe(true);
	});

	test("an empty entitlements dict signs without --entitlements; a real one is passed through", async () => {
		const empty = await run();
		expect(empty.calls.find((c) => c[1] === "--force")).not.toContain("--entitlements");
		rmSync(outDir, { recursive: true, force: true });
		mkdirSync(outDir);
		const plist = '<?xml version="1.0"?><plist><dict><key>get-task-allow</key><true/></dict></plist>';
		const full = await run({ entitlements: plist });
		const sign = full.calls.find((c) => c[1] === "--force") ?? [];
		expect(sign).toContain("--entitlements");
		expect(sign.at(-2)).toBe(join(outDir, ".entitlements.plist"));
	});

	test("expo-updates present: EXUpdatesEnabled is set false in Expo.plist (created when missing)", async () => {
		mkdirSync(join(base, "EXUpdates.bundle"));
		const { res, calls } = await run();
		expect(res.success).toBe(true);
		const plist = join(outDir, "App.app", "Expo.plist");
		expect(calls).toContainEqual(["plutil", "-create", "xml1", plist]);
		expect(calls).toContainEqual(["plutil", "-replace", "EXUpdatesEnabled", "-bool", "false", plist]);
	});

	test("no expo-updates: Expo.plist is left alone", async () => {
		const { calls } = await run();
		expect(calls.some((c) => c[0] === "plutil" && c[1] === "-replace")).toBe(false);
	});

	test("falls back to a plain copy when the volume cannot clone", async () => {
		const { res, calls } = await run({ cloneFails: true });
		expect(res.success).toBe(true);
		expect(existsSync(join(outDir, "App.app", "Info.plist"))).toBe(true);
		expect(calls.some((c) => c[0] === "cp" && c[1] === "-c")).toBe(true);
	});

	test("errors: codesign failure, bundle id change", async () => {
		const signFails = await run({ signFails: true });
		expect(signFails.res).toMatchObject({ success: false });
		rmSync(outDir, { recursive: true, force: true });
		mkdirSync(outDir);
		const changed = await run({ idAfter: "com.other" });
		expect(changed.res).toEqual({ success: false, error: "the bundle id changed (com.x.app → com.other)" });
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { err, ok } from "@delacour/warden-types/result";
import { bunExec, type Exec, type ExecResult } from "../exec";
import { openStore, type Store } from "../store";
import type { Platform } from "../types";
import { fakeApp, testProject } from "./builds.testing";
import { findRepack, getBuild, getInstall, kindDir, kindHash, recordInstall, storeArtifact } from "./cache";
import type { ensureKindBuild } from "./ensure";
import { readRepackMeta } from "./js-key";
import { computeKindKey } from "./kind-key";
import {
	bundlerFlags,
	detectHermes,
	findHermesc,
	hasHbcMagic,
	type RepackInput,
	repackApp,
	resolveEntryFile,
} from "./repack";
import type { ApplyRepack } from "./repack.types";
import type { ResolveSource } from "./resolve";

let dir: string;
let root: string;
let store: Store;
let env: Record<string, string>;
let clock: number;
const KEY = "github.com/o/r:app";
const HBC = Uint8Array.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f, 0, 0]);

async function git(...args: string[]): Promise<void> {
	const res = await bunExec(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
	if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
}

beforeEach(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-repack-")));
	root = join(dir, "app");
	env = { WARDEN_HOME: join(dir, "home"), HOME: join(dir, "user") };
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
	writeFileSync(join(root, "node_modules", ".bin", "expo"), "");
	writeFileSync(join(root, "node_modules", ".bin", "react-native"), "");
	writeFileSync(join(root, "package.json"), JSON.stringify({ main: "index.js" }));
	writeFileSync(join(root, "index.js"), "main");
	writeFileSync(join(root, "src", "a.ts"), "a");
	writeFileSync(join(root, ".gitignore"), "node_modules\n");
	await git("init", "-q", "-b", "main");
	await git("add", "-A");
	await git("commit", "-q", "-m", "init");
	store = openStore(join(dir, "home", "warden.db"));
	clock = 10_000;
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

type Host = { exec: Exec; calls: string[][] };

/** hermesc: fails, or writes bytecode (with bad magic when asked) plus its map at `out` */
function fakeHermesc(over: { hermescFails?: boolean; hermescBadMagic?: boolean }, out: string): ExecResult {
	if (over.hermescFails) return { exitCode: 1, stdout: "", stderr: "hermesc boom" };
	writeFileSync(out, over.hermescBadMagic ? new Uint8Array(10) : HBC);
	writeFileSync(`${out}.map`, "{}");
	return { exitCode: 0, stdout: "", stderr: "" };
}

/** the bundler: logs its start / end to `events`, fails, or writes the bundle and its map */
async function fakeBundler(over: HostOver, args: string[]): Promise<ExecResult> {
	const flagOf = (name: string) => args[args.indexOf(name) + 1] ?? "";
	over.events?.push("bundle");
	await Bun.sleep(5);
	over.events?.push("bundle:end");
	if (over.bundleFails) return { exitCode: 1, stdout: "", stderr: "metro exploded" };
	writeFileSync(flagOf("--bundle-output"), "JS");
	writeFileSync(flagOf("--sourcemap-output"), "{}");
	return { exitCode: 0, stdout: "", stderr: "" };
}

/** git is real; the project's fingerprint command, the bundler, hermesc and the compose script are fake */
type HostOver = {
	bundleFails?: boolean;
	hermescFails?: boolean;
	hermescBadMagic?: boolean;
	/** "bundle" is pushed when the bundler starts, "bundle:end" when it returns */
	events?: string[];
	/** what `unzip -Z1 <apk>` lists */
	apkEntries?: string[];
};

function host(over: HostOver = {}): Host {
	const calls: string[][] = [];
	const done: ExecResult = { exitCode: 0, stdout: "", stderr: "" };
	const flagOf = (args: string[], name: string) => args[args.indexOf(name) + 1] ?? "";
	const exec: Exec = async (cmd, opts) => {
		const [bin = "", ...args] = cmd;
		if (cmd.join(" ") === "sh -c fp") return { ...done, stdout: '{"hash":"native-1"}' };
		if (bin === "git") return bunExec(cmd, opts);
		calls.push([...cmd]);
		if (bin.endsWith("/.bin/expo") || bin.endsWith("/.bin/react-native")) return fakeBundler(over, args);
		if (bin === "unzip" && over.apkEntries) return { ...done, stdout: `${over.apkEntries.join("\n")}\n` };
		if (bin.endsWith("/hermesc")) return fakeHermesc(over, flagOf(args, "-out"));
		if (bin === "node") {
			writeFileSync(args[args.indexOf("-o") + 1] ?? "", "{}");
			return done;
		}
		return { exitCode: 127, stdout: "", stderr: cmd.join(" ") };
	};
	return { exec, calls };
}

type Applied = { count: number; bundles: boolean[] };

/** copies the base into outDir and records whether the bundle handed over was Hermes bytecode */
function applier(applied: Applied, over: { fail?: boolean; fallback?: string } = {}): ApplyRepack {
	return async ({ baseArtifact, outDir, bundle }) => {
		applied.count++;
		applied.bundles.push(bundle.hermes);
		mkdirSync(outDir, { recursive: true });
		if (over.fail) {
			writeFileSync(join(outDir, "partial"), "x");
			return err("codesign exploded");
		}
		if (over.fallback) return ok({ fallback: true, reason: over.fallback });
		if (baseArtifact.endsWith(".apk")) {
			const apk = join(outDir, basename(baseArtifact));
			writeFileSync(apk, "REPACKED");
			return ok({ artifact: apk });
		}
		const target = join(outDir, "App.app");
		cpSync(baseArtifact, target, { recursive: true });
		writeFileSync(join(target, "main.jsbundle"), "REPACKED");
		return ok({ artifact: target });
	};
}

async function seedBase(binary = "binary!"): Promise<void> {
	const keys = await computeKindKey({
		exec: host().exec,
		project: testProject({ root, fingerprintCommand: "fp" }),
		platform: "ios",
		kind: "simulator",
		env: {},
	});
	if (!keys.success) throw new Error(keys.error);
	const app = fakeApp(join(dir, "src"));
	writeFileSync(join(app, "App"), binary);
	mkdirSync(join(app, "Frameworks", "hermesvm.framework"), { recursive: true });
	const stored = await storeArtifact({
		store,
		env,
		projectKey: KEY,
		platform: "ios",
		profile: "local:simulator",
		hash: kindHash(keys.data.key),
		artifact: app,
		source: "import",
		layout: { dir: kindDir(env, KEY, "ios", keys.data.key), kind: "simulator-base" },
		now: 1,
	});
	if (!stored.success) throw new Error(stored.error);
}

/** A fake Android base: an apk file. */
function fakeApk(parent: string, body = "apk-bytes"): string {
	mkdirSync(parent, { recursive: true });
	const apk = join(parent, "app-release.apk");
	writeFileSync(apk, body);
	return apk;
}

/**
 * `ensureKindBuild` that "builds" the simulator base: pushes "base:start", waits `delayMs`, caches a fake `.app` /
 * `.apk` at the base's kind dir, pushes "base:end" and reports `source`.
 */
function baseBuilder(
	events: string[],
	platform: Platform,
	over: { source?: ResolveSource; delayMs?: number; fails?: string } = {}
): typeof ensureKindBuild {
	return async (inp) => {
		events.push("base:start");
		await Bun.sleep(over.delayMs ?? 40);
		if (over.fails) {
			events.push("base:end");
			return err(over.fails);
		}
		const src = mkdtempSync(join(dir, "built-"));
		let artifact: string;
		if (platform === "ios") {
			artifact = fakeApp(src);
			mkdirSync(join(artifact, "Frameworks", "hermesvm.framework"), { recursive: true });
		} else artifact = fakeApk(src);
		const hash = kindHash(inp.key);
		const stored = await storeArtifact({
			store,
			env,
			projectKey: KEY,
			platform,
			profile: "local:simulator",
			hash,
			artifact,
			source: "build",
			layout: { dir: kindDir(env, KEY, platform, inp.key), kind: "simulator-base" },
			now: 1,
		});
		if (!stored.success) throw new Error(stored.error);
		events.push("base:end");
		return ok({ appPath: stored.data.path, hash, source: over.source ?? "build", installed: false });
	};
}

function input(h: Host, applied: Applied, over: Partial<RepackInput> = {}): RepackInput {
	return {
		store,
		exec: h.exec,
		env,
		now: () => (clock += 10),
		sleep: async () => {},
		log: () => {},
		pidAlive: () => false,
		owner: { kind: "agent", sessionId: "me", cwd: dir },
		pid: 1,
		project: testProject({ root, fingerprintCommand: "fp" }),
		projectKey: KEY,
		platform: "ios",
		eas: false,
		build: false,
		repackers: { ios: applier(applied), android: applier(applied) },
		scratchRoot: join(dir, "scratch"),
		...over,
	};
}

const fresh = (): Applied => ({ count: 0, bundles: [] });
const stagingLeft = (): string[] => {
	const repacks = join(dir, "home", "builds");
	const found: string[] = [];
	const walk = (d: string): void => {
		if (!existsSync(d)) return;
		for (const e of readdirSync(d, { withFileTypes: true })) {
			if (e.name.startsWith(".staging-")) found.push(join(d, e.name));
			else if (e.isDirectory()) walk(join(d, e.name));
		}
	};
	walk(repacks);
	return found;
};

describe("repackApp", () => {
	test("bundles, Hermes-compiles, applies, records and writes meta; the second call reuses it", async () => {
		await seedBase();
		const h = host();
		const applied = fresh();
		mkdirSync(join(root, "node_modules", "hermes-compiler", "hermesc", "osx-bin"), { recursive: true });
		writeFileSync(join(root, "node_modules", "hermes-compiler", "hermesc", "osx-bin", "hermesc"), "");
		mkdirSync(join(root, "node_modules", "react-native", "scripts"), { recursive: true });
		writeFileSync(join(root, "node_modules", "react-native", "scripts", "compose-source-maps.js"), "");
		const first = await repackApp(input(h, applied, { hermes: async () => true }));
		if (!first.success || first.data.kind !== "repacked") throw new Error(JSON.stringify(first));
		expect(applied).toEqual({ count: 1, bundles: [true] });
		expect(first.data.artifact).toBe(
			join(
				kindDir(env, KEY, "ios", {
					kind: "simulator-repack",
					nativeFp: first.data.baseHash.split(":")[0] ?? "",
					jsKey: first.data.jsKey,
				}),
				"App.app"
			)
		);
		expect(first.data.hash).toBe(`${first.data.baseHash.split(":")[0]}:${first.data.jsKey}`);
		const record = getBuild(store, KEY, "ios", first.data.hash);
		expect(record).toMatchObject({
			kind: "simulator-repack",
			baseHash: first.data.baseHash,
			jsKey: first.data.jsKey,
			branch: "main",
		});
		expect(existsSync(join(dirname(first.data.artifact), "meta.json"))).toBe(true);
		const bundler = h.calls.find((c) => c[0]?.endsWith("/.bin/expo"));
		expect(bundler?.slice(1, 8)).toEqual(["export:embed", "--platform", "ios", "--dev", "false", "--minify", "true"]);
		expect(bundler).toContain("--reset-cache");
		expect(h.calls.some((c) => c[0]?.endsWith("/hermesc") && c.includes("-emit-binary"))).toBe(true);
		expect(h.calls.some((c) => c[0] === "node" && c.includes("-o"))).toBe(true);
		expect(stagingLeft()).toEqual([]);
		expect(existsSync(join(dir, "scratch")) ? readdirSync(join(dir, "scratch")) : []).toEqual([]);

		h.calls.length = 0;
		const second = await repackApp(input(h, applied));
		expect(second).toMatchObject({
			success: true,
			data: { kind: "reused", artifact: first.data.artifact, jsKey: first.data.jsKey },
		});
		expect(second.success && second.data.kind === "reused" && second.data.bundleMs).toBe(first.data.bundleMs);
		expect(applied.count).toBe(1);
		expect(h.calls).toEqual([]);
		expect(getBuild(store, KEY, "ios", first.data.hash)?.lastUsedAt).toBeGreaterThan(record?.lastUsedAt ?? 0);
	});

	test("a JS edit makes a new repack over the same base", async () => {
		await seedBase();
		const h = host();
		const applied = fresh();
		const a = await repackApp(input(h, applied, { hermes: async () => false }));
		writeFileSync(join(root, "src", "a.ts"), "edited");
		const b = await repackApp(input(h, applied, { hermes: async () => false }));
		if (!a.success || !b.success || a.data.kind !== "repacked" || b.data.kind !== "repacked")
			throw new Error("expected repacks");
		expect(b.data.baseHash).toBe(a.data.baseHash);
		expect(b.data.jsKey).not.toBe(a.data.jsKey);
		expect(applied.count).toBe(2);
	});

	test("JSC (no Hermes): no hermesc, the plain bundle is handed to the repacker", async () => {
		await seedBase();
		const h = host();
		const applied = fresh();
		const res = await repackApp(input(h, applied, { hermes: async () => false }));
		expect(res.success && res.data.kind).toBe("repacked");
		expect(applied.bundles).toEqual([false]);
		expect(h.calls.some((c) => c[0]?.endsWith("/hermesc"))).toBe(false);
	});

	test("the default Hermes detection reads the base's frameworks", async () => {
		await seedBase();
		const h = host();
		const applied = fresh();
		mkdirSync(join(root, "node_modules", "hermes-compiler", "hermesc", "osx-bin"), { recursive: true });
		writeFileSync(join(root, "node_modules", "hermes-compiler", "hermesc", "osx-bin", "hermesc"), "");
		await repackApp(input(h, applied));
		expect(applied.bundles).toEqual([true]);
	});

	test("the same base again: the repack is reused", async () => {
		await seedBase();
		const h = host();
		const applied = fresh();
		await repackApp(input(h, applied, { hermes: async () => false }));
		await seedBase();
		const again = await repackApp(input(h, applied, { hermes: async () => false }));
		expect(again).toMatchObject({ success: true, data: { kind: "reused" } });
		expect(applied.count).toBe(1);
	});

	test("a base replaced under the same native fingerprint: the repack is rebuilt (base-changed)", async () => {
		await seedBase("base A");
		const h = host();
		const applied = fresh();
		const first = await repackApp(input(h, applied, { hermes: async () => false }));
		if (!first.success || first.data.kind !== "repacked") throw new Error(JSON.stringify(first));
		expect(first.data.reason).toBeUndefined();
		await seedBase("base B, other signature");
		const second = await repackApp(input(h, applied, { hermes: async () => false }));
		expect(second).toMatchObject({ success: true, data: { kind: "repacked", reason: "base-changed" } });
		expect(applied.count).toBe(2);
		const third = await repackApp(input(h, applied, { hermes: async () => false }));
		expect(third).toMatchObject({ success: true, data: { kind: "reused" } });
		expect(applied.count).toBe(2);
	});

	test("a cached repack signed by another key than its base is rebuilt (signer-changed)", async () => {
		await seedBase();
		const h = host();
		const applied = fresh();
		await repackApp(input(h, applied, { hermes: async () => false }));
		const second = await repackApp(input(h, applied, { hermes: async () => false, keepsSigner: async () => false }));
		expect(second).toMatchObject({ success: true, data: { kind: "repacked", reason: "signer-changed" } });
		expect(applied.count).toBe(2);
		const third = await repackApp(input(h, applied, { hermes: async () => false, keepsSigner: async () => true }));
		expect(third).toMatchObject({ success: true, data: { kind: "reused" } });
		expect(applied.count).toBe(2);
	});

	test("a repack without a recorded base identity (made by an older warden) is rebuilt once", async () => {
		await seedBase();
		const h = host();
		const applied = fresh();
		const first = await repackApp(input(h, applied, { hermes: async () => false }));
		if (!first.success || first.data.kind !== "repacked") throw new Error(JSON.stringify(first));
		const metaFile = join(dirname(first.data.artifact), "meta.json");
		const meta = JSON.parse(readFileSync(metaFile, "utf8")) as Record<string, unknown>;
		const { baseId: _baseId, ...legacy } = meta;
		writeFileSync(metaFile, JSON.stringify(legacy));
		const second = await repackApp(input(h, applied, { hermes: async () => false }));
		expect(second).toMatchObject({ success: true, data: { kind: "repacked", reason: "base-unrecorded" } });
		const third = await repackApp(input(h, applied, { hermes: async () => false }));
		expect(third).toMatchObject({ success: true, data: { kind: "reused" } });
		expect(applied.count).toBe(2);
	});

	test("a rebuilt repack forgets the installs of the old one, so devices install the new one", async () => {
		await seedBase("base A");
		const h = host();
		const applied = fresh();
		const first = await repackApp(input(h, applied, { hermes: async () => false }));
		if (!first.success || first.data.kind !== "repacked") throw new Error(JSON.stringify(first));
		recordInstall(store, {
			platform: "ios",
			deviceId: "SIM-1",
			bundleId: "com.x.app",
			hash: first.data.hash,
			installedAt: 1,
		});
		await seedBase("base B");
		await repackApp(input(h, applied, { hermes: async () => false }));
		expect(getInstall(store, "ios", "SIM-1", "com.x.app")).toBeUndefined();
	});

	test("force rebuilds a cached repack", async () => {
		await seedBase();
		const h = host();
		const applied = fresh();
		const first = await repackApp(input(h, applied, { hermes: async () => false }));
		const forced = await repackApp(input(h, applied, { hermes: async () => false, force: true }));
		expect(first.success && first.data.kind).toBe("repacked");
		expect(forced.success && forced.data.kind).toBe("repacked");
		expect(applied.count).toBe(2);
		expect(stagingLeft()).toEqual([]);
	});

	test("lock double-check: a repack that lands while this run waits on the lock is reused, not rebuilt", async () => {
		await seedBase();
		const h = host();
		const applied = fresh();
		const probe = await repackApp(input(h, fresh(), { hermes: async () => false }));
		if (!probe.success || probe.data.kind !== "repacked") throw new Error("seed repack");
		const hit = findRepack(store, {
			projectKey: KEY,
			platform: "ios",
			nativeFp: probe.data.hash.split(":")[0] ?? "",
			jsKey: probe.data.jsKey,
		});
		if (!hit) throw new Error("no record");
		// the holder's finished repack is hidden until it releases the lock
		store.db.query("UPDATE builds SET kind = 'legacy' WHERE hash = ?").run(hit.hash);
		const lockKey = `${KEY}|ios|${probe.data.jsKey}`;
		const held = store.insertLease(
			{
				resource: { kind: "build", key: lockKey },
				owner: { kind: "agent", sessionId: "other", cwd: "/" },
				ttlMs: 600_000,
			},
			clock
		);
		let sleeps = 0;
		const res = await repackApp(
			input(h, applied, {
				hermes: async () => false,
				sleep: async () => {
					sleeps++;
					store.db.query("UPDATE builds SET kind = 'simulator-repack' WHERE hash = ?").run(hit.hash);
					store.deleteLeases([held.id]);
				},
			})
		);
		expect(sleeps).toBe(1);
		expect(res).toMatchObject({ success: true, data: { kind: "reused", jsKey: probe.data.jsKey } });
		expect(applied.count).toBe(0);
	});

	test("a failed apply leaves no repack dir, staging dir, scratch dir or record", async () => {
		await seedBase();
		const h = host();
		const applied = fresh();
		const res = await repackApp(
			input(h, applied, {
				hermes: async () => false,
				repackers: { ios: applier(applied, { fail: true }), android: applier(applied) },
			})
		);
		expect(res).toEqual({ success: false, error: "repack: codesign exploded" });
		expect(stagingLeft()).toEqual([]);
		expect(store.listLeases()).toEqual([]);
		const builds = store.db.query("SELECT hash FROM builds WHERE kind = 'simulator-repack'").all();
		expect(builds).toEqual([]);
		expect(existsSync(join(dir, "scratch")) ? readdirSync(join(dir, "scratch")) : []).toEqual([]);
		const repacks = join(dir, "home", "builds");
		expect(
			existsSync(repacks) && readdirSync(repacks, { recursive: true }).some((p) => String(p).includes("repacks/"))
		).toBe(false);
	});

	test("a repacker fallback passes through with nothing recorded", async () => {
		await seedBase();
		const applied = fresh();
		const res = await repackApp(
			input(host(), applied, {
				hermes: async () => false,
				repackers: { ios: applier(applied, { fallback: "images changed" }), android: applier(applied) },
			})
		);
		expect(res).toEqual({ success: true, data: { kind: "fallback", reason: "images changed" } });
		expect(store.db.query("SELECT hash FROM builds WHERE kind = 'simulator-repack'").all()).toEqual([]);
		expect(stagingLeft()).toEqual([]);
	});

	test("bundler, hermesc and bad bytecode errors clean up", async () => {
		await seedBase();
		const applied = fresh();
		const bundle = await repackApp(input(host({ bundleFails: true }), applied, { hermes: async () => false }));
		expect(bundle).toMatchObject({ success: false });
		expect(!bundle.success && bundle.error).toContain("metro exploded");
		mkdirSync(join(root, "node_modules", "hermes-compiler", "hermesc", "osx-bin"), { recursive: true });
		writeFileSync(join(root, "node_modules", "hermes-compiler", "hermesc", "osx-bin", "hermesc"), "");
		const compile = await repackApp(input(host({ hermescFails: true }), applied, { hermes: async () => true }));
		expect(!compile.success && compile.error).toContain("hermesc boom");
		const magic = await repackApp(input(host({ hermescBadMagic: true }), applied, { hermes: async () => true }));
		expect(!magic.success && magic.error).toContain("bad magic");
		expect(applied.count).toBe(0);
		expect(stagingLeft()).toEqual([]);
	});

	test("the base is ensured, not built, when missing and builds are off", async () => {
		const res = await repackApp(input(host(), fresh(), { hermes: async () => false }));
		expect(res.success).toBe(false);
	});

	test("bare react-native uses the react-native bundle command", async () => {
		await seedBase();
		const h = host();
		const res = await repackApp(
			input(h, fresh(), {
				hermes: async () => false,
				project: testProject({ root, fingerprintCommand: "fp", framework: "react-native" }),
			})
		);
		expect(res.success).toBe(true);
		expect(h.calls.find((c) => c[0]?.endsWith("/.bin/react-native"))?.[1]).toBe("bundle");
	});
});

describe("repackApp: a base built in this run", () => {
	const scratchLeft = () => (existsSync(join(dir, "scratch")) ? readdirSync(join(dir, "scratch")) : []);

	test("iOS: the JS is bundled while the base builds, Hermes-compiled once the base is there", async () => {
		const events: string[] = [];
		const h = host({ events });
		const applied = fresh();
		mkdirSync(join(root, "node_modules", "hermes-compiler", "hermesc", "osx-bin"), { recursive: true });
		writeFileSync(join(root, "node_modules", "hermes-compiler", "hermesc", "osx-bin", "hermesc"), "");
		const hermes = async (_e: Exec, _p: Platform, base: string) => {
			events.push("hermes?");
			return existsSync(base);
		};
		const res = await repackApp(input(h, applied, { build: true, hermes, ensureBase: baseBuilder(events, "ios") }));
		if (!res.success || res.data.kind !== "repacked") throw new Error(JSON.stringify(res));
		expect(events.indexOf("bundle")).toBeLessThan(events.indexOf("base:end"));
		expect(events.indexOf("hermes?")).toBeGreaterThan(events.indexOf("base:end"));
		expect(applied).toEqual({ count: 1, bundles: [true] });
		expect(h.calls.filter((c) => c[0]?.endsWith("/.bin/expo"))).toHaveLength(1);
		expect(res.data.bundleMs).toBeGreaterThan(0);
		expect(res.data.fromBase).toBeUndefined();
		expect(getBuild(store, KEY, "ios", res.data.hash)).toMatchObject({ kind: "simulator-repack" });
		expect(stagingLeft()).toEqual([]);
		expect(scratchLeft()).toEqual([]);
	});

	test("iOS: a cached base is never raced (bundled after, as before)", async () => {
		await seedBase();
		const events: string[] = [];
		const res = await repackApp(
			input(host({ events }), fresh(), {
				build: true,
				hermes: async () => false,
				ensureBase: baseBuilder(events, "ios", { source: "cache" }),
			})
		);
		expect(res).toMatchObject({ success: true, data: { kind: "repacked" } });
		expect(events.indexOf("bundle")).toBeGreaterThan(events.indexOf("base:end"));
	});

	test("iOS: a failed bundle still waits for the base (cached for next time) and cleans up", async () => {
		const events: string[] = [];
		const applied = fresh();
		const res = await repackApp(
			input(host({ events, bundleFails: true }), applied, {
				build: true,
				hermes: async () => false,
				ensureBase: baseBuilder(events, "ios"),
			})
		);
		expect(res).toMatchObject({ success: false });
		expect(!res.success && res.error).toContain("metro exploded");
		expect(events).toContain("base:end");
		expect(applied.count).toBe(0);
		expect(stagingLeft()).toEqual([]);
		expect(scratchLeft()).toEqual([]);
	});

	test("iOS: a failed base build discards the bundle made alongside it", async () => {
		const events: string[] = [];
		const res = await repackApp(
			input(host({ events }), fresh(), {
				build: true,
				hermes: async () => false,
				ensureBase: baseBuilder(events, "ios", { fails: "xcodebuild exploded" }),
			})
		);
		expect(!res.success && res.error).toContain("xcodebuild exploded");
		expect(scratchLeft()).toEqual([]);
	});

	test("Android: a base built here embeds this JS, so it becomes the repack with no second bundle", async () => {
		const events: string[] = [];
		const h = host({ events, apkEntries: ["AndroidManifest.xml", "assets/index.android.bundle", "classes.dex"] });
		const applied = fresh();
		const res = await repackApp(
			input(h, applied, { platform: "android", build: true, ensureBase: baseBuilder(events, "android") })
		);
		if (!res.success || res.data.kind !== "repacked") throw new Error(JSON.stringify(res));
		expect(res.data.fromBase).toBe(true);
		expect(h.calls.some((c) => c[0]?.endsWith("/.bin/expo"))).toBe(false);
		expect(applied.count).toBe(0);
		expect(readFileSync(res.data.artifact, "utf8")).toBe("apk-bytes");
		const base = getBuild(store, KEY, "android", res.data.baseHash);
		expect(res.data.artifact).not.toBe(base?.path);
		expect(getBuild(store, KEY, "android", res.data.hash)).toMatchObject({
			kind: "simulator-repack",
			baseHash: res.data.baseHash,
			jsKey: res.data.jsKey,
		});
		const meta = await readRepackMeta(dirname(res.data.artifact));
		expect(meta?.baseId).toMatch(/^sha256:/);
		expect(stagingLeft()).toEqual([]);

		const again = await repackApp(input(h, applied, { platform: "android" }));
		expect(again).toMatchObject({ success: true, data: { kind: "reused", artifact: res.data.artifact } });
	});

	test("Android: a base built here without an embedded bundle is bundled and repacked as usual", async () => {
		const events: string[] = [];
		const h = host({ events, apkEntries: ["AndroidManifest.xml", "classes.dex"] });
		const applied = fresh();
		const res = await repackApp(
			input(h, applied, {
				platform: "android",
				build: true,
				hermes: async () => false,
				ensureBase: baseBuilder(events, "android"),
			})
		);
		expect(res).toMatchObject({ success: true, data: { kind: "repacked" } });
		expect(res.success && res.data.kind === "repacked" && res.data.fromBase).toBeFalsy();
		expect(events.indexOf("bundle")).toBeGreaterThan(events.indexOf("base:end"));
		expect(applied.count).toBe(1);
	});

	test("Android: a base another warden built (cache) may hold other JS: bundled and repacked as usual", async () => {
		const events: string[] = [];
		const h = host({ events, apkEntries: ["assets/index.android.bundle"] });
		const applied = fresh();
		const res = await repackApp(
			input(h, applied, {
				platform: "android",
				build: true,
				hermes: async () => false,
				ensureBase: baseBuilder(events, "android", { source: "cache" }),
			})
		);
		expect(res).toMatchObject({ success: true, data: { kind: "repacked" } });
		expect(applied.count).toBe(1);
		expect(h.calls.some((c) => c[0]?.endsWith("/.bin/expo"))).toBe(true);
	});
});

describe("helpers", () => {
	test("resolveEntryFile: main file, extension-less main, index fallback, none", () => {
		expect(resolveEntryFile(root)).toBe(join(root, "index.js"));
		writeFileSync(join(root, "package.json"), JSON.stringify({ main: "entry" }));
		writeFileSync(join(root, "entry.tsx"), "");
		expect(resolveEntryFile(root)).toBe(join(root, "entry.tsx"));
		writeFileSync(join(root, "package.json"), "{}");
		expect(resolveEntryFile(root)).toBe(join(root, "index.js"));
		rmSync(join(root, "index.js"));
		expect(resolveEntryFile(root)).toBeUndefined();
	});

	test("bundlerFlags carry no scratch path; the entry is root-relative", () => {
		const flags = bundlerFlags("android", "expo", "index.ts");
		expect(flags.join(" ")).toBe(
			"export:embed --platform android --dev false --minify true --entry-file index.ts --reset-cache"
		);
	});

	test("findHermesc prefers hermes-compiler, falls back to react-native/sdks", () => {
		const present = new Set<string>();
		const exists = (p: string) => present.has(p);
		expect(findHermesc("/r/app", "osx-bin", exists)).toBeUndefined();
		present.add("/r/node_modules/react-native/sdks/hermesc/osx-bin/hermesc");
		expect(findHermesc("/r/app", "osx-bin", exists)).toBe("/r/node_modules/react-native/sdks/hermesc/osx-bin/hermesc");
		present.add("/r/node_modules/hermes-compiler/hermesc/osx-bin/hermesc");
		expect(findHermesc("/r/app", "osx-bin", exists)).toBe("/r/node_modules/hermes-compiler/hermesc/osx-bin/hermesc");
	});

	test("detectHermes: iOS frameworks, Android libhermes in the apk", async () => {
		const app = join(dir, "H.app");
		mkdirSync(join(app, "Frameworks", "hermesvm.framework"), { recursive: true });
		expect(await detectHermes(host().exec, "ios", app)).toBe(true);
		expect(await detectHermes(host().exec, "ios", join(dir, "none.app"))).toBe(false);
		const apk =
			(stdout: string): Exec =>
			async () => ({ exitCode: 0, stdout, stderr: "" });
		expect(await detectHermes(apk("classes.dex\nlib/arm64-v8a/libhermes.so\n"), "android", "a.apk")).toBe(true);
		expect(await detectHermes(apk("classes.dex\nlib/arm64-v8a/libjsc.so\n"), "android", "a.apk")).toBe(false);
	});

	test("hasHbcMagic", () => {
		const good = join(dir, "good");
		const bad = join(dir, "bad");
		writeFileSync(good, HBC);
		writeFileSync(bad, "// js");
		expect(hasHbcMagic(good)).toBe(true);
		expect(hasHbcMagic(bad)).toBe(false);
		expect(hasHbcMagic(join(dir, "missing"))).toBe(false);
		chmodSync(good, 0o644);
	});
});

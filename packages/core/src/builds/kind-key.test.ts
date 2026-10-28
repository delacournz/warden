import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec, type Exec } from "../exec";
import { testProject } from "./builds.testing";
import { kindHash } from "./cache";
import { computeKindKey, type KindKeyDeps, type KindKeys } from "./kind-key";

let dir: string;
let root: string;
let fingerprint: string;

async function git(...args: string[]): Promise<void> {
	const res = await bunExec(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
	if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
}

beforeEach(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-kindkey-")));
	root = join(dir, "app");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "a.ts"), "a");
	writeFileSync(join(root, "app.json"), "{}");
	await git("init", "-q", "-b", "main");
	await git("add", "-A");
	await git("commit", "-q", "-m", "init");
	fingerprint = "native-1";
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** the project's own fingerprint command answers `fingerprint`; git is real */
const exec: Exec = async (cmd, opts) =>
	cmd.join(" ") === "sh -c fp" ? { exitCode: 0, stdout: `{"hash":"${fingerprint}"}`, stderr: "" } : bunExec(cmd, opts);

const deps = (over: Partial<KindKeyDeps> = {}): KindKeyDeps => ({
	exec,
	project: testProject({ root, fingerprintCommand: "fp" }),
	platform: "ios",
	kind: "dev",
	env: {},
	...over,
});

async function keys(over: Partial<KindKeyDeps> = {}): Promise<KindKeys> {
	const res = await computeKindKey(deps(over));
	if (!res.success) throw new Error(res.error);
	return res.data;
}

describe("computeKindKey", () => {
	test("dev: keyed by the native fingerprint, no JS key", async () => {
		const k = await keys();
		expect(k.key).toEqual({ kind: "dev", nativeFp: "native-1" });
		expect(k.buildKey).toBe("native-1");
		expect(k.native).toBe("native-1");
		expect(k.repack).toBeUndefined();
		expect(k.project.kind).toBe("dev");
	});

	test("simulator: the base is keyed by the (Release-salted) native fingerprint, the repack adds the JS key", async () => {
		const k = await keys({ kind: "simulator" });
		expect(k.key.kind).toBe("simulator-base");
		expect(k.key.nativeFp).not.toBe("native-1");
		expect(k.buildKey).toBe(k.key.nativeFp);
		expect(k.native).toBe("native-1");
		expect(k.repack).toMatchObject({ kind: "simulator-repack", nativeFp: k.key.nativeFp });
		expect(k.repack?.jsKey).toMatch(/^[0-9a-f]{40}$/);
		expect(kindHash(k.repack ?? k.key)).toBe(`${k.key.nativeFp}:${k.repack?.jsKey}`);
	});

	test("simulator: a JS edit changes the repack key and nothing else", async () => {
		const before = await keys({ kind: "simulator" });
		writeFileSync(join(root, "src", "a.ts"), "edited");
		const after = await keys({ kind: "simulator" });
		expect(after.key).toEqual(before.key);
		expect(after.repack?.jsKey).not.toBe(before.repack?.jsKey);
	});

	test("simulator: a native change moves the base and the repack", async () => {
		const before = await keys({ kind: "simulator" });
		fingerprint = "native-2";
		const after = await keys({ kind: "simulator" });
		expect(after.key.nativeFp).not.toBe(before.key.nativeFp);
		expect(after.repack?.jsKey).not.toBe(before.repack?.jsKey);
	});

	test("simulator: bundle env is part of the repack key, not of the base", async () => {
		const plain = await keys({ kind: "simulator" });
		const withEnv = await keys({ kind: "simulator", env: { EXPO_PUBLIC_API: "x" } });
		expect(withEnv.key).toEqual(plain.key);
		expect(withEnv.repack?.jsKey).not.toBe(plain.repack?.jsKey);
	});

	test("release: build key covers native + JS; the dir fingerprint is the native one", async () => {
		const k = await keys({ kind: "release" });
		expect(k.key.kind).toBe("release");
		const sim = await keys({ kind: "simulator" });
		expect(k.key.nativeFp).toBe(sim.key.nativeFp);
		expect(k.buildKey).not.toBe(k.key.nativeFp);
		expect(k.buildKey).toMatch(/^[0-9a-f]{40}$/);
		expect(k.key.kind === "release" && k.key.jsKey).toMatch(/^[0-9a-f]{40}$/);
		expect(k.repack).toBeUndefined();
	});

	test("release and simulator JS keys differ for the same inputs", async () => {
		const sim = await keys({ kind: "simulator" });
		const rel = await keys({ kind: "release" });
		expect(rel.key.kind === "release" && rel.key.jsKey).not.toBe(sim.repack?.jsKey);
	});

	test("kinds.<kind>.jsInputs narrows the JS key", async () => {
		const project = testProject({ root, fingerprintCommand: "fp", kinds: { simulator: { jsInputs: ["src/**"] } } });
		const before = await keys({ kind: "simulator", project });
		writeFileSync(join(root, "app.json"), '{"changed":true}');
		expect((await keys({ kind: "simulator", project })).repack?.jsKey).toBe(before.repack?.jsKey);
		writeFileSync(join(root, "src", "a.ts"), "edited");
		expect((await keys({ kind: "simulator", project })).repack?.jsKey).not.toBe(before.repack?.jsKey);
	});

	test("kinds.<kind>.env joins the key", async () => {
		const plain = await keys({ kind: "simulator" });
		const project = testProject({ root, fingerprintCommand: "fp", kinds: { simulator: { env: { API: "x" } } } });
		expect((await keys({ kind: "simulator", project })).repack?.jsKey).not.toBe(plain.repack?.jsKey);
	});

	test("a failing fingerprint is an error", async () => {
		const failing: Exec = async () => ({ exitCode: 1, stdout: "", stderr: "boom" });
		const res = await computeKindKey(deps({ exec: failing }));
		expect(res.success).toBe(false);
	});
});

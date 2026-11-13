import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { commitIos, makeRepo, type PodsHarness, podsHarness, sha1 } from "./pods.testing";
import type { PodsOutcome } from "./pods.types";
import { podsInstall } from "./pods-install";
import { getPodsEntry, listPodsEntries } from "./pods-store";

let h: PodsHarness;
beforeEach(() => {
	h = podsHarness();
});
afterEach(() => {
	h.store.close();
	rmSync(h.dir, { recursive: true, force: true });
});

async function install(
	root: string,
	over: { noCache?: boolean; framework?: "expo" | "react-native" } = {}
): Promise<PodsOutcome> {
	const res = await podsInstall(h.deps, { projectRoot: root, ...over });
	if (!res.success) throw new Error(res.error);
	return res.data;
}

const read = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");

/** What a real install in `root` would leave: every file that held the root now holds it, locks agree, checksum matches. */
function expectConsistent(root: string, files: readonly string[], oldRoot?: string): void {
	expect(read(root, "ios/Podfile.lock")).toBe(read(root, "ios/Pods/Manifest.lock"));
	const spec = read(root, "ios/Pods/Local Podspecs/Local.podspec.json");
	expect(read(root, "ios/Podfile.lock")).toContain(`Local: ${sha1(spec)}`);
	for (const f of files) {
		expect(read(root, f)).toContain(root);
		if (oldRoot) expect(read(root, f)).not.toContain(`${oldRoot}/`);
	}
}

describe("podsInstall (CNG)", () => {
	test("miss stores; another checkout hits with the root rewritten and prebuild skipped", async () => {
		const a = await makeRepo(h.dir, "a", { ignoreIos: true });
		const b = await makeRepo(h.dir, "bb-other", { ignoreIos: true });
		const first = await install(a);
		expect(first).toMatchObject({ kind: "miss", mode: "cng", stored: true });
		expect(h.tc.podInstalls).toBe(1);
		expect(h.tc.prebuilds).toBe(1);
		expect(listPodsEntries(h.store)).toHaveLength(1);

		const second = await install(b);
		expect(second).toMatchObject({ kind: "hit", mode: "cng" });
		expect(h.tc.podInstalls).toBe(1);
		expect(h.tc.prebuilds).toBe(1);

		expect(read(b, "ios/Pods/Pods.xcodeproj/project.pbxproj")).toBe(
			`HEADER_SEARCH_PATHS = ${b}/node_modules/local/include;\n`
		);
		expect(read(b, "ios/Pods/Target Support Files/x.xcconfig")).toContain(b);
		expectConsistent(b, ["ios/Pods/Pods.xcodeproj/project.pbxproj", "ios/Pods/Local Podspecs/Local.podspec.json"], a);
		expect(read(b, "ios/Pods/Local Podspecs/Local.podspec.json")).not.toContain(a);
		expect(read(b, "node_modules/local/Products/stub.txt")).toBe("stub\n");
		expect(existsSync(join(b, "node_modules/.cache/ignored.txt"))).toBe(false);
		expect(read(b, "ios/Pods/.warden-pods-key")).toBe(first.kind === "miss" ? first.key : "");
		expect(readdirSync(b).filter((n) => n.startsWith(".warden-pods-staging"))).toEqual([]);
		const entry = getPodsEntry(h.store, (second as { key: string }).key);
		expect(entry?.root).toBe(a);
		expect(entry?.lastUsedAt).toBeGreaterThan(entry?.createdAt ?? Number.POSITIVE_INFINITY);
	});

	test("a miss over a stale ios/ prebuilds --clean and never stores the stale files", async () => {
		const a = await makeRepo(h.dir, "a", { ignoreIos: true });
		await Bun.write(join(a, "ios/STALE.marker"), "stale");
		await Bun.write(join(a, "ios/Podfile"), "stale podfile");
		const cleaned: string[][] = [];
		const deps = {
			...h.deps,
			exec: async (c: readonly string[], o?: Parameters<typeof h.tc.exec>[1]) => {
				cleaned.push([...c]);
				return h.tc.exec(c, o);
			},
		};
		const res = await podsInstall(deps, { projectRoot: a });
		expect(res.success && res.data.kind).toBe("miss");
		expect(cleaned.some((c) => c[0] === "bunx" && c.includes("--clean"))).toBe(true);
		const key = res.success && res.data.kind === "miss" ? res.data.key : "";
		expect(existsSync(join(h.home, "pods", key, "ios", "STALE.marker"))).toBe(false);
		expect(existsSync(join(a, "ios", "STALE.marker"))).toBe(false);
	});

	test("an installed checkout is up-to-date and untouched", async () => {
		const a = await makeRepo(h.dir, "a", { ignoreIos: true });
		await install(a);
		const calls = h.tc.podInstalls;
		expect(await install(a)).toMatchObject({ kind: "up-to-date", mode: "cng" });
		expect(h.tc.podInstalls).toBe(calls);
	});

	test("a changed fingerprint is a new key", async () => {
		const a = await makeRepo(h.dir, "a", { ignoreIos: true });
		const b = await makeRepo(h.dir, "b", { ignoreIos: true });
		await install(a);
		h.tc.fingerprint = "fp-2";
		expect(await install(b)).toMatchObject({ kind: "miss" });
		expect(h.tc.podInstalls).toBe(2);
		expect(listPodsEntries(h.store)).toHaveLength(2);
	});

	test("two checkouts racing on one key run one pod install; the other hits", async () => {
		const a = await makeRepo(h.dir, "a", { ignoreIos: true });
		const b = await makeRepo(h.dir, "b", { ignoreIos: true });
		h.tc.installMs = 150;
		const other = { ...h.deps, pid: 4343, owner: { kind: "agent" as const, sessionId: "two", cwd: "/" } };
		const [x, y] = await Promise.all([podsInstall(h.deps, { projectRoot: a }), podsInstall(other, { projectRoot: b })]);
		expect(x.success && y.success).toBe(true);
		expect(h.tc.podInstalls).toBe(1);
		const kinds = [x, y].map((r) => (r.success ? r.data.kind : "err")).sort();
		expect(kinds).toEqual(["hit", "miss"]);
		expectConsistent(a, []);
		expectConsistent(b, []);
	});

	test("a snapshot that cannot be taken still succeeds as an unstored miss", async () => {
		const a = await makeRepo(h.dir, "a", { ignoreIos: true });
		h.tc.failCopy = true;
		h.deps.clone = () => false;
		const out = await install(a);
		expect(out).toMatchObject({ kind: "miss", stored: false });
		expect(out.kind === "miss" && out.storeError).toBeTruthy();
		expect(listPodsEntries(h.store)).toHaveLength(0);
		expect(readdirSync(join(h.home, "pods")).filter((n) => n.startsWith(".staging"))).toEqual([]);
		expect(existsSync(join(a, "ios/Pods/Manifest.lock"))).toBe(true);
	});

	test("a corrupt entry falls back to a real install and is replaced", async () => {
		const a = await makeRepo(h.dir, "a", { ignoreIos: true });
		const b = await makeRepo(h.dir, "b", { ignoreIos: true });
		const first = await install(a);
		const key = (first as { key: string }).key;
		rmSync(join(h.home, "pods", key, "meta.json"));
		const out = await install(b);
		expect(out).toMatchObject({ kind: "miss", stored: true });
		expect(h.tc.podInstalls).toBe(2);
		expect(h.logs.some((l) => l.includes("unusable"))).toBe(true);
	});

	test("--no-cache and a key that cannot be computed run plain and are uncached", async () => {
		const a = await makeRepo(h.dir, "a", { ignoreIos: true });
		expect(await install(a, { noCache: true })).toMatchObject({ kind: "uncached", reason: "--no-cache" });
		expect(listPodsEntries(h.store)).toHaveLength(0);
		const deps = {
			...h.deps,
			exec: async (c: readonly string[], o?: Parameters<typeof h.tc.exec>[1]) =>
				c[0] === "xcodebuild" ? { exitCode: 1, stdout: "", stderr: "no xcode" } : h.tc.exec(c, o),
		};
		const res = await podsInstall(deps, { projectRoot: a });
		expect(res.success && res.data.kind).toBe("uncached");
	});

	test("pod missing names how to install it", async () => {
		const a = await makeRepo(h.dir, "a", { ignoreIos: true });
		h.tc.noPod = true;
		const res = await podsInstall(h.deps, { projectRoot: a });
		expect(res.success).toBe(false);
		expect(!res.success && res.error).toContain("gem install cocoapods");
		expect(!res.success && res.error).toContain("brew install cocoapods");
	});

	test("a failing pod install is an error and stores nothing", async () => {
		const a = await makeRepo(h.dir, "a", { ignoreIos: true });
		const deps = {
			...h.deps,
			exec: async (c: readonly string[], o?: Parameters<typeof h.tc.exec>[1]) =>
				c[0] === "pod" && c[1] === "install" ? { exitCode: 1, stdout: "", stderr: "boom" } : h.tc.exec(c, o),
		};
		const res = await podsInstall(deps, { projectRoot: a });
		expect(res.success).toBe(false);
		expect(listPodsEntries(h.store)).toHaveLength(0);
	});
});

describe("podsInstall (committed ios/)", () => {
	test("restores Pods, build and the files pod install wrote into a second checkout, keeping tracked sources", async () => {
		const a = await makeRepo(h.dir, "a", { ignoreIos: false });
		const b = await makeRepo(h.dir, "bbb", { ignoreIos: false });
		await commitIos(a);
		await commitIos(b);
		expect(await install(a)).toMatchObject({ kind: "miss", mode: "committed", stored: true });
		expect(h.tc.prebuilds).toBe(0);
		expect(await install(b)).toMatchObject({ kind: "hit", mode: "committed" });
		expect(h.tc.podInstalls).toBe(1);
		expectConsistent(b, ["ios/Pods/Pods.xcodeproj/project.pbxproj"], a);
		expect(read(b, "ios/Podfile")).toBe("target 'App' do\nend\n");
		expect(read(b, "ios/build/generated/ios/a.h")).toBe("// generated\n");
		expect(read(b, "node_modules/local/Products/stub.txt")).toBe("stub\n");
		expect(await install(b)).toMatchObject({ kind: "up-to-date" });
	});

	test("a different Podfile is a different key", async () => {
		const a = await makeRepo(h.dir, "a", { ignoreIos: false });
		const b = await makeRepo(h.dir, "b", { ignoreIos: false });
		await commitIos(a);
		await commitIos(b);
		await Bun.write(join(b, "ios/Podfile"), "target 'App' do\n  pod 'X'\nend\n");
		await install(a);
		expect(await install(b)).toMatchObject({ kind: "miss" });
		expect(h.tc.podInstalls).toBe(2);
	});
});

describe("podsInstall clone seam", () => {
	test("uses deps.clone for whole trees and falls back to cp -c when it declines", async () => {
		const a = await makeRepo(h.dir, "a", { ignoreIos: true });
		const b = await makeRepo(h.dir, "b", { ignoreIos: true });
		const cloned: string[] = [];
		const deps = {
			...h.deps,
			clone: (src: string, _dst: string) => {
				cloned.push(src);
				return false;
			},
		};
		await podsInstall(deps, { projectRoot: a });
		const hit = await podsInstall(deps, { projectRoot: b });
		expect(hit.success && hit.data.kind).toBe("hit");
		expect(cloned.length).toBeGreaterThan(2);
		expect(h.logs.some((l) => /pods restore \w+: clone ios\/ \d+ ms/.test(l))).toBe(true);
		expect(h.logs.some((l) => l.includes("verify")) && h.logs.some((l) => l.includes("swap"))).toBe(true);
	});

	test("the native clonefile path restores a hit on a real filesystem", async () => {
		const a = await makeRepo(h.dir, "a", { ignoreIos: true });
		const b = await makeRepo(h.dir, "b", { ignoreIos: true });
		const deps = { ...h.deps, exec: h.tc.exec };
		await podsInstall(deps, { projectRoot: a });
		const hit = await podsInstall(deps, { projectRoot: b });
		expect(hit.success && hit.data.kind).toBe("hit");
		expect(read(b, "ios/Pods/Pods.xcodeproj/project.pbxproj")).toContain(b);
	});
});

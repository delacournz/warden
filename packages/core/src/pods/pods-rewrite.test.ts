import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha1 } from "./pods.testing";
import { fixChecksums, leftovers, locksMatch, rewriteRoots, rootPattern } from "./pods-rewrite";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-pods-rw-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(rel: string, text: string): void {
	mkdirSync(dirname(join(dir, rel)), { recursive: true });
	writeFileSync(join(dir, rel), text);
}
const read = (rel: string): string => readFileSync(join(dir, rel), "utf8");

describe("rootPattern", () => {
	test("matches whole path prefixes only", () => {
		const re = rootPattern([{ from: "/a/b", to: "/c/d" }]);
		const sub = (s: string) => s.replace(re as RegExp, "X");
		expect(sub("/a/b/x")).toBe("X/x");
		expect(sub('"/a/b"')).toBe('"X"');
		expect(sub("/a/bc/x")).toBe("/a/bc/x");
		expect(sub("/z/a/b/x")).toBe("/z/a/b/x");
	});

	test("the longer spelling wins over the one it contains", () => {
		const re = rootPattern([
			{ from: "/tmp/x", to: "/tmp/y" },
			{ from: "/private/tmp/x", to: "/private/tmp/y" },
		]) as RegExp;
		expect("/private/tmp/x/a /tmp/x/b".replace(re, (m) => (m === "/tmp/x" ? "/tmp/y" : "/private/tmp/y"))).toBe(
			"/private/tmp/y/a /tmp/y/b"
		);
	});
});

describe("rewrite + checksum fix", () => {
	test("restored into another root: locks equal, match the new sha1, no old root left", () => {
		const oldRoot = "/work/a";
		const newRoot = "/work/b-longer";
		const spec = JSON.stringify({ name: "Local", path: `${oldRoot}/node_modules/local` });
		const lock = (checksum: string) => `SPEC CHECKSUMS:\n  Local: ${checksum}\n  Other: deadbeef\n`;
		put("ios/Pods/Local Podspecs/Local.podspec.json", spec);
		put("ios/Pods/Pods.xcodeproj/project.pbxproj", `PATH = ${oldRoot}/node_modules/x;\nSIBLING = /work/ab/y;\n`);
		put("ios/Podfile.lock", lock(sha1(spec)));
		put("ios/Pods/Manifest.lock", lock(sha1(spec)));
		const files = ["ios/Pods/Local Podspecs/Local.podspec.json", "ios/Pods/Pods.xcodeproj/project.pbxproj"];
		const pairs = [{ from: oldRoot, to: newRoot }];

		const res = rewriteRoots(dir, files, pairs);
		expect(res.success).toBe(true);
		if (!res.success) return;
		fixChecksums(join(dir, "ios/Podfile.lock"), res.data.checksums);
		fixChecksums(join(dir, "ios/Pods/Manifest.lock"), res.data.checksums);

		const newSpec = read("ios/Pods/Local Podspecs/Local.podspec.json");
		expect(newSpec).toContain(newRoot);
		expect(locksMatch(join(dir, "ios"))).toBe(true);
		expect(read("ios/Podfile.lock")).toContain(`Local: ${sha1(newSpec)}`);
		expect(read("ios/Podfile.lock")).toContain("Other: deadbeef");
		expect(leftovers(dir, files, pairs)).toEqual([]);
		expect(read("ios/Pods/Pods.xcodeproj/project.pbxproj")).toContain("/work/ab/y");
	});

	test("a missing cached file is an error", () => {
		const res = rewriteRoots(dir, ["ios/nope"], [{ from: "/a", to: "/b" }]);
		expect(res.success).toBe(false);
	});

	test("locksMatch is false when they differ or Pods is missing", () => {
		put("ios/Podfile.lock", "a");
		expect(locksMatch(join(dir, "ios"))).toBe(false);
		put("ios/Pods/Manifest.lock", "b");
		expect(locksMatch(join(dir, "ios"))).toBe(false);
	});
});

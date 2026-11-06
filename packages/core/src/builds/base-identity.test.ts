import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseIdentity } from "./base-identity";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-base-id-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function app(over: { exe?: string; plist?: string; resources?: string; bundle?: string } = {}): string {
	const root = join(dir, `A${Math.random().toString(36).slice(2)}.app`);
	mkdirSync(join(root, "_CodeSignature"), { recursive: true });
	writeFileSync(join(root, "Info.plist"), over.plist ?? "plist");
	writeFileSync(join(root, "App"), over.exe ?? "exe");
	chmodSync(join(root, "App"), 0o755);
	writeFileSync(join(root, "_CodeSignature", "CodeResources"), over.resources ?? "res");
	if (over.bundle !== undefined) writeFileSync(join(root, "main.jsbundle"), over.bundle);
	return root;
}

describe("baseIdentity", () => {
	test("ios: equal for equal content, whatever the path", async () => {
		expect(await baseIdentity("ios", app())).toBe(await baseIdentity("ios", app()));
	});

	test("ios: the executable, Info.plist and code signature each change it", async () => {
		const same = await baseIdentity("ios", app());
		expect(await baseIdentity("ios", app({ exe: "other signature" }))).not.toBe(same);
		expect(await baseIdentity("ios", app({ plist: "other" }))).not.toBe(same);
		expect(await baseIdentity("ios", app({ resources: "other" }))).not.toBe(same);
	});

	test("ios: the JS bundle is not part of it", async () => {
		expect(await baseIdentity("ios", app({ bundle: "x" }))).toBe(await baseIdentity("ios", app({ bundle: "y" })));
	});

	test("android: the apk's content", async () => {
		const a = join(dir, "a.apk");
		const b = join(dir, "b.apk");
		writeFileSync(a, "one");
		writeFileSync(b, "two");
		expect(await baseIdentity("android", a)).not.toBe(await baseIdentity("android", b));
		expect(await baseIdentity("android", a)).toBe(await baseIdentity("android", a));
	});

	test("an unreadable base has no identity", async () => {
		expect(await baseIdentity("ios", join(dir, "missing.app"))).toBeUndefined();
		expect(await baseIdentity("android", join(dir, "missing.apk"))).toBeUndefined();
	});
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	atfSourceHash,
	fetchArtifact,
	parseLock,
	r8Argv,
	renderAtfGenerated,
} from "../../../native/android/scripts/build-atf";
import { atfDevicePath, ensureAtfJar } from "./atf-device";
import { ATF_DEX } from "./atf-dex.generated";
import { WORKSPACE_ATF_JAR } from "./atf-jar";

describe("the generated ATF module", () => {
	test("is built from the lock, rules and entry class that are checked in", () => {
		// when this fails: `bun run --cwd packages/e2e android:emit-atf`, commit the result
		expect<string>(ATF_DEX.sourceSha256).toBe(atfSourceHash());
	});

	test("the checked-in jar is a zip with a dex and the strings inside (size and hash: atf-jar.test.ts)", () => {
		const jar = readFileSync(WORKSPACE_ATF_JAR);
		expect(jar.subarray(0, 2).toString("latin1")).toBe("PK");
		expect(jar.includes(Buffer.from("classes.dex"))).toBe(true);
		expect(jar.includes(Buffer.from("resources/strings.xml"))).toBe(true);
	});

	test("carries no bytes: the jar is a release asset, never part of the bundle", () => {
		expect(Object.keys(ATF_DEX).sort()).toEqual(["bytes", "jarSha256", "sourceSha256", "version"]);
	});
});

describe("parseLock", () => {
	const good = {
		version: "4.1.1",
		license: "Apache-2.0",
		artifacts: [{ name: "a", kind: "jar", url: "https://x/a.jar", sha256: "a".repeat(64) }],
	};
	test("accepts an exact, hashed, https lock", () => {
		expect(parseLock(JSON.stringify(good)).version).toBe("4.1.1");
	});
	test.each([
		["a range", { ...good, version: "^4.1.1" }],
		["a short hash", { ...good, artifacts: [{ ...good.artifacts[0], sha256: "abc" }] }],
		["http", { ...good, artifacts: [{ ...good.artifacts[0], url: "http://x/a.jar" }] }],
	])("rejects %s", (_name, lock) => {
		expect(() => parseLock(JSON.stringify(lock))).toThrow();
	});
	test("the checked-in lock pins ATF 4.1.1", () => {
		const lock = parseLock(
			require("node:fs").readFileSync(new URL("../../../native/android/atf/atf.lock.json", import.meta.url), "utf8")
		);
		expect(lock.version).toBe("4.1.1");
		expect(lock.artifacts[0]?.name).toBe("accessibility-test-framework");
	});
});

describe("fetchArtifact", () => {
	test("refuses bytes that do not match the pinned hash", async () => {
		const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "atf-"));
		const artifact = { name: "x", kind: "jar" as const, url: "https://x/x.jar", sha256: "0".repeat(64) };
		await expect(fetchArtifact(artifact, dir, async () => new Uint8Array([1, 2, 3]))).rejects.toThrow(
			"does not match the lock"
		);
	});
});

describe("r8Argv", () => {
	test("keeps rules and inputs in order", () => {
		const argv = r8Argv({
			java: "java",
			r8Jar: "d8.jar",
			androidJar: "a.jar",
			rules: "r.pro",
			outDir: "out",
			inputs: ["e.jar", "f.jar"],
		});
		expect(argv).toContain("--pg-conf");
		expect(argv.slice(-2)).toEqual(["e.jar", "f.jar"]);
	});
});

describe("ensureAtfJar", () => {
	const jar = { bytes: 3, jarSha256: "abcdef0123456789" };
	const load = async () => ({
		success: true as const,
		data: { bytes: new Uint8Array([1, 2, 3]), source: "cache" as const },
	});
	const session = (present: boolean) => ({
		run: async () => ({
			success: true as const,
			data: { stdout: present ? "present\n" : "", stderr: "", exitCode: present ? 0 : 1 },
		}),
	});

	test("names the jar by hash under /data/local/tmp", () => {
		expect(atfDevicePath(jar)).toBe("/data/local/tmp/warden-atf-abcdef01.jar");
	});

	test("does not load or push a jar that is already there", async () => {
		const pushed: unknown[] = [];
		const res = await ensureAtfJar({
			session: session(true) as never,
			adb: "adb",
			serial: "s",
			jar,
			load: async () => {
				throw new Error("loaded");
			},
			push: async (a) => {
				pushed.push(a);
				return { exitCode: 0, output: "" };
			},
		});
		expect(res).toEqual({ success: true, data: "/data/local/tmp/warden-atf-abcdef01.jar" });
		expect(pushed).toHaveLength(0);
	});

	test("pushes the bytes on first use and reports a failed write as E_IO", async () => {
		let bytes: Uint8Array = new Uint8Array();
		const ok = await ensureAtfJar({
			session: session(false) as never,
			adb: "adb",
			serial: "s",
			jar,
			load,
			push: async (_a, b) => {
				bytes = b;
				return { exitCode: 0, output: "" };
			},
		});
		expect(ok.success).toBe(true);
		expect([...bytes]).toEqual([1, 2, 3]);
		const bad = await ensureAtfJar({
			session: session(false) as never,
			adb: "adb",
			serial: "s",
			jar,
			load,
			push: async () => ({ exitCode: 1, output: "no space" }),
		});
		expect(bad.success).toBe(false);
		if (!bad.success) expect(bad.error.code).toBe("E_IO");
	});

	test("a jar that cannot be loaded (offline, no cache) is E_IO and nothing is pushed", async () => {
		let pushed = false;
		const res = await ensureAtfJar({
			session: session(false) as never,
			adb: "adb",
			serial: "s",
			jar,
			load: async () => ({ success: false as const, error: "GET x: offline" }),
			push: async () => {
				pushed = true;
				return { exitCode: 0, output: "" };
			},
		});
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.code).toBe("E_IO");
			expect(res.error.message).toContain("offline");
		}
		expect(pushed).toBe(false);
	});
});

test("renderAtfGenerated writes the module the driver imports", () => {
	const text = renderAtfGenerated({
		version: "4.1.1",
		bytes: 3,
		jarSha256: "j",
		dexBytes: 1,
		sourceSha256: "s",
		minApi: 26,
		r8: "r",
		builtAt: "n",
	});
	expect(text).toContain("export const ATF_DEX = {");
	expect(text).not.toContain("base64");
});

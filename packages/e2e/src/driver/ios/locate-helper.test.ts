import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateHelper } from "./locate-helper";

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "locate-helper-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function touch(path: string): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "#!/bin/sh\n");
	return path;
}

function layout() {
	return {
		explicit: join(root, "explicit", "my-simd"),
		helperDir: join(root, "helper-dir"),
		binDir: join(root, "bin"),
		importDir: join(root, "pkg", "e2e", "src", "driver", "ios"),
		home: join(root, "home"),
	};
}

function locate(env: Record<string, string>, l = layout()) {
	return locateHelper({
		env,
		execPath: join(l.binDir, "warden"),
		importDir: l.importDir,
		wardenHome: l.home,
		version: "1.2.3",
		exists: existsSync,
		realpath: realpathSync,
	});
}

describe("locateHelper order", () => {
	test("WARDEN_SIMD wins over everything", () => {
		const l = layout();
		touch(l.explicit);
		touch(join(l.helperDir, "warden-simd"));
		touch(join(l.binDir, "warden-simd"));
		const result = locate({ WARDEN_SIMD: l.explicit, WARDEN_HELPER_DIR: l.helperDir }, l);
		expect(result).toEqual({ success: true, data: { path: l.explicit, source: "WARDEN_SIMD" } });
	});

	test("then WARDEN_HELPER_DIR/warden-simd", () => {
		const l = layout();
		touch(join(l.helperDir, "warden-simd"));
		touch(join(l.binDir, "warden-simd"));
		const result = locate({ WARDEN_HELPER_DIR: l.helperDir }, l);
		expect(result.success && result.data.source).toBe("WARDEN_HELPER_DIR");
	});

	test("then next to the real path of the executable", () => {
		const l = layout();
		touch(join(l.binDir, "warden-simd"));
		const result = locate({}, l);
		expect(result).toEqual({ success: true, data: { path: join(l.binDir, "warden-simd"), source: "execPath" } });
	});

	test("a symlinked executable resolves to the directory of its target", () => {
		const l = layout();
		const real = join(root, "install", "warden");
		touch(real);
		touch(join(root, "install", "warden-simd"));
		mkdirSync(l.binDir, { recursive: true });
		symlinkSync(real, join(l.binDir, "warden"));
		const result = locate({}, l);
		expect(result.success && result.data.path).toBe(join(root, "install", "warden-simd"));
	});

	test("then the source checkout build output", () => {
		const l = layout();
		const built = touch(join(root, "pkg", "e2e", "native", "dist", "warden-simd"));
		const result = locate({}, l);
		expect(result).toEqual({ success: true, data: { path: built, source: "source-build" } });
	});

	test("then $WARDEN_HOME/simd/<version>/", () => {
		const l = layout();
		const staged = touch(join(l.home, "simd", "1.2.3", "warden-simd"));
		const result = locate({}, l);
		expect(result).toEqual({ success: true, data: { path: staged, source: "warden-home" } });
	});

	test("a different version's staged copy is not used", () => {
		const l = layout();
		touch(join(l.home, "simd", "0.9.0", "warden-simd"));
		expect(locate({}, l).success).toBe(false);
	});
});

describe("locateHelper failures", () => {
	test("nothing found → E_HELPER_MISSING with the doctor hint and every tried path", () => {
		const l = layout();
		const result = locate({}, l);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("E_HELPER_MISSING");
		expect(result.error.message).toContain("warden doctor");
		expect(result.error.detail).toEqual({
			tried: [
				join(l.binDir, "warden-simd"),
				join(root, "pkg", "e2e", "native", "dist", "warden-simd"),
				join(l.home, "simd", "1.2.3", "warden-simd"),
			],
		});
	});

	test("an explicit WARDEN_SIMD that does not exist fails instead of falling through", () => {
		const l = layout();
		touch(join(l.binDir, "warden-simd"));
		const result = locate({ WARDEN_SIMD: join(root, "nope") }, l);
		expect(!result.success && result.error.message).toContain("WARDEN_SIMD");
	});

	test("an explicit WARDEN_HELPER_DIR without the binary fails instead of falling through", () => {
		const l = layout();
		touch(join(l.binDir, "warden-simd"));
		const result = locate({ WARDEN_HELPER_DIR: l.helperDir }, l);
		expect(!result.success && result.error.code).toBe("E_HELPER_MISSING");
	});

	test("without a version the staged lookup is skipped; injected fs is respected", () => {
		const seen: string[] = [];
		const result = locateHelper({
			env: {},
			execPath: "/opt/warden/bin/warden",
			importDir: "/repo/packages/e2e/src/driver/ios",
			wardenHome: "/home/.warden",
			exists: (path) => {
				seen.push(path);
				return false;
			},
		});
		expect(result.success).toBe(false);
		expect(seen).toEqual(["/opt/warden/bin/warden-simd", "/repo/packages/e2e/native/dist/warden-simd"]);
	});
});

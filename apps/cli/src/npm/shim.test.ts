import { describe, expect, test } from "bun:test";
import { locateBinary, type ShimDeps } from "./shim";

function deps(overrides: Partial<ShimDeps> = {}): ShimDeps {
	return {
		platform: "darwin",
		arch: "arm64",
		env: {},
		scriptDir: "/g/node_modules/@delacour/warden/bin",
		resolvePackageJson: (name) => `/g/node_modules/${name}/package.json`,
		...overrides,
	};
}

describe("locateBinary", () => {
	test("resolves the platform package's bin/warden", () => {
		expect(locateBinary(deps())).toEqual({
			success: true,
			data: "/g/node_modules/@delacour/warden-darwin-arm64/bin/warden",
		});
	});

	test("WARDEN_BINARY overrides resolution", () => {
		expect(locateBinary(deps({ env: { WARDEN_BINARY: "/custom/warden" } }))).toEqual({
			success: true,
			data: "/custom/warden",
		});
	});

	test("unsupported platform → clear error with the build-from-source hint", () => {
		const result = locateBinary(deps({ platform: "win32", arch: "x64" }));
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toContain("win32-x64");
			expect(result.error).toContain("build from source");
		}
	});

	test("platform package missing (optional deps skipped) → names the package and the fix", () => {
		const result = locateBinary(
			deps({
				resolvePackageJson: () => {
					throw new Error("Cannot find module");
				},
			})
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toContain("@delacour/warden-darwin-arm64");
			expect(result.error).toContain("optional");
		}
	});

	test("a shim copied out of its package (a cache that flattens symlinks) finds the npm global prefix's install", () => {
		const tried: (readonly string[] | undefined)[] = [];
		const result = locateBinary(
			deps({
				scriptDir: "/cache/warden-cli/bin",
				resolvePackageJson: (name, paths) => {
					tried.push(paths);
					if (!paths) throw new Error("Cannot find module");
					return `${paths[0]}/node_modules/${name}/package.json`;
				},
			})
		);
		expect(tried).toEqual([undefined, ["/cache/warden-cli/lib/node_modules/@delacour/warden"]]);
		expect(result).toEqual({
			success: true,
			data: "/cache/warden-cli/lib/node_modules/@delacour/warden/node_modules/@delacour/warden-darwin-arm64/bin/warden",
		});
	});
});

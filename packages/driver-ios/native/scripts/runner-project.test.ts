import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * `ios-runner/WardenRunner.xcodeproj` is generated from `project.yml` (xcodegen) and checked in, because SwiftPM cannot
 * build a UI-test bundle. Nothing in CI runs xcodegen, so this guards the two things that drift: a Swift file added
 * to or removed from the runner without regenerating the project, and a `RunnerCore/.../Shared` link that stopped
 * pointing at the `warden-simd` file it stands for.
 */
const runner = join(import.meta.dir, "..", "ios-runner");
const simd = join(import.meta.dir, "..", "ios", "Sources", "warden-simd");
const pbxproj = readFileSync(join(runner, "WardenRunner.xcodeproj", "project.pbxproj"), "utf8");
const spec = readFileSync(join(runner, "project.yml"), "utf8");

function swiftFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".swift"))
		.map((entry) => entry.name);
}

const shared = join(runner, "RunnerCore", "Sources", "RunnerCore", "Shared");

describe("WardenRunner.xcodeproj", () => {
	const compiled = [
		...swiftFiles(join(runner, "RunnerTests")),
		...swiftFiles(join(runner, "RunnerCore", "Sources", "RunnerCore")),
		...swiftFiles(shared),
	];
	for (const name of new Set(compiled)) {
		test(`compiles ${name} into the UI-test bundle`, () => {
			expect(pbxproj).toContain(`/* ${name} in Sources */`);
		});
	}

	test("compiles the host app", () => {
		for (const name of swiftFiles(join(runner, "Host"))) expect(pbxproj).toContain(`/* ${name} in Sources */`);
	});

	test("compiles nothing the sources no longer have", () => {
		const listed = [...pbxproj.matchAll(/\/\* (\S+\.swift) in Sources \*\//g)].map((match) => match[1] as string);
		for (const name of new Set(listed)) {
			expect(new Set([...compiled, ...swiftFiles(join(runner, "Host"))]).has(name)).toBe(true);
		}
	});

	test("the Shared sources are compiled once, from the warden-simd copy", () => {
		for (const name of swiftFiles(shared)) {
			expect(pbxproj.split(`/* ${name} in Sources */`).length - 1).toBe(2);
		}
	});

	test("carries no team id and no absolute path", () => {
		expect(pbxproj).not.toMatch(/DEVELOPMENT_TEAM = [A-Z0-9]{10}/);
		expect(pbxproj).not.toContain("/Users/");
	});

	test("both bundle ids derive from one overridable setting", () => {
		expect(pbxproj).toContain('PRODUCT_BUNDLE_IDENTIFIER = "$(WARDEN_RUNNER_BUNDLE_ID)"');
		expect(pbxproj).toContain('PRODUCT_BUNDLE_IDENTIFIER = "$(WARDEN_RUNNER_BUNDLE_ID).uitests"');
		expect(spec).toContain("nz.co.delacour.warden.runner.$(DEVELOPMENT_TEAM:lower)");
	});
});

describe("RunnerCore Shared links", () => {
	test("each is a symlink to a warden-simd file", () => {
		const names = swiftFiles(shared);
		expect(names.sort()).toEqual(["Element.swift", "NDJSON.swift", "RoleMap.swift", "Wire.swift"]);
		for (const name of names) {
			const link = join(shared, name);
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(existsSync(link)).toBe(true);
			const target = relative(simd, realpathSync(link));
			expect(target.startsWith("..")).toBe(false);
			expect(readlinkSync(link)).toContain("warden-simd");
		}
	});
});

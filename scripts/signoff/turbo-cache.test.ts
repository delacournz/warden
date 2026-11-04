import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

/**
 * Holds `turbo.jsonc` to the rules that make a cached green honest (AGENTS.md § Signoff). The cache
 * replays typecheck / check / test when the task hash is unchanged, so the hash has to cover
 * everything the task reads: a test that reads outside its workspace must declare it as a
 * `$TURBO_ROOT$/…` input or a `<pkg>#transit` dependency, and this file only guards the shape of
 * that config, not the reads themselves.
 */

const ROOT = join(import.meta.dir, "../..");

type TaskConfig = { dependsOn?: string[]; cache?: boolean; outputs?: string[]; inputs?: string[] };
type TurboConfig = { tasks: Record<string, TaskConfig> };

const turbo = Bun.JSONC.parse(readFileSync(join(ROOT, "turbo.jsonc"), "utf8")) as TurboConfig;

/** Every workspace package name, from the root `workspaces` globs. */
function workspaceNames(): string[] {
	const { workspaces } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { workspaces: string[] };
	const names: string[] = [];
	for (const pattern of workspaces) {
		for (const dir of new Glob(pattern).scanSync({ cwd: ROOT, onlyFiles: false })) {
			try {
				const manifest = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as { name: string };
				names.push(manifest.name);
			} catch {
				// a workspace glob match without a package.json is not a package
			}
		}
	}
	return names;
}

const CACHED = ["typecheck", "check", "test"] as const;

/** `<pkg>#<task>` overrides, split into the package and the task. */
const overrides = Object.entries(turbo.tasks).flatMap(([key, config]) => {
	const at = key.lastIndexOf("#");
	return at === -1 ? [] : [{ key, pkg: key.slice(0, at), task: key.slice(at + 1), config }];
});

describe("turbo.jsonc caching", () => {
	test("transit is a pure dependency-hash node", () => {
		expect(turbo.tasks.transit).toEqual({ dependsOn: ["^transit"] });
	});

	test("typecheck, check and test are cached and keep only their logs", () => {
		for (const task of CACHED) {
			expect(turbo.tasks[task]?.cache).toBe(true);
			expect(turbo.tasks[task]?.outputs).toEqual([]);
		}
	});

	test("typecheck and test see dependency changes through transit, never through ^typecheck / ^test", () => {
		for (const task of ["typecheck", "test"] as const) {
			expect(turbo.tasks[task]?.dependsOn).toContain("transit");
			expect(turbo.tasks[task]?.dependsOn).not.toContain(`^${task}`);
		}
	});

	test("every <pkg>#<task> override names a real workspace package (a typo silently does nothing)", () => {
		const names = new Set(workspaceNames());
		expect(overrides.filter((o) => !names.has(o.pkg)).map((o) => o.key)).toEqual([]);
	});

	test("an override restates what the generic task has: turbo does not merge them", () => {
		for (const { key, task, config } of overrides) {
			if (!(CACHED as readonly string[]).includes(task)) continue;
			expect({ key, cache: config.cache }).toEqual({ key, cache: true });
			expect({ key, outputs: config.outputs }).toEqual({ key, outputs: [] });
			if (task !== "check")
				expect({ key, dependsOn: config.dependsOn }).toEqual({ key, dependsOn: expect.arrayContaining(["transit"]) });
		}
	});

	test("an override's inputs keep the default file set ($TURBO_DEFAULT$ opts back in)", () => {
		for (const { key, config } of overrides) {
			if (config.inputs)
				expect({ key, inputs: config.inputs }).toEqual({ key, inputs: expect.arrayContaining(["$TURBO_DEFAULT$"]) });
		}
	});

	test("root-relative inputs never use a bare `**` over a directory that holds build outputs", () => {
		const risky = ["packages/biome-config/**", "packages/e2e/native/**"];
		const inputs = Object.values(turbo.tasks).flatMap((config) => config.inputs ?? []);
		expect(inputs.filter((input) => risky.some((glob) => input.endsWith(glob)))).toEqual([]);
	});
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { VERSION_FILES } from "../../apps/cli/scripts/release";

const root = resolve(import.meta.dir, "..", "..");

type ChangesetConfig = {
	baseBranch: string;
	fixed: string[][];
	ignore: string[];
	privatePackages: { version: boolean; tag: boolean };
	commit: boolean;
};

type Manifest = { name: string; workspaces?: string[]; version?: string };

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(join(root, path), "utf8")) as T;
}

/** Every workspace package name, from the root `workspaces` globs. */
function workspaceNames(): string[] {
	const { workspaces = [] } = readJson<Manifest>("package.json");
	const names: string[] = [];
	for (const pattern of workspaces) {
		for (const dir of new Glob(pattern).scanSync({ cwd: root, onlyFiles: false })) {
			try {
				names.push(readJson<Manifest>(join(dir, "package.json")).name);
			} catch {
				// a workspace glob match without a package.json is not a package
			}
		}
	}
	return names;
}

const config = readJson<ChangesetConfig>(".changeset/config.json");
const published = VERSION_FILES.map((file) => readJson<Manifest>(file).name);

describe(".changeset/config.json", () => {
	test("versions are cut for develop, uncommitted, and private packages are versioned but never tagged", () => {
		expect(config.baseBranch).toBe("develop");
		expect(config.commit).toBe(false);
		expect(config.privatePackages).toEqual({ version: true, tag: false });
	});

	test("the one fixed group is exactly the lock-step published manifests", () => {
		expect(config.fixed).toHaveLength(1);
		expect([...(config.fixed[0] ?? [])].sort()).toEqual([...published].sort());
	});

	test("every other workspace is ignored, so `changeset version` only ever bumps the published two", () => {
		const names = workspaceNames();
		expect(names.length).toBeGreaterThan(published.length);
		const unaccounted = names.filter((name) => !published.includes(name) && !config.ignore.includes(name));
		expect(unaccounted).toEqual([]);
		const stale = config.ignore.filter((name) => !names.includes(name));
		expect(stale).toEqual([]);
		const both = config.ignore.filter((name) => published.includes(name));
		expect(both).toEqual([]);
	});

	test("the published manifests share one version", () => {
		const versions = new Set(VERSION_FILES.map((file) => readJson<Manifest>(file).version));
		expect(versions.size).toBe(1);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "../exec";
import { makeSuiteRepo } from "./fixture.testing";
import {
	type GraphDoc,
	type GraphRequest,
	graphDoc,
	importsOfDoc,
	parseGraphDoc,
	readSnapshot,
	snapshotKey,
	statusPaths,
	writeSnapshot,
} from "./graph-snapshot";

describe("graphDoc / importsOfDoc", () => {
	const graph: Record<string, string[]> = { "/a": ["/c", "/b"], "/b": ["/c"], "/c": [] };
	const doc = graphDoc(["/a", "/b", "/c"], (file) => graph[file] ?? []);

	test("one table of files and index edges; import order is kept", () => {
		expect(doc).toEqual({ version: 1, files: ["/a", "/b", "/c"], edges: [[2, 1], [2], []] });
		const imports = importsOfDoc(doc);
		expect(imports("/a")).toEqual(["/c", "/b"]);
		expect(imports("/b")).toEqual(["/c"]);
		expect(imports("/c")).toEqual([]);
	});

	test("a file the walk never reached has no imports", () => {
		expect(importsOfDoc(doc)("/elsewhere")).toEqual([]);
	});

	test("an import outside the walked files is dropped", () => {
		expect(graphDoc(["/a"], () => ["/missing"]).edges).toEqual([[]]);
	});
});

describe("parseGraphDoc", () => {
	const ok: GraphDoc = { version: 1, files: ["/a", "/b"], edges: [[1], []] };

	test("the exact format round-trips", () => {
		expect(parseGraphDoc(JSON.stringify(ok))).toEqual(ok);
	});

	test.each([
		["not json", "{nope"],
		["null", "null"],
		["an old version", JSON.stringify({ ...ok, version: 0 })],
		["edges that do not match files", JSON.stringify({ ...ok, edges: [[1]] })],
		["an edge out of range", JSON.stringify({ ...ok, edges: [[2], []] })],
		["a negative edge", JSON.stringify({ ...ok, edges: [[-1], []] })],
		["a non-string file", JSON.stringify({ ...ok, files: ["/a", 2] })],
		["edges that are not lists", JSON.stringify({ ...ok, edges: [1, []] })],
	])("%s is no table", (_name, text) => {
		expect(parseGraphDoc(text)).toBeUndefined();
	});
});

describe("statusPaths", () => {
	test("modified, untracked and deleted paths", () => {
		expect(statusPaths(" M src/a.ts\0?? src/b.ts\0D  gone.ts\0")).toEqual(["src/a.ts", "src/b.ts", "gone.ts"]);
	});

	test("a rename lists both paths", () => {
		expect(statusPaths("R  new.ts\0old.ts\0 M other.ts\0")).toEqual(["new.ts", "old.ts", "other.ts"]);
		expect(statusPaths("RM new.ts\0old.ts\0")).toEqual(["new.ts", "old.ts"]);
	});

	test("nothing", () => {
		expect(statusPaths("")).toEqual([]);
	});
});

describe("snapshotKey", () => {
	let dir: string;
	let write: (path: string, text: string) => void;
	beforeEach(async () => {
		({ dir, write } = await makeSuiteRepo());
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const request = (extra: Partial<GraphRequest> = {}): GraphRequest => ({
		platform: "ios",
		repoRoot: dir,
		entries: [join(dir, "src/app/(app)/chats.tsx")],
		...extra,
	});
	const key = (extra: Partial<GraphRequest> = {}, ignoreDir?: string) =>
		snapshotKey(bunExec, request(extra), ignoreDir);
	const git = (...args: string[]) => {
		const res = Bun.spawnSync(["git", ...args], { cwd: dir });
		if (res.exitCode !== 0) throw new Error(res.stderr.toString());
	};

	test("<HEAD>-<hash>; the same state keys the same", async () => {
		const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir }).stdout.toString().trim();
		const first = await key();
		expect(first).toMatch(new RegExp(`^${head}-[0-9a-f]{16}$`));
		expect(await key()).toBe(first as string);
	});

	test("editing a tracked file misses, and so does editing it again to the same status", async () => {
		const clean = await key();
		write("src/settings/form.tsx", "export const a = 1;\n");
		const first = await key();
		expect(first).not.toBe(clean as string);
		write("src/settings/form.tsx", "export const a = 2;\n");
		expect(await key()).not.toBe(first as string);
	});

	test("an untracked file, and its content, count; touching it without changing it does not", async () => {
		const clean = await key();
		write("src/new.ts", "export {};\n");
		const first = await key();
		expect(first).not.toBe(clean as string);
		utimesSync(join(dir, "src/new.ts"), new Date(2020, 1, 1), new Date(2020, 1, 1));
		expect(await key()).toBe(first as string);
		write("src/new.ts", 'import "./other";\n');
		expect(await key()).not.toBe(first as string);
	});

	test("a deleted file counts", async () => {
		const clean = await key();
		rmSync(join(dir, "src/settings/form.tsx"));
		expect(await key()).not.toBe(clean as string);
	});

	test("a new commit misses even when the tree ends up the same", async () => {
		const before = await key();
		git("commit", "-q", "--allow-empty", "-m", "again");
		const after = await key();
		expect(after).not.toBe(before as string);
		expect(after?.slice(0, 40)).not.toBe(before?.slice(0, 40));
	});

	test("the request is part of the key: platform, entries, tsconfig", async () => {
		const base = await key();
		expect(await key({ platform: "android" })).not.toBe(base as string);
		expect(await key({ entries: [] })).not.toBe(base as string);
		expect(await key({ fallbackTsconfig: join(dir, "tsconfig.json") })).not.toBe(base as string);
	});

	test("a package added to node_modules (even inside a scope) misses", async () => {
		const clean = await key();
		mkdirSync(join(dir, "node_modules/@y"), { recursive: true });
		const scoped = await key();
		expect(scoped).not.toBe(clean as string);
		symlinkSync(join(dir, "packages/ui"), join(dir, "node_modules/@y/ui"));
		expect(await key()).not.toBe(scoped as string);
	});

	test("files under the cache dir do not count", async () => {
		const cacheDir = join(dir, ".cache");
		const clean = await key({}, cacheDir);
		write(".cache/abc.json", "{}");
		expect(await key({}, cacheDir)).toBe(clean as string);
		expect(await key()).not.toBe(clean as string);
	});

	test("not a git repo, or a repo with no commit, cannot be keyed", async () => {
		const plain = mkdtempSync(join(tmpdir(), "warden-nogit-"));
		const empty = mkdtempSync(join(tmpdir(), "warden-empty-"));
		try {
			Bun.spawnSync(["git", "init", "-q"], { cwd: empty });
			expect(await snapshotKey(bunExec, request({ repoRoot: plain }))).toBeUndefined();
			expect(await snapshotKey(bunExec, request({ repoRoot: empty }))).toBeUndefined();
		} finally {
			rmSync(plain, { recursive: true, force: true });
			rmSync(empty, { recursive: true, force: true });
		}
	});
});

describe("readSnapshot / writeSnapshot", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-snap-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const sha = (n: number) => n.toString(16).padStart(40, "0");
	const key = (n: number) => `${sha(n)}-${"a".repeat(16)}`;
	const doc = graphDoc(["/a"], () => []);

	test("a snapshot reads back; none, or a corrupt one, is a miss", () => {
		const nested = join(dir, "affected");
		expect(readSnapshot(nested, key(1))).toBeUndefined();
		writeSnapshot(nested, key(1), doc);
		expect(readSnapshot(nested, key(1))).toEqual(doc);
		writeFileSync(join(nested, `${key(2)}.json`), "{torn");
		expect(readSnapshot(nested, key(2))).toBeUndefined();
	});

	test("no partial file is left behind", () => {
		writeSnapshot(dir, key(1), doc);
		expect(readdirSync(dir)).toEqual([`${key(1)}.json`]);
	});

	test("only the newest 24 snapshots are kept; other files are left alone", () => {
		writeFileSync(join(dir, "abcdef.json"), "{}");
		for (let n = 1; n <= 30; n++) {
			writeSnapshot(dir, key(n), doc);
			utimesSync(join(dir, `${key(n)}.json`), new Date(2026, 0, 1, 0, n), new Date(2026, 0, 1, 0, n));
		}
		writeSnapshot(dir, key(31), doc);
		const left = readdirSync(dir).filter((f) => f !== "abcdef.json");
		expect(left).toHaveLength(24);
		expect(existsSync(join(dir, `${key(31)}.json`))).toBe(true);
		expect(existsSync(join(dir, `${key(1)}.json`))).toBe(false);
		expect(existsSync(join(dir, "abcdef.json"))).toBe(true);
	});

	test("a cache dir that cannot be written is not an error", () => {
		const file = join(dir, "file");
		writeFileSync(file, "");
		expect(() => writeSnapshot(join(file, "inside"), key(1), doc)).not.toThrow();
	});
});

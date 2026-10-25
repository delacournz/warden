import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { bunExec, type Exec, type ExecResult } from "../exec";
import { findSuite } from "./affected";
import { graphOf, makeSuiteRepo } from "./fixture.testing";
import { reachable, TYPESCRIPT_UNUSABLE_EXIT } from "./graph";
import {
	compiledBinary,
	GRAPH_WORKER_SUBCOMMAND,
	graphEntries,
	type LoadGraphOptions,
	loadImportGraph,
} from "./graph-process";
import { buildGraphDoc } from "./graph-worker";

let dir: string;
let cacheDir: string;
let write: (path: string, text: string) => void;
let spawns: string[][];

/** the real exec, remembering every command that is not git (the walker runs) */
const counting: Exec = (cmd, opts) => {
	if (cmd[0] !== "git") spawns.push([...cmd]);
	return bunExec(cmd, opts);
};

beforeEach(async () => {
	({ dir, write } = await makeSuiteRepo());
	cacheDir = mkdtempSync(join(tmpdir(), "warden-graph-cache-"));
	spawns = [];
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(cacheDir, { recursive: true, force: true });
});

const chats = () => join(dir, "src/app/(app)/chats.tsx");
const rel = (files: Iterable<string>) => [...files].map((f) => relative(dir, f)).sort();

const loadResult = (extra: Partial<LoadGraphOptions> = {}) =>
	loadImportGraph({
		exec: counting,
		platform: "ios",
		repoRoot: dir,
		entries: [chats()],
		cacheDir,
		...extra,
	});

/** `loadImportGraph`, failing the test when it is an error. */
async function loaded(options: LoadGraphOptions) {
	const res = await loadImportGraph(options);
	if (!res.success) throw new Error(res.error);
	return res.data;
}

const load = async (extra: Partial<LoadGraphOptions> = {}) => {
	const res = await loadResult(extra);
	if (!res.success) throw new Error(res.error);
	return res.data;
};

const done = (stdout: string, exitCode = 0, stderr = ""): ExecResult => ({ exitCode, stdout, stderr });

describe("loadImportGraph", () => {
	test("a worker process walks it, and the table gives what the in-process graph gives", async () => {
		const loaded = await load();
		expect(loaded.via).toBe("process");
		expect(loaded.warning).toBeUndefined();
		expect(spawns).toHaveLength(1);
		expect(spawns[0]?.[1]).toEndWith("graph-worker.ts");
		const direct = await graphOf({ platform: "ios", repoRoot: dir });
		const want = reachable([chats()], direct.imports);
		const got = reachable([chats()], loaded.graph.imports);
		expect(rel(got.keys())).toEqual(rel(want.keys()));
		expect([...got]).toEqual([...want]);
	});

	test("a cache hit skips the spawn: same HEAD and tree reads the snapshot", async () => {
		await load();
		expect(spawns).toHaveLength(1);
		const again = await load();
		expect(again.via).toBe("snapshot");
		expect(spawns).toHaveLength(1);
		expect(rel(reachable([chats()], again.graph.imports).keys())).toContain("packages/ui/src/button.tsx");
		expect(readdirSync(cacheDir).filter((f) => /^[0-9a-f]{40}-[0-9a-f]{16}\.json$/.test(f))).toHaveLength(1);
	});

	test("any source change misses and walks again", async () => {
		await load();
		write("src/chat/list.tsx", 'import "./lazy";\n');
		const edited = await load();
		expect(edited.via).toBe("process");
		expect(spawns).toHaveLength(2);
		expect(rel(reachable([chats()], edited.graph.imports).keys())).not.toContain("packages/ui/src/button.tsx");
		expect((await load()).via).toBe("snapshot");
		write("src/chat/lazy.tsx", 'import "@x/ui";\n');
		const again = await load();
		expect(again.via).toBe("process");
		expect(rel(reachable([chats()], again.graph.imports).keys())).toContain("packages/ui/src/button.tsx");
		expect(spawns).toHaveLength(3);
	});

	test("each platform has its own snapshot", async () => {
		const ios = await load();
		const android = await load({ platform: "android" });
		expect(android.via).toBe("process");
		expect(rel(reachable([chats()], ios.graph.imports).keys())).toContain("src/chat/row.ios.tsx");
		expect(rel(reachable([chats()], android.graph.imports).keys())).toContain("src/chat/android-only.tsx");
		expect((await load({ platform: "android" })).via).toBe("snapshot");
		expect(spawns).toHaveLength(2);
	});

	test("without a cache dir nothing is kept and every call walks", async () => {
		await load({ cacheDir: undefined });
		await load({ cacheDir: undefined });
		expect(spawns).toHaveLength(2);
		expect(readdirSync(cacheDir)).toEqual([]);
	});

	test("the worker keeps the per-file specifier cache", async () => {
		const importCachePath = join(cacheDir, "imports.json");
		await load({ importCachePath });
		expect(readdirSync(cacheDir)).toContain("imports.json");
	});

	test("no bun, or no worker script: the walk is done in this process, silently", async () => {
		const noBun = await load({ bun: null });
		expect(noBun).toMatchObject({ via: "in-process" });
		expect(noBun.warning).toBeUndefined();
		const noScript = await load({ worker: join(dir, "nope.ts") });
		expect(noScript.via).toBe("in-process");
		expect(noScript.warning).toBeUndefined();
		expect(spawns).toHaveLength(0);
		expect(rel(reachable([chats()], noBun.graph.imports).keys())).toContain("packages/ui/src/button.tsx");
	});

	test("a worker with no usable typescript is that error, not an in-process walk (cli-size-R5)", async () => {
		const res = await loadResult({
			exec: async (cmd, o) =>
				cmd[0] === "git" ? bunExec(cmd, o) : done("", TYPESCRIPT_UNUSABLE_EXIT, "typescript 4.6 at /x is too old\n"),
		});
		expect(res).toEqual({ success: false, error: "typescript 4.6 at /x is too old" });
	});

	test("a worker error is its last non-empty stderr line with colour codes stripped (cli-size-S2)", async () => {
		const colored = await loadResult({
			exec: async (cmd, o) =>
				cmd[0] === "git"
					? bunExec(cmd, o)
					: done(
							"",
							TYPESCRIPT_UNUSABLE_EXIT,
							`\x1b[31m✖ warden ${GRAPH_WORKER_SUBCOMMAND}: no typescript\x1b[39m\n\n`
						),
		});
		expect(colored).toEqual({ success: false, error: "no typescript" });
		const empty = await loadResult({
			exec: async (cmd, o) => (cmd[0] === "git" ? bunExec(cmd, o) : done("", TYPESCRIPT_UNUSABLE_EXIT, "")),
		});
		expect(empty).toEqual({
			success: false,
			error: `the import graph worker found no usable typescript (exit ${TYPESCRIPT_UNUSABLE_EXIT}, no message)`,
		});
	});

	test("a worker that cannot start (exit 127) falls back silently", async () => {
		const loaded = await load({ exec: async (cmd) => (cmd[0] === "git" ? done("", 128) : done("", 127)) });
		expect(loaded.via).toBe("in-process");
		expect(loaded.warning).toBeUndefined();
	});

	test("a worker that crashes, or prints garbage, falls back with a warning and caches nothing", async () => {
		const git: Exec = bunExec;
		const crash = await load({
			exec: async (cmd, o) => (cmd[0] === "git" ? git(cmd, o) : done("", 1, "SyntaxError: boom")),
		});
		expect(crash.via).toBe("in-process");
		expect(crash.warning).toContain("import graph worker failed");
		expect(crash.warning).toContain("boom");
		const junk = await load({ exec: async (cmd, o) => (cmd[0] === "git" ? git(cmd, o) : done("not a table")) });
		expect(junk.via).toBe("in-process");
		expect(junk.warning).toContain("printed no import graph");
		expect(readdirSync(cacheDir)).toEqual([]);
		expect(rel(reachable([chats()], junk.graph.imports).keys())).toContain("packages/ui/src/button.tsx");
	});

	test("outside a git repo the walker still runs, just without a snapshot", async () => {
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "warden-plain-")));
		try {
			writeFileSync(join(plain, "tsconfig.json"), "{}");
			writeFileSync(join(plain, "a.ts"), 'import "./b";\n');
			writeFileSync(join(plain, "b.ts"), "export {};\n");
			const options = {
				exec: counting,
				platform: "ios" as const,
				repoRoot: plain,
				entries: [join(plain, "a.ts")],
				cacheDir,
			};
			const first = await loaded(options);
			expect(first.via).toBe("process");
			expect(first.graph.imports(join(plain, "a.ts"))).toEqual([join(plain, "b.ts")]);
			expect((await loaded(options)).via).toBe("process");
			expect(readdirSync(cacheDir)).toEqual([]);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});

describe("compiledBinary", () => {
	test("a Bun-compiled entry is embedded under /$bunfs/ (B:/~BUN/ on Windows): the binary is the exec path", () => {
		expect(compiledBinary("/$bunfs/root/warden", "/usr/local/bin/warden")).toBe("/usr/local/bin/warden");
		expect(compiledBinary("B:/~BUN/root/warden.exe", "C:\\warden.exe")).toBe("C:\\warden.exe");
	});

	test("a run from source is not compiled, and neither is this test process", () => {
		expect(compiledBinary("/repo/apps/cli/src/cli.ts", "/usr/local/bin/bun")).toBeUndefined();
		expect(compiledBinary()).toBeUndefined();
	});
});

describe("loadImportGraph in a compiled binary (no worker script on disk)", () => {
	const SELF = "/opt/warden/bin/warden";
	let selfCalls: string[][];

	/** The compiled binary's `__affected-graph`, played by the real walker; git and everything else is real. */
	const asBinary: Exec = async (cmd, opts) => {
		if (cmd[0] !== SELF) return counting(cmd, opts);
		selfCalls.push([...cmd]);
		const built = await buildGraphDoc(JSON.parse(cmd[2] ?? ""));
		return built.success ? done(JSON.stringify(built.data)) : done("", TYPESCRIPT_UNUSABLE_EXIT, built.error);
	};
	beforeEach(() => {
		selfCalls = [];
	});

	const compiled = (extra: Partial<LoadGraphOptions> = {}) => load({ exec: asBinary, self: SELF, bun: null, ...extra });

	test("the binary runs its own hidden subcommand with the request, and the table is the in-process graph's", async () => {
		const loaded = await compiled();
		expect(loaded.via).toBe("process");
		expect(loaded.warning).toBeUndefined();
		expect(selfCalls).toHaveLength(1);
		expect(selfCalls[0]?.slice(0, 2)).toEqual([SELF, GRAPH_WORKER_SUBCOMMAND]);
		expect(JSON.parse(selfCalls[0]?.[2] ?? "")).toMatchObject({ platform: "ios", repoRoot: dir, entries: [chats()] });
		expect(spawns).toHaveLength(0);
		const direct = await graphOf({ platform: "ios", repoRoot: dir });
		expect([...reachable([chats()], loaded.graph.imports)]).toEqual([...reachable([chats()], direct.imports)]);
	});

	test("the subcommand is `__affected-graph`", () => {
		expect(GRAPH_WORKER_SUBCOMMAND).toBe("__affected-graph");
	});

	test("it wins over a bun and a script that are both there", async () => {
		const loaded = await load({ exec: asBinary, self: SELF });
		expect(loaded.via).toBe("process");
		expect(selfCalls).toHaveLength(1);
		expect(spawns).toHaveLength(0);
	});

	test("its table is snapshotted like a script worker's: the second call spawns nothing", async () => {
		await compiled();
		const again = await compiled();
		expect(again.via).toBe("snapshot");
		expect(selfCalls).toHaveLength(1);
	});

	test("a binary that fails, or prints garbage, falls back in-process with a warning naming it", async () => {
		const crash = await compiled({
			exec: async (cmd, o) => (cmd[0] === SELF ? done("", 1, "TypeError: boom") : counting(cmd, o)),
		});
		expect(crash.via).toBe("in-process");
		expect(crash.warning).toContain(`${SELF} ${GRAPH_WORKER_SUBCOMMAND}`);
		expect(crash.warning).toContain("boom");
		const junk = await compiled({ exec: async (cmd, o) => (cmd[0] === SELF ? done("hello") : counting(cmd, o)) });
		expect(junk.via).toBe("in-process");
		expect(junk.warning).toContain("printed no import graph");
		expect(readdirSync(cacheDir)).toEqual([]);
	});

	test("a binary with no usable typescript is that error, not an in-process walk (cli-size-R5)", async () => {
		const why = "needs typescript in the analysed project: add it as a devDependency";
		const res = await loadResult({
			exec: async (cmd, o) =>
				cmd[0] === SELF
					? done("", TYPESCRIPT_UNUSABLE_EXIT, `✖ warden ${GRAPH_WORKER_SUBCOMMAND}: ${why}\n`)
					: counting(cmd, o),
			self: SELF,
			bun: null,
		});
		expect(res).toEqual({ success: false, error: why });
		expect(readdirSync(cacheDir)).toEqual([]);
	});

	test("a binary that cannot start (exit 127) falls back silently", async () => {
		const loaded = await compiled({ exec: async (cmd, o) => (cmd[0] === SELF ? done("", 127) : counting(cmd, o)) });
		expect(loaded.via).toBe("in-process");
		expect(loaded.warning).toBeUndefined();
	});

	test("self: null with no bun is the in-process walk, as before", async () => {
		const loaded = await load({ exec: asBinary, self: null, bun: null });
		expect(loaded.via).toBe("in-process");
		expect(selfCalls).toHaveLength(0);
	});
});

describe("graphEntries", () => {
	test("every spec's entries that exist, then the router layouts above them", async () => {
		const suite = await findSuite(bunExec, dir);
		if (!suite.success) throw new Error(suite.error);
		const config = { ...suite.data.config, routerRoot: "src/app" };
		expect(rel(graphEntries(config, dir, "ios"))).toEqual([
			"src/app/(app)/_layout.tsx",
			"src/app/(app)/chats.tsx",
			"src/app/(app)/settings.tsx",
			"src/app/_layout.tsx",
		]);
		expect(rel(graphEntries(suite.data.config, dir, "ios"))).toEqual([
			"src/app/(app)/chats.tsx",
			"src/app/(app)/settings.tsx",
		]);
	});

	test("an entry that does not exist is left out", async () => {
		const suite = await findSuite(bunExec, dir);
		if (!suite.success) throw new Error(suite.error);
		const specs = {
			...suite.data.config.specs,
			ghost: { ...suite.data.config.specs.chats, entries: ["src/ghost.tsx"] },
		};
		expect(rel(graphEntries({ ...suite.data.config, specs } as typeof suite.data.config, dir, "ios"))).toEqual([
			"src/app/(app)/chats.tsx",
			"src/app/(app)/settings.tsx",
		]);
	});
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import ts from "typescript";
import { buildExpoBuildCache } from "./expo-build-cache-entry";
import { EXPO_BUILD_CACHE_DTS, EXPO_BUILD_CACHE_JS, mainManifest, SHIM_PATH } from "./manifests";

let dir: string;
let pkg: string;

/** Answers like `warden builds path|import … --json` for a project whose dev build is cached at /cache/App.app. */
const FAKE_WARDEN = `const args = process.argv.slice(2);
const [group, sub] = args;
const hashAt = args.indexOf("--hash");
const hash = hashAt === -1 ? "fp:dev" : args[hashAt + 1];
if (group === "builds" && sub === "path") {
	const found = hash === "fp:dev";
	console.log(JSON.stringify(found ? { found, hash, path: "/cache/App.app", platform: "ios", kind: "dev", defaultBuild: true } : { found, hash, defaultBuild: true }));
	process.exit(found ? 0 : 2);
}
if (group === "builds" && sub === "import") {
	console.log(JSON.stringify({ kind: "dev", hash, path: "/cache/Stored.app", cwd: process.cwd() }));
	process.exit(0);
}
process.exit(1);
`;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "warden-expo-build-cache-"));
	pkg = join(dir, "node_modules", "@delacour", "warden");
	mkdirSync(join(pkg, "bin"), { recursive: true });
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify(mainManifest({ version: "0.0.0", description: "", license: "MIT" }))
	);
	const res = await buildExpoBuildCache(pkg);
	if (!res.success) throw new Error(res.error);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run `script` under real Node (not Bun), as Expo's CLI does, and parse what it prints. */
async function underNode(
	script: string,
	env: Record<string, string> = {}
): Promise<{ out: string; all: string; err: string }> {
	const node = Bun.which("node");
	if (!node) throw new Error("node is required for this test");
	const proc = Bun.spawn([node, "-e", script], {
		cwd: dir,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	return { out: out.trim().split("\n").at(-1) ?? "", all: out.trim(), err: err.trim() };
}

const requireProvider = () => `const p = require(${JSON.stringify(join(pkg, EXPO_BUILD_CACHE_JS))});`;

describe("buildExpoBuildCache", () => {
	test("the shim path the provider looks for is the package's bin", () => {
		expect(SHIM_PATH).toBe("bin/warden.mjs");
	});

	test("the bundle is plain CommonJS that loads under node and exports the provider both ways", async () => {
		const { out, err } = await underNode(
			`${requireProvider()}console.log(JSON.stringify([Object.keys(p.default).sort(), typeof p.resolveBuildCache, typeof p.uploadBuildCache, typeof p.calculateFingerprintHash]))`
		);
		expect(err).toBe("");
		expect(JSON.parse(out)).toEqual([
			["calculateFingerprintHash", "resolveBuildCache", "uploadBuildCache"],
			"function",
			"function",
			"function",
		]);
	});

	test("it runs the package's own shim under node: hit, miss, upload, in the project root", async () => {
		writeFileSync(join(pkg, SHIM_PATH), FAKE_WARDEN);
		const { out, all } = await underNode(`${requireProvider()}
(async () => {
	const base = { projectRoot: process.cwd(), platform: "ios", runOptions: {} };
	const hash = await p.default.calculateFingerprintHash(base);
	const hit = await p.default.resolveBuildCache({ ...base, fingerprintHash: hash });
	const miss = await p.default.resolveBuildCache({ ...base, fingerprintHash: "other:dev" });
	const stored = await p.default.uploadBuildCache({ ...base, fingerprintHash: "other:dev", buildPath: "/b/App.app" });
	const release = await p.default.calculateFingerprintHash({ ...base, runOptions: { configuration: "Release" } });
	console.log(JSON.stringify({ hash, hit, miss, stored, release }));
})();`);
		expect(JSON.parse(out)).toEqual({
			hash: "fp:dev",
			hit: "/cache/App.app",
			miss: null,
			stored: "/cache/Stored.app",
			release: null,
		});
		expect(all).toContain("warden: using the cached dev build");
	});

	test("without the shim it falls back to `warden` on PATH; a missing warden is a warning and a null", async () => {
		rmSync(join(pkg, SHIM_PATH), { force: true });
		const bin = join(dir, "path-bin");
		mkdirSync(bin, { recursive: true });
		const script = join(bin, "warden");
		writeFileSync(script, `#!${Bun.which("node")}\n${FAKE_WARDEN}`);
		chmodSync(script, 0o755);
		const call = `${requireProvider()}
p.default.calculateFingerprintHash({ projectRoot: process.cwd(), platform: "ios", runOptions: {} }).then((h) => console.log(JSON.stringify(h)));`;
		const onPath = await underNode(call, { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` });
		expect(JSON.parse(onPath.out)).toBe("fp:dev");
		const empty = join(dir, "empty-bin");
		mkdirSync(empty, { recursive: true });
		const nowhere = await underNode(call, { PATH: empty });
		expect(JSON.parse(nowhere.out)).toBeNull();
		expect(nowhere.err).toContain("warden: build cache skipped");
	});

	test("the .d.ts types a consumer's provider reference", () => {
		const file = join(dir, "check.ts");
		writeFileSync(
			file,
			`import provider, { resolveBuildCache, type ExpoBuildCacheProvider } from "@delacour/warden/expo-build-cache";
const typed: ExpoBuildCacheProvider = provider;
export const run = () => [typed, resolveBuildCache({ projectRoot: "/x", platform: "ios", runOptions: {}, fingerprintHash: "h" })];`
		);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
		const program = ts.createProgram([file], {
			strict: true,
			noEmit: true,
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.Node16,
			moduleResolution: ts.ModuleResolutionKind.Node16,
			types: [],
		});
		const problems = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
		expect(problems).toEqual([]);
		expect(Bun.file(join(pkg, EXPO_BUILD_CACHE_DTS)).size).toBeGreaterThan(0);
	}, 60_000);
});

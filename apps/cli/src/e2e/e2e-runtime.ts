import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { bundleRuntime } from "../npm/e2e-runtime-pack";
import type { BuildInfo } from "../update/build-info";

/**
 * The `@delacour/warden-e2e` copy the global warden ships, for app repos that don't depend on it.
 *
 * The binary embeds one blob (`e2e-runtime.bin`: a JSON map of file name → text, the `Bun.build` output of
 * `packages/e2e` with `zod` inlined so the copy needs no `node_modules`). It is extracted to
 * `<wardenHome>/e2e-runtime/<version>/` and `bun test` runs `--preload <dir>/fallback-preload.mjs`.
 *
 * Why a preload plugin and not a `node_modules` symlink / `NODE_PATH` / tsconfig `paths`: measured on bun 1.4.3,
 * `NODE_PATH` is ignored by `bun test`; a symlink only helps specs below the directory that holds it (never a spec
 * in the app repo, and warden must not write there); `paths` needs a tsconfig in the spec's tree. A `Bun.plugin`
 * virtual module (`build.module`) registered from a preload is honoured for every spec file wherever it lives
 * (repo or `~/.warden` overlay), so `import { test } from "@delacour/warden-e2e"` resolves to the copy with no
 * file written outside warden's home.
 */

/** Name of the embedded blob (`Bun.embeddedFiles` reports it with a content hash: `e2e-runtime-<hash>.bin`). */
export const RUNTIME_BLOB = "e2e-runtime.bin";
/** The preload `bun test` is given: registers the `@delacour/warden-e2e` module, then runs the copy's own preload. */
export const RUNTIME_FALLBACK_PRELOAD = "fallback-preload.mjs";
const RUNTIME_ENTRY = "index.mjs";
const RUNTIME_PRELOAD = "preload.mjs";
const READY_MARKER = ".ready";
const E2E_PACKAGE = "@delacour/warden-e2e";

/** File name → text of one extracted copy. */
export type RuntimeFiles = Readonly<Record<string, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The blob's JSON; names are flat (no path separators) so extraction cannot leave its directory. */
export function parseRuntime(text: string): Result<RuntimeFiles> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return err("embedded @delacour/warden-e2e runtime is not valid JSON");
	}
	if (!isRecord(parsed)) return err("embedded @delacour/warden-e2e runtime is not an object");
	const files: Record<string, string> = {};
	for (const [name, content] of Object.entries(parsed)) {
		if (typeof content !== "string") return err(`embedded @delacour/warden-e2e runtime: ${name} is not text`);
		if (name === "" || name.includes("/") || name.includes("\\") || name.startsWith("."))
			return err(`embedded @delacour/warden-e2e runtime: bad file name ${JSON.stringify(name)}`);
		files[name] = content;
	}
	return ok(files);
}

/** `<home>/e2e-runtime/<version>`. */
export function runtimeDir(home: string, version: string): string {
	return join(home, "e2e-runtime", version);
}

/** The fallback preload's text: `import … from "@delacour/warden-e2e"` in any spec resolves to `index.mjs` next to it. */
function fallbackPreloadSource(): string {
	return `import { plugin } from "bun";
import { join } from "node:path";

plugin({
	name: "warden-e2e-runtime",
	setup(build) {
		build.module("${E2E_PACKAGE}", () => ({
			loader: "js",
			contents: \`export * from \${JSON.stringify(join(import.meta.dir, "${RUNTIME_ENTRY}"))};\`,
		}));
	},
});

await import("./${RUNTIME_PRELOAD}");
`;
}

export type StageRuntimeOptions = {
	home: string;
	/** warden's own version: the copy's `WARDEN_E2E_VERSION` is baked to it and the preload refuses any other */
	version: string;
	/**
	 * `release`: the copy for a version never changes, so it lives at `<version>` and a ready one is reused unloaded.
	 * `content`: local / dev builds keep their version while the code changes, so the copy lives at
	 * `<version>-<hash of the files>`; never rewritten in place, so a spec still running from an older one is safe.
	 */
	keyed: "release" | "content";
	load: () => AsyncResult<RuntimeFiles>;
};

function contentKey(version: string, files: RuntimeFiles): string {
	const hash = createHash("sha256");
	for (const name of Object.keys(files).sort())
		hash
			.update(name)
			.update("\0")
			.update(files[name] ?? "")
			.update("\0");
	return `${version}-${hash.digest("hex").slice(0, 8)}`;
}

/**
 * Extract the runtime under `<home>/e2e-runtime/` and return the path of its fallback preload. Written to a
 * sibling temp dir and renamed into place, so a concurrent run never sees half a copy; `.ready` marks a complete one.
 */
export async function stageRuntime(o: StageRuntimeOptions): AsyncResult<string> {
	if (o.keyed === "release") {
		const ready = join(runtimeDir(o.home, o.version), RUNTIME_FALLBACK_PRELOAD);
		if (existsSync(join(runtimeDir(o.home, o.version), READY_MARKER))) return ok(ready);
	}
	const loaded = await o.load();
	if (!loaded.success) return loaded;
	const files = loaded.data;
	if (!(RUNTIME_ENTRY in files) || !(RUNTIME_PRELOAD in files))
		return err(`embedded @delacour/warden-e2e runtime lacks ${RUNTIME_ENTRY} / ${RUNTIME_PRELOAD}`);
	const dir = runtimeDir(o.home, o.keyed === "release" ? o.version : contentKey(o.version, files));
	const preload = join(dir, RUNTIME_FALLBACK_PRELOAD);
	if (existsSync(join(dir, READY_MARKER))) return ok(preload);
	const tmp = `${dir}.tmp-${process.pid}`;
	try {
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(tmp, { recursive: true });
		for (const [name, content] of Object.entries(files)) writeFileSync(join(tmp, name), content);
		writeFileSync(
			join(tmp, "package.json"),
			`${JSON.stringify({ name: E2E_PACKAGE, version: o.version, type: "module" })}\n`
		);
		writeFileSync(join(tmp, RUNTIME_FALLBACK_PRELOAD), fallbackPreloadSource());
		writeFileSync(join(tmp, READY_MARKER), `${o.version}\n`);
		// a half-written copy from a crashed run has no marker: replace it
		rmSync(dir, { recursive: true, force: true });
		try {
			renameSync(tmp, dir);
		} catch (cause) {
			// another warden renamed its copy in first: same key, same content, use it
			if (!existsSync(join(dir, READY_MARKER))) throw cause;
		}
		return ok(preload);
	} catch (cause) {
		return err(`could not extract the bundled @delacour/warden-e2e to ${dir}: ${String(cause)}`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** The blob embedded in the compiled binary (`Bun.embeddedFiles`, name `e2e-runtime-<hash>.bin`). */
export async function loadEmbeddedRuntime(embedded: readonly Blob[] = Bun.embeddedFiles): AsyncResult<RuntimeFiles> {
	const blob = embedded.find(
		(file) => "name" in file && typeof file.name === "string" && /^e2e-runtime(-[^.]*)?\.bin$/.test(file.name)
	);
	if (blob === undefined)
		return err(
			"this warden build has no embedded @delacour/warden-e2e runtime; rebuild it or run bun add -d @delacour/warden-e2e"
		);
	const parsed = parseRuntime(await blob.text());
	return parsed;
}

/**
 * Extract the runtime for the running warden and return its fallback preload: the embedded blob in a compiled
 * binary, bundled from the checkout's `packages/e2e` when warden runs from source.
 */
export function stageBundledRuntime(env: Record<string, string | undefined>, build: BuildInfo): AsyncResult<string> {
	const { version } = build;
	return stageRuntime({
		home: wardenHome(env),
		version,
		keyed: build.channel === "release" ? "release" : "content",
		load:
			build.channel === "dev"
				? () => bundleRuntime({ srcDir: join(build.sourceDir, "packages", "e2e", "src"), version })
				: () => loadEmbeddedRuntime(),
	});
}

export type PreloadSource = "repo" | "bundled";

export type SelectPreloadOptions = {
	/** the suite's project dir: where the repo's own `@delacour/warden-e2e` would resolve from */
	cwd: string;
	/** warden's own version */
	version: string;
	/** `Bun.resolveSync`: throws when the package is not installed */
	resolve: (specifier: string, from: string) => string;
	/** the published version of the package that owns a resolved preload (`undefined`: workspace sources / unknown) */
	readVersion: (preloadPath: string) => string | undefined;
	/** extract the bundled copy and return its fallback preload */
	stage: () => AsyncResult<string>;
};

/**
 * Which `@delacour/warden-e2e` the specs run on. The repo's own dependency wins when it is warden's version;
 * a repo copy at another version is an error (the preload would refuse it anyway, this says how to fix it);
 * no dependency at all falls back to the copy warden ships.
 */
export async function selectPreload(o: SelectPreloadOptions): AsyncResult<{ path: string; source: PreloadSource }> {
	let repoPreload: string | undefined;
	try {
		repoPreload = o.resolve(`${E2E_PACKAGE}/preload`, o.cwd);
	} catch {
		repoPreload = undefined;
	}
	if (repoPreload === undefined) {
		const staged = await o.stage();
		return staged.success ? ok({ path: staged.data, source: "bundled" }) : staged;
	}
	const found = o.readVersion(repoPreload);
	if (found !== undefined && found !== o.version)
		return err(
			`${E2E_PACKAGE} ${found} (${repoPreload}) does not match warden ${o.version}; install the matching version (bun add -d ${E2E_PACKAGE}@${o.version}) or remove it from the repo to use the copy bundled with warden`
		);
	return ok({ path: repoPreload, source: "repo" });
}

/**
 * The version in the `package.json` that owns `preloadPath`, when it is the published `@delacour/warden-e2e`.
 * The workspace package is `private` (never published): its sources carry no handshake version, so `undefined`.
 */
export function readE2ePackageVersion(preloadPath: string): string | undefined {
	let dir: string;
	try {
		dir = dirname(realpathSync(preloadPath));
	} catch {
		return undefined;
	}
	for (;;) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) return publishedVersion(manifest);
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function publishedVersion(manifest: string): string | undefined {
	try {
		const pkg: unknown = JSON.parse(readFileSync(manifest, "utf8"));
		if (!isRecord(pkg) || pkg.name !== E2E_PACKAGE || pkg.private === true) return undefined;
		return typeof pkg.version === "string" ? pkg.version : undefined;
	} catch {
		return undefined;
	}
}

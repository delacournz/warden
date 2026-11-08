import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { WARDEN_E2E_VERSION, WORKSPACE_VERSION } from "../../version";

/**
 * Where the bytes of `warden-atf.jar` come from. They are not in the bundle: a 180 KB base64 zip of dex inside
 * `preload.mjs` held every `@delacour/warden-e2e` release in npm's automated review for ~16 minutes. Each GitHub
 * release carries the jar as `warden-atf-<sha8>.jar`; it is fetched on the first Android audit, checked against
 * `jarSha256` and cached in `$WARDEN_HOME/atf/`.
 *
 * Order: `WARDEN_ATF_JAR` (a local file, for offline hosts; nothing else is tried), the cache, the checked-in jar
 * when running from the workspace, then the release download.
 */

export const ATF_RELEASE_REPO = "delacournz/warden";
export const ATF_ENV = "WARDEN_ATF_JAR";
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** `native/android/atf/warden-atf.jar`, as seen from this source file (absent in the bundle and the binary). */
export const WORKSPACE_ATF_JAR = join(import.meta.dir, "../../../native/android/atf/warden-atf.jar");

export type AtfJarMeta = { bytes: number; jarSha256: string };
export type AtfJarSource = "env" | "cache" | "workspace" | "download";
export type AtfFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export type LoadAtfDeps = {
	env: Record<string, string | undefined>;
	home: string;
	version: string;
	workspaceJar: string;
	fetch: AtfFetch;
};

const short = (jar: Pick<AtfJarMeta, "jarSha256">): string => jar.jarSha256.slice(0, 8);

export function atfAssetName(jar: Pick<AtfJarMeta, "jarSha256">): string {
	return `warden-atf-${short(jar)}.jar`;
}

export function atfCachePath(home: string, jar: Pick<AtfJarMeta, "jarSha256">): string {
	return join(home, "atf", atfAssetName(jar));
}

export function atfDownloadUrl(version: string, jar: Pick<AtfJarMeta, "jarSha256">, repo = ATF_RELEASE_REPO): string {
	return `https://github.com/${repo}/releases/download/v${version}/${atfAssetName(jar)}`;
}

export function defaultAtfDeps(env: Record<string, string | undefined> = process.env): LoadAtfDeps {
	return {
		env,
		home: wardenHome(env),
		version: WARDEN_E2E_VERSION,
		workspaceJar: WORKSPACE_ATF_JAR,
		fetch: (url, init) => fetch(url, { ...init, redirect: "follow" }),
	};
}

function verify(bytes: Uint8Array, jar: AtfJarMeta, from: string): Result<Uint8Array> {
	if (bytes.length !== jar.bytes) return err(`${from}: ${bytes.length} B, expected ${jar.bytes} B`);
	const sha = createHash("sha256").update(bytes).digest("hex");
	if (sha !== jar.jarSha256)
		return err(`${from}: sha256 ${sha.slice(0, 12)}…, expected ${jar.jarSha256.slice(0, 12)}…`);
	return ok(bytes);
}

function readVerified(path: string, jar: AtfJarMeta): Result<Uint8Array> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return verify(new Uint8Array(readFileSync(path)), jar, path);
	} catch (error) {
		return err(error);
	}
}

/** Best effort: a cache that cannot be written only costs the next run a download. */
function writeCache(path: string, bytes: Uint8Array): void {
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, bytes);
		renameSync(tmp, path);
	} catch {
		rmSync(tmp, { force: true });
	}
}

async function download(jar: AtfJarMeta, deps: LoadAtfDeps): AsyncResult<Uint8Array> {
	const url = atfDownloadUrl(deps.version, jar);
	const offline = `download it once and set ${ATF_ENV}=<path to ${atfAssetName(jar)}>`;
	try {
		const res = await deps.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
		if (!res.ok) return err(`GET ${url}: HTTP ${res.status} (${offline})`);
		const checked = verify(new Uint8Array(await res.arrayBuffer()), jar, url);
		if (!checked.success) return checked;
		writeCache(atfCachePath(deps.home, jar), checked.data);
		return checked;
	} catch (error) {
		return err(`GET ${url}: ${error instanceof Error ? error.message : String(error)} (${offline})`);
	}
}

/** The jar's bytes, checked against `jar`, and where they came from. */
export async function loadAtfJar(
	jar: AtfJarMeta,
	deps: LoadAtfDeps = defaultAtfDeps()
): AsyncResult<{ bytes: Uint8Array; source: AtfJarSource }> {
	const fromEnv = deps.env[ATF_ENV];
	if (fromEnv) {
		const read = readVerified(fromEnv, jar) ?? err(`${fromEnv}: no such file`);
		return read.success ? ok({ bytes: read.data, source: "env" }) : err(`${ATF_ENV}: ${read.error}`);
	}
	const cached = readVerified(atfCachePath(deps.home, jar), jar);
	if (cached?.success) return ok({ bytes: cached.data, source: "cache" });
	const workspace = readVerified(deps.workspaceJar, jar);
	if (workspace?.success) return ok({ bytes: workspace.data, source: "workspace" });
	if (deps.version === WORKSPACE_VERSION) {
		return err(
			`no ${atfAssetName(jar)} for a workspace build: run \`bun run --cwd packages/e2e android:emit-atf\` or set ${ATF_ENV}`
		);
	}
	const fetched = await download(jar, deps);
	return fetched.success ? ok({ bytes: fetched.data, source: "download" }) : fetched;
}

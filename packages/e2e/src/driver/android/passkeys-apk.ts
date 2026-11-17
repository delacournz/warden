import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { WARDEN_E2E_VERSION, WORKSPACE_VERSION } from "../../version";

/**
 * Where the bytes of `warden-passkeys.apk` (the virtual authenticator's credential provider, ~38 KB) come from. They
 * are not in the bundle: a base64 zip inside `preload.mjs` held every `@delacour/warden-e2e` release in npm's
 * automated review for ~16 minutes (the ATF jar lesson, `atf-jar.ts`). Each GitHub release carries the APK as
 * `warden-passkeys-<sha8>.apk`; it is fetched on the first Android passkey op, checked against `apkSha256` and cached
 * in `$WARDEN_HOME/passkeys-apk/`.
 *
 * Order: `WARDEN_PASSKEYS_APK` (a local file; nothing else is tried), the cache, the checked-in APK when running from
 * the workspace, then the release download.
 */

export const PASSKEYS_APK_RELEASE_REPO = "delacournz/warden";
export const PASSKEYS_APK_ENV = "WARDEN_PASSKEYS_APK";
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** `native/android/passkeys/warden-passkeys.apk`, as seen from this source file (absent in the bundle and the binary). */
export const WORKSPACE_PASSKEYS_APK = join(import.meta.dir, "../../../native/android/passkeys/warden-passkeys.apk");

export type PasskeysApkMeta = { bytes: number; apkSha256: string };
export type PasskeysApkSource = "env" | "cache" | "workspace" | "download";
export type PasskeysApkFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export type LoadPasskeysApkDeps = {
	env: Record<string, string | undefined>;
	home: string;
	version: string;
	workspaceApk: string;
	fetch: PasskeysApkFetch;
};

const short = (apk: Pick<PasskeysApkMeta, "apkSha256">): string => apk.apkSha256.slice(0, 8);

export function passkeysApkAssetName(apk: Pick<PasskeysApkMeta, "apkSha256">): string {
	return `warden-passkeys-${short(apk)}.apk`;
}

export function passkeysApkCachePath(home: string, apk: Pick<PasskeysApkMeta, "apkSha256">): string {
	return join(home, "passkeys-apk", passkeysApkAssetName(apk));
}

export function passkeysApkDownloadUrl(
	version: string,
	apk: Pick<PasskeysApkMeta, "apkSha256">,
	repo = PASSKEYS_APK_RELEASE_REPO
): string {
	return `https://github.com/${repo}/releases/download/v${version}/${passkeysApkAssetName(apk)}`;
}

export function defaultPasskeysApkDeps(env: Record<string, string | undefined> = process.env): LoadPasskeysApkDeps {
	return {
		env,
		home: wardenHome(env),
		version: WARDEN_E2E_VERSION,
		workspaceApk: WORKSPACE_PASSKEYS_APK,
		fetch: (url, init) => fetch(url, { ...init, redirect: "follow" }),
	};
}

function verify(bytes: Uint8Array, apk: PasskeysApkMeta, from: string): Result<Uint8Array> {
	if (bytes.length !== apk.bytes) return err(`${from}: ${bytes.length} B, expected ${apk.bytes} B`);
	const sha = createHash("sha256").update(bytes).digest("hex");
	if (sha !== apk.apkSha256)
		return err(`${from}: sha256 ${sha.slice(0, 12)}…, expected ${apk.apkSha256.slice(0, 12)}…`);
	return ok(bytes);
}

function readVerified(path: string, apk: PasskeysApkMeta): Result<Uint8Array> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return verify(new Uint8Array(readFileSync(path)), apk, path);
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

async function download(apk: PasskeysApkMeta, deps: LoadPasskeysApkDeps): AsyncResult<Uint8Array> {
	const url = passkeysApkDownloadUrl(deps.version, apk);
	const offline = `download it once and set ${PASSKEYS_APK_ENV}=<path to ${passkeysApkAssetName(apk)}>`;
	try {
		const res = await deps.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
		if (!res.ok) return err(`GET ${url}: HTTP ${res.status} (${offline})`);
		const checked = verify(new Uint8Array(await res.arrayBuffer()), apk, url);
		if (!checked.success) return checked;
		writeCache(passkeysApkCachePath(deps.home, apk), checked.data);
		return checked;
	} catch (error) {
		return err(`GET ${url}: ${error instanceof Error ? error.message : String(error)} (${offline})`);
	}
}

/** The APK's bytes, checked against `apk`, and where they came from. */
export async function loadPasskeysApk(
	apk: PasskeysApkMeta,
	deps: LoadPasskeysApkDeps = defaultPasskeysApkDeps()
): AsyncResult<{ bytes: Uint8Array; source: PasskeysApkSource }> {
	const fromEnv = deps.env[PASSKEYS_APK_ENV];
	if (fromEnv) {
		const read = readVerified(fromEnv, apk) ?? err(`${fromEnv}: no such file`);
		return read.success ? ok({ bytes: read.data, source: "env" }) : err(`${PASSKEYS_APK_ENV}: ${read.error}`);
	}
	const cached = readVerified(passkeysApkCachePath(deps.home, apk), apk);
	if (cached?.success) return ok({ bytes: cached.data, source: "cache" });
	const workspace = readVerified(deps.workspaceApk, apk);
	if (workspace?.success) return ok({ bytes: workspace.data, source: "workspace" });
	if (deps.version === WORKSPACE_VERSION) {
		return err(
			`no ${passkeysApkAssetName(apk)} for a workspace build: run \`bun run --cwd packages/e2e android:emit-passkeys\` or set ${PASSKEYS_APK_ENV}`
		);
	}
	const fetched = await download(apk, deps);
	return fetched.success ? ok({ bytes: fetched.data, source: "download" }) : fetched;
}

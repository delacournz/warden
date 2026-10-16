import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import type { Platform } from "../results/schema";
import { type Exec, runOk } from "./exec";

export type EnsuredApp = { appPath: string; hash: string; source: string; installed: boolean };

export type EnsureInput = {
	platform: Platform;
	cliPath: string;
	udid: string;
	/** a directory name under `apps/` (default `example`) */
	project?: string;
	/** checkout root; `apps/<project>` is resolved against it (default: cwd) */
	repoRoot?: string;
	log: (line: string) => void;
};

function parseEnsure(stdout: string): EnsuredApp | undefined {
	try {
		const raw: unknown = JSON.parse(stdout);
		if (typeof raw !== "object" || raw === null) return undefined;
		const { appPath, hash, source, installed } = raw as Record<string, unknown>;
		if (typeof appPath !== "string" || typeof hash !== "string") return undefined;
		return { appPath, hash, source: typeof source === "string" ? source : "", installed: installed === true };
	} catch {
		return undefined;
	}
}

async function warden(exec: Exec, input: EnsureInput, extra: readonly string[]): AsyncResult<EnsuredApp> {
	const dir = join(input.repoRoot ?? process.cwd(), "apps", input.project ?? "example");
	const args = [input.cliPath, "app", "ensure", input.platform, "--project", dir, ...extra, "--json"];
	const ran = await runOk(exec, process.execPath, args, { onLine: (_s, line) => input.log(line) });
	if (!ran.success) return ran;
	const parsed = parseEnsure(ran.data.stdout);
	return parsed === undefined
		? err(`warden app ensure: unparseable output: ${ran.data.stdout.slice(0, 200)}`)
		: ok(parsed);
}

/**
 * Installs the project's build on the device via warden. `appPath` is "" when the app was already
 * installed and the cache no longer holds it, so a second `--no-install` call resolves the cache path
 * (the fingerprint of the artifact is recorded in the results).
 */
export async function ensureApp(exec: Exec, input: EnsureInput): AsyncResult<EnsuredApp> {
	const first = await warden(exec, input, ["--udid", input.udid]);
	if (!first.success || first.data.appPath !== "") return first;
	const resolved = await warden(exec, input, ["--no-install"]);
	if (!resolved.success) return resolved;
	return ok({ ...first.data, appPath: resolved.data.appPath });
}

function listFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.push(full);
		}
	};
	walk(root);
	return out.sort();
}

/** sha256 over the sorted relative file list and contents of a `.app` dir, or over the file for an `.apk`. */
export function appFingerprint(appPath: string): Result<{ sha256: string; bytes: number }> {
	try {
		const hash = createHash("sha256");
		if (!statSync(appPath).isDirectory()) {
			const data = readFileSync(appPath);
			hash.update(data);
			return ok({ sha256: hash.digest("hex"), bytes: data.length });
		}
		let bytes = 0;
		for (const file of listFiles(appPath)) {
			const data = readFileSync(file);
			hash.update(`${relative(appPath, file)}\0${data.length}\0`);
			hash.update(data);
			bytes += data.length;
		}
		return ok({ sha256: hash.digest("hex"), bytes });
	} catch (e) {
		return err(e);
	}
}

/** `xcrun simctl install` / `adb install -r`. */
export async function installApp(exec: Exec, platform: Platform, udid: string, appPath: string): AsyncResult<void> {
	const [cmd, args] =
		platform === "ios"
			? (["xcrun", ["simctl", "install", udid, appPath]] as const)
			: (["adb", ["-s", udid, "install", "-r", appPath]] as const);
	const ran = await runOk(exec, cmd, args);
	return ran.success ? ok(undefined) : ran;
}

const NOT_RUNNING = /not running|found nothing to terminate/i;

/** Stops the app; "not running" is not an error (the next rep starts it fresh either way). */
export async function terminateApp(exec: Exec, platform: Platform, udid: string, bundleId: string): AsyncResult<void> {
	if (platform === "android") {
		const ran = await runOk(exec, "adb", ["-s", udid, "shell", "am", "force-stop", bundleId]);
		return ran.success ? ok(undefined) : ran;
	}
	const r = await exec.run("xcrun", ["simctl", "terminate", udid, bundleId]);
	if (r.spawnError !== undefined) return err(`xcrun: ${r.spawnError}`);
	if (r.code === 0 || NOT_RUNNING.test(r.stderr + r.stdout)) return ok(undefined);
	return err(`xcrun simctl terminate exited ${r.code}: ${r.stderr.trim()}`);
}

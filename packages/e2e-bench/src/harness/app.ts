import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import type { Platform } from "../results/schema";
import { type Exec, runOk } from "./exec";

export type EnsuredApp = { appPath: string; hash: string; source: string; installed: boolean };

/** Parses `warden app ensure --json` stdout; undefined when it is not the expected object. */
export function parseEnsure(stdout: string): EnsuredApp | undefined {
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

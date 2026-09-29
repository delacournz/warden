import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Exec } from "@warden/core/exec";
import { type AsyncResult, err, ok } from "@warden/types/result";

/**
 * Put `source` at `target` atomically: copy next to the target, chmod 755, drop the macOS
 * quarantine flag, check it runs and reports `expectedVersion`, then rename over the target.
 * The running process keeps its old inode; the next `warden` call gets the new binary.
 */
export async function installBinary(
	exec: Exec,
	source: string,
	target: string,
	expectedVersion: string
): AsyncResult<void> {
	mkdirSync(dirname(target), { recursive: true });
	const staged = `${target}.new-${process.pid}`;
	try {
		copyFileSync(source, staged);
		chmodSync(staged, 0o755);
		await exec(["xattr", "-d", "com.apple.quarantine", staged]);
		const check = await exec([staged, "version", "--json"]);
		const reported = parseReportedVersion(check.stdout);
		if (check.exitCode !== 0 || reported !== expectedVersion) {
			rmSync(staged, { force: true });
			return err(
				`new binary failed its self-check (expected ${expectedVersion}, got ${reported ?? `exit ${check.exitCode}`})`
			);
		}
		renameSync(staged, target);
		return ok(undefined);
	} catch (error) {
		rmSync(staged, { force: true });
		return err(error);
	}
}

function parseReportedVersion(stdout: string): string | undefined {
	try {
		const data: unknown = JSON.parse(stdout);
		return typeof data === "object" && data !== null && "version" in data && typeof data.version === "string"
			? data.version
			: undefined;
	} catch {
		return undefined;
	}
}

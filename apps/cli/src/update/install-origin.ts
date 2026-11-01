import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeLocator } from "@delacour/warden-store/store";

/**
 * Where a standalone binary came from, when that can't be read off its path: `warden install` run via
 * npx / bunx copies the package's binary to `~/.local/bin/warden`, which then updates from npm.
 * Stored as `{ "<binary path>": "npm" }` in `$WARDEN_HOME/install-origin.json`.
 */
export type InstallOrigin = "npm";

export class InstallOriginHelpers {
	private originFile(env: Record<string, string | undefined>): string {
		return join(storeLocator.wardenHome(env), "install-origin.json");
	}

	private readOrigins(env: Record<string, string | undefined>): Record<string, InstallOrigin> {
		const path = this.originFile(env);
		if (!existsSync(path)) return {};
		try {
			const data: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
			return Object.fromEntries(Object.entries(data).filter((entry) => entry[1] === "npm"));
		} catch {
			return {};
		}
	}

	installOrigin(env: Record<string, string | undefined>, binary: string): InstallOrigin | undefined {
		return this.readOrigins(env)[binary];
	}

	/** Record (or with `undefined`, forget) where the binary at `binary` came from. */
	recordInstallOrigin(
		env: Record<string, string | undefined>,
		binary: string,
		origin: InstallOrigin | undefined
	): void {
		const origins = this.readOrigins(env);
		if (origins[binary] === origin) return;
		if (origin) origins[binary] = origin;
		else delete origins[binary];
		const path = this.originFile(env);
		mkdirSync(storeLocator.wardenHome(env), { recursive: true });
		const tmp = `${path}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(origins, null, 2)}\n`);
		renameSync(tmp, path);
	}
}

export const installOriginHelpers = new InstallOriginHelpers();

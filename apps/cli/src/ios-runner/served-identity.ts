import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * The identity of a runner build is its derived-data directory: `<home>/ios-runner/<team>/<xcode build>-<sources hash>/dd`.
 * A resident `__ios-runner-host` writes the one it serves next to its socket; a client compares it with the one the
 * current sources and toolchain would build (`expectedRunnerIdentity`) and replaces a host that serves another.
 */
export function runnerIdentityPath(socketPath: string): string {
	return `${socketPath}.build.json`;
}

export function writeServedIdentity(socketPath: string, derivedData: string): void {
	writeFileSync(runnerIdentityPath(socketPath), JSON.stringify({ derivedData }));
}

/** The derived data the host on `socketPath` serves; undefined for no file (a host that predates identities) or a torn one. */
export function readServedIdentity(socketPath: string): string | undefined {
	try {
		const raw: unknown = JSON.parse(readFileSync(runnerIdentityPath(socketPath), "utf8"));
		if (typeof raw === "object" && raw !== null && "derivedData" in raw && typeof raw.derivedData === "string") {
			return raw.derivedData;
		}
	} catch {
		// absent or torn
	}
	return undefined;
}

export function removeServedIdentity(socketPath: string): void {
	try {
		if (existsSync(runnerIdentityPath(socketPath))) unlinkSync(runnerIdentityPath(socketPath));
	} catch {
		// already gone
	}
}

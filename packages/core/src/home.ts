import { homedir } from "node:os";
import { join } from "node:path";

/** `$WARDEN_HOME`, else `~/.warden` (the user's home directory when `HOME` is not set). */
export function wardenHome(env: Record<string, string | undefined> = process.env): string {
	if (env.WARDEN_HOME) return env.WARDEN_HOME;
	return join(env.HOME || homedir(), ".warden");
}

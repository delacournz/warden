import { readFileSync } from "node:fs";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { note, reportError } from "../output";
import { DEFAULT_API_URL } from "../remote/credentials";
import { runUplink, UPLINK_FINAL_CODES } from "./uplink";

export type UplinkFlags = { api?: string; tokenFile?: string };

const SCOPE = "host uplink";

/** The host token: `--token-file`, else `WARDEN_HOST_TOKEN` (never a flag value: argv is world-readable in ps). */
export function hostToken(env: Record<string, string | undefined>, tokenFile: string | undefined): Result<string> {
	if (tokenFile !== undefined) {
		try {
			const token = readFileSync(tokenFile, "utf8").trim();
			return token ? ok(token) : err(`--token-file ${tokenFile} is empty`);
		} catch (e) {
			return err(`--token-file ${tokenFile}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	const token = env.WARDEN_HOST_TOKEN?.trim();
	return token ? ok(token) : err("no host token: set WARDEN_HOST_TOKEN or pass --token-file <file>");
}

export function uplinkApi(env: Record<string, string | undefined>, api: string | undefined): string {
	return (api ?? env.WARDEN_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
}

/** `warden host uplink`: hold the uplink (redialling) until Ctrl-C / SIGTERM or warden-api ends it for good. */
export async function uplinkHost(ctx: CommandContext, flags: UplinkFlags): Promise<number> {
	const token = hostToken(ctx.env, flags.tokenFile);
	if (!token.success) {
		reportError(ctx, SCOPE, token.error);
		return 1;
	}
	const stop = new AbortController();
	const onSignal = () => stop.abort();
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	const { WARDEN_HOST_TOKEN: _, ...env } = ctx.env;
	try {
		const code = await runUplink({
			apiUrl: uplinkApi(ctx.env, flags.api),
			hostToken: token.data,
			env,
			signal: stop.signal,
			log: (line) => note(ctx, `${SCOPE}: ${line}`),
		});
		return UPLINK_FINAL_CODES.includes(code) ? 1 : 0;
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

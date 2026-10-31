import { err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { createWardenApi, type WardenApi } from "./api";
import { type Credentials, resolveAuth } from "./credentials";

/** A warden-api client that carries a token, and where that token came from. */
export type Authed = { api: WardenApi; apiUrl: string } & (
	| { source: "env" }
	| { source: "saved"; credentials: Credentials }
);

export const NOT_LOGGED_IN = "not logged in; run warden login (or set WARDEN_TOKEN)";

/** A client with no token (login endpoints only). */
export function anonApi(ctx: CommandContext, apiUrl: string): WardenApi {
	return createWardenApi({ baseUrl: apiUrl, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) });
}

/** The logged-in client for this command, or the message telling the user how to log in. */
export function authedApi(ctx: CommandContext): Result<Authed> {
	const auth = resolveAuth(ctx.env);
	if (!auth.success) return auth;
	const resolved = auth.data;
	const make = (token: string) =>
		createWardenApi({ baseUrl: resolved.apiUrl, token, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) });
	switch (resolved.kind) {
		case "none":
			return err(NOT_LOGGED_IN);
		case "env":
			return ok({ api: make(resolved.token), apiUrl: resolved.apiUrl, source: "env" });
		case "saved":
			return ok({
				api: make(resolved.credentials.token),
				apiUrl: resolved.apiUrl,
				source: "saved",
				credentials: resolved.credentials,
			});
	}
}

import { ok } from "@delacour/warden-types/result";
import { z } from "zod";
import { type DevtoolsFacet, type DevtoolsResult, devtoolsErr } from "./devtools.types";
import { ROUTE_EXPRESSION } from "./route.script";

const DEFAULT_TIMEOUT_MS = 2_000;

const replySchema = z.union([z.object({ error: z.string() }), z.object({ route: z.array(z.string()) })]);

/** Expo Router's own wrapper route; it is not a file. */
const ROOT = "__root";

/** The route names of the focused screens → the route key (`(tabs)/todos`); undefined when no screen is focused. */
export function routeKey(names: readonly string[]): string | undefined {
	const key = names.filter((name) => name !== ROOT).join("/");
	return key === "" ? undefined : key;
}

/**
 * The route key of the screen the app is on (see `route.script.ts`), through one synchronous `evaluate`.
 * `devtools_unavailable` for a build without the DevTools hook (release) or before a React root mounts.
 */
export async function readRoute(
	facet: Pick<DevtoolsFacet, "evaluate">,
	options: { timeoutMs?: number } = {}
): Promise<DevtoolsResult<string | undefined>> {
	const reply = await facet.evaluate(ROUTE_EXPRESSION, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
	if (!reply.success) return devtoolsErr(reply.error.code ?? "eval_failed", reply.error.message);
	let parsed: z.ZodSafeParseResult<z.infer<typeof replySchema>>;
	try {
		parsed = replySchema.safeParse(typeof reply.data === "string" ? JSON.parse(reply.data) : undefined);
	} catch {
		return devtoolsErr("cdp_protocol", "route script reply is not JSON");
	}
	if (!parsed.success) return devtoolsErr("cdp_protocol", "unexpected route script reply");
	if ("error" in parsed.data) {
		const hook = parsed.data.error === "no-hook" || parsed.data.error === "no-roots";
		return devtoolsErr(
			hook ? "devtools_unavailable" : "eval_failed",
			hook ? "no React DevTools hook or root (release build?)" : `route script failed: ${parsed.data.error}`
		);
	}
	return ok(routeKey(parsed.data.route));
}

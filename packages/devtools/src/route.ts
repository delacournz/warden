import { resultFactory } from "@delacour/warden-types/result";
import { z } from "zod";
import { type DevtoolsFacet, type DevtoolsResult, devtoolsErrors } from "./devtools.types";
import { ROUTE_EXPRESSION } from "./route.script";

const DEFAULT_TIMEOUT_MS = 2_000;

const replySchema = z.union([z.object({ error: z.string() }), z.object({ route: z.array(z.string()) })]);

/** Expo Router's own wrapper route; it is not a file. */
const ROOT = "__root";

/** Reads the focused route out of the app. Use the shared {@link routeReader} singleton. */
export class RouteReader {
	/** The route names of the focused screens → the route key (`(tabs)/todos`); undefined when no screen is focused. */
	key(names: readonly string[]): string | undefined {
		const key = names.filter((name) => name !== ROOT).join("/");
		return key === "" ? undefined : key;
	}

	/**
	 * The route key of the screen the app is on (see `route.script.ts`), through one synchronous `evaluate`.
	 * `devtools_unavailable` for a build without the DevTools hook (release) or before a React root mounts.
	 */
	async read(
		facet: Pick<DevtoolsFacet, "evaluate">,
		options: { timeoutMs?: number } = {}
	): Promise<DevtoolsResult<string | undefined>> {
		const reply = await facet.evaluate(ROUTE_EXPRESSION, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
		if (!reply.success) return devtoolsErrors.err(reply.error.code ?? "eval_failed", reply.error.message);
		let parsed: z.ZodSafeParseResult<z.infer<typeof replySchema>>;
		try {
			parsed = replySchema.safeParse(typeof reply.data === "string" ? JSON.parse(reply.data) : undefined);
		} catch {
			return devtoolsErrors.err("cdp_protocol", "route script reply is not JSON");
		}
		if (!parsed.success) return devtoolsErrors.err("cdp_protocol", "unexpected route script reply");
		if ("error" in parsed.data) {
			const hook = parsed.data.error === "no-hook" || parsed.data.error === "no-roots";
			return devtoolsErrors.err(
				hook ? "devtools_unavailable" : "eval_failed",
				hook ? "no React DevTools hook or root (release build?)" : `route script failed: ${parsed.data.error}`
			);
		}
		return resultFactory.ok(this.key(parsed.data.route));
	}
}

export const routeReader = new RouteReader();

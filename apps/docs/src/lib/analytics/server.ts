import { docsRoute } from "@/lib/shared";
import { ANALYTICS, isCountedHost, type PosthogConfig } from "./config";

/**
 * Server-side events, for the readers the browser SDK can never see.
 *
 * `/llms.txt`, `/llms-full.txt` and each page's `.md` twin are read by coding
 * agents, crawlers and `curl`, none of which run JavaScript, so PostHog's SDK
 * never loads for them. For a tool whose setup path is "hand this to your
 * agent", those reads are the traffic most worth counting. The request
 * middleware in `src/start.ts` reports each one here.
 */

export type AgentFetchKind = "llms" | "markdown";

type OnConfig = Extract<PosthogConfig, { kind: "on" }>;

/**
 * The user agent the events are sent with. PostHog's web analytics hides bot
 * traffic, which is every agent this exists to count, so the caller's own
 * agent travels in the event's `agent` property instead. `server.test.ts`
 * holds this string to passing a bot check.
 */
export const SERVER_USER_AGENT = "Mozilla/5.0 (compatible; warden-docs)";

/** Leaves room for `agent:` inside the 200 characters PostHog allows a `distinct_id`. */
const MAX_AGENT = 190;

export function agentFetch(pathname: string): AgentFetchKind | null {
	if (pathname === "/llms.txt" || pathname === "/llms-full.txt") return "llms";
	if (pathname.startsWith(`${docsRoute}/`) && pathname.endsWith(".md")) return "markdown";
	return null;
}

/** PostHog's single-event capture endpoint. */
export function captureUrl(posthog: OnConfig): string {
	return `${posthog.host}/i/v0/e/`;
}

/**
 * One `agent-fetch` event. The `distinct_id` is the agent itself, so PostHog's
 * unique-user counts read as distinct agents; `$process_person_profile: false`
 * keeps it from making a person of one. The request is the server's, so the
 * only address PostHog sees is the server's own, and `$geoip_disable` stops
 * it looking that one up as though it were the reader's.
 */
export function serverEventBody(posthog: OnConfig, request: Request, kind: AgentFetchKind) {
	const url = new URL(request.url);
	const language = request.headers.get("accept-language")?.split(",")[0]?.split(";")[0]?.trim() ?? "";
	const agent = (request.headers.get("user-agent") ?? "unknown").slice(0, MAX_AGENT);

	return {
		api_key: posthog.token,
		event: "agent-fetch",
		distinct_id: `agent:${agent}`,
		properties: {
			path: url.pathname,
			kind,
			agent,
			$current_url: `${url.origin}${url.pathname}`,
			$host: url.host,
			$pathname: url.pathname,
			$browser_language: language,
			$lib: "warden-docs",
			$process_person_profile: false,
			$geoip_disable: true,
		},
	} as const;
}

/**
 * Report an agent fetch, if this is one, PostHog is on, and the request
 * arrived on a counted host: the server's twin of the browser SDK's host
 * check, so a production build run on `localhost` never counts itself. Never
 * awaited and never throws: a slow or unreachable analytics host must not cost
 * the reader a millisecond. The visitor's IP is not forwarded.
 */
export function reportAgentFetch(request: Request, posthog: PosthogConfig = ANALYTICS.posthog): void {
	if (posthog.kind === "off") return;

	const url = new URL(request.url);
	if (!isCountedHost(url.host)) return;

	const kind = agentFetch(url.pathname);
	if (!kind) return;

	void fetch(captureUrl(posthog), {
		method: "POST",
		headers: { "content-type": "application/json", "user-agent": SERVER_USER_AGENT },
		body: JSON.stringify(serverEventBody(posthog, request, kind)),
	}).catch(() => {});
}

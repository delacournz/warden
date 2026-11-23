import { decodeMarkdownUrl, docsRoute, encodeMarkdownUrl } from "@/lib/shared";
import { ANALYTICS, isCountedHost, type PosthogConfig } from "./config";

/**
 * Server-side events, for the readers the browser SDK can never see.
 *
 * `/llms.txt`, `/llms-full.txt` and each page's `.md` twin are read by coding
 * agents, crawlers and `curl`, none of which run JavaScript, so PostHog's SDK
 * never loads for them. For a tool whose setup path is "hand this to your
 * agent", those reads are the traffic most worth counting. The request
 * middleware in `src/start.ts` reports each one here, once it has been answered.
 *
 * An event is built from fixed vocabularies only: the address is the page's own
 * (`/llms.txt`, or the `.md` twin of a page the site has), and the reader is a
 * label from `AGENT_BUCKETS`. Nothing the request spelled out is copied into it.
 */

export type AgentFetchKind = "llms" | "markdown";

/** What was read: its kind, and the one address the site gives it. */
export type AgentFetchTarget = { kind: AgentFetchKind; path: string };

/** The site's own slugs for the page these slugs name, or `null` when there is no such page. */
export type PageSlugs = (slugs: string[]) => readonly string[] | null;

type OnConfig = Extract<PosthogConfig, { kind: "on" }>;

/**
 * The user agent the events are sent with. PostHog's web analytics hides bot
 * traffic, which is every agent this exists to count, so the caller's label
 * travels in the event's `agent` property instead. `server.test.ts` holds this
 * string to passing a bot check.
 */
export const SERVER_USER_AGENT = "Mozilla/5.0 (compatible; warden-docs)";

/**
 * The programs an event can name, first match wins, so a specific name sits
 * above the family it belongs to. The label is what is sent; the header itself
 * never is. `/privacy` names this list, and `privacy.test.ts` holds it to that.
 */
export const AGENT_BUCKETS = [
	{ label: "claude-user", match: /claude-user/i },
	{ label: "claude-searchbot", match: /claude-searchbot/i },
	{ label: "claude-code", match: /claude-code|claude-cli/i },
	{ label: "claudebot", match: /claudebot|anthropic-ai/i },
	{ label: "chatgpt-user", match: /chatgpt-user/i },
	{ label: "oai-searchbot", match: /oai-searchbot/i },
	{ label: "gptbot", match: /gptbot/i },
	{ label: "perplexity", match: /perplexitybot|perplexity-user/i },
	{ label: "google-extended", match: /google-extended|google-cloudvertexbot|gemini/i },
	{ label: "googlebot", match: /googlebot|googleother/i },
	{ label: "bingbot", match: /bingbot/i },
	{ label: "applebot", match: /applebot/i },
	{ label: "amazonbot", match: /amazonbot/i },
	{ label: "meta-externalagent", match: /meta-externalagent|meta-externalfetcher/i },
	{ label: "bytespider", match: /bytespider/i },
	{ label: "ccbot", match: /ccbot/i },
	{ label: "duckassistbot", match: /duckassistbot|duckduckbot/i },
	{ label: "cursor", match: /cursor/i },
	{ label: "curl", match: /^curl\//i },
	{ label: "wget", match: /^wget\//i },
	{ label: "python", match: /python|aiohttp|httpx/i },
	{ label: "node", match: /^node|undici|axios|node-fetch|^got\b/i },
	{ label: "bun", match: /^bun\//i },
	{ label: "go", match: /go-http-client/i },
	{ label: "browser", match: /^mozilla\/(?!.*(bot|crawl|spider|compatible))/i },
] as const;

export type AgentBucket = (typeof AGENT_BUCKETS)[number]["label"] | "other";

/** Longer than any header a listed program sends; the rest of an oversized one is never read. */
const MAX_AGENT_SCAN = 512;

/** The label for a `User-Agent` header: one from `AGENT_BUCKETS`, else `other`. */
export function agentBucket(userAgent: string | null): AgentBucket {
	const agent = (userAgent ?? "").slice(0, MAX_AGENT_SCAN);
	return AGENT_BUCKETS.find((bucket) => bucket.match.test(agent))?.label ?? "other";
}

const LLMS_FILES: ReadonlySet<string> = new Set(["/llms.txt", "/llms-full.txt"]);

/**
 * What this pathname reads, if it is one of the agent-facing files: an llms
 * file, or the `.md` twin of a page `pageSlugs` knows. The path returned is
 * rebuilt from the page's slugs, so one page is always counted under one address.
 */
export function agentFetchTarget(pathname: string, pageSlugs: PageSlugs): AgentFetchTarget | null {
	if (LLMS_FILES.has(pathname)) return { kind: "llms", path: pathname };
	if (!pathname.startsWith(`${docsRoute}/`) || !pathname.endsWith(".md")) return null;

	let segments: string[];
	try {
		segments = pathname
			.slice(docsRoute.length + 1)
			.split("/")
			.map(decodeURIComponent);
	} catch {
		return null;
	}

	const slugs = pageSlugs(decodeMarkdownUrl(segments));
	return slugs ? { kind: "markdown", path: encodeMarkdownUrl([...slugs]) } : null;
}

/** PostHog's single-event capture endpoint. */
export function captureUrl(posthog: OnConfig): string {
	return `${posthog.host}/i/v0/e/`;
}

/**
 * One `agent-fetch` event. The `distinct_id` is the program's label, so
 * PostHog's unique-user counts read as distinct kinds of agent;
 * `$process_person_profile: false` keeps it from making a person of one. The
 * request is the server's, so the only address PostHog sees is the server's
 * own, and `$geoip_disable` stops it looking that one up as though it were the
 * reader's. Of the reader's request, only the host (a counted one) and the
 * label are used.
 */
export function serverEventBody(posthog: OnConfig, request: Request, target: AgentFetchTarget) {
	const url = new URL(request.url);
	const agent = agentBucket(request.headers.get("user-agent"));

	return {
		api_key: posthog.token,
		event: "agent-fetch",
		distinct_id: `agent:${agent}`,
		properties: {
			path: target.path,
			kind: target.kind,
			agent,
			$current_url: `${url.origin}${target.path}`,
			$host: url.host,
			$pathname: target.path,
			$lib: "warden-docs",
			site: "warden",
			surface: "server",
			$process_person_profile: false,
			$geoip_disable: true,
		},
	} as const;
}

/**
 * A fixed-window counter: `limit` yeses per `windowMs`, then no until the next
 * window opens. Held in memory, per server process; the clock is injected.
 */
export function createEventCap(options: { limit: number; windowMs: number; now?: () => number }): () => boolean {
	const now = options.now ?? Date.now;
	let windowStart = now();
	let count = 0;

	return () => {
		const time = now();
		if (time - windowStart >= options.windowMs) {
			windowStart = time;
			count = 0;
		}
		if (count >= options.limit) return false;
		count += 1;
		return true;
	};
}

/** The most events one server process sends: 120 a minute. Reads past it are served and not counted. */
const allowEvent = createEventCap({ limit: 120, windowMs: 60_000 });

export type AgentFetchDeps = {
	pageSlugs: PageSlugs;
	posthog?: PosthogConfig;
	allow?: () => boolean;
};

/**
 * Report an agent fetch, if this is one: a `GET` answered `200` for an llms
 * file or a known page's Markdown, with PostHog on, on a counted host (the
 * server's twin of the browser SDK's host check, so a production build run on
 * `localhost` never counts itself), and under the per-window cap. Never awaited
 * and never throws: a slow or unreachable analytics host must not cost the
 * reader a millisecond. The visitor's IP is not forwarded.
 */
export function reportAgentFetch(request: Request, response: Response, deps: AgentFetchDeps): void {
	const posthog = deps.posthog ?? ANALYTICS.posthog;
	if (posthog.kind === "off") return;
	if (request.method !== "GET" || response.status !== 200) return;

	const url = new URL(request.url);
	if (!isCountedHost(url.host)) return;

	const target = agentFetchTarget(url.pathname, deps.pageSlugs);
	if (!target) return;
	if (!(deps.allow ?? allowEvent)()) return;

	void fetch(captureUrl(posthog), {
		method: "POST",
		headers: { "content-type": "application/json", "user-agent": SERVER_USER_AGENT },
		body: JSON.stringify(serverEventBody(posthog, request, target)),
	}).catch(() => {});
}

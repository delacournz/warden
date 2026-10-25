import { isFileHref } from "@/lib/shared";

/**
 * Every custom event the site sends, as one union. A new event is a new member
 * here, so a call site cannot misspell a name or forget a property, and the
 * analytics dashboard's event list is this type, read top to bottom.
 *
 * `copy`: `command` is an install line, `agent-prompt` a block to paste into
 * an agent, `code` a Fumadocs code block, `markdown` a docs page's Markdown.
 */
export type AnalyticsEvent =
	| { name: "outbound"; url: string }
	| { name: "download"; file: string }
	| { name: "copy"; what: "command" | "agent-prompt" | "code" | "markdown" }
	| { name: "search"; query: string; results: number };

export type EventData = Record<string, string | number>;

/** The provider takes a name and a flat object; the union's discriminant is the name. */
export function eventPayload(event: AnalyticsEvent): { name: AnalyticsEvent["name"]; data: EventData } {
	const { name, ...data } = event;
	return { name, data };
}

/**
 * What a click on a link means, from its href alone. Another host is
 * outbound; a same-origin path whose last segment has an extension
 * (`/llms.txt`, a page's `.md` twin) is a download, by the same test
 * `isFileHref` uses to decide a link cannot go through the router. Everything
 * else is ordinary navigation that page views already count.
 */
export function classifyLink(href: string, page: string): AnalyticsEvent | null {
	let url: URL;
	try {
		url = new URL(href, page);
	} catch {
		return null;
	}

	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.host !== new URL(page).host) return { name: "outbound", url: url.href };
	if (isFileHref(url.pathname)) return { name: "download", file: url.pathname };
	return null;
}

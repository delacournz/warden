import { type AnalyticsEvent, classifyLink, eventPayload } from "./events";
import { posthogCapture } from "./posthog";

/**
 * Send one event to PostHog, if it is on this page. A build without the env
 * vars, a blocker, a script still loading: each makes this a no-op rather
 * than an error. Autocapture is off, so this is the only way a click reaches
 * PostHog and nothing is counted twice.
 */
export function track(event: AnalyticsEvent): void {
	if (typeof window === "undefined") return;
	const { name, data } = eventPayload(event);
	posthogCapture(name, data);
}

/**
 * Fumadocs' code-block copy button. It is Fumadocs' markup rather than ours, so
 * it is found by the label it renders; the site is English-only.
 */
const CODE_COPY = 'button[aria-label="Copy Text"]';

/** Fumadocs' "Copy Markdown" button in the docs toolbar, found the same way. */
const MARKDOWN_COPY = 'button[aria-label="Copy Markdown"]';

/**
 * One delegated listener for every link and Fumadocs copy button on the site.
 *
 * Scanning the DOM once on load and tagging each link misses every link an SPA
 * renders after its first navigation. A listener on `document` sees them all
 * without knowing when they appeared. Our own copy buttons (`CopyCommand`,
 * `CopyBlock`) call `track` themselves.
 *
 * Returns the cleanup for `useEffect`.
 */
export function installClickTracking(): () => void {
	const onClick = (event: MouseEvent) => {
		if (!(event.target instanceof Element)) return;

		if (event.target.closest(CODE_COPY)) {
			track({ name: "copy", what: "code" });
			return;
		}
		if (event.target.closest(MARKDOWN_COPY)) {
			track({ name: "copy", what: "markdown" });
			return;
		}

		const anchor = event.target.closest("a[href]");
		if (!anchor) return;

		const link = classifyLink(anchor.getAttribute("href") ?? "", window.location.href);
		if (link) track(link);
	};

	document.addEventListener("click", onClick, { capture: true });
	return () => document.removeEventListener("click", onClick, { capture: true });
}

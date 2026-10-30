import type { Tone } from "@/modules/showcase/utils/tones";
import { formatMs, median, type Sample } from "./samples";

/** What NetInfo reports, reduced to the fields the screen reads. */
export type LinkReading = {
	isConnected: boolean | null;
	isInternetReachable: boolean | null;
	type: string;
};

export type StateKind = "starting" | "paused" | "online" | "slow" | "unstable" | "failing" | "offline";

/** The screen's state: words for the hero, a link quality 0..3 for the glyph, a tone for colour. */
export type NetState = {
	kind: StateKind;
	title: string;
	body: string;
	quality: 0 | 1 | 2 | 3;
	tone: Tone;
};

/** Classification looks at this many of the latest requests. */
export const WINDOW = 6;
/** A median above this is a slow link. */
export const SLOW_MS = 600;
/** This many link changes inside the recent window mark the link unstable. */
export const UNSTABLE_LINK_CHANGES = 2;
/** Failures in a row on a link that is not confirmed reachable mean no route out. */
const OFFLINE_STREAK = 3;
const FAILING_STREAK = 2;

export type ClassifyInput = {
	samples: readonly Sample[];
	link: LinkReading;
	paused: boolean;
	/** Link changes seen in roughly the last ten seconds. */
	linkChangesInWindow: number;
};

function trailing(samples: readonly Sample[], ok: boolean): number {
	let n = 0;
	for (let i = samples.length - 1; i >= 0 && samples[i]?.ok === ok; i--) n += 1;
	return n;
}

function failingBody(last: Sample | undefined): string {
	if (!last || last.ok) return "Requests are not getting through.";
	if (last.reason === "timeout") return "Requests time out before an answer.";
	if (last.reason.startsWith("http")) return "The server answers with errors.";
	return "Connection reset by the network.";
}

function measure(input: ClassifyInput): NetState {
	const { link, linkChangesInWindow } = input;
	const recent = input.samples.slice(-WINDOW);
	const last = recent.at(-1);
	const okRun = trailing(recent, true);
	const failRun = trailing(recent, false);
	const linkDown = link.isConnected === false || link.isInternetReachable === false;

	if (linkDown && okRun === 0) {
		return { kind: "offline", title: "Offline", body: "No route out. Probes keep trying.", quality: 0, tone: "off" };
	}
	if (recent.length === 0) {
		return { kind: "starting", title: "Starting", body: "Sending the first request.", quality: 0, tone: "idle" };
	}
	if (failRun >= OFFLINE_STREAK && link.isInternetReachable !== true) {
		return { kind: "offline", title: "Offline", body: "No route out. Probes keep trying.", quality: 0, tone: "off" };
	}
	if (failRun >= FAILING_STREAK) {
		return { kind: "failing", title: "Requests failing", body: failingBody(last), quality: 1, tone: "warn" };
	}
	const failed = recent.filter((s) => !s.ok).length;
	if (failed > 0 && okRun < 2) {
		return {
			kind: "unstable",
			title: "Unstable",
			body: `${failed} of the last ${recent.length} requests failed.`,
			quality: 1,
			tone: "warn",
		};
	}
	const landed = recent.flatMap((s) => (s.ok ? [s.ms] : []));
	const mid = median(landed) ?? 0;
	if (linkChangesInWindow >= UNSTABLE_LINK_CHANGES) {
		return {
			kind: "unstable",
			title: "Unstable",
			body: `${linkChangesInWindow} link changes in the last 10 seconds.`,
			quality: 1,
			tone: "warn",
		};
	}
	if (mid > SLOW_MS) {
		return {
			kind: "slow",
			title: "Slow link",
			body: `Median ${formatMs(mid)}, every request still lands.`,
			quality: 2,
			tone: "scan",
		};
	}
	return {
		kind: "online",
		title: "Online",
		body: `Median ${formatMs(mid)} over the last ${recent.length} requests.`,
		quality: 3,
		tone: "open",
	};
}

/**
 * The state the hero shows, derived from the latest {@link WINDOW} requests and NetInfo. Measured requests outrank
 * NetInfo: a landed request beats a stale "unreachable" reading. `paused` changes the words and tone but leaves the
 * glyph on the last measured quality.
 */
export function classify(input: ClassifyInput): NetState {
	const measured = measure(input);
	if (!input.paused) return measured;
	return {
		kind: "paused",
		title: "Paused",
		body: "Probes stopped. Resume to measure again.",
		quality: measured.quality,
		tone: "idle",
	};
}

/** The `net-link` readout. */
export function linkText(link: LinkReading): string {
	if (link.isConnected === false) return "none";
	if (link.isConnected === null) return link.type;
	return `${link.type} · ${link.isInternetReachable === false ? "unreachable" : "connected"}`;
}

/** The short name of the link in a log line: its type, or `none`. */
export function linkLabel(link: LinkReading): string {
	return link.isConnected === false ? "none" : link.type;
}

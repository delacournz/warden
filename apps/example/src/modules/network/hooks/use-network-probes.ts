import { useNetInfo } from "@react-native-community/netinfo";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LogLine } from "@/modules/showcase/components/event-log";
import { classify, type LinkReading, linkLabel, type NetState } from "../utils/link-state";
import { ping } from "../utils/ping";
import { describeFailure, formatMs, pushSample, type Sample, STRIP_SIZE } from "../utils/samples";

/** A small known HTTPS download (1 KB), the same one the conditions screen fetches. */
export const PROBE_URL = "https://speed.cloudflare.com/__down?bytes=1000";

/** Gap between the end of one request and the start of the next. */
const INTERVAL_MS = 1500;
/** A request that has not answered by now is a failure. */
const TIMEOUT_MS = 4000;
/** The log keeps this many lines, newest first. */
const MAX_LOG = 6;
/** Link changes older than this stop counting towards Unstable. */
const LINK_WINDOW_MS = 10_000;

export type NetworkProbes = {
	state: NetState;
	link: LinkReading;
	samples: readonly Sample[];
	tally: { ok: number; failed: number };
	events: readonly LogLine[];
	paused: boolean;
	/** Increments each time a request is sent; the glyph pulses on it. */
	sent: number;
	toggle: () => void;
};

/**
 * The network showcase's data: one GET to {@link PROBE_URL} every 1.5 s while the screen is focused and not paused,
 * no retry, with the NetInfo link beside it. Every sample, tally count and log line is a measurement; the state is
 * derived from them by `classify`. Probes stop when the screen loses focus, so a backgrounded screen sends nothing.
 */
export function useNetworkProbes(): NetworkProbes {
	const netInfo = useNetInfo();
	const link = useMemo<LinkReading>(
		() => ({ isConnected: netInfo.isConnected, isInternetReachable: netInfo.isInternetReachable, type: netInfo.type }),
		[netInfo.isConnected, netInfo.isInternetReachable, netInfo.type]
	);
	const linkRef = useRef(link);
	linkRef.current = link;

	const [samples, setSamples] = useState<readonly Sample[]>([]);
	const [tally, setTally] = useState({ ok: 0, failed: 0 });
	const [events, setEvents] = useState<readonly LogLine[]>([]);
	const [linkChanges, setLinkChanges] = useState<readonly number[]>([]);
	const [paused, setPaused] = useState(false);
	const [sent, setSent] = useState(0);
	const mountedAt = useRef(Date.now());
	const nextId = useRef(1);

	const since = useCallback(() => Date.now() - mountedAt.current, []);
	const log = useCallback((line: LogLine) => {
		setEvents((prev) => [line, ...prev].slice(0, MAX_LOG));
	}, []);

	const label = linkLabel(link);
	const previousLabel = useRef(label);
	useEffect(() => {
		if (previousLabel.current === label) return;
		const at = since();
		log({ at, text: `link ${previousLabel.current} → ${label}`, tone: label === "none" ? "off" : "scan" });
		setLinkChanges((prev) => [...prev, at].slice(-8));
		previousLabel.current = label;
	}, [label, log, since]);

	const focused = useRef(false);
	const loop = useRef<ReturnType<typeof setTimeout> | null>(null);

	const send = useCallback(async () => {
		setSent((n) => n + 1);
		const result = await ping(PROBE_URL, { fetchImpl: fetch, timeoutMs: TIMEOUT_MS, now: Date.now });
		if (!focused.current) return;
		const at = since();
		const id = nextId.current++;
		const linkUp = linkRef.current.isConnected !== false && linkRef.current.isInternetReachable !== false;
		const sample: Sample = result.ok
			? { id, at, ok: true, ms: result.ms, status: result.status }
			: { id, at, ok: false, ms: result.ms, reason: describeFailure(result.error, result.status, linkUp) };
		setSamples((prev) => pushSample(prev, sample, STRIP_SIZE));
		setTally((prev) => (sample.ok ? { ...prev, ok: prev.ok + 1 } : { ...prev, failed: prev.failed + 1 }));
		log({
			at,
			text: sample.ok ? `GET ${sample.status} · ${formatMs(sample.ms)}` : `GET failed · ${sample.reason}`,
			tone: sample.ok ? "open" : "warn",
		});
	}, [log, since]);

	useFocusEffect(
		useCallback(() => {
			if (paused) return undefined;
			focused.current = true;
			let stopped = false;
			const tick = async () => {
				await send();
				if (stopped) return;
				loop.current = setTimeout(tick, INTERVAL_MS);
			};
			tick();
			return () => {
				stopped = true;
				focused.current = false;
				if (loop.current) clearTimeout(loop.current);
			};
		}, [paused, send])
	);

	const toggle = useCallback(() => {
		if (!paused) log({ at: since(), text: "probes paused", tone: "idle" });
		setPaused(!paused);
	}, [log, paused, since]);

	const recentChanges = linkChanges.filter((at) => since() - at <= LINK_WINDOW_MS).length;
	const state = classify({ samples, link, paused, linkChangesInWindow: recentChanges });

	return { state, link, samples, tally, events, paused, sent, toggle };
}

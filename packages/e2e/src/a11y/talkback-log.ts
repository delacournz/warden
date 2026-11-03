import type { SpokenLine } from "./a11y.types";

/**
 * What real TalkBack said, read from its verbose log (WDN-A11Y, A11Y-7). TalkBack logs every utterance as
 * `SpeechControllerImpl: Speaking fragment text="…", utteranceId=talkback_N, …, event=type:EVENT_TYPE_ACCESSIBILITY
 * subtype:<TYPE>` under tag `talkback` once its log level is VERBOSE. That level is a TalkBack developer setting that
 * only the settings UI can change (its pref is in private app data), so without it there are no such lines and the
 * speech comes from the focus event stream instead (see `screenReaderSpoken`). Verified on TalkBack 17, API 37.
 */

const FRAGMENT = /SpeechControllerImpl: Speaking fragment text="(.*)", utteranceId=(talkback_\d+), .*event=type:\w+/;
/** `logcat -v epoch` prefix: seconds.millis */
const EPOCH = /^\s*(\d+)\.(\d{3})\s/;

/** One-shot dump of TalkBack's log with epoch timestamps. */
export const TALKBACK_LOGCAT_ARGV: readonly string[] = ["logcat", "-d", "-v", "epoch", "-s", "talkback:V"];

export type TalkBackLogOptions = {
	/** `at` for a line with no epoch prefix */
	now: number;
	/** keep only lines after this epoch ms */
	since?: number;
};

/** The spoken fragments in `log`, in log order. */
export function parseTalkBackLog(log: string, opts: TalkBackLogOptions): SpokenLine[] {
	const lines: SpokenLine[] = [];
	for (const raw of log.split("\n")) {
		const match = FRAGMENT.exec(raw);
		if (match === null) continue;
		const stamp = EPOCH.exec(raw);
		const at = stamp === null ? opts.now : Number(stamp[1]) * 1000 + Number(stamp[2]);
		if (opts.since !== undefined && at <= opts.since) continue;
		lines.push({ text: match[1] ?? "", at, source: "talkback" });
	}
	return lines;
}

/** Is TalkBack's log level verbose, as far as this log can tell: it holds at least one spoken fragment. */
export function hasSpeechLines(log: string): boolean {
	return FRAGMENT.test(log);
}

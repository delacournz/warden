import { describe, expect, test } from "bun:test";
import { hasSpeechLines, parseTalkBackLog, TALKBACK_LOGCAT_ARGV } from "./talkback-log";

/** Lines captured from TalkBack 17 with verbose logging on (API 37 emulator), `logcat -s talkback:V`. */
const THREADTIME = [
	"10-30 14:56:31.900  5491  5491 V talkback: EventTypeViewAccessibilityFocusedFeedbackRule: ttsOutput={Network & internet. 4 of 28}",
	'10-30 14:56:31.922  5491  5491 V talkback: SpeechControllerImpl: Speaking fragment text="Network & internet. 4 of 28", utteranceId=talkback_6, TtsSpan=null, locale=null, event=type:EVENT_TYPE_ACCESSIBILITY subtype:TYPE_VIEW_ACCESSIBILITY_FOCUSED displayId:0 time:462103',
	'10-30 14:56:33.414  5491  5491 V talkback: SpeechControllerImpl: Speaking fragment text="Connected devices. 5 of 28", utteranceId=talkback_7, TtsSpan=null, locale=null, event=type:EVENT_TYPE_ACCESSIBILITY subtype:TYPE_VIEW_ACCESSIBILITY_FOCUSED displayId:0 time:463595',
	"10-30 14:56:33.500  5491  5491 E talkback: SpeechControllerImpl: TTS is not ready",
];

const EPOCH = [
	'1761836191.922  5491  5491 V talkback: SpeechControllerImpl: Speaking fragment text="Apps. 7 of 28", utteranceId=talkback_8, TtsSpan=null, locale=null, event=type:EVENT_TYPE_ACCESSIBILITY subtype:TYPE_VIEW_ACCESSIBILITY_FOCUSED displayId:0 time:465099',
	'1761836193.000  5491  5491 V talkback: SpeechControllerImpl: Speaking fragment text="Double-tap to activate", utteranceId=talkback_9, TtsSpan=null, locale=null, event=type:EVENT_TYPE_ACCESSIBILITY subtype:TYPE_VIEW_ACCESSIBILITY_FOCUSED displayId:0 time:466000',
];

describe("parseTalkBackLog", () => {
	test("reads the spoken fragments and nothing else", () => {
		const lines = parseTalkBackLog(THREADTIME.join("\n"), { now: 5_000 });
		expect(lines.map((l) => l.text)).toEqual(["Network & internet. 4 of 28", "Connected devices. 5 of 28"]);
		expect(lines.every((l) => l.source === "talkback")).toBe(true);
	});
	test("epoch timestamps become milliseconds; lines without one take the fallback", () => {
		const epoch = parseTalkBackLog(EPOCH.join("\n"), { now: 5_000 });
		expect(epoch.map((l) => l.at)).toEqual([1761836191922, 1761836193000]);
		const dated = parseTalkBackLog(THREADTIME.join("\n"), { now: 5_000 });
		expect(dated.map((l) => l.at)).toEqual([5_000, 5_000]);
	});
	test("an escaped quote in the text survives", () => {
		const line =
			'1.000  1  1 V talkback: SpeechControllerImpl: Speaking fragment text="Say "hi"", utteranceId=talkback_1, TtsSpan=null, event=type:EVENT_TYPE_ACCESSIBILITY subtype:TYPE_VIEW_FOCUSED';
		expect(parseTalkBackLog(line, { now: 0 })[0]?.text).toBe('Say "hi"');
	});
	test("empty and unrelated logs give nothing", () => {
		expect(parseTalkBackLog("", { now: 0 })).toEqual([]);
		expect(parseTalkBackLog("--------- beginning of main\n", { now: 0 })).toEqual([]);
	});
	test("since drops lines at or before it", () => {
		const lines = parseTalkBackLog(EPOCH.join("\n"), { now: 0, since: 1761836191922 });
		expect(lines.map((l) => l.text)).toEqual(["Double-tap to activate"]);
	});
});

describe("hasSpeechLines", () => {
	test("is verbose logging when a fragment is present", () => {
		expect(hasSpeechLines(THREADTIME.join("\n"))).toBe(true);
		expect(hasSpeechLines(THREADTIME[3] ?? "")).toBe(false);
	});
});

test("the logcat argv dumps epoch lines of the talkback tag", () => {
	expect(TALKBACK_LOGCAT_ARGV).toEqual(["logcat", "-d", "-v", "epoch", "-s", "talkback:V"]);
});

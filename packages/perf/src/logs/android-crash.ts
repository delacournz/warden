import { logcatParser } from "./logcat";

/** A crash or ANR read off an Android device. `atMs` is the device's zone-less wall clock (compare with `parseDeviceDate`). */
export type AndroidCrash = {
	kind: "crash" | "anr";
	process: string;
	pid?: number;
	at: string;
	atMs: number;
	/** exception line, ANR subject, or the fatal signal */
	reason: string;
	signal?: string;
	/** top 10 stack lines */
	frames: string[];
	firstAppFrame?: string;
	/** `logcat` or `dropbox:<tag>` */
	source: string;
};

const MAX_FRAMES = 10;

type Draft = Omit<AndroidCrash, "frames" | "firstAppFrame"> & { allFrames: string[]; native: boolean };

type LogEntry = NonNullable<ReturnType<typeof logcatParser.parseThreadtime>>;

const FATAL_SIGNAL = /Fatal signal \d+ \((SIG\w+)\).*?pid (\d+) \(([^)]+)\)/;

type CrashScan = { crashes: AndroidCrash[]; draft: Draft | undefined };

const SEPARATOR = /^={10,}\s*$/m;
const DROPBOX_HEADER = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) (\S+) \(/;

export class AndroidCrashParser {
	private finish(
		c: Omit<AndroidCrash, "frames" | "firstAppFrame"> & { allFrames: string[] },
		pkg?: string
	): AndroidCrash {
		const { allFrames, ...rest } = c;
		const app = allFrames.find((f) => (pkg ?? rest.process) !== "" && f.includes(pkg ?? rest.process));
		return { ...rest, frames: allFrames.slice(0, MAX_FRAMES), ...(app !== undefined ? { firstAppFrame: app } : {}) };
	}

	/** A draft opened by a Java `FATAL EXCEPTION` line. */
	private javaDraft(e: LogEntry): Draft {
		return {
			kind: "crash",
			process: "",
			pid: e.pid,
			at: e.ts,
			atMs: e.tsMs,
			reason: "",
			allFrames: [],
			source: "logcat",
			native: false,
		};
	}

	/** A draft opened by a native `Fatal signal` line. */
	private nativeDraft(fatal: RegExpExecArray, e: LogEntry): Draft {
		return {
			kind: "crash",
			process: fatal[3] ?? "",
			pid: Number(fatal[2]),
			at: e.ts,
			atMs: e.tsMs,
			reason: e.msg.trim(),
			signal: fatal[1] ?? "",
			allFrames: [],
			source: "logcat",
			native: true,
		};
	}

	/** Fold an `AndroidRuntime` line into the open Java draft: process, a stack frame, or the first message as the reason. */
	private addJavaLine(draft: Draft, e: LogEntry): void {
		if (draft.native || draft.pid !== e.pid) return;
		const proc = /^Process:\s*([^,\s]+)(?:,\s*PID:\s*(\d+))?/.exec(e.msg);
		if (proc) {
			draft.process = proc[1] ?? "";
			return;
		}
		const frame = /^\s*at\s+(.+)$/.exec(e.msg);
		if (frame) draft.allFrames.push(frame[1] ?? "");
		else if (draft.reason === "" && e.msg.trim() !== "") draft.reason = e.msg.trim();
	}

	/** Fold a `DEBUG` backtrace line into the open native draft. */
	private addNativeFrame(draft: Draft, e: LogEntry): void {
		const bt = /^\s*#\d+\s+pc\s+[0-9a-f]+\s+(.+)$/.exec(e.msg);
		if (bt) draft.allFrames.push(bt[1] ?? "");
	}

	/** Close the open draft, if any, into a finished crash. */
	private flushDraft(scan: CrashScan): void {
		if (scan.draft === undefined) return;
		const { native: _native, ...rest } = scan.draft;
		scan.crashes.push(this.finish(rest));
		scan.draft = undefined;
	}

	/** Fold one logcat entry into the scan: open, extend or close a draft. */
	private scanEntry(scan: CrashScan, e: LogEntry): void {
		if (e.tag === "AndroidRuntime") {
			if (e.msg.startsWith("FATAL EXCEPTION")) {
				this.flushDraft(scan);
				scan.draft = this.javaDraft(e);
			} else if (scan.draft !== undefined) this.addJavaLine(scan.draft, e);
			return;
		}
		const fatal = FATAL_SIGNAL.exec(e.msg);
		if (e.tag === "libc" && fatal) {
			this.flushDraft(scan);
			scan.draft = this.nativeDraft(fatal, e);
			return;
		}
		if (e.tag === "DEBUG" && scan.draft?.native) {
			this.addNativeFrame(scan.draft, e);
			return;
		}
		this.flushDraft(scan);
	}

	/**
	 * Crashes in `logcat -b crash -d -v threadtime`: Java `FATAL EXCEPTION` blocks (`AndroidRuntime`) and native
	 * `Fatal signal N` lines with their `DEBUG` backtrace. Tombstone files themselves are not read.
	 */
	parseCrashBuffer(text: string, year: number): AndroidCrash[] {
		const scan: CrashScan = { crashes: [], draft: undefined };
		for (const raw of text.split("\n")) {
			const e = logcatParser.parseThreadtime(raw, year);
			if (e !== undefined) this.scanEntry(scan, e);
		}
		this.flushDraft(scan);
		return scan.crashes;
	}

	/** The `Key: value` header lines before the first blank line of a dropbox entry. */
	private dropboxHeaders(headerLines: string[]): Map<string, string> {
		const headers = new Map<string, string>();
		for (const line of headerLines) {
			const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
			if (kv?.[1]) headers.set(kv[1], kv[2] ?? "");
		}
		return headers;
	}

	/** One dropbox entry as a crash; none when the chunk has no dated header line. */
	private parseDropboxChunk(chunk: string): AndroidCrash[] {
		const lines = chunk.replace(/\r/g, "").split("\n");
		const start = lines.findIndex((l) => DROPBOX_HEADER.test(l));
		const m = start < 0 ? null : DROPBOX_HEADER.exec(lines[start] ?? "");
		if (!m) return [];
		const [, y, mo, d, h, mi, s, tag] = m;
		const rest = lines.slice(start + 1);
		const blank = rest.findIndex((l) => l.trim() === "");
		const headers = this.dropboxHeaders(rest.slice(0, blank < 0 ? rest.length : blank));
		const body = blank < 0 ? [] : rest.slice(blank + 1);
		const isAnr = tag?.includes("anr") === true;
		const process = headers.get("Process") ?? "";
		const reason = isAnr
			? (headers.get("Subject") ?? "ANR")
			: (body.find((l) => l.trim() !== "" && !/^\s+at\s/.test(l))?.trim() ?? "");
		const frames = body.flatMap((l) => {
			const f = /^\s+at\s+(.+)$/.exec(l);
			return f?.[1] ? [f[1]] : [];
		});
		const pid = headers.get("PID");
		return [
			this.finish(
				{
					kind: isAnr ? "anr" : "crash",
					process,
					...(pid !== undefined && /^\d+$/.test(pid) ? { pid: Number(pid) } : {}),
					at: `${y}-${mo}-${d} ${h}:${mi}:${s}`,
					atMs: Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
					reason,
					allFrames: frames,
					source: `dropbox:${tag}`,
				},
				process
			),
		];
	}

	/** `dumpsys dropbox --print data_app_crash|data_app_anr`: entries split by `====` lines, headers then body. */
	parseDropbox(text: string): AndroidCrash[] {
		return text.split(SEPARATOR).flatMap(this.parseDropboxChunk.bind(this));
	}
}

export const androidCrashParser = new AndroidCrashParser();

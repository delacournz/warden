import { parseThreadtime } from "./logcat";

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

function finish(
	c: Omit<AndroidCrash, "frames" | "firstAppFrame"> & { allFrames: string[] },
	pkg?: string
): AndroidCrash {
	const { allFrames, ...rest } = c;
	const app = allFrames.find((f) => (pkg ?? rest.process) !== "" && f.includes(pkg ?? rest.process));
	return { ...rest, frames: allFrames.slice(0, MAX_FRAMES), ...(app !== undefined ? { firstAppFrame: app } : {}) };
}

type Draft = Omit<AndroidCrash, "frames" | "firstAppFrame"> & { allFrames: string[]; native: boolean };

/**
 * Crashes in `logcat -b crash -d -v threadtime`: Java `FATAL EXCEPTION` blocks (`AndroidRuntime`) and native
 * `Fatal signal N` lines with their `DEBUG` backtrace. Tombstone files themselves are not read.
 */
export function parseCrashBuffer(text: string, year: number): AndroidCrash[] {
	const crashes: AndroidCrash[] = [];
	let draft: Draft | undefined;
	const flush = () => {
		if (draft !== undefined) {
			const { native: _native, ...rest } = draft;
			crashes.push(finish(rest));
			draft = undefined;
		}
	};
	for (const raw of text.split("\n")) {
		const e = parseThreadtime(raw, year);
		if (e === undefined) continue;
		if (e.tag === "AndroidRuntime") {
			if (e.msg.startsWith("FATAL EXCEPTION")) {
				flush();
				draft = {
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
				continue;
			}
			if (draft === undefined || draft.native || draft.pid !== e.pid) continue;
			const proc = /^Process:\s*([^,\s]+)(?:,\s*PID:\s*(\d+))?/.exec(e.msg);
			if (proc) {
				draft.process = proc[1] ?? "";
				continue;
			}
			const frame = /^\s*at\s+(.+)$/.exec(e.msg);
			if (frame) draft.allFrames.push(frame[1] ?? "");
			else if (draft.reason === "" && e.msg.trim() !== "") draft.reason = e.msg.trim();
			continue;
		}
		const fatal = /Fatal signal \d+ \((SIG\w+)\).*?pid (\d+) \(([^)]+)\)/.exec(e.msg);
		if (e.tag === "libc" && fatal) {
			flush();
			draft = {
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
			continue;
		}
		if (e.tag === "DEBUG" && draft?.native) {
			const bt = /^\s*#\d+\s+pc\s+[0-9a-f]+\s+(.+)$/.exec(e.msg);
			if (bt) draft.allFrames.push(bt[1] ?? "");
			continue;
		}
		flush();
	}
	flush();
	return crashes;
}

const SEPARATOR = /^={10,}\s*$/m;
const DROPBOX_HEADER = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) (\S+) \(/;

/** `dumpsys dropbox --print data_app_crash|data_app_anr`: entries split by `====` lines, headers then body. */
export function parseDropbox(text: string): AndroidCrash[] {
	return text.split(SEPARATOR).flatMap((chunk) => {
		const lines = chunk.replace(/\r/g, "").split("\n");
		const start = lines.findIndex((l) => DROPBOX_HEADER.test(l));
		const m = start < 0 ? null : DROPBOX_HEADER.exec(lines[start] ?? "");
		if (!m) return [];
		const [, y, mo, d, h, mi, s, tag] = m;
		const rest = lines.slice(start + 1);
		const blank = rest.findIndex((l) => l.trim() === "");
		const headers = new Map<string, string>();
		for (const line of rest.slice(0, blank < 0 ? rest.length : blank)) {
			const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
			if (kv?.[1]) headers.set(kv[1], kv[2] ?? "");
		}
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
			finish(
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
	});
}

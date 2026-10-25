import { err, ok, type Result } from "@delacour/warden-types/result";

export type LaunchState = "COLD" | "WARM" | "HOT";

/** What `am start -W` printed. `totalMs` is the time to the first frame; `waitMs` also counts the system's own wait. */
export type AmStart = {
	launchState?: LaunchState;
	activity?: string;
	totalMs: number;
	waitMs?: number;
	thisMs?: number;
};

const intField = (text: string, name: string): number | undefined => {
	const m = new RegExp(`^${name}:\\s*(\\d+)\\s*$`, "m").exec(text);
	return m?.[1] === undefined ? undefined : Number(m[1]);
};

/** Parse `am start -W` output: needs `Status: ok` and a `TotalTime` (falls back to `WaitTime`). The error text is the failure message. */
export function parseAmStart(stdout: string): Result<AmStart, string> {
	const status = /^Status:\s*(\S+)/m.exec(stdout)?.[1];
	if (status !== undefined && status !== "ok") return err(`am start reported Status: ${status}`);
	const error = /^Error(?: type \d+|:.*)$/m.exec(stdout);
	if (error) {
		const detail = /^Error:\s*(.+)$/m.exec(stdout)?.[1];
		return err(detail ?? `am start failed: ${error[0]}`);
	}
	const total = intField(stdout, "TotalTime") ?? intField(stdout, "WaitTime");
	if (total === undefined) return err("am start printed no TotalTime (was -W given?)");
	const state = /^LaunchState:\s*(COLD|WARM|HOT)\s*$/m.exec(stdout)?.[1] as LaunchState | undefined;
	const activity = /^Activity:\s*(\S+)/m.exec(stdout)?.[1];
	const wait = intField(stdout, "WaitTime");
	const thisTime = intField(stdout, "ThisTime");
	return ok({
		totalMs: total,
		...(state !== undefined ? { launchState: state } : {}),
		...(activity !== undefined ? { activity } : {}),
		...(wait !== undefined ? { waitMs: wait } : {}),
		...(thisTime !== undefined ? { thisMs: thisTime } : {}),
	});
}

/** `cmd package resolve-activity --brief <pkg>`: the last line is `pkg/.Activity` ("No activity found" otherwise). */
export function parseResolveActivity(stdout: string): string | undefined {
	const last = stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "")
		.pop();
	return last !== undefined && /^[\w.]+\/[\w.$]+$/.test(last) ? last : undefined;
}

export const resolveActivityArgv = (appId: string): string[] => [
	"shell",
	"cmd",
	"package",
	"resolve-activity",
	"--brief",
	appId,
];

/** `am start -W [-S] -n <component>`: `-S` force-stops the app first (cold). */
export const amStartArgv = (component: string, cold: boolean): string[] => [
	"shell",
	"am",
	"start",
	"-W",
	...(cold ? ["-S"] : []),
	"-n",
	component,
];

/** An app's own `reportFullyDrawn()` as the system logged it. */
export type FullyDrawn = { component: string; ms: number };

/** `+1m2s5ms` / `+3s641ms` / `+620ms` → milliseconds. */
function parseDuration(text: string): number | undefined {
	const m = /^\+(?:(\d+)m(?!s))?(?:(\d+)s)?(?:(\d+)ms)?/.exec(text);
	if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return undefined;
	return Number(m[1] ?? 0) * 60_000 + Number(m[2] ?? 0) * 1000 + Number(m[3] ?? 0);
}

/** `Fully drawn <component>: +3s641ms` lines of `logcat -d -s ActivityTaskManager`, oldest first. */
export function parseFullyDrawn(logcat: string): FullyDrawn[] {
	const out: FullyDrawn[] = [];
	for (const line of logcat.split("\n")) {
		const m = /Fully drawn (\S+): (\+\S+)/.exec(line);
		const ms = m?.[2] === undefined ? undefined : parseDuration(m[2]);
		if (m?.[1] !== undefined && ms !== undefined) out.push({ component: m[1], ms });
	}
	return out;
}

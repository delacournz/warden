/** Where Perfetto (running as shell) may write on the device. */
export const REMOTE_TRACE_DIR = "/data/misc/perfetto-traces";
/** simpleperf output goes to a place `shell` always owns. */
export const REMOTE_TMP_DIR = "/data/local/tmp";

/** Sampling rate `simpleperf record` is asked for (`-f`), so sample counts convert to CPU time. */
export const SIMPLEPERF_HZ = 4000;

export const remoteTracePath = (ts: number): string => `${REMOTE_TRACE_DIR}/warden-${ts}.pftrace`;
export const remoteSimpleperfPath = (ts: number): string => `${REMOTE_TMP_DIR}/warden-${ts}.data`;

type Adb = { adb: string; serial: string };
const shell = ({ adb, serial }: Adb, ...args: string[]): string[] => [adb, "-s", serial, "shell", ...args];

/** Starts Perfetto with the config on stdin. `--background-wait` returns once tracing runs and prints the daemon pid. */
export function perfettoStartArgv(a: Adb, remote: string): string[] {
	return shell(a, "perfetto", "--txt", "-c", "-", "--background-wait", "-o", remote);
}

/** The pid `perfetto --background-wait` prints (alone on a line), or undefined. */
export function parsePerfettoPid(output: string): number | undefined {
	const m = /^\s*(\d+)\s*$/m.exec(output);
	return m?.[1] === undefined ? undefined : Number(m[1]);
}

/**
 * `simpleperf record` sampling one pid, detached (`nohup`) and capped by `--duration`; prints the background pid.
 * Runs through the device shell, so the line is one `sh -c` string.
 */
export function simpleperfStartArgv(a: Adb, pid: number, remote: string, maxDurationMs: number): string[] {
	const seconds = Math.max(1, Math.ceil(maxDurationMs / 1000));
	return shell(
		a,
		`nohup simpleperf record -e cpu-clock:u -f ${SIMPLEPERF_HZ} -p ${pid} --duration ${seconds} -o ${remote} >/dev/null 2>&1 & echo $!`
	);
}

export const killArgv = (a: Adb, pid: number, signal: "INT" | "TERM" | "KILL"): string[] =>
	shell(a, "kill", `-${signal}`, String(pid));

/** Exit 0 while `/proc/<pid>` exists. */
export const aliveArgv = (a: Adb, pid: number): string[] => shell(a, "test", "-d", `/proc/${pid}`);

export const pullArgv = ({ adb, serial }: Adb, remote: string, local: string): string[] => [
	adb,
	"-s",
	serial,
	"pull",
	remote,
	local,
];

export const removeArgv = (a: Adb, remote: string): string[] => shell(a, "rm", "-f", remote);

export const simpleperfReportArgv = (a: Adb, remote: string): string[] =>
	shell(a, "simpleperf", "report", "-i", remote, "--stdio", "--sort", "comm,dso,symbol");

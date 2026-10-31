import type { RouteDeps } from "./route";
import type { RunnerArtifacts, RunnerProcess } from "./types";

export const UDID = "00008140-000A0B0C0D0E0F10";
export const ARTIFACTS: RunnerArtifacts = {
	xctestrun: "/cache/WardenRunner.xctestrun",
	derivedData: "/cache/dd",
	bundleId: "nz.co.delacour.warden.runner.abc",
};

/** A scripted `xcodebuild`: tests push output lines and decide when it exits. SIGTERM ends it with 143 unless `ignoreTerm`. */
export type FakeProc = RunnerProcess & {
	cmd: readonly string[];
	env: Readonly<Record<string, string>>;
	signals: string[];
	emit(line: string, stream?: "stdout" | "stderr"): void;
	exit(code: number): void;
};

export function fakeProc(cmd: readonly string[], env: Readonly<Record<string, string>>, ignoreTerm = false): FakeProc {
	const encoder = new TextEncoder();
	let out: ReadableStreamDefaultController<Uint8Array> | undefined;
	let errc: ReadableStreamDefaultController<Uint8Array> | undefined;
	const stdout = new ReadableStream<Uint8Array>({
		start: (c) => {
			out = c;
		},
	});
	const stderr = new ReadableStream<Uint8Array>({
		start: (c) => {
			errc = c;
		},
	});
	let finish: (code: number) => void = () => undefined;
	const exited = new Promise<number>((resolve) => {
		finish = resolve;
	});
	let done = false;
	const proc: FakeProc = {
		cmd,
		env,
		signals: [],
		stdout,
		stderr,
		exited,
		emit: (line, stream = "stdout") => (stream === "stdout" ? out : errc)?.enqueue(encoder.encode(`${line}\n`)),
		exit: (code) => {
			if (done) return;
			done = true;
			out?.close();
			errc?.close();
			finish(code);
		},
		kill: (signal) => {
			proc.signals.push(signal);
			if (signal === "SIGKILL" || !ignoreTerm) proc.exit(signal === "SIGKILL" ? 137 : 143);
		},
	};
	return proc;
}

export const READY_LINE = 'WARDEN_RUNNER_READY {"event":"ready","port":50123,"udid":"x"}';

/** A tunnel that reports the given `[state, ip]` per `devicectl` read, then repeats the last. */
export function fakeRoute(reads: Array<[state: string, ip?: string]>): { deps: RouteDeps; reads: () => number } {
	let n = 0;
	let t = 0;
	return {
		reads: () => n,
		deps: {
			list: async () => {
				const [state, ip] = reads[Math.min(n++, reads.length - 1)] ?? ["disconnected"];
				return {
					success: true as const,
					data: {
						result: {
							devices: [
								{
									hardwareProperties: { udid: UDID, reality: "physical" },
									connectionProperties: { tunnelState: state, ...(ip !== undefined ? { tunnelIPAddress: ip } : {}) },
								},
							],
						},
					},
				};
			},
			sleep: async (ms) => {
				t += ms;
			},
			now: () => t,
		},
	};
}

/** Timers that fire only when a test calls `fire`. */
export function manualTimers() {
	const pending = new Map<number, { ms: number; fn: () => void }>();
	let next = 0;
	return {
		after: (ms: number, fn: () => void) => {
			const id = next++;
			pending.set(id, { ms, fn });
			return () => void pending.delete(id);
		},
		fire: (ms: number) => {
			for (const [id, timer] of [...pending]) {
				if (timer.ms === ms) {
					pending.delete(id);
					timer.fn();
				}
			}
		},
		pending: () => [...pending.values()].map((t) => t.ms),
	};
}

export async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Bun.sleep(0);
}

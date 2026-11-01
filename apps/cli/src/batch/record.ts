/** A running recording: `startedAt` = epoch ms the first frame was captured; `stop` finalizes the file. */
export type Recording = { startedAt: number; stop: () => Promise<number> };

const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 15_000;

export class BatchRecord {
	/** `--record`: one `simctl io recordVideo` per leased iOS simulator. */

	/** Recording file of worker `i`, relative to the record dir (the `batch.json` contract). */
	videoName(worker: number): string {
		return `dev-${worker}.mp4`;
	}

	recordArgv(udid: string, path: string): string[] {
		return ["xcrun", "simctl", "io", udid, "recordVideo", "--codec", "h264", "--force", path];
	}

	/**
	 * Start `simctl io <udid> recordVideo` and wait for it to report "Recording started" (or give up
	 * after 10s and assume it has). `stop` sends SIGINT and waits for exit so the mp4 is finalized
	 * (SIGKILL after 15s).
	 */
	async startSimRecording(udid: string, path: string, now: () => number): Promise<Recording> {
		const proc = Bun.spawn(this.recordArgv(udid, path), { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
		const started = await new Promise<number>((resolve) => {
			const timer = setTimeout(() => resolve(now()), START_TIMEOUT_MS);
			const done = (at: number) => {
				clearTimeout(timer);
				resolve(at);
			};
			// keep draining stderr after the marker so simctl never hits a closed pipe before finalizing
			void (async () => {
				const decoder = new TextDecoder();
				let seen = "";
				for await (const chunk of proc.stderr) {
					if (seen.length < 4096) seen += decoder.decode(chunk, { stream: true });
					if (/recording started/i.test(seen)) done(now());
				}
				done(now());
			})();
			void proc.exited.then(() => done(now()));
		});
		return {
			startedAt: started,
			stop: async () => {
				if (proc.exitCode !== null) return proc.exitCode;
				proc.kill("SIGINT");
				const timer = setTimeout(() => proc.kill("SIGKILL"), STOP_TIMEOUT_MS);
				try {
					return await proc.exited;
				} finally {
					clearTimeout(timer);
				}
			},
		};
	}
}

export const batchRecord = new BatchRecord();

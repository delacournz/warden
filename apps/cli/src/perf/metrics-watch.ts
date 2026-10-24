import type { MetricSample } from "@delacour/warden-perf/metrics/series";
import type { FrameRateSource } from "./metrics-sampler";
import { eraseLines, renderWatch, type WatchFrame } from "./render-spark";

/** What a `perf metrics` run reaches the terminal and the clock through; tests inject fakes. */
export type MetricsIo = {
	/** wait `ms`, or until `signal` aborts */
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	/** aborted by Ctrl-C */
	signal: AbortSignal;
	/** raw write to stderr (the live display); stdout stays clean for the result */
	write: (chunk: string) => void;
	/** an fps source (Android gfxinfo, from the frames phase); the fps sparkline is drawn only when one is given */
	fps?: FrameRateSource | undefined;
	dispose?: () => void;
};

/** Real timers, stderr, and a SIGINT handler that ends the run cleanly (so the summary still prints, exit 130). */
export function defaultMetricsIo(): MetricsIo {
	const abort = new AbortController();
	const onSigint = () => abort.abort();
	process.once("SIGINT", onSigint);
	return {
		signal: abort.signal,
		write: (chunk) => {
			process.stderr.write(chunk);
		},
		sleep: (ms, signal) =>
			new Promise<void>((resolve) => {
				const finish = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", finish);
					resolve();
				};
				const timer = setTimeout(finish, ms);
				signal.addEventListener("abort", finish, { once: true });
			}),
		dispose: () => {
			process.off("SIGINT", onSigint);
		},
	};
}

const KB_PER_MB = 1024;

/** The sparkline rows for the samples so far: cpu, memory (PSS when the platform has it, else RSS), and fps when a source feeds it. */
export function buildFrame(title: string, samples: readonly MetricSample[], withFps: boolean): WatchFrame {
	const last = samples[samples.length - 1];
	const usePss = samples.length > 0 && samples.every((s) => s.pssKb !== undefined);
	return {
		title,
		elapsedMs: last?.atMs ?? 0,
		rows: [
			{ label: "cpu", unit: "%", floor: "zero", values: samples.flatMap((s) => s.cpuPct ?? []) },
			{
				label: usePss ? "pss" : "rss",
				unit: "MB",
				floor: "min",
				values: samples.map((s) => (usePss ? (s.pssKb ?? 0) : s.rssKb) / KB_PER_MB),
			},
			...(withFps
				? [{ label: "fps", unit: "fps" as const, floor: "zero" as const, values: samples.flatMap((s) => s.fps ?? []) }]
				: []),
		],
	};
}

/** Redraws the frame in place on stderr: erase the previous one, write the new. */
export function createRedraw(io: Pick<MetricsIo, "write">, columns: number, dim: (text: string) => string) {
	let drawn = 0;
	return (frame: WatchFrame): void => {
		const lines = renderWatch(frame, columns, dim);
		io.write(`${eraseLines(drawn)}${lines.join("\n")}\n`);
		drawn = lines.length;
	};
}

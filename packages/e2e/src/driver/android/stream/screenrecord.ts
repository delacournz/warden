import { type AccessUnit, AnnexBSplitter, AuFlag } from "./au-framing";

export type Size = { width: number; height: number };

/** `wm size`: the override size when one is set, else the physical size. */
export function parseWmSize(stdout: string): Size | undefined {
	const read = (label: string) => {
		const match = new RegExp(`${label} size:\\s*(\\d+)x(\\d+)`).exec(stdout);
		return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
	};
	return read("Override") ?? read("Physical");
}

/**
 * What `screenrecord` encodes: half the display (the guest's encoder reaches ~30 fps at half size and ~13 at full),
 * then the long side capped at `maxEdge` (0 = no cap), aspect kept, both sides even.
 */
export function screenrecordSize(display: Size, maxEdge: number): Size {
	const half = { width: display.width / 2, height: display.height / 2 };
	const long = Math.max(half.width, half.height);
	const scale = maxEdge > 0 && long > maxEdge ? maxEdge / long : 1;
	const even = (value: number) => Math.max(2, Math.floor(value * scale) & ~1);
	return { width: even(half.width), height: even(half.height) };
}

/** `adb exec-out screenrecord` writing raw Annex-B H.264 to stdout. */
export function screenrecordArgv(
	adb: string,
	serial: string,
	size: Size,
	bitrate: number,
	timeLimitS: number
): string[] {
	return [
		adb,
		"-s",
		serial,
		"exec-out",
		"screenrecord",
		"--output-format=h264",
		"--size",
		`${size.width}x${size.height}`,
		"--bit-rate",
		String(bitrate),
		"--time-limit",
		String(timeLimitS),
		"-",
	];
}

/** A running recorder (`Bun.spawn` fits). */
export type RecorderProcess = { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void };

export type ScreenrecordSourceOptions = {
	argv: readonly string[];
	spawn: (argv: readonly string[]) => RecorderProcess;
	onUnit: (unit: AccessUnit) => void;
	/** replace the recorder this long after it started, before `screenrecord`'s 3 min cap (default 170 s) */
	restartAfterMs?: number;
	/**
	 * a recorder quiet this long has written a whole frame: drain it (default 8 ms; a keyframe larger than one pipe read
	 * arrives in pieces, which a loaded host can space a few ms apart)
	 */
	idleDrainMs?: number;
	now?: () => number;
	log?: (line: string) => void;
};

export type ScreenrecordStats = {
	recorders: number;
	restarts: number;
	units: number;
	keyframes: number;
	splitErrors: number;
	exits: number;
	/** the idle wait before a drain, doubled (to 40 ms) after each frame a drain cut short */
	idleDrainMs: number;
};

const MAX_IDLE_DRAIN_MS = 40;

export type ScreenrecordSource = {
	/** the next unit is an IDR: a fresh recorder starts with one (`screenrecord` has no on-demand keyframe) */
	requestKeyframe(): void;
	stats(): ScreenrecordStats;
	stop(): void;
};

const DEFAULT_RESTART_AFTER_MS = 170_000;

type Recorder = {
	process: RecorderProcess;
	splitter: AnnexBSplitter;
	/** its first IDR arrived: it may replace the live one */
	keyed: boolean;
	drainTimer?: ReturnType<typeof setTimeout>;
	killed: boolean;
};

/**
 * The `screenrecord` path (an emulator without gRPC, and every physical phone): raw H.264 split into access units.
 * `screenrecord` stops after 3 minutes and cannot be asked for a keyframe, so both are a second recorder started
 * beside the live one: the live one keeps streaming until the new one's first IDR arrives, then the new one takes
 * over and the old one is killed, so the stream switches on a keyframe with no gap.
 */
export function startScreenrecordSource(options: ScreenrecordSourceOptions): ScreenrecordSource {
	const now = options.now ?? Date.now;
	const restartAfterMs = options.restartAfterMs ?? DEFAULT_RESTART_AFTER_MS;
	let idleDrainMs = options.idleDrainMs ?? 8;
	const startedAt = now();
	const stats = { recorders: 0, restarts: 0, units: 0, keyframes: 0, splitErrors: 0, exits: 0 };
	let live: Recorder | undefined;
	let next: Recorder | undefined;
	let stopped = false;
	let rotateTimer: ReturnType<typeof setTimeout> | undefined;
	let failures = 0;

	const kill = (recorder: Recorder) => {
		if (recorder.killed) return;
		recorder.killed = true;
		if (recorder.drainTimer) clearTimeout(recorder.drainTimer);
		recorder.process.kill();
	};

	const emit = (recorder: Recorder, units: Omit<AccessUnit, "ptsMicros">[]) => {
		for (const unit of units) {
			const key = (unit.flags & AuFlag.key) !== 0;
			if (recorder === next && key) {
				// the replacement is up: switch on its IDR
				recorder.keyed = true;
				const old = live;
				live = recorder;
				next = undefined;
				if (old) kill(old);
				armRotation();
			}
			if (recorder !== live) continue;
			stats.units++;
			if (key) {
				stats.keyframes++;
				failures = 0;
			}
			options.onUnit({ ...unit, ptsMicros: BigInt(Math.max(0, now() - startedAt)) * 1000n });
		}
	};

	const pump = async (recorder: Recorder) => {
		const reader = recorder.process.stdout.getReader();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done || recorder.killed) break;
				const errorsBefore = recorder.splitter.splitErrors;
				emit(recorder, recorder.splitter.push(value));
				if (recorder.splitter.splitErrors > errorsBefore) {
					// the frame drained early was cut short: the decoder needs a fresh IDR
					stats.splitErrors += recorder.splitter.splitErrors - errorsBefore;
					idleDrainMs = Math.min(MAX_IDLE_DRAIN_MS, idleDrainMs * 2);
					if (recorder === live) replace();
				}
				if (recorder.drainTimer) clearTimeout(recorder.drainTimer);
				recorder.drainTimer = setTimeout(() => {
					if (!recorder.killed) emit(recorder, recorder.splitter.drain());
				}, idleDrainMs);
			}
		} catch {}
	};

	const spawn = (): Recorder => {
		stats.recorders++;
		const recorder: Recorder = {
			process: options.spawn(options.argv),
			splitter: new AnnexBSplitter(),
			keyed: false,
			killed: false,
		};
		void pump(recorder);
		void recorder.process.exited.then((code) => {
			if (recorder.killed || stopped) return;
			recorder.killed = true;
			stats.exits++;
			options.log?.(`screenrecord exited ${code}`);
			if (recorder === next) next = undefined;
			if (recorder === live) {
				live = undefined;
				failures++;
				// a recorder that keeps failing is not respawned in a tight loop
				setTimeout(
					() => {
						if (!stopped && live === undefined) startLive();
					},
					failures > 2 ? 1_000 : 0
				);
			}
		});
		return recorder;
	};

	const armRotation = () => {
		if (rotateTimer) clearTimeout(rotateTimer);
		rotateTimer = setTimeout(() => replace(), restartAfterMs);
	};

	const startLive = () => {
		live = spawn();
		armRotation();
	};

	/** Start the replacement unless one is already on its way. */
	const replace = () => {
		if (stopped || next !== undefined) return;
		if (live === undefined) {
			startLive();
			return;
		}
		stats.restarts++;
		next = spawn();
	};

	startLive();

	return {
		requestKeyframe: replace,
		stats: () => ({ ...stats, idleDrainMs }),
		stop() {
			stopped = true;
			if (rotateTimer) clearTimeout(rotateTimer);
			for (const recorder of [live, next]) if (recorder) kill(recorder);
			live = undefined;
			next = undefined;
		},
	};
}

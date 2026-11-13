/**
 * Records one `warden dev` take on a claimed simulator: claim, 9:41 status bar, dark appearance, optional
 * uninstall (so dev installs from the build cache on camera), start the simctl video, spawn the REAL dev TUI in a
 * PTY (cols x rows) mirrored into a headless xterm, run the beats (waits, keys, one real source edit), quit with
 * `q`, stop the video. Writes `take.mp4`, `tui.cast` (timestamps on the video clock) and `dev.json` (beat times).
 * The edit is reverted and the lease released by id in `finally`.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";
import type { DevBeat, DevDemoDefinition, DevTake, RecordedBeat } from "./demo.types";
import { type Chunk, castText, cutAtAltScreenExit, deviceLeaseOf, leasesHeldBy, screenMatches } from "./dev-timeline";
import { defaultDeps, type RecordDeps } from "./record";

export type BeatIo = {
	frame: () => string[];
	keys: (text: string) => void;
	phoneWait: (selectors: readonly string[], timeoutMs: number) => Promise<void>;
	edit: (edit: NonNullable<DevBeat["edit"]>) => Promise<void>;
	stopVideo: () => Promise<void>;
	waitBoot?: () => Promise<void>;
	/** Runs once a beat is recorded, before its pause; the next beat waits for it (lets two takes meet at a beat). */
	beatDone?: (beat: RecordedBeat) => Promise<void>;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
};

const POLL_MS = 50;

async function waitFrame(source: string, io: BeatIo, timeoutMs: number, id: string): Promise<void> {
	const deadline = io.now() + timeoutMs / 1000;
	while (io.now() < deadline) {
		if (screenMatches(source, io.frame())) return;
		await io.sleep(POLL_MS);
	}
	throw new Error(`beat ${id}: screen never matched /${source}/\n${io.frame().join("\n")}`);
}

/** Runs the beats in order against `io`; every time is `io.now()` (the video clock). */
export async function runBeats(defs: readonly DevBeat[], io: BeatIo): Promise<RecordedBeat[]> {
	const out: RecordedBeat[] = [];
	for (const def of defs) {
		const startS = io.now();
		if (def.waitScreen) await waitFrame(def.waitScreen, io, def.timeoutMs, def.id);
		if (def.waitPhone?.length) await io.phoneWait(def.waitPhone, def.timeoutMs);
		if (def.waitBoot) await io.waitBoot?.();
		const readyS = io.now();
		if (def.stopVideoFirst) await io.stopVideo();
		if (def.edit) await io.edit(def.edit);
		if (def.keys) io.keys(def.keys);
		if (def.afterPhone?.length) await io.phoneWait(def.afterPhone, def.timeoutMs);
		const endS = io.now();
		const recorded = { id: def.id, startS, readyS, endS };
		out.push(recorded);
		await io.beatDone?.(recorded);
		await io.sleep(def.pauseAfterMs);
	}
	return out;
}

/** Applies one edit and returns the function that puts the file back byte for byte. */
export async function applyEdit(file: string, edit: { from: string; to: string }): Promise<() => Promise<void>> {
	const original = await readFile(file, "utf8");
	if (!original.includes(edit.from)) throw new Error(`edit: ${file} does not contain ${JSON.stringify(edit.from)}`);
	await writeFile(file, original.replace(edit.from, edit.to));
	return () => writeFile(file, original);
}

const STATUS_BAR = [
	"--time",
	"9:41",
	"--batteryState",
	"charged",
	"--batteryLevel",
	"100",
	"--cellularBars",
	"4",
	"--wifiBars",
	"3",
];

type Pty = {
	pid: number;
	frame: () => string[];
	keys: (text: string) => void;
	exited: Promise<number>;
	kill: () => void;
};

/** The real TUI under a PTY: raw chunks are timestamped for the cast and mirrored into xterm for frame reads. */
function spawnTui(
	argv: string[],
	def: DevDemoDefinition,
	cwd: string,
	extraEnv: Record<string, string>,
	onChunk: (data: string) => void
): Pty {
	const term = new Terminal({ cols: def.cols, rows: def.rows, allowProposedApi: true, scrollback: 0 });
	const decoder = new TextDecoder();
	let pending: Promise<void> = Promise.resolve();
	const proc = Bun.spawn(argv, {
		cwd,
		env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...extraEnv },
		terminal: {
			cols: def.cols,
			rows: def.rows,
			data(_t, chunk) {
				const copy = new Uint8Array(chunk);
				onChunk(decoder.decode(copy, { stream: true }));
				pending = pending.then(() => new Promise<void>((resolve) => term.write(copy, resolve)));
			},
		},
	});
	return {
		pid: proc.pid,
		frame: () => {
			const b = term.buffer.active;
			return Array.from({ length: term.rows }, (_, y) =>
				(b.getLine(b.baseY + y)?.translateToString(true) ?? "").trimEnd()
			);
		},
		keys: (text) => {
			proc.terminal?.write(text);
		},
		exited: proc.exited.then(async (code) => {
			await pending;
			return code;
		}),
		kill: () => proc.kill("SIGINT"),
	};
}

/** `sh -c` argv for a script definition: `warden` runs the checkout's CLI, `{label}` is the take's label. */
export function scriptArgv(script: string, label: string, cli: readonly string[]): string[] {
	return ["sh", "-c", `warden() { ${cli.join(" ")} "$@"; }\n${script.replaceAll("{label}", label)}`];
}

const BOOT_WAIT_S = 120;
const HOME_SCREEN_MIN_BYTES = 100_000;
const DEVICE_POLL_MS = 300;
const DEVICE_WAIT_MS = 120_000;

type RunWarden = (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Polls `warden ls --json` until the dev session's labelled device lease exists. */
async function waitForDeviceLease(
	run: RunWarden,
	label: string,
	at: () => number,
	sleep: (ms: number) => Promise<void>,
	frame: () => string[]
): Promise<{ leaseId: string; udid: string }> {
	const deadline = at() + DEVICE_WAIT_MS / 1000;
	let lastLs = "";
	while (at() <= deadline) {
		const listed = await run(["ls", "--json"]);
		lastLs = `${listed.code} ${listed.stdout.slice(0, 300)} ${listed.stderr.slice(0, 300)}`;
		const found = listed.code === 0 ? deviceLeaseOf(listed.stdout, label) : undefined;
		if (found) return found;
		await sleep(DEVICE_POLL_MS);
	}
	throw new Error(`warden dev never claimed a device labelled ${label} (last ls: ${lastLs})\n${frame().join("\n")}`);
}

/** `sh -c` argv that starts `simctl io recordVideo` in the background (stopped with SIGINT, see `stopRecording`). */
export function rawRecordArgv(udid: string, file: string): string[] {
	return ["sh", "-c", `nohup xcrun simctl io ${udid} recordVideo --codec h264 --force '${file}' >/dev/null 2>&1 &`];
}

/** `ui screen video start`, retried while the claimed simulator is still booting. */
async function startVideo(
	run: RunWarden,
	udid: string,
	file: string,
	at: () => number,
	sleep: (ms: number) => Promise<void>
): Promise<void> {
	const deadline = at() + DEVICE_WAIT_MS / 1000;
	let started = await run(["ui", "screen", "video", "start", file, "--udid", udid]);
	while (started.code !== 0 && at() < deadline) {
		await sleep(DEVICE_POLL_MS);
		started = await run(["ui", "screen", "video", "start", file, "--udid", udid]);
	}
	if (started.code !== 0) throw new Error(`video start failed: ${started.stderr.trim()}`);
}

/**
 * Stops the simulator video through warden; when that is refused (the lease is gone, the helper died) kills the
 * `simctl io <udid> recordVideo <file>` child with SIGINT so the file is finalised and the sim is not left recording.
 */
export async function stopRecording(
	run: RunWarden,
	sh: (cmd: readonly string[]) => Promise<{ code: number }>,
	udid: string,
	file: string,
	raw = false
): Promise<"stopped" | "killed"> {
	if (!raw) {
		const stopped = await run(["ui", "screen", "video", "stop", "--udid", udid]).catch(() => ({ code: 1 }));
		if (stopped.code === 0) return "stopped";
	}
	await sh(["pkill", "-INT", "-f", `simctl io ${udid} recordVideo.*${file}`]);
	// simctl finalises the mp4 on SIGINT
	if (raw) await sh(["sleep", "2"]);
	return "killed";
}

/** What a take learns about its device as it goes; the signal handler and the cleanup read it. */
type TakeState = { udid: string | undefined; videoStarted: boolean; restoreAppearance: string | undefined };

type TakeContext = {
	def: DevDemoDefinition;
	deps: RecordDeps;
	run: RunWarden;
	sh: (cmd: readonly string[]) => ReturnType<RecordDeps["exec"]>;
	label: string;
	takePath: string;
	state: TakeState;
};

/** Once `warden dev` has claimed: appearance, status bar, uninstall, then the simulator video. */
async function prepareDevice(
	ctx: TakeContext & { at: () => number; frame: () => string[] }
): Promise<{ udid: string; videoStartS: number }> {
	const { def, deps, run, sh, label, at, takePath, state } = ctx;
	const found = await waitForDeviceLease(run, label, at, deps.sleep, ctx.frame);
	state.udid = found.udid;
	deps.log(`warden dev claimed ${found.udid} (lease ${found.leaseId}) at ${at().toFixed(1)}s`);
	if (def.app.appearance) {
		const was = await sh(["xcrun", "simctl", "ui", found.udid, "appearance"]);
		state.restoreAppearance = was.stdout.trim() || "light";
		await sh(["xcrun", "simctl", "ui", found.udid, "appearance", def.app.appearance]);
	}
	// a script claims and boots the simulator itself. A video started while it boots recorded 4 frames and stopped
	// (a run that started it the same way by hand recorded fine, cause not found), so the video starts after the boot.
	if (def.script) await sh(["xcrun", "simctl", "bootstatus", found.udid]);
	await sh(["xcrun", "simctl", "status_bar", found.udid, "override", ...STATUS_BAR]);
	if (def.uninstallFirst && !def.script) await sh(["xcrun", "simctl", "uninstall", found.udid, def.app.bundleId]);
	if (def.rawVideo) {
		await sh(rawRecordArgv(found.udid, takePath));
		await deps.sleep(1000);
	} else await startVideo(run, found.udid, takePath, at, deps.sleep);
	state.videoStarted = true;
	return { udid: found.udid, videoStartS: at() };
}

/** Screenshots the simulator until it shows more than the boot logo, or throws after {@link BOOT_WAIT_S}. */
async function waitForBoot(
	sh: TakeContext["sh"],
	deps: RecordDeps,
	id: string,
	shot: string,
	at: () => number
): Promise<void> {
	const deadline = at() + BOOT_WAIT_S;
	while (at() < deadline) {
		await sh(["xcrun", "simctl", "io", id, "screenshot", shot]);
		// the boot logo is a few KB of PNG, a home screen is far larger
		if ((await stat(shot)).size > HOME_SCREEN_MIN_BYTES) return;
		await deps.sleep(1000);
	}
	throw new Error(`simulator ${id} still shows the boot logo after ${BOOT_WAIT_S}s`);
}

/** A failed take leaves the error and the last TUI frame next to its output. */
async function writeFailureFrame(outDir: string, error: unknown, pty: Pty | undefined): Promise<void> {
	const frame = pty?.frame().join("\n") ?? "(no tui)";
	await writeFile(
		join(outDir, "failure-frame.txt"),
		`${error instanceof Error ? error.message : String(error)}\n\n${frame}\n`
	);
}

/** Take teardown: video, dev child, edit reverts, status bar and appearance, then the lease. */
async function cleanupTake(
	ctx: TakeContext & { pty: Pty | undefined; restores: (() => Promise<void>)[] }
): Promise<void> {
	const { def, deps, run, sh, label, takePath, state, pty, restores } = ctx;
	const { udid, restoreAppearance } = state;
	// the video first: killing the dev child releases the lease, after which `warden ui` refuses to stop it
	if (udid && state.videoStarted)
		deps.log(`video ${await stopRecording(run, sh, udid, takePath, def.rawVideo === true)}`);
	pty?.kill();
	for (const restore of restores.reverse())
		await restore().catch((e: unknown) => deps.log(`REVERT FAILED: ${String(e)}`));
	if (udid) {
		await sh(["xcrun", "simctl", "status_bar", udid, "clear"]).catch(() => undefined);
		if (restoreAppearance)
			await sh(["xcrun", "simctl", "ui", udid, "appearance", restoreAppearance]).catch(() => undefined);
	}
	// a claimed simulator is ours alone (warden creates and deletes it): shut it down so the next take clones again
	const rel = await run(["release", "--mine", "--label", label, ...(def.script ? ["--shutdown"] : [])]);
	deps.log(rel.code === 0 ? `released --mine --label ${label}` : `release failed: ${rel.stderr.trim()}`);
	// a command that ends its own lease (a failed `warden e2e` keeps its simulator booted) leaves a warden-made simulator behind
	if (def.script && udid) await run(["sims", "delete", udid, "--yes"]).catch(() => undefined);
}

/** Called with each recorded beat while the take runs (before the beat's pause). */
export type DevTakeHooks = { onBeat?: (beat: RecordedBeat) => Promise<void> };

export async function recordDev(
	def: DevDemoDefinition,
	repoRoot: string,
	outDir: string,
	label: string,
	deps: RecordDeps = defaultDeps,
	hooks: DevTakeHooks = {}
): Promise<DevTake> {
	const cli = ["bun", join(repoRoot, "apps/cli/src/cli.ts")];
	const projectDir = join(repoRoot, def.app.project);
	// its own session: `warden dev` adopts a device lease held by the caller's session, and every teammate agent shares
	// this one, so without an id of our own it could take (and the take uninstall the app from) someone else's simulator
	const sessionId = `demo-dev-${label}-${Date.now()}`;
	const env = { WARDEN_SIMD: process.env.WARDEN_SIMD, WARDEN_SESSION_ID: sessionId };
	const run = (args: readonly string[]) => deps.exec([...cli, ...args], { cwd: projectDir, env });
	const must = async (args: readonly string[]) => {
		const r = await run(args);
		if (r.code !== 0)
			throw new Error(`warden ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
		return r;
	};
	const sh = (cmd: readonly string[]) => deps.exec(cmd, { cwd: projectDir });

	await mkdir(outDir, { recursive: true });
	const takePath = join(outDir, "take.mp4");
	const devArgv = def.script
		? scriptArgv(def.script, label, cli)
		: [...cli, "dev", def.platform, "--label", label, ...def.devArgs];
	if (!def.script && def.claim.profile) devArgv.push("--profile", def.claim.profile);
	const restores: (() => Promise<void>)[] = [];
	const state: TakeState = { udid: undefined, videoStarted: false, restoreAppearance: undefined };
	let pty: Pty | undefined;
	/** Ctrl-C / kill mid-take: stop the video, kill the dev child, release by label, then exit. */
	const onSignal = () => {
		void (async () => {
			if (state.udid && state.videoStarted) await stopRecording(run, sh, state.udid, takePath, def.rawVideo === true);
			pty?.kill();
			await run(["release", "--mine", "--label", label]);
			process.exit(130);
		})();
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		const t0 = deps.now();
		const at = () => deps.now() - t0;
		const chunks: Chunk[] = [{ atS: 0, data: "\u001b[?25l" }];
		pty = spawnTui(devArgv, def, projectDir, { ...def.devEnv, WARDEN_SESSION_ID: sessionId }, (data) =>
			chunks.push({ atS: at(), data })
		);
		const livePty = pty;

		const device = prepareDevice({ def, deps, run, sh, label, at, frame: livePty.frame, takePath, state });
		device.catch(() => undefined);

		const io: BeatIo = {
			frame: livePty.frame,
			keys: livePty.keys,
			phoneWait: async (selectors, timeoutMs) => {
				const { udid: id } = await device;
				for (const s of selectors) await must(["ui", "wait", s, "--timeout", String(timeoutMs), "--udid", id]);
			},
			stopVideo: async () => {
				const { udid: id } = await device;
				if (def.rawVideo) await stopRecording(run, sh, id, takePath, true);
				else await must(["ui", "screen", "video", "stop", "--udid", id]);
				state.videoStarted = false;
			},
			waitBoot: async () => waitForBoot(sh, deps, (await device).udid, join(outDir, "boot-probe.png"), at),
			edit: async (edit) => {
				restores.push(await applyEdit(join(repoRoot, edit.file), edit));
			},
			...(hooks.onBeat ? { beatDone: hooks.onBeat } : {}),
			now: at,
			sleep: deps.sleep,
		};
		const beats = await runBeats(def.beats, io);
		const code = await Promise.race([livePty.exited, deps.sleep(30_000).then(() => -1)]);
		if (code === -1) throw new Error(`warden dev did not exit after the last beat\n${livePty.frame().join("\n")}`);
		deps.log(`warden dev exited ${code}`);
		const stillHeld = def.script ? [] : leasesHeldBy((await run(["ls", "--json"])).stdout, label, livePty.pid);
		if (stillHeld.length > 0) throw new Error(`leases still held after q: ${stillHeld.join(", ")}`);
		await deps.sleep(def.tailHoldMs);
		const recordedS = at();
		const { videoStartS } = await device;
		const { kept, exitS } = cutAtAltScreenExit(chunks);
		// a last no-op event at the end of the take: agg renders the cast up to it, so the final dashboard frame is held
		const held = [...kept, { atS: recordedS, data: "\u001b[?25l" }];
		await writeFile(join(outDir, "tui.cast"), castText(held, def.cols, def.rows));
		const take: DevTake = {
			name: def.name,
			udid: state.udid ?? "",
			startedAtS: t0,
			beats,
			recordedS,
			videoStartS,
			exitS,
			released: !def.script,
		};
		await writeFile(join(outDir, "dev.json"), `${JSON.stringify(take, null, "\t")}\n`);
		return take;
	} catch (error) {
		await writeFailureFrame(outDir, error, pty);
		throw error;
	} finally {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
		await cleanupTake({ def, deps, run, sh, label, takePath, state, pty, restores });
	}
}

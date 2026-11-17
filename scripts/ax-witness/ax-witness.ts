#!/usr/bin/env bun
/**
 * AX witness harness: does an XCUITest runner (`warden-runner`) on the SAME simulator still answer `snapshot` while
 * `warden-simd`'s accessibility readers (in-sim `axbridge` guest, host `ax` translator) are silent?
 *
 *   bun scripts/ax-witness/ax-witness.ts --udid <sim udid> (--freeze | --observe)
 *       [--seconds 120] [--freeze-seconds 60] [--app com.apple.Preferences] [--interval 1000]
 *       [--simd <path>] [--out <dir>] [--skip-build] [--derived-data <dir>] [--min-streak 3]
 *       [--runner-ready-seconds 420]
 *
 * Each round sends one `snapshot` to simd, then one to the runner, and appends a JSONL record per read. The runner
 * (`xcodebuild test-without-building`) takes 2–4 min to come up on a fresh CI sim, so simd is read from the start
 * (`startup` rounds, runner unread) and a runner that never gets ready still leaves a summary (`runnerStartup: failed`):
 * on a wedged sim XCUITest may never start, and those simd reads are the evidence.
 * `--freeze`: baseline rounds, then SIGSTOP the launched app + SpringBoard (an emulation of a silent AX service, not
 * a real wedge), read for `--freeze-seconds`, SIGCONT, recovery rounds. `--observe`: no interference, for CI hunting.
 * Only ever pass a simulator you own (a claimed lease, or a throwaway CI VM): `--freeze` stops its processes.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
	classify,
	formatSummary,
	parseJsonl,
	pidForLabel,
	type ReadResult,
	RUNNER_FAILURE_PREFIX,
	RUNNER_READY_NOTE,
	type RunRecord,
	readyPort,
	type Source,
	summarize,
	type WireReply,
} from "./witness";

const ROOT = resolve(import.meta.dir, "../..");
const RUNNER_BUNDLE_ID = "nz.co.delacour.warden.runner.axwitness";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const numArg = (name: string, fallback: number): number => {
	const value = Number(arg(name) ?? fallback);
	return Number.isFinite(value) ? value : fallback;
};

type Wire = WireReply & { id: string };

/** One NDJSON request/response line client; `call` resolves to a client-timeout instead of rejecting. */
class LineClient {
	private pending = new Map<string, (reply: Wire) => void>();
	private next = 0;
	constructor(private write: (line: string) => void) {}

	feed(line: string): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		const id = typeof msg.id === "string" ? msg.id : undefined;
		if (id) this.pending.get(id)?.(msg as Wire);
	}

	call(request: Record<string, unknown>, waitMs: number): Promise<ReadResult> {
		const id = `w${++this.next}`;
		const started = Date.now();
		return new Promise((resolveCall) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolveCall({ kind: "client-timeout", waitedMs: Date.now() - started });
			}, waitMs);
			this.pending.set(id, (reply) => {
				clearTimeout(timer);
				this.pending.delete(id);
				resolveCall({ kind: "reply", reply });
			});
			this.write(`${JSON.stringify({ id, ...request })}\n`);
		});
	}
}

function startSimd(
	simd: string,
	udid: string,
	logFile: string
): { child: ChildProcess; client: LineClient; ready: Promise<void> } {
	const child = spawn(simd, ["--udid", udid], { stdio: ["pipe", "pipe", "pipe"] });
	const client = new LineClient((line) => child.stdin?.write(line));
	let readyResolve: () => void = () => {};
	const ready = new Promise<void>((r) => {
		readyResolve = r;
	});
	if (child.stdout) {
		createInterface({ input: child.stdout }).on("line", (line) => {
			try {
				const msg = JSON.parse(line) as { event?: string; level?: string; op?: string; message?: string };
				if (msg.event === "ready") readyResolve();
				if (msg.event === "log") appendFileSync(logFile, `${msg.level} ${msg.op ?? ""} ${msg.message}\n`);
			} catch {
				// not JSON
			}
			client.feed(line);
		});
	}
	if (child.stderr) createInterface({ input: child.stderr }).on("line", (line) => appendFileSync(logFile, `${line}\n`));
	return { child, client, ready };
}

type Runner = { xcodebuild: ChildProcess; socket: net.Socket; client: LineClient };

function xcodebuildArgs(action: string, udid: string, derivedData: string, extra: string[]): string[] {
	return [
		action,
		"-project",
		join(ROOT, "packages/e2e/native/ios-runner/WardenRunner.xcodeproj"),
		"-scheme",
		"WardenRunner",
		"-destination",
		`id=${udid}`,
		"-derivedDataPath",
		derivedData,
		...extra,
		`WARDEN_RUNNER_BUNDLE_ID=${RUNNER_BUNDLE_ID}`,
		"CODE_SIGNING_ALLOWED=NO",
	];
}

function buildRunner(udid: string, derivedData: string, logFile: string): boolean {
	console.log(`build-for-testing (simulator ${udid}) …`);
	const build = spawnSync("xcodebuild", xcodebuildArgs("build-for-testing", udid, derivedData, []), {
		encoding: "utf8",
		maxBuffer: 128 * 1024 * 1024,
	});
	writeFileSync(logFile, `${build.stdout}\n${build.stderr}`);
	if (build.status !== 0) console.error((build.stdout + build.stderr).split("\n").slice(-40).join("\n"));
	return build.status === 0;
}

/** Starts the runner; `ready` settles once it listens (or fails); `xcodebuild` is exposed so teardown can stop it early. */
function startRunner(
	udid: string,
	derivedData: string,
	logFile: string,
	readySeconds: number
): { xcodebuild: ChildProcess; ready: Promise<Runner> } {
	const env = { ...process.env, TEST_RUNNER_WARDEN_RUNNER_UDID: udid, TEST_RUNNER_WARDEN_RUNNER_IDLE_SECONDS: "3600" };
	const xcodebuild = spawn(
		"xcodebuild",
		xcodebuildArgs("test-without-building", udid, derivedData, [
			"-only-testing:WardenRunnerUITests/RunnerTests/testServe",
		]),
		{ env }
	);
	const ready = new Promise<Runner>((resolveRunner, reject) => {
		let settled = false;
		// Every reject path stops xcodebuild: the caller never gets a Runner to tear down, and testServe idles for an hour.
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (xcodebuild.exitCode === null) xcodebuild.kill("SIGTERM");
			reject(error);
		};
		const timer = setTimeout(() => fail(new Error(`runner not ready after ${readySeconds} s`)), readySeconds * 1000);
		const onLine = (line: string): void => {
			appendFileSync(logFile, `${line}\n`);
			if (settled) return;
			const port = readyPort(line);
			if (port === undefined) return;
			clearTimeout(timer);
			const socket = net.connect({ host: "127.0.0.1", port });
			const client = new LineClient((text) => socket.write(text));
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
					client.feed(buffer.slice(0, at));
					buffer = buffer.slice(at + 1);
				}
			});
			socket.on("error", (error) => {
				if (settled) return;
				socket.destroy();
				fail(error);
			});
			socket.on("connect", () => {
				if (settled) return;
				settled = true;
				resolveRunner({ xcodebuild, socket, client });
			});
		};
		for (const stream of [xcodebuild.stdout, xcodebuild.stderr]) {
			if (stream) createInterface({ input: stream }).on("line", onLine);
		}
		xcodebuild.on("exit", (code) => fail(new Error(`xcodebuild exited ${code} before the runner was ready`)));
	});
	return { xcodebuild, ready };
}

type Phase = "startup" | "baseline" | "freeze" | "recovery" | "observe";

function launchedPid(result: ReadResult): number | undefined {
	return result.kind === "reply" ? (result.reply.data as { pid?: number } | undefined)?.pid : undefined;
}

type ReadContext = {
	simd: LineClient;
	/** The runner's client once it is ready; undefined while it starts (that read is skipped, not recorded). */
	runner: () => LineClient | undefined;
	app: string;
	at: () => number;
	emit: (record: RunRecord) => void;
};

/** One `snapshot` to one source, recorded as a JSONL read and echoed as a log line. */
async function readOnce(ctx: ReadContext, round: number, source: Source, phase: Phase): Promise<void> {
	const client = source === "simd" ? ctx.simd : ctx.runner();
	if (!client) return;
	const request =
		source === "simd"
			? { op: "snapshot", interactiveOnly: true, timeoutMs: 15_000 }
			: { op: "snapshot", bundleId: ctx.app, interactiveOnly: true, timeoutMs: 15_000 };
	const started = ctx.at();
	const result = await client.call(request, 25_000);
	const latencyMs = ctx.at() - started;
	const verdict = classify(result);
	ctx.emit({ kind: "read", round, source, tMs: started, latencyMs, ...verdict });
	console.log(
		`${(started / 1000).toFixed(1).padStart(7)}s r${String(round).padStart(3)} ${phase.padEnd(8)} ${source.padEnd(6)} ${verdict.outcome.padEnd(8)} ${String(latencyMs).padStart(6)} ms ${verdict.code ?? verdict.backend ?? ""}`
	);
}

type Options = {
	udid: string;
	freeze: boolean;
	app: string;
	interval: number;
	minStreak: number;
	seconds: number;
	freezeSeconds: number;
	runnerReadySeconds: number;
	simdPath: string;
	derivedData: string;
	out: string;
};

function parseOptions(): Options | undefined {
	const udid = arg("udid");
	const freeze = flag("freeze");
	if (!udid || freeze === flag("observe")) return undefined;
	return {
		udid,
		freeze,
		app: arg("app") ?? "com.apple.Preferences",
		interval: numArg("interval", 1000),
		minStreak: numArg("min-streak", 3),
		seconds: numArg("seconds", 120),
		freezeSeconds: numArg("freeze-seconds", 60),
		runnerReadySeconds: numArg("runner-ready-seconds", 420),
		simdPath: resolve(arg("simd") ?? join(ROOT, "packages/e2e/native/dist/warden-simd")),
		derivedData: resolve(arg("derived-data") ?? join(homedir(), "Library/Caches/warden-ax-witness/derived-data")),
		out: resolve(arg("out") ?? join(ROOT, "ax-witness-out", new Date().toISOString().replace(/[:.]/g, "-"))),
	};
}

async function main(): Promise<number> {
	const options = parseOptions();
	if (!options) {
		console.error(
			"usage: ax-witness.ts --udid <sim udid> (--freeze | --observe) [--seconds 120] [--freeze-seconds 60]"
		);
		console.error(
			"       [--app <bundle id>] [--interval 1000] [--simd <path>] [--out <dir>] [--skip-build] [--min-streak 3]"
		);
		console.error("       [--runner-ready-seconds 420]");
		return 2;
	}
	const {
		udid,
		freeze,
		app,
		interval,
		minStreak,
		seconds,
		freezeSeconds,
		runnerReadySeconds,
		simdPath,
		derivedData,
		out,
	} = options;
	mkdirSync(out, { recursive: true });
	mkdirSync(derivedData, { recursive: true });
	const jsonl = join(out, "run.jsonl");
	writeFileSync(jsonl, "");
	const t0 = Date.now();
	const at = (): number => Date.now() - t0;
	const emit = (record: RunRecord): void => appendFileSync(jsonl, `${JSON.stringify(record)}\n`);
	const note = (text: string): void => {
		console.log(`${(at() / 1000).toFixed(1).padStart(7)}s ${text}`);
		emit({ kind: "note", tMs: at(), text });
	};

	if (!flag("skip-build") && !buildRunner(udid, derivedData, join(out, "runner-build.log"))) return 1;

	const simd = startSimd(simdPath, udid, join(out, "simd.log"));
	let runner: Runner | undefined;
	let runnerProcess: ChildProcess | undefined;
	// An object, not a `let`: the startup callbacks set it, and TS would keep a `let` narrowed to "starting".
	const runnerStart: { state: "starting" | "ready" | "failed" } = { state: "starting" };
	const freezer = new Freezer();
	process.on("SIGINT", () => {
		freezer.thaw();
		process.exit(130);
	});

	try {
		await Promise.race([simd.ready, Bun.sleep(30_000)]);
		note(`simd ready (pid ${simd.child.pid})`);
		const started = startRunner(udid, derivedData, join(out, "runner.log"), runnerReadySeconds);
		runnerProcess = started.xcodebuild;
		started.ready.then(
			(ready) => {
				runner = ready;
				runnerStart.state = "ready";
				note(RUNNER_READY_NOTE);
			},
			(error: unknown) => {
				runnerStart.state = "failed";
				note(`${RUNNER_FAILURE_PREFIX}${error instanceof Error ? error.message : String(error)}`);
			}
		);
		const launched = await simd.client.call({ op: "launch", bundleId: app }, 30_000);
		const appPid = launchedPid(launched);
		if (!appPid) throw new Error(`could not launch ${app} through simd`);
		note(`launched ${app} pid ${appPid}`);
		await Bun.sleep(2000);

		const reads: ReadContext = { simd: simd.client, runner: () => runner?.client, app, at, emit };
		let round = 0;
		const rounds = async (until: () => boolean, phase: Phase): Promise<void> => {
			while (!until()) {
				round++;
				await readOnce(reads, round, "simd", phase);
				await readOnce(reads, round, "runner", phase);
				await Bun.sleep(interval);
			}
		};
		const forSeconds = (s: number): (() => boolean) => {
			const end = Date.now() + s * 1000;
			return () => Date.now() >= end;
		};

		await rounds(() => runnerStart.state !== "starting", "startup");
		if (runnerStart.state === "failed") {
			if (freeze) throw new Error("the runner never got ready; --freeze needs it");
		} else if (freeze) {
			await freezeCycle({ udid, app, appPid, freezeSeconds, freezer, rounds, forSeconds, note });
		} else {
			await rounds(forSeconds(seconds), "observe");
		}
		const wedge = await simd.client.call({ op: "axWedge" }, 5000);
		if (wedge.kind === "reply") note(`simd axWedge ${JSON.stringify(wedge.reply.data ?? wedge.reply.error)}`);
	} catch (error) {
		note(`harness failure: ${error instanceof Error ? error.message : String(error)}`);
		freezer.thaw();
		await teardown(simd.child, runner, runnerProcess);
		return 1;
	}
	freezer.thaw();
	await teardown(simd.child, runner, runnerProcess);

	const summary = summarize(parseJsonl(await Bun.file(jsonl).text()), minStreak);
	writeFileSync(
		join(out, "summary.json"),
		`${JSON.stringify({ udid, mode: freeze ? "freeze" : "observe", ...summary }, null, 2)}\n`
	);
	writeFileSync(join(out, "summary.txt"), `${formatSummary(summary)}\n`);
	console.log(`\n${formatSummary(summary)}\noutput: ${out}`);
	return 0;
}

/** Processes `--freeze` SIGSTOPped; `thaw` resumes them, and is safe to call on every exit path. */
class Freezer {
	private stopped: number[] = [];

	stop(pids: readonly number[]): void {
		for (const pid of pids) process.kill(pid, "SIGSTOP");
		this.stopped = [...pids];
	}

	thaw(): void {
		for (const pid of this.stopped) {
			try {
				process.kill(pid, "SIGCONT");
			} catch {
				// already gone
			}
		}
		this.stopped = [];
	}
}

type FreezeCycle = {
	udid: string;
	app: string;
	appPid: number;
	freezeSeconds: number;
	freezer: Freezer;
	rounds: (until: () => boolean, phase: Phase) => Promise<void>;
	forSeconds: (s: number) => () => boolean;
	note: (text: string) => void;
};

/** Baseline rounds, SIGSTOP the app + SpringBoard (an emulation of a silent AX service), freeze rounds, SIGCONT, recovery. */
async function freezeCycle(c: FreezeCycle): Promise<void> {
	await c.rounds(c.forSeconds(6), "baseline");
	const list = spawnSync("xcrun", ["simctl", "spawn", c.udid, "launchctl", "list"], { encoding: "utf8" }).stdout;
	const sbPid = pidForLabel(list, "com.apple.SpringBoard");
	c.freezer.stop(sbPid === undefined ? [c.appPid] : [c.appPid, sbPid]);
	c.note(`SIGSTOP ${c.app} pid ${c.appPid} + SpringBoard pid ${sbPid ?? "?"} (emulation, not a real wedge)`);
	await c.rounds(c.forSeconds(c.freezeSeconds), "freeze");
	c.freezer.thaw();
	c.note("SIGCONT");
	await c.rounds(c.forSeconds(10), "recovery");
}

async function teardown(
	simd: ChildProcess,
	runner: Runner | undefined,
	runnerProcess: ChildProcess | undefined
): Promise<void> {
	// A runner still starting has no socket to shut down; stop its xcodebuild (a failed start already stopped it).
	if (!runner && runnerProcess?.exitCode === null) runnerProcess.kill("SIGTERM");
	if (runner) {
		await runner.client.call({ op: "shutdown" }, 5000).catch(() => undefined);
		runner.socket.destroy();
		const exited = new Promise<void>((r) => runner.xcodebuild.once("exit", () => r()));
		await Promise.race([exited, Bun.sleep(15_000)]);
		if (runner.xcodebuild.exitCode === null) runner.xcodebuild.kill("SIGTERM");
	}
	simd.kill("SIGTERM");
}

if (import.meta.main) process.exit(await main());

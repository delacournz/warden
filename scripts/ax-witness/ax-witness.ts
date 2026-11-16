#!/usr/bin/env bun
/**
 * AX witness harness: does an XCUITest runner (`warden-runner`) on the SAME simulator still answer `snapshot` while
 * `warden-simd`'s accessibility readers (in-sim `axbridge` guest, host `ax` translator) are silent?
 *
 *   bun scripts/ax-witness/ax-witness.ts --udid <sim udid> (--freeze | --observe)
 *       [--seconds 120] [--freeze-seconds 60] [--app com.apple.Preferences] [--interval 1000]
 *       [--simd <path>] [--out <dir>] [--skip-build] [--derived-data <dir>] [--min-streak 3]
 *
 * Each round sends one `snapshot` to simd, then one to the runner, and appends a JSONL record per read.
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

function startRunner(udid: string, derivedData: string, logFile: string): Promise<Runner> {
	const env = { ...process.env, TEST_RUNNER_WARDEN_RUNNER_UDID: udid, TEST_RUNNER_WARDEN_RUNNER_IDLE_SECONDS: "3600" };
	const xcodebuild = spawn(
		"xcodebuild",
		xcodebuildArgs("test-without-building", udid, derivedData, [
			"-only-testing:WardenRunnerUITests/RunnerTests/testServe",
		]),
		{ env }
	);
	return new Promise<Runner>((resolveRunner, reject) => {
		const timer = setTimeout(() => reject(new Error("runner not ready after 240 s")), 240_000);
		const onLine = (line: string): void => {
			appendFileSync(logFile, `${line}\n`);
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
			socket.on("error", (error) => reject(error));
			socket.on("connect", () => resolveRunner({ xcodebuild, socket, client }));
		};
		for (const stream of [xcodebuild.stdout, xcodebuild.stderr]) {
			if (stream) createInterface({ input: stream }).on("line", onLine);
		}
		xcodebuild.on("exit", (code) => reject(new Error(`xcodebuild exited ${code} before the runner was ready`)));
	});
}

type Phase = "baseline" | "freeze" | "recovery" | "observe";

function launchedPid(result: ReadResult): number | undefined {
	return result.kind === "reply" ? (result.reply.data as { pid?: number } | undefined)?.pid : undefined;
}

type Options = {
	udid: string;
	freeze: boolean;
	app: string;
	interval: number;
	minStreak: number;
	seconds: number;
	freezeSeconds: number;
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
		return 2;
	}
	const { udid, freeze, app, interval, minStreak, seconds, freezeSeconds, simdPath, derivedData, out } = options;
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
	let appPid: number | undefined;
	let sbPid: number | undefined;
	let frozen = false;
	const thaw = (): void => {
		if (!frozen) return;
		for (const pid of [appPid, sbPid]) {
			if (pid === undefined) continue;
			try {
				process.kill(pid, "SIGCONT");
			} catch {
				// already gone
			}
		}
		frozen = false;
	};
	process.on("SIGINT", () => {
		thaw();
		process.exit(130);
	});

	try {
		await Promise.race([simd.ready, Bun.sleep(30_000)]);
		note(`simd ready (pid ${simd.child.pid})`);
		runner = await startRunner(udid, derivedData, join(out, "runner.log"));
		note("runner ready");
		const launched = await simd.client.call({ op: "launch", bundleId: app }, 30_000);
		appPid = launchedPid(launched);
		if (!appPid) throw new Error(`could not launch ${app} through simd`);
		note(`launched ${app} pid ${appPid}`);
		await Bun.sleep(2000);

		const readOnce = async (round: number, source: Source, phase: Phase): Promise<void> => {
			const client = source === "simd" ? simd.client : runner?.client;
			if (!client) return;
			const request =
				source === "simd"
					? { op: "snapshot", interactiveOnly: true, timeoutMs: 15_000 }
					: { op: "snapshot", bundleId: app, interactiveOnly: true, timeoutMs: 15_000 };
			const started = at();
			const result = await client.call(request, 25_000);
			const latencyMs = at() - started;
			const verdict = classify(result);
			emit({ kind: "read", round, source, tMs: started, latencyMs, ...verdict });
			console.log(
				`${(started / 1000).toFixed(1).padStart(7)}s r${String(round).padStart(3)} ${phase.padEnd(8)} ${source.padEnd(6)} ${verdict.outcome.padEnd(8)} ${String(latencyMs).padStart(6)} ms ${verdict.code ?? verdict.backend ?? ""}`
			);
		};

		let round = 0;
		const rounds = async (until: () => boolean, phase: Phase): Promise<void> => {
			while (!until()) {
				round++;
				await readOnce(round, "simd", phase);
				await readOnce(round, "runner", phase);
				await Bun.sleep(interval);
			}
		};
		const forSeconds = (s: number): (() => boolean) => {
			const end = Date.now() + s * 1000;
			return () => Date.now() >= end;
		};

		if (freeze) {
			await rounds(forSeconds(6), "baseline");
			const list = spawnSync("xcrun", ["simctl", "spawn", udid, "launchctl", "list"], { encoding: "utf8" }).stdout;
			sbPid = pidForLabel(list, "com.apple.SpringBoard");
			process.kill(appPid, "SIGSTOP");
			if (sbPid !== undefined) process.kill(sbPid, "SIGSTOP");
			frozen = true;
			note(`SIGSTOP ${app} pid ${appPid} + SpringBoard pid ${sbPid ?? "?"} (emulation, not a real wedge)`);
			await rounds(forSeconds(freezeSeconds), "freeze");
			thaw();
			note("SIGCONT");
			await rounds(forSeconds(10), "recovery");
		} else {
			await rounds(forSeconds(seconds), "observe");
		}
		const wedge = await simd.client.call({ op: "axWedge" }, 5000);
		if (wedge.kind === "reply") note(`simd axWedge ${JSON.stringify(wedge.reply.data ?? wedge.reply.error)}`);
	} catch (error) {
		note(`harness failure: ${error instanceof Error ? error.message : String(error)}`);
		thaw();
		await teardown(simd.child, runner);
		return 1;
	}
	thaw();
	await teardown(simd.child, runner);

	const summary = summarize(parseJsonl(await Bun.file(jsonl).text()), minStreak);
	writeFileSync(
		join(out, "summary.json"),
		`${JSON.stringify({ udid, mode: freeze ? "freeze" : "observe", ...summary }, null, 2)}\n`
	);
	writeFileSync(join(out, "summary.txt"), `${formatSummary(summary)}\n`);
	console.log(`\n${formatSummary(summary)}\noutput: ${out}`);
	return 0;
}

async function teardown(simd: ChildProcess, runner: Runner | undefined): Promise<void> {
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

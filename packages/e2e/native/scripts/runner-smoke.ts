#!/usr/bin/env bun
/**
 * By-hand smoke for `warden-runner` on ONE real iPhone/iPad (never run by `bun test`):
 *
 *   bun native/scripts/runner-smoke.ts --udid <CoreDevice UDID> [--team <id>] [--app com.apple.Preferences]
 *                                       [--reps 10] [--record <file.ndjson>] [--skip-build] [--keep]
 *
 * Builds the runner for that device (`xcodebuild build-for-testing -destination id=<udid>`, automatic signing with the
 * team from `--team` / `DEVELOPMENT_TEAM`), starts it (`test-without-building ... testServe`), connects over the
 * CoreDevice tunnel (`devicectl list devices -j` -> `tunnelIPAddress`, re-read once the runner is up because it changes
 * on every install), checks the ready event and every v1 op against the `simd-protocol.ts` schemas, prints p50/p95
 * latencies, then `shutdown`s and uninstalls the two bundles it installed (`--keep` leaves them).
 *
 * `--record` appends every request/response pair as NDJSON (`{request,response}`), which `fake-runner.ts` (PHY-6) replays.
 * The phone must be unlocked and paired; the app is only launched, scrolled and searched in (Settings by default), and
 * nothing is typed anywhere but the Settings search field.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	alertButtonsDataSchema,
	frontmostDataSchema,
	healthDataSchema,
	launchDataSchema,
	orientationDataSchema,
	parseLine,
	type ReadyEvent,
	readyEventSchema,
	screenshotDataSchema,
	snapshotDataSchema,
	terminateDataSchema,
	type WireElement,
} from "../../src/driver/ios/simd-protocol";

// ---------- pure helpers (unit-tested in runner-smoke.test.ts) ----------

export const READY_PREFIX = "WARDEN_RUNNER_READY";

/** The ready event inside a `WARDEN_RUNNER_READY {json}` line, or undefined for any other line. */
export function parseReadyLine(line: string): ReadyEvent | undefined {
	const at = line.indexOf(READY_PREFIX);
	if (at < 0) return undefined;
	try {
		const parsed = readyEventSchema.safeParse(JSON.parse(line.slice(at + READY_PREFIX.length).trim()));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

/** The listening port the runner printed (the ready line also carries it, but the schema strips it). */
export function readyPort(line: string): number | undefined {
	const at = line.indexOf(READY_PREFIX);
	if (at < 0) return undefined;
	try {
		const port: unknown = JSON.parse(line.slice(at + READY_PREFIX.length).trim()).port;
		return typeof port === "number" ? port : undefined;
	} catch {
		return undefined;
	}
}

type DevicectlList = {
	result?: {
		devices?: {
			hardwareProperties?: { udid?: string; reality?: string };
			connectionProperties?: { tunnelIPAddress?: string; tunnelState?: string };
		}[];
	};
};

/** `connectionProperties.tunnelIPAddress` of the physical device `udid`, from `devicectl list devices -j`. */
export function tunnelIpFor(list: DevicectlList, udid: string): string | undefined {
	const device = list.result?.devices?.find(
		(d) => d.hardwareProperties?.udid === udid && d.hardwareProperties?.reality === "physical"
	);
	return device?.connectionProperties?.tunnelIPAddress;
}

export type RunnerFailure = "device_locked" | "developer_mode_off" | "runner_untrusted" | "device_busy";

/** A line of `xcodebuild` output that says the runner cannot start, as a short code. */
export function classifyXcodebuildLine(line: string): RunnerFailure | undefined {
	if (/Unlock .* to Continue/i.test(line)) return "device_locked";
	if (/Developer Mode/i.test(line) && /disabled|not enabled|turn on/i.test(line)) return "developer_mode_off";
	if (/not trusted|Untrusted Developer|profile has not been explicitly trusted/i.test(line)) return "runner_untrusted";
	if (/Failed to establish communication with the test runner|already .*(testing|being tested)/i.test(line)) {
		return "device_busy";
	}
	return undefined;
}

export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
}

export function runnerBundleId(team: string): string {
	return `nz.co.delacour.warden.runner.${team.toLowerCase()}`;
}

/** The two bundles `xcodebuild` installs for a runner: the host app and the UI-test runner app. */
export function installedBundleIds(bundleId: string): string[] {
	return [bundleId, `${bundleId}.uitests.xctrunner`];
}

const PHYSICAL_UDID = /^[0-9A-F]{8}-[0-9A-F]{16}$/i;

// ---------- the smoke ----------

type Wire = { id: string; ok: boolean; data?: unknown; error?: { code: string; message: string } };

class RunnerClient {
	private socket: net.Socket;
	private pending = new Map<string, (line: Wire) => void>();
	private buffer = "";
	private next = 0;
	/** The ready event as sent: `readyEventSchema` strips `backend` / `engine`, which the smoke checks. */
	ready: Promise<Record<string, unknown>>;

	constructor(
		host: string,
		port: number,
		private record?: string
	) {
		this.socket = net.connect({ host, port });
		let resolveReady: (event: Record<string, unknown>) => void = () => {};
		let rejectReady: (error: Error) => void = () => {};
		this.ready = new Promise((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		this.socket.on("error", (error) => rejectReady(error));
		this.socket.on("data", (chunk) => {
			this.buffer += chunk.toString("utf8");
			for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
				const line = this.buffer.slice(0, at);
				this.buffer = this.buffer.slice(at + 1);
				const parsed = parseLine(line);
				if (!parsed.success) continue;
				if (parsed.message.kind === "event") {
					if (parsed.message.event.event === "ready") resolveReady(JSON.parse(line) as Record<string, unknown>);
					continue;
				}
				const response = parsed.message.response;
				this.pending.get(response.id)?.(JSON.parse(line) as Wire);
			}
		});
	}

	call(request: Record<string, unknown>, timeoutMs = 60_000): Promise<Wire> {
		const id = String(++this.next);
		const line = { id, ...request };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`${String(request.op)} timed out after ${timeoutMs} ms`)),
				timeoutMs
			);
			this.pending.set(id, (response) => {
				clearTimeout(timer);
				this.pending.delete(id);
				if (this.record) appendFileSync(this.record, `${JSON.stringify({ request: line, response })}\n`);
				resolve(response);
			});
			this.socket.write(`${JSON.stringify(line)}\n`);
		});
	}

	close(): void {
		this.socket.destroy();
	}
}

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function devicectlJson(args: string[]): DevicectlList {
	const dir = mkdtempSync(join(tmpdir(), "wdn-runner-smoke-"));
	const out = join(dir, "out.json");
	try {
		spawnSync("xcrun", ["devicectl", ...args, "--json-output", out], { encoding: "utf8" });
		return JSON.parse(readFileSync(out, "utf8")) as DevicectlList;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Reporting shared by the steps: counts failures, prints one line per check. */
class Report {
	failures = 0;
	times: Record<string, number[]> = {};

	ok(name: string, ms?: number, extra = ""): void {
		const took = ms === undefined ? "" : `${String(Math.round(ms)).padStart(6)} ms`;
		console.log(`ok    ${name.padEnd(30)} ${took} ${extra}`);
	}

	fail(name: string, why: string): void {
		this.failures++;
		console.log(`FAIL  ${name.padEnd(30)} ${why}`);
	}

	latencies(): void {
		console.log("\nlatency (ms)        p50     p95");
		for (const [name, values] of Object.entries(this.times)) {
			const p50 = String(Math.round(percentile(values, 0.5))).padStart(5);
			const p95 = String(Math.round(percentile(values, 0.95))).padStart(7);
			console.log(`${name.padEnd(18)} ${p50} ${p95}`);
		}
	}
}

type Target = { udid: string; team: string; app: string; reps: number; project: string; derivedData: string };

function xcodebuildArgs(action: string, target: Target, extra: string[]): string[] {
	return [
		action,
		"-project",
		target.project,
		"-scheme",
		"WardenRunner",
		"-destination",
		`id=${target.udid}`,
		"-allowProvisioningUpdates",
		"-derivedDataPath",
		target.derivedData,
		...extra,
		`DEVELOPMENT_TEAM=${target.team}`,
	];
}

function buildRunner(target: Target, report: Report): boolean {
	console.log(`build-for-testing for ${target.udid} (team ${target.team}) …`);
	const build = spawnSync("xcodebuild", xcodebuildArgs("build-for-testing", target, ["CODE_SIGN_STYLE=Automatic"]), {
		env: { ...process.env, DEVELOPMENT_TEAM: target.team },
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (build.status !== 0) {
		console.error((build.stdout + build.stderr).split("\n").slice(-40).join("\n"));
		return false;
	}
	report.ok("build-for-testing");
	return true;
}

/** Resolves with the `WARDEN_RUNNER_READY` line, or rejects with the failure `xcodebuild` printed instead. */
function waitForReady(xcodebuild: ChildProcess): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("runner not ready after 300 s (is the phone unlocked?)")), 300_000);
		let buffer = "";
		const onData = (chunk: Buffer): void => {
			buffer += chunk.toString("utf8");
			for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				const failure = classifyXcodebuildLine(line);
				if (failure) {
					clearTimeout(timer);
					reject(new Error(`${failure}: ${line.trim()}`));
				}
				if (parseReadyLine(line)) {
					clearTimeout(timer);
					resolve(line);
				}
			}
		};
		xcodebuild.stdout?.on("data", onData);
		xcodebuild.stderr?.on("data", onData);
		xcodebuild.on("exit", (code) => reject(new Error(`xcodebuild exited ${code} before the runner was ready`)));
	});
}

class Checks {
	constructor(
		private client: RunnerClient,
		private target: Target,
		private report: Report
	) {}

	async rpc(name: string, request: Record<string, unknown>): Promise<Wire> {
		const t0 = performance.now();
		const response = await this.client.call(request);
		if (response.ok) this.report.ok(name, performance.now() - t0);
		else this.report.fail(name, `${response.error?.code}: ${response.error?.message}`);
		return response;
	}

	async expectError(name: string, request: Record<string, unknown>, code: string): Promise<void> {
		const response = await this.client.call(request);
		if (!response.ok && response.error?.code === code) this.report.ok(name, undefined, `(${code})`);
		else this.report.fail(name, `expected ${code}, got ${JSON.stringify(response)}`);
	}

	/** `reps` calls of one op; stops at the first failure. */
	async timed(name: string, request: Record<string, unknown>): Promise<Wire | undefined> {
		let last: Wire | undefined;
		for (let i = 0; i < this.target.reps; i++) {
			const t0 = performance.now();
			last = await this.client.call(request);
			this.report.times[name] = [...(this.report.times[name] ?? []), performance.now() - t0];
			if (!last.ok) {
				this.report.fail(name, `${last.error?.code}: ${last.error?.message}`);
				return last;
			}
		}
		return last;
	}

	async ready(event: Record<string, unknown>): Promise<void> {
		if (event.engine === "xcuitest" && event.backend === "ax") this.report.ok("ready event (xcuitest, ax)");
		else this.report.fail("ready event", JSON.stringify(event));
		const health = healthDataSchema.safeParse((await this.rpc("health", { op: "health" })).data);
		if (!health.success) this.report.fail("health schema", health.error.message);
	}

	async snapshot(): Promise<WireElement | undefined> {
		const { app } = this.target;
		const launched = launchDataSchema.safeParse(
			(await this.rpc(`launch ${app}`, { op: "launch", bundleId: app })).data
		);
		if (!launched.success) this.report.fail("launch schema", launched.error.message);
		const parsed = snapshotDataSchema.safeParse(
			(await this.timed("snapshot", { op: "snapshot", bundleId: app }))?.data
		);
		if (!parsed.success) {
			this.report.fail("snapshot schema", parsed.error.message);
			return undefined;
		}
		const { backend, elements, screen, nodes } = parsed.data;
		if (backend !== "ax" || elements.length === 0) this.report.fail("snapshot content", "no ax elements");
		else
			this.report.ok(
				"snapshot schema",
				undefined,
				`${nodes ?? "?"} nodes, ${screen.width}x${screen.height}@${screen.scale}`
			);
		await this.rpc("snapshot interactiveOnly", { op: "snapshot", bundleId: app, interactiveOnly: true });
		const walk = (nodes: readonly WireElement[]): WireElement[] => nodes.flatMap((n) => [n, ...walk(n.children ?? [])]);
		return walk(elements).find((n) => n.role === "searchfield" && n.tapPoint);
	}

	async input(search: WireElement | undefined): Promise<void> {
		const { app } = this.target;
		await this.timed("tap (status bar)", { op: "tap", x: 5, y: 5, bundleId: app });
		await this.rpc("swipe up", {
			op: "swipe",
			from: { x: 220, y: 700 },
			to: { x: 220, y: 400 },
			durationMs: 300,
			bundleId: app,
		});
		await this.rpc("swipe down", {
			op: "swipe",
			from: { x: 220, y: 400 },
			to: { x: 220, y: 700 },
			durationMs: 300,
			bundleId: app,
		});
		if (search?.tapPoint) {
			await this.rpc("tap search field", { op: "tap", x: search.tapPoint.x, y: search.tapPoint.y, bundleId: app });
			await this.rpc("typeText 12 chars", { op: "typeText", text: "wardenrunner", bundleId: app });
			for (let i = 0; i < 12; i++) await this.client.call({ op: "key", name: "Backspace", bundleId: app });
			this.report.ok("key Backspace x12");
		} else {
			console.log("skip  typeText                      (no search field in the snapshot)");
		}
	}

	async reads(): Promise<void> {
		const { app } = this.target;
		const shot = screenshotDataSchema.safeParse((await this.timed("screenshot", { op: "screenshot" }))?.data);
		const magic =
			shot.success && shot.data.png ? Buffer.from(shot.data.png, "base64").subarray(1, 4).toString("ascii") : "";
		if (magic === "PNG" && shot.success)
			this.report.ok("screenshot png", undefined, `${shot.data.width}x${shot.data.height}`);
		else this.report.fail("screenshot png", "no PNG in the reply");
		const orientation = orientationDataSchema.safeParse((await this.timed("orientation", { op: "orientation" }))?.data);
		if (orientation.success) this.report.ok("orientation get", undefined, orientation.data.orientation);
		else this.report.fail("orientation schema", orientation.error.message);
		const alert = alertButtonsDataSchema.safeParse((await this.rpc("alertButtons", { op: "alertButtons" })).data);
		if (!alert.success) this.report.fail("alertButtons schema", alert.error.message);
		const front = frontmostDataSchema.safeParse((await this.rpc("frontmost", { op: "frontmost", bundleId: app })).data);
		if (!front.success || !front.data.frontmost) this.report.fail("frontmost", "app is not frontmost");
		await this.rpc("appState", { op: "appState", bundleId: app });
	}

	/** Last: a failed op must leave the runner serving (continueAfterFailure + the issue observer). */
	async failedOpKeepsServing(): Promise<void> {
		const { app } = this.target;
		await this.rpc(`relaunch ${app}`, { op: "launch", bundleId: app });
		await this.expectError("typeText with no focus", { op: "typeText", text: "x", bundleId: app }, "E_NO_ELEMENT");
		const alive = await this.rpc("health after a failed op", { op: "health" });
		if (!alive.ok) this.report.fail("runner survived a failed op", "health failed");
		await this.rpc("snapshot after a failed op", { op: "snapshot", bundleId: app });
		const t0 = performance.now();
		const shot = await this.client.call({ op: "screenshot" }, 20_000).catch((error: Error) => error);
		if (shot instanceof Error) this.report.fail("screenshot after a failed op", shot.message);
		else this.report.ok("screenshot after a failed op", performance.now() - t0);
	}

	async unsupportedAndTeardown(): Promise<void> {
		const { app } = this.target;
		await this.expectError(
			"orientation set -> unsupported",
			{ op: "orientation", set: "landscapeLeft" },
			"E_UNSUPPORTED"
		);
		await this.expectError("pinch -> unsupported", { op: "pinch", center: { x: 1, y: 1 } }, "E_UNSUPPORTED");
		await this.expectError("bad request", { op: "tap", x: "no" }, "E_BAD_REQUEST");
		await this.rpc("pressButton home", { op: "pressButton", button: "home" });
		const gone = terminateDataSchema.safeParse(
			(await this.rpc(`terminate ${app}`, { op: "terminate", bundleId: app })).data
		);
		if (!gone.success) this.report.fail("terminate schema", gone.error.message);
	}
}

async function serve(
	target: Target,
	env: NodeJS.ProcessEnv,
	record: string | undefined,
	report: Report
): Promise<void> {
	const runnerEnv = {
		...env,
		TEST_RUNNER_WARDEN_RUNNER_UDID: target.udid,
		TEST_RUNNER_WARDEN_RUNNER_IDLE_SECONDS: "900",
	};
	const test = ["-only-testing:WardenRunnerUITests/RunnerTests/testServe"];
	const xcodebuild = spawn("xcodebuild", xcodebuildArgs("test-without-building", target, test), { env: runnerEnv });
	const started = performance.now();
	const tail: string[] = [];
	const keepTail = (chunk: Buffer): void => {
		tail.push(
			...chunk
				.toString("utf8")
				.split("\n")
				.filter((line) => line.trim() !== "")
		);
		tail.splice(0, Math.max(0, tail.length - 30));
	};
	xcodebuild.stdout?.on("data", keepTail);
	xcodebuild.stderr?.on("data", keepTail);
	let client: RunnerClient | undefined;
	try {
		const readyLine = await waitForReady(xcodebuild);
		report.ok("runner ready", performance.now() - started);
		const port = readyPort(readyLine);
		if (port === undefined) throw new Error("ready line carries no port");
		const ip = tunnelIpFor(devicectlJson(["list", "devices"]), target.udid);
		if (!ip) throw new Error("no tunnelIPAddress for the device (tunnelState disconnected?)");
		console.log(`      tunnel [${ip}]:${port}`);
		client = new RunnerClient(ip, port, record);
		const checks = new Checks(client, target, report);
		await checks.ready(await client.ready);
		const search = await checks.snapshot();
		await checks.input(search);
		await checks.reads();
		await checks.failedOpKeepsServing();
		await checks.unsupportedAndTeardown();
		report.latencies();
		await client.call({ op: "shutdown" }, 10_000).catch(() => undefined);
	} catch (error) {
		report.fail("smoke", error instanceof Error ? error.message : String(error));
		console.log(
			`      xcodebuild (exit ${xcodebuild.exitCode}) tail:\n${tail.map((line) => `        ${line}`).join("\n")}`
		);
	} finally {
		client?.close();
		const exited = new Promise<void>((resolve) => xcodebuild.once("exit", () => resolve()));
		await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 20_000))]);
		if (xcodebuild.exitCode === null) xcodebuild.kill("SIGTERM");
	}
}

function uninstall(udid: string, bundleId: string): void {
	for (const id of installedBundleIds(bundleId)) {
		const gone = spawnSync("xcrun", ["devicectl", "device", "uninstall", "app", "--device", udid, id], {
			encoding: "utf8",
		});
		console.log(`${gone.status === 0 ? "ok   " : "note "} uninstall ${id}`);
	}
}

async function main(): Promise<number> {
	const udid = arg("udid");
	const team = arg("team") ?? process.env.DEVELOPMENT_TEAM;
	if (!udid || !PHYSICAL_UDID.test(udid) || !team) {
		console.error(
			"usage: runner-smoke.ts --udid <physical UDID, 00008140-…> --team <id> (or DEVELOPMENT_TEAM) [--app <bundle id>]"
		);
		console.error("                       [--reps 10] [--record <file>] [--skip-build] [--keep]");
		return 2;
	}
	const record = arg("record");
	if (record) writeFileSync(record, "");
	const target: Target = {
		udid,
		team,
		app: arg("app") ?? "com.apple.Preferences",
		reps: Number(arg("reps") ?? 10),
		project: join(import.meta.dir, "..", "ios-runner", "WardenRunner.xcodeproj"),
		derivedData: join(tmpdir(), `wdn-runner-dd-${team}`),
	};
	mkdirSync(target.derivedData, { recursive: true });
	const report = new Report();
	if (!flag("skip-build") && !buildRunner(target, report)) return 1;
	await serve(target, { ...process.env, DEVELOPMENT_TEAM: team }, record, report);
	if (!flag("keep")) uninstall(udid, runnerBundleId(team));
	console.log(report.failures === 0 ? "\nrunner smoke passed" : `\nrunner smoke FAILED (${report.failures})`);
	return report.failures === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());

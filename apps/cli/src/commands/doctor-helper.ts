import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DOCTOR_HINT, helperLocator } from "@delacour/warden-driver-ios/locate-helper";
import { simctlParser } from "@delacour/warden-providers/ios";
import { storeLocator } from "@delacour/warden-store/store";
import type { CommandContext } from "../context";
import { HELPER_MANIFEST, HELPER_TARGET, type HelperInfo, parseHelperManifest } from "../npm/helper";
import { type BuildInfo, currentBuild } from "../update/build-info";
import type { DoctorCheck } from "./doctor";

/** `--health` is a one-shot: it must answer well inside this, or the check says so. */
const HEALTH_TIMEOUT_MS = 5_000;

/** Outside world for the helper checks, injectable for tests. */
export type HelperDeps = {
	platform: string;
	arch: string;
	/** the running warden (a compiled one ships the helper next to itself) */
	execPath: string;
	/** `packages/driver-ios/src` of a source checkout, anchors the `native/dist` lookup */
	importDir: string;
	version: string;
	exists: (path: string) => boolean;
	realpath: (path: string) => string;
	/** file contents, or `undefined` when unreadable */
	readFile: (path: string) => string | undefined;
	/** `health` answered by the helper serving this socket, or `undefined` when it does not answer in time */
	runningHealth?: (socketPath: string) => Promise<Record<string, unknown> | undefined>;
};

export class DoctorHelper {
	/** Asks a running `warden-simd` for its `health` over its unix socket (one request, 2 s limit). */
	readonly queryRunningHealth = (socketPath: string): Promise<Record<string, unknown> | undefined> => {
		return new Promise((resolve) => {
			let buffer = "";
			let settled = false;
			const finish = (value: Record<string, unknown> | undefined) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket?.end();
				resolve(value);
			};
			const timer = setTimeout(() => finish(undefined), 2_000);
			let socket: { end: () => void } | undefined;
			Bun.connect({
				unix: socketPath,
				socket: {
					open(handle) {
						socket = handle;
						handle.write(`${JSON.stringify({ id: "doctor", op: "health", timeoutMs: 1500 })}\n`);
					},
					data: (_handle, chunk) => {
						buffer += chunk.toString();
						for (const text of buffer.split("\n")) {
							const parsed = this.parseJson(text);
							if (this.isRecord(parsed) && parsed.id === "doctor") return finish(parsed);
						}
					},
					error: () => finish(undefined),
					close: () => finish(undefined),
				},
			}).catch(() => finish(undefined));
		});
	};

	private readonly readOrUndefined = (path: string): string | undefined => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	};

	/** Where a source checkout's e2e driver lives; `/` (matches nothing) for builds without a checkout. */
	importDirFor(build: BuildInfo): string {
		const sourceDir = build.channel === "release" ? undefined : build.sourceDir;
		return sourceDir ? join(sourceDir, "packages", "driver-ios", "src") : "/";
	}

	realHelperDeps(): HelperDeps {
		const build = currentBuild();
		return {
			platform: process.platform,
			arch: process.arch,
			execPath: process.execPath,
			importDir: this.importDirFor(build),
			version: build.version,
			exists: existsSync,
			realpath: realpathSync,
			readFile: this.readOrUndefined,
			runningHealth: this.queryRunningHealth,
		};
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	private parseJson(text: string): unknown {
		try {
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	}

	/** Build info of the helper at `helperPath`: `manifest.json` beside it, else the platform package.json `warden.helper`. */
	helperInfo(deps: HelperDeps, helperPath: string): HelperInfo | undefined {
		const dir = dirname(helperPath);
		const manifest = deps.readFile(join(dir, HELPER_MANIFEST));
		if (manifest !== undefined) {
			const parsed = parseHelperManifest(manifest);
			if (parsed.success) return parsed.data;
		}
		const pkg = deps.readFile(join(dir, "..", "package.json"));
		const warden = pkg === undefined ? undefined : this.parseJson(pkg);
		const helper = this.isRecord(warden) && this.isRecord(warden.warden) ? warden.warden.helper : undefined;
		if (!this.isRecord(helper)) return undefined;
		const { version, idb, xcode } = helper;
		return typeof version === "string" && typeof idb === "string" && typeof xcode === "string"
			? { version, idb, xcode }
			: undefined;
	}

	private async firstBootedSim(ctx: CommandContext): Promise<string | undefined> {
		const result = await ctx.exec(["xcrun", "simctl", "list", "devices", "available", "-j"], { timeoutMs: 10_000 });
		if (result.exitCode !== 0) return undefined;
		const devices = simctlParser.parseDevices(result.stdout);
		return devices.success ? devices.data.find((device) => device.state === "booted")?.id : undefined;
	}

	/** Last JSON line of `warden-simd --health` stdout: a response (`{ok, data}`), a `fatal` event, or the bare data. */
	private healthLine(stdout: string): Record<string, unknown> | undefined {
		for (const line of stdout.trim().split("\n").reverse()) {
			const parsed = this.parseJson(line);
			if (this.isRecord(parsed)) return parsed;
		}
		return undefined;
	}

	/** `data.<key>` as a record, if it is one. */
	private child(parent: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
		const value = parent?.[key];
		return this.isRecord(value) ? value : undefined;
	}

	/** Why a health probe gave no answer: the helper's own error, else stderr, else (timeout / crash) the exit code. */
	private failureReason(line: Record<string, unknown> | undefined, stderr: string, exitCode: number): string {
		const message = this.child(line, "error")?.message;
		if (typeof message === "string") return message;
		return (
			stderr.trim().split("\n").pop() || `no answer within ${HEALTH_TIMEOUT_MS / 1000}s or crashed, exit ${exitCode}`
		);
	}

	private healthRow(
		stdout: string,
		exitCode: number,
		stderr: string,
		udid: string
	): Pick<DoctorCheck, "status" | "detail"> {
		const line = this.healthLine(stdout);
		const data = this.child(line, "data") ?? line;
		const transport = this.child(data, "hid")?.transport;
		const ax = this.child(data, "ax");
		if (exitCode !== 0 || typeof transport !== "string" || typeof ax?.bridge !== "string") {
			return {
				status: "warn",
				detail: `warden-simd --health on ${udid} failed (${this.failureReason(line, stderr, exitCode)})`,
			};
		}
		const summary = `${udid}: hid.transport=${transport} ax.bridge=${ax.bridge}`;
		if (ax.bridge === "available") return { status: "ok", detail: summary };
		if (ax.bridge === "degraded") return { status: "warn", detail: this.degradedDetail(summary, ax) };
		const reason = typeof ax.error === "string" ? ` (${ax.error})` : "";
		return { status: "warn", detail: `${summary}${reason} — snapshots fall back to the slower host-side AX` };
	}

	/** `ax.lastError` of a degraded bridge: the failure and how long ago it happened. */
	private degradedDetail(summary: string, ax: Record<string, unknown>): string {
		const lastError = this.child(ax, "lastError");
		const message = typeof lastError?.message === "string" ? lastError.message : "a read failed";
		const agoMs = typeof lastError?.agoMs === "number" ? lastError.agoMs : undefined;
		const ago = agoMs === undefined ? "" : `, ${Math.round(agoMs / 1000)}s ago`;
		return `${summary} (last read failed${ago}: ${message}) — reads may be falling back to the slower host-side AX`;
	}

	/**
	 * The state of a helper that is already serving this simulator: a fresh `--health` process has no read history, so
	 * only the running one can say its bridge is `degraded`. Undefined when it does not answer.
	 */
	private async runningHelperRow(
		deps: HelperDeps,
		socketPath: string,
		udid: string
	): Promise<Pick<DoctorCheck, "status" | "detail"> | undefined> {
		if (!deps.runningHealth || !deps.exists(socketPath)) return undefined;
		const answer = await deps.runningHealth(socketPath);
		const data = this.child(answer, "data") ?? answer;
		const ax = this.child(data, "ax");
		const transport = this.child(data, "hid")?.transport;
		if (ax?.bridge !== "degraded") return undefined;
		const summary = `${udid}: hid.transport=${typeof transport === "string" ? transport : "?"} ax.bridge=degraded`;
		return { status: "warn", detail: this.degradedDetail(summary, ax) };
	}

	/**
	 * The "simulator helper" doctor rows: where `warden-simd` was found and which build it is, and, with a booted
	 * iOS simulator, whether it can drive it (`hid.transport` / `ax.bridge` from `warden-simd --health`).
	 * Linux has no iOS, so it gets no rows; darwin-x64 has no helper build, which warns like any missing helper.
	 */
	async helperChecks(ctx: CommandContext, deps: HelperDeps): Promise<DoctorCheck[]> {
		const row = (name: string, status: DoctorCheck["status"], detail: string): DoctorCheck => ({
			name,
			level: "optional",
			status,
			detail,
		});
		const target = `${deps.platform}-${deps.arch}`;
		if (deps.platform !== "darwin") return [];
		if (target !== HELPER_TARGET)
			return [
				row(
					"sim-helper",
					"warn",
					`no helper for ${target} in this version — \`warden ui\` / \`warden e2e\` cannot drive iOS simulators on this Mac`
				),
			];

		const located = helperLocator.locate({
			env: ctx.env,
			execPath: deps.execPath,
			importDir: deps.importDir,
			wardenHome: storeLocator.wardenHome(ctx.env),
			version: deps.version,
			exists: deps.exists,
			realpath: deps.realpath,
		});
		if (!located.success) {
			// the driver's own hint says "run `warden doctor`", which is what is running: keep only the WARDEN_SIMD half
			const message = located.error.message.replace(DOCTOR_HINT, "set WARDEN_SIMD=/path/to/warden-simd");
			return [row("sim-helper", "warn", `${message} — or fetch it: \`warden doctor --fetch-helper\``)];
		}
		const { path, source } = located.data;
		const info = this.helperInfo(deps, path);
		const build = info ? ` — warden-simd ${info.version}, idb ${info.idb}, xcode ${info.xcode}` : "";
		const rows = [row("sim-helper", "ok", `${path} (${source})${build}`)];

		const udid = await this.firstBootedSim(ctx);
		if (!udid) return [...rows, row("sim-helper-health", "ok", "no booted iOS simulator to probe")];
		const health = await ctx.exec([path, "--health", "--udid", udid], { timeoutMs: HEALTH_TIMEOUT_MS });
		const standalone = this.healthRow(health.stdout, health.exitCode, health.stderr, udid);
		const socketPath = join(storeLocator.wardenHome(ctx.env), "simd", `${udid}.sock`);
		const { status, detail } =
			(standalone.status === "ok" && (await this.runningHelperRow(deps, socketPath, udid))) || standalone;
		return [...rows, row("sim-helper-health", status, detail)];
	}
}

export const doctorHelper = new DoctorHelper();

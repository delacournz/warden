import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverError, DriverResult, Orientation } from "@delacour/warden-driver/driver.types";
import { driverErrors } from "@delacour/warden-driver/errors";
import type { Exec, ExecResult } from "@delacour/warden-runtime/exec";
import { simctlArgv } from "../simctl";

/**
 * What the iPhone driver asks `xcrun devicectl device …` for because the XCUITest runner cannot: install /
 * uninstall / listing, the screenshot and orientation fallbacks, the appearance and pasteboard reads. Argv builders
 * are pure; `DevicectlClient` binds them to an injected `Exec`. devicectl prints its JSON only to a file
 * (`--json-output`), so commands that answer data run in a private temp directory.
 */

const BASE = ["xcrun", "devicectl", "device"] as const;

const SHORT_MS = 30_000;
const INSTALL_MS = 10 * 60_000;
const SCREENSHOT_MS = 30_000;

/** The `xcrun devicectl device …` argv builders. Use the shared {@link devicectlArgv} singleton. */
export class DevicectlArgv {
	install(udid: string, appPath: string, json: string): string[] {
		return [...BASE, "install", "app", ...this.device(udid), appPath, "--json-output", json];
	}

	uninstall(udid: string, bundleId: string, json: string): string[] {
		return [...BASE, "uninstall", "app", ...this.device(udid), bundleId, "--json-output", json];
	}

	/** `--include-default-apps`: system apps (Settings) are listed too, so a probe of one is not a false negative. */
	apps(udid: string, bundleId: string, json: string): string[] {
		return [
			...BASE,
			"info",
			"apps",
			...this.device(udid),
			"--bundle-id",
			bundleId,
			"--include-default-apps",
			"--json-output",
			json,
		];
	}

	appearance(udid: string, json: string): string[] {
		return [...BASE, "info", "appearance", ...this.device(udid), "--json-output", json];
	}

	orientation(udid: string, orientation: Orientation): string[] {
		return [...BASE, "orientation", "set", ...this.device(udid), orientation];
	}

	screenshot(udid: string, destination: string): string[] {
		return [...BASE, "capture", "screenshot", ...this.device(udid), "--destination", destination];
	}

	paste(udid: string): string[] {
		return [...BASE, "pasteboard", "paste", ...this.device(udid)];
	}

	private device(udid: string): string[] {
		return ["--device", udid];
	}
}

export const devicectlArgv = new DevicectlArgv();

export type DevicectlOptions = {
	udid: string;
	exec: Exec;
	/** a fresh private directory for `--json-output` files and screenshots */
	makeDir?: () => Promise<string>;
	read?: (path: string) => Promise<string>;
	readBytes?: (path: string) => Promise<Uint8Array>;
	remove?: (dir: string) => Promise<void>;
};

export type Devicectl = {
	install(appPath: string): DriverResult<{ bundleIds: string[] }>;
	uninstall(bundleId: string): DriverResult<void>;
	isInstalled(bundleId: string): DriverResult<boolean>;
	appearance(): DriverResult<"light" | "dark">;
	setOrientation(orientation: Orientation): DriverResult<void>;
	/** to `path` when given, else the PNG bytes */
	screenshot(path?: string): DriverResult<{ path?: string; png?: Uint8Array }>;
	pasteboardCopy(text: string): DriverResult<void>;
	pasteboardPaste(): DriverResult<string>;
};

const LOCKED = /locked|unlock|passcode/i;

/** Maps a failed devicectl call to a `DriverError`. Use the shared {@link devicectlErrors} singleton. */
export class DevicectlErrors {
	/** A failed devicectl call: a locked phone cannot be retried, anything else is an I/O failure with devicectl's own words. */
	fromResult(what: string, result: ExecResult): DriverError {
		const text = `${result.stderr}\n${result.stdout}`.trim();
		const line = text.split("\n").find((l) => l.trim() !== "") ?? `exit ${result.exitCode}`;
		if (LOCKED.test(text)) {
			return driverErrors.make("E_DEVICE_LOCKED", `devicectl ${what}: ${line.trim()}`, { retryable: false });
		}
		return driverErrors.make("E_IO", `devicectl ${what} failed: ${line.trim()}`);
	}
}

export const devicectlErrors = new DevicectlErrors();

/** `xcrun devicectl` bound to one device and an injected `Exec`. */
export class DevicectlClient implements Devicectl {
	private readonly udid: string;
	private readonly exec: Exec;
	private readonly makeDir: () => Promise<string>;
	private readonly read: (path: string) => Promise<string>;
	private readonly readBytes: (path: string) => Promise<Uint8Array>;
	private readonly remove: (dir: string) => Promise<void>;

	constructor(o: DevicectlOptions) {
		this.udid = o.udid;
		this.exec = o.exec;
		this.makeDir = o.makeDir ?? (() => mkdtemp(join(tmpdir(), "warden-devicectl-")));
		this.read = o.read ?? ((path: string) => readFile(path, "utf8"));
		this.readBytes = o.readBytes ?? (async (path: string) => new Uint8Array(await readFile(path)));
		this.remove = o.remove ?? ((dir: string) => rm(dir, { recursive: true, force: true }));
	}

	async install(appPath: string): DriverResult<{ bundleIds: string[] }> {
		const done = await this.json("install app", (out) => devicectlArgv.install(this.udid, appPath, out), INSTALL_MS);
		if (!done.success) return done;
		return { success: true, data: { bundleIds: this.stringsOf(done.data.installedApplications, "bundleID") } };
	}

	async uninstall(bundleId: string): DriverResult<void> {
		const done = await this.json("uninstall app", (out) => devicectlArgv.uninstall(this.udid, bundleId, out), SHORT_MS);
		return done.success ? { success: true, data: undefined } : done;
	}

	async isInstalled(bundleId: string): DriverResult<boolean> {
		const done = await this.json("info apps", (out) => devicectlArgv.apps(this.udid, bundleId, out), SHORT_MS);
		if (!done.success) return done;
		return { success: true, data: this.stringsOf(done.data.apps, "bundleIdentifier").includes(bundleId) };
	}

	async appearance(): DriverResult<"light" | "dark"> {
		const done = await this.json("info appearance", (out) => devicectlArgv.appearance(this.udid, out), SHORT_MS);
		if (!done.success) return done;
		const style = done.data.userInterfaceStyle;
		if (style === "light" || style === "dark") return { success: true, data: style };
		return {
			success: false,
			error: driverErrors.make("E_IO", `devicectl info appearance: no light/dark style (${String(style)})`),
		};
	}

	async setOrientation(orientation: Orientation): DriverResult<void> {
		const done = await this.plain("orientation set", devicectlArgv.orientation(this.udid, orientation), SHORT_MS);
		return done.success ? { success: true, data: undefined } : done;
	}

	screenshot(path?: string): DriverResult<{ path?: string; png?: Uint8Array }> {
		if (path !== undefined) {
			return this.plain("capture screenshot", devicectlArgv.screenshot(this.udid, path), SCREENSHOT_MS).then((done) =>
				done.success ? { success: true as const, data: { path } } : done
			);
		}
		return this.inTempDir(async (dir) => {
			const file = join(dir, "screenshot.png");
			const done = await this.plain("capture screenshot", devicectlArgv.screenshot(this.udid, file), SCREENSHOT_MS);
			if (!done.success) return done;
			return { success: true as const, data: { png: await this.readBytes(file) } };
		});
	}

	async pasteboardCopy(text: string): DriverResult<void> {
		const done = await this.plain("pasteboard copy", simctlArgv.devicectlPbcopy(this.udid, text), SHORT_MS);
		return done.success ? { success: true, data: undefined } : done;
	}

	async pasteboardPaste(): DriverResult<string> {
		const done = await this.plain("pasteboard paste", devicectlArgv.paste(this.udid), SHORT_MS);
		return done.success ? { success: true, data: done.data.stdout } : done;
	}

	private async inTempDir<T>(use: (dir: string) => Promise<T>): Promise<T> {
		const dir = await this.makeDir();
		try {
			return await use(dir);
		} finally {
			await this.remove(dir).catch(() => undefined);
		}
	}

	/** Runs a command that writes a JSON document to the path `argv` is built with; answers `result`. */
	private json(
		what: string,
		argv: (out: string) => string[],
		timeoutMs: number
	): DriverResult<Record<string, unknown>> {
		return this.inTempDir(async (dir) => {
			const out = join(dir, "out.json");
			const ran = await this.exec(argv(out), { timeoutMs });
			if (ran.exitCode !== 0) return { success: false as const, error: devicectlErrors.fromResult(what, ran) };
			try {
				return { success: true as const, data: this.resultOf(JSON.parse(await this.read(out))) };
			} catch (error) {
				const why = error instanceof Error ? error.message : String(error);
				return {
					success: false as const,
					error: driverErrors.make("E_IO", `devicectl ${what}: unreadable output (${why})`),
				};
			}
		});
	}

	private async plain(what: string, argv: string[], timeoutMs: number): DriverResult<ExecResult> {
		const ran = await this.exec(argv, { timeoutMs });
		return ran.exitCode === 0
			? { success: true, data: ran }
			: { success: false, error: devicectlErrors.fromResult(what, ran) };
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null;
	}

	private resultOf(document: unknown): Record<string, unknown> {
		return this.isRecord(document) && this.isRecord(document.result) ? document.result : {};
	}

	private stringsOf(list: unknown, key: string): string[] {
		if (!Array.isArray(list)) return [];
		return list.flatMap((entry: unknown) => {
			const value = this.isRecord(entry) ? entry[key] : undefined;
			return typeof value === "string" ? [value] : [];
		});
	}
}

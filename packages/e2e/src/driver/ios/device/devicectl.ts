import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "@delacour/warden-core/exec";
import type { DriverError, DriverResult, Orientation } from "../../driver.types";
import { driverError } from "../../errors";
import { devicectlPbcopyArgv } from "../simctl";

/**
 * What the iPhone driver asks `xcrun devicectl device …` for because the XCUITest runner cannot: install /
 * uninstall / listing, the screenshot and orientation fallbacks, the appearance and pasteboard reads. Argv builders
 * are pure; `createDevicectl` binds them to an injected `Exec`. devicectl prints its JSON only to a file
 * (`--json-output`), so commands that answer data run in a private temp directory.
 */

const BASE = ["xcrun", "devicectl", "device"] as const;

const SHORT_MS = 30_000;
const INSTALL_MS = 10 * 60_000;
const SCREENSHOT_MS = 30_000;

const device = (udid: string): string[] => ["--device", udid];

export const installArgv = (udid: string, appPath: string, json: string): string[] => [
	...BASE,
	"install",
	"app",
	...device(udid),
	appPath,
	"--json-output",
	json,
];
export const uninstallArgv = (udid: string, bundleId: string, json: string): string[] => [
	...BASE,
	"uninstall",
	"app",
	...device(udid),
	bundleId,
	"--json-output",
	json,
];
/** `--include-default-apps`: system apps (Settings) are listed too, so a probe of one is not a false negative. */
export const appsArgv = (udid: string, bundleId: string, json: string): string[] => [
	...BASE,
	"info",
	"apps",
	...device(udid),
	"--bundle-id",
	bundleId,
	"--include-default-apps",
	"--json-output",
	json,
];
export const appearanceArgv = (udid: string, json: string): string[] => [
	...BASE,
	"info",
	"appearance",
	...device(udid),
	"--json-output",
	json,
];
export const orientationArgv = (udid: string, orientation: Orientation): string[] => [
	...BASE,
	"orientation",
	"set",
	...device(udid),
	orientation,
];
export const screenshotArgv = (udid: string, destination: string): string[] => [
	...BASE,
	"capture",
	"screenshot",
	...device(udid),
	"--destination",
	destination,
];
export const pasteArgv = (udid: string): string[] => [...BASE, "pasteboard", "paste", ...device(udid)];

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

/** A failed devicectl call: a locked phone cannot be retried, anything else is an I/O failure with devicectl's own words. */
export function devicectlError(what: string, result: ExecResult): DriverError {
	const text = `${result.stderr}\n${result.stdout}`.trim();
	const line = text.split("\n").find((l) => l.trim() !== "") ?? `exit ${result.exitCode}`;
	if (LOCKED.test(text)) {
		return driverError("E_DEVICE_LOCKED", `devicectl ${what}: ${line.trim()}`, { retryable: false });
	}
	return driverError("E_IO", `devicectl ${what} failed: ${line.trim()}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function resultOf(document: unknown): Record<string, unknown> {
	return isRecord(document) && isRecord(document.result) ? document.result : {};
}

function stringsOf(list: unknown, key: string): string[] {
	if (!Array.isArray(list)) return [];
	return list.flatMap((entry: unknown) => {
		const value = isRecord(entry) ? entry[key] : undefined;
		return typeof value === "string" ? [value] : [];
	});
}

export function createDevicectl(o: DevicectlOptions): Devicectl {
	const { udid, exec } = o;
	const makeDir = o.makeDir ?? (() => mkdtemp(join(tmpdir(), "warden-devicectl-")));
	const read = o.read ?? ((path: string) => readFile(path, "utf8"));
	const readBytes = o.readBytes ?? (async (path: string) => new Uint8Array(await readFile(path)));
	const remove = o.remove ?? ((dir: string) => rm(dir, { recursive: true, force: true }));

	async function inTempDir<T>(use: (dir: string) => Promise<T>): Promise<T> {
		const dir = await makeDir();
		try {
			return await use(dir);
		} finally {
			await remove(dir).catch(() => undefined);
		}
	}

	/** Runs a command that writes a JSON document to the path `argv` is built with; answers `result`. */
	function json(
		what: string,
		argv: (out: string) => string[],
		timeoutMs: number
	): DriverResult<Record<string, unknown>> {
		return inTempDir(async (dir) => {
			const out = join(dir, "out.json");
			const ran = await exec(argv(out), { timeoutMs });
			if (ran.exitCode !== 0) return { success: false as const, error: devicectlError(what, ran) };
			try {
				return { success: true as const, data: resultOf(JSON.parse(await read(out))) };
			} catch (error) {
				const why = error instanceof Error ? error.message : String(error);
				return { success: false as const, error: driverError("E_IO", `devicectl ${what}: unreadable output (${why})`) };
			}
		});
	}

	async function plain(what: string, argv: string[], timeoutMs: number): DriverResult<ExecResult> {
		const ran = await exec(argv, { timeoutMs });
		return ran.exitCode === 0 ? { success: true, data: ran } : { success: false, error: devicectlError(what, ran) };
	}

	return {
		async install(appPath) {
			const done = await json("install app", (out) => installArgv(udid, appPath, out), INSTALL_MS);
			if (!done.success) return done;
			return { success: true, data: { bundleIds: stringsOf(done.data.installedApplications, "bundleID") } };
		},
		async uninstall(bundleId) {
			const done = await json("uninstall app", (out) => uninstallArgv(udid, bundleId, out), SHORT_MS);
			return done.success ? { success: true, data: undefined } : done;
		},
		async isInstalled(bundleId) {
			const done = await json("info apps", (out) => appsArgv(udid, bundleId, out), SHORT_MS);
			if (!done.success) return done;
			return { success: true, data: stringsOf(done.data.apps, "bundleIdentifier").includes(bundleId) };
		},
		async appearance() {
			const done = await json("info appearance", (out) => appearanceArgv(udid, out), SHORT_MS);
			if (!done.success) return done;
			const style = done.data.userInterfaceStyle;
			if (style === "light" || style === "dark") return { success: true, data: style };
			return {
				success: false,
				error: driverError("E_IO", `devicectl info appearance: no light/dark style (${String(style)})`),
			};
		},
		async setOrientation(orientation) {
			const done = await plain("orientation set", orientationArgv(udid, orientation), SHORT_MS);
			return done.success ? { success: true, data: undefined } : done;
		},
		screenshot(path) {
			if (path !== undefined) {
				return plain("capture screenshot", screenshotArgv(udid, path), SCREENSHOT_MS).then((done) =>
					done.success ? { success: true as const, data: { path } } : done
				);
			}
			return inTempDir(async (dir) => {
				const file = join(dir, "screenshot.png");
				const done = await plain("capture screenshot", screenshotArgv(udid, file), SCREENSHOT_MS);
				if (!done.success) return done;
				return { success: true as const, data: { png: await readBytes(file) } };
			});
		},
		async pasteboardCopy(text) {
			const done = await plain("pasteboard copy", devicectlPbcopyArgv(udid, text), SHORT_MS);
			return done.success ? { success: true, data: undefined } : done;
		},
		async pasteboardPaste() {
			const done = await plain("pasteboard paste", pasteArgv(udid), SHORT_MS);
			return done.success ? { success: true, data: done.data.stdout } : done;
		},
	};
}

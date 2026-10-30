import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { Exec, ExecResult } from "../exec";
import { classifyRunnerOutput } from "../ios-runner/classify";
import type { InstalledApp } from "./resolve";

/**
 * Installing on a physical iPhone: `xcrun devicectl device install app | info apps | uninstall app`. devicectl prints
 * its JSON only to a file (`--json-output`), so each call runs with a private temp directory. Argv builders are pure;
 * the effects (exec, the temp directory) are injected.
 */

const BASE = ["xcrun", "devicectl", "device"] as const;
const SHORT_MS = 30_000;
const INSTALL_MS = 10 * 60_000;

/** The temp-file effects of a devicectl call. */
export type DeviceIo = {
	/** a fresh private directory */
	tempDir: () => Promise<string>;
	read: (path: string) => Promise<string>;
	remove: (dir: string) => Promise<void>;
};

export const nodeDeviceIo: DeviceIo = {
	tempDir: () => mkdtemp(join(tmpdir(), "warden-devicectl-")),
	read: (path) => readFile(path, "utf8"),
	remove: (dir) => rm(dir, { recursive: true, force: true }),
};

export type PhoneDeps = { exec: Exec; io?: DeviceIo };

export const phoneInstallArgv = (udid: string, appPath: string, json: string): string[] => [
	...BASE,
	"install",
	"app",
	"--device",
	udid,
	appPath,
	"--json-output",
	json,
];

export const phoneUninstallArgv = (udid: string, bundleId: string, json: string): string[] => [
	...BASE,
	"uninstall",
	"app",
	"--device",
	udid,
	bundleId,
	"--json-output",
	json,
];

export const phoneAppsArgv = (udid: string, bundleId: string, json: string): string[] => [
	...BASE,
	"info",
	"apps",
	"--device",
	udid,
	"--bundle-id",
	bundleId,
	"--json-output",
	json,
];

const LOCKED = /device (is )?locked|is locked|passcode|unlock/i;
const NOT_IN_PROFILE =
	/0xe800801[0-9a-f]|provisioning profile.*(doesn'?t|does not|not) include|(doesn'?t|does not) include (this|the) device|device is not (included|registered)/i;

/**
 * A failed devicectl call in words: a locked phone, a phone the provisioning profile does not list, or one of the
 * classified signing / device states (`classifyRunnerOutput`), each with what to do; else devicectl's first line.
 */
export function describePhoneFailure(what: string, res: ExecResult): string {
	const text = `${res.stderr}\n${res.stdout}`.trim();
	if (LOCKED.test(text)) return `${what} failed: device_locked: unlock the phone and run the command again`;
	if (NOT_IN_PROFILE.test(text)) {
		return `${what} failed: device_not_in_profile: the app's provisioning profile does not list this phone. warden registers a phone with a build for it when it can; if this stays, check the phone is listed in your team's Devices, then \`warden builds rm\` the device build and retry`;
	}
	const known = classifyRunnerOutput(text);
	if (known) return `${what} failed: ${known.code}: ${known.message}. ${known.hint}`;
	const line = text.split("\n").find((l) => l.trim() !== "") ?? `exit ${res.exitCode}`;
	return `${what} failed: ${line.trim()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Run a devicectl command that writes its answer to the `--json-output` path; the document's `result`. */
async function devicectlJson(
	deps: PhoneDeps,
	what: string,
	argv: (json: string) => string[],
	timeoutMs: number
): AsyncResult<Record<string, unknown>> {
	const io = deps.io ?? nodeDeviceIo;
	const dir = await io.tempDir();
	try {
		const out = join(dir, "out.json");
		const res = await deps.exec(argv(out), { timeoutMs });
		if (res.exitCode !== 0) return err(describePhoneFailure(what, res));
		try {
			const doc: unknown = JSON.parse(await io.read(out));
			return ok(isRecord(doc) && isRecord(doc.result) ? doc.result : {});
		} catch (error) {
			return err(`${what}: unreadable devicectl output (${error instanceof Error ? error.message : String(error)})`);
		}
	} finally {
		await io.remove(dir).catch(() => undefined);
	}
}

/** Is `bundleId` on the phone, and which `CFBundleVersion` does it have? */
export async function probePhone(deps: PhoneDeps, udid: string, bundleId: string): AsyncResult<InstalledApp> {
	const done = await devicectlJson(
		deps,
		"devicectl info apps",
		(json) => phoneAppsArgv(udid, bundleId, json),
		SHORT_MS
	);
	if (!done.success) return done;
	const apps = Array.isArray(done.data.apps) ? done.data.apps : [];
	const app = apps.find((a) => isRecord(a) && a.bundleIdentifier === bundleId);
	if (!isRecord(app)) return ok({ present: false });
	return ok({ present: true, ...(typeof app.bundleVersion === "string" ? { version: app.bundleVersion } : {}) });
}

/** Install `appPath`, then confirm `bundleId` is there. */
export async function installOnPhone(
	deps: PhoneDeps,
	udid: string,
	appPath: string,
	bundleId: string
): AsyncResult<InstalledApp> {
	const done = await devicectlJson(
		deps,
		"devicectl install app",
		(json) => phoneInstallArgv(udid, appPath, json),
		INSTALL_MS
	);
	if (!done.success) return done;
	const present = await probePhone(deps, udid, bundleId);
	if (!present.success) return present;
	if (!present.data.present) {
		return err(`installed ${appPath} on ${udid} but ${bundleId} is not there — wrong bundle id in config?`);
	}
	return present;
}

/** Remove `bundleId` (the app under test) from the phone. */
export async function uninstallFromPhone(deps: PhoneDeps, udid: string, bundleId: string): AsyncResult<void> {
	const done = await devicectlJson(
		deps,
		"devicectl uninstall app",
		(json) => phoneUninstallArgv(udid, bundleId, json),
		SHORT_MS
	);
	return done.success ? ok(undefined) : done;
}

/** `CFBundleVersion` of an `.app` (one `plutil` spawn); undefined when it cannot be read. */
export async function appBundleVersion(exec: Exec, appDir: string): Promise<string | undefined> {
	const res = await exec(["plutil", "-extract", "CFBundleVersion", "raw", "-o", "-", join(appDir, "Info.plist")]);
	const version = res.stdout.trim();
	return res.exitCode === 0 && version !== "" ? version : undefined;
}

/**
 * Is the app on the phone the cached build? The install record already named this build's key; this adds the
 * `CFBundleVersion` the phone reports against the cached `.app`'s. Anything unreadable counts as a mismatch
 * (a reinstall is the safe side).
 */
export async function phoneAppMatches(exec: Exec, cachedApp: string, installed: InstalledApp): Promise<boolean> {
	if (installed.version === undefined) return false;
	return installed.version === (await appBundleVersion(exec, cachedApp));
}

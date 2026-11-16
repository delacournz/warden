import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_PASSKEY_MODE,
	DEFAULT_PASSKEY_UV,
	isPasskeyMode,
	isPasskeyUv,
	PASSKEY_PROVIDER_PACKAGE,
	type PasskeyCredential,
	type PasskeyMode,
	type PasskeyProviderSettings,
	type PasskeyUv,
} from "@delacour/warden-core/conditions/conditions.types";
import {
	filterPasskeys,
	passkeyStorePath,
	publicPasskey,
	readPasskeyStore,
	writePasskeyStore,
} from "@delacour/warden-core/conditions/passkey-store";
import type { AsyncResult, Result } from "@delacour/warden-types/result";
import type { Driver, DriverError, DriverResult, Element, PasskeyState } from "../driver.types";
import { driverErr } from "../errors";
import { loadPasskeysApk, type PasskeysApkMeta, type PasskeysApkSource } from "./passkeys-apk";
import { PASSKEYS_APK } from "./passkeys-apk.generated";
import { detectPasskeySheet, type SheetAction, sheetAction } from "./passkeys-sheet";

/**
 * The virtual authenticator on an Android emulator (API 34+): warden's credential provider app
 * (`passkeys-apk.generated.ts`, built from `native/android/passkeys`) installed on the device and enabled as the
 * credential provider through the secure settings `credential_service` / `credential_service_primary`. The app
 * keeps the mode, the UV behaviour and the credentials in its own store; this driver talks to it with
 * `content call` (the provider accepts the shell only) and mirrors its credential list into
 * `$WARDEN_HOME/passkeys/<serial>/store.json` after every change (`passkey-store.ts`).
 *
 * `previousProvider` is read before the settings are first changed and returned on that op, so the lease record can
 * restore it on release (`conditions/undo.ts`); an empty-string value (what a past uninstall leaves) counts as unset.
 * `off` keeps the app and its credentials and sets its mode to `off` (it then offers nothing and warden leaves the
 * system sheets alone); release uninstalls it. The Credential Manager sheet is `sheetFor` / `passkeys-sheet.ts`.
 */

export const PASSKEYS_MIN_SDK = 34;
const COMPONENT = `${PASSKEY_PROVIDER_PACKAGE}/${PASSKEY_PROVIDER_PACKAGE}.WardenPasskeyService`;
const AUTHORITY = `content://${PASSKEY_PROVIDER_PACKAGE}`;

export type PasskeysApk = PasskeysApkMeta & {
	packageName: string;
	versionName: string;
};

type Shelled = { ok: boolean; stdout: string };

export type AndroidPasskeysDeps = {
	serial: string;
	wardenHome: string;
	/** a command on the device shell */
	shell(argv: readonly string[]): Promise<Shelled>;
	/** `ro.build.version.sdk`, when the driver knows it */
	sdk: () => Promise<number | undefined>;
	/** `adb install -r <apk>` on this device */
	install(path: string): DriverResult<void>;
	/** default `PASSKEYS_APK` */
	apk?: PasskeysApk;
	/** the APK's bytes (default `loadPasskeysApk`: env, cache, workspace file, release asset) */
	load?: (apk: PasskeysApkMeta) => AsyncResult<{ bytes: Uint8Array; source: PasskeysApkSource }>;
	/** default `Date.now` */
	now?: () => number;
};

/** What the provider app reports: its whole store. */
type ProviderStore = { mode: PasskeyMode | "off"; uv: PasskeyUv; credentials: PasskeyCredential[] };

type SetOrAdd = Extract<Parameters<Driver["passkeys"]>[0], { kind: "set" | "add" }>;

export type AndroidPasskeys = {
	op: Driver["passkeys"];
	/** what to do with the screen, when it shows the Credential Manager sheet; undefined = not a passkey sheet, or not warden's to answer */
	sheetFor(flat: readonly Element[]): Promise<SheetAction | undefined>;
};

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** `settings get` prints `null` for an unset key; an empty value is what an uninstall leaves: both are "unset". */
function settingValue(stdout: string): string | null {
	const value = stdout.trim();
	return value === "" || value === "null" ? null : value;
}

function parseStore(raw: unknown): ProviderStore | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { mode, uv, credentials } = raw as Record<string, unknown>;
	if (typeof mode !== "string" || (mode !== "off" && !isPasskeyMode(mode))) return undefined;
	if (typeof uv !== "string" || !isPasskeyUv(uv) || !Array.isArray(credentials)) return undefined;
	return { mode: mode as ProviderStore["mode"], uv, credentials: credentials as PasskeyCredential[] };
}

export function createAndroidPasskeys(deps: AndroidPasskeysDeps): AndroidPasskeys {
	const apk = deps.apk ?? PASSKEYS_APK;
	const storePath = passkeyStorePath(deps.wardenHome, deps.serial);

	async function sdkOk(): DriverResult<void> {
		const sdk = await deps.sdk();
		if (sdk !== undefined && sdk >= PASSKEYS_MIN_SDK) return { success: true, data: undefined };
		return driverErr(
			"E_PASSKEY_API",
			`passkeys need Android ${PASSKEYS_MIN_SDK - 20} (API ${PASSKEYS_MIN_SDK}) or later${sdk === undefined ? "" : `, this device is API ${sdk}`}`,
			{ retryable: false, detail: { serial: deps.serial, sdk } }
		);
	}

	async function installedVersion(): Promise<string | undefined> {
		const dumped = await deps.shell(["dumpsys", "package", apk.packageName]);
		return /^\s*versionName=(\S+)/m.exec(dumped.stdout)?.[1];
	}

	async function readSetting(key: string): Promise<string | null> {
		return settingValue((await deps.shell(["settings", "get", "secure", key])).stdout);
	}

	const isEnabled = async (): Promise<boolean> =>
		((await readSetting("credential_service")) ?? "").split(":").includes(COMPONENT);

	/** `content call` on the provider app: its store after the call, or why not. */
	async function call(method: string, extras: readonly string[] = [], arg?: string): DriverResult<ProviderStore> {
		const argv = [
			"content",
			"call",
			"--uri",
			AUTHORITY,
			"--method",
			method,
			...(arg === undefined ? [] : ["--arg", arg]),
			...extras.flatMap((extra) => ["--extra", extra]),
		];
		const done = await deps.shell(argv);
		const text = done.stdout.trim();
		const failure = /error=([\s\S]*?)\}\]$/.exec(text)?.[1];
		const result = /result=([\s\S]*)\}\]$/.exec(text)?.[1];
		if (!done.ok || failure !== undefined || result === undefined) {
			return driverErr("E_IO", `passkey provider ${method}: ${failure ?? (text || "no answer")}`, {
				detail: { serial: deps.serial },
			});
		}
		let parsed: ProviderStore | undefined;
		try {
			parsed = parseStore(JSON.parse(result));
		} catch {
			parsed = undefined;
		}
		return parsed === undefined
			? driverErr("E_IO", `passkey provider ${method}: unreadable store ${result.slice(0, 120)}`, {
					detail: { serial: deps.serial },
				})
			: { success: true, data: parsed };
	}

	function mirror(credentials: readonly PasskeyCredential[]): Result<void, DriverError> {
		const written = writePasskeyStore(storePath, credentials);
		const back = written.success ? readPasskeyStore(storePath) : written;
		if (back.success) return { success: true, data: undefined };
		return driverErr("E_PASSKEY_STORE", back.error, { retryable: false, detail: { serial: deps.serial } });
	}

	/** The credentials warden keeps for this device, for ops that need no device. */
	function hostStore(): Result<PasskeyCredential[], DriverError> {
		const read = readPasskeyStore(storePath);
		return read.success ? read : driverErr("E_PASSKEY_STORE", read.error, { retryable: false });
	}

	/** The APK on the host, next to the lease's other passkey files. */
	async function stageApk(): DriverResult<string> {
		const loaded = await (deps.load ?? ((meta) => loadPasskeysApk(meta)))(apk);
		if (!loaded.success) return driverErr("E_IO", `cannot get warden-passkeys: ${loaded.error}`);
		const file = join(deps.wardenHome, "passkeys", `provider-${apk.versionName}.apk`);
		try {
			mkdirSync(join(deps.wardenHome, "passkeys"), { recursive: true });
			const tmp = `${file}.${process.pid}.tmp`;
			writeFileSync(tmp, loaded.data.bytes);
			renameSync(tmp, file);
			return { success: true, data: file };
		} catch (error) {
			return driverErr(
				"E_IO",
				`cannot stage the passkey provider app: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/** A replaced install lost its store: put the host store's credentials back. */
	async function reseed(): DriverResult<void> {
		const kept = readPasskeyStore(storePath);
		if (!kept.success) return { success: true, data: undefined };
		for (const credential of kept.data) {
			const added = await call("add", [`b64:s:${b64(JSON.stringify(credential))}`]);
			if (!added.success) return added;
		}
		return { success: true, data: undefined };
	}

	/** Install the app when it is missing or from other sources. */
	async function ensureInstalled(): DriverResult<void> {
		const have = await installedVersion();
		if (have === apk.versionName) return { success: true, data: undefined };
		if (have !== undefined) await deps.shell(["pm", "uninstall", apk.packageName]);
		const staged = await stageApk();
		if (!staged.success) return staged;
		const installed = await deps.install(staged.data);
		if (!installed.success) return installed;
		return have === undefined ? installed : reseed();
	}

	/** Make warden's app the credential provider; returns the settings it replaced, only when this call replaced them. */
	async function enable(): DriverResult<PasskeyProviderSettings | undefined> {
		if (await isEnabled()) return { success: true, data: undefined };
		const previous: PasskeyProviderSettings = {
			service: await readSetting("credential_service"),
			primary: await readSetting("credential_service_primary"),
		};
		for (const key of ["credential_service", "credential_service_primary"]) {
			const put = await deps.shell(["settings", "put", "secure", key, COMPONENT]);
			if (!put.ok)
				return driverErr("E_IO", `settings put secure ${key}: ${put.stdout.trim()}`, {
					detail: { serial: deps.serial },
				});
		}
		return { success: true, data: previous };
	}

	function view(
		store: ProviderStore,
		enabled: boolean,
		filter?: { rpId?: string; withKeys?: boolean },
		previousProvider?: PasskeyProviderSettings
	): PasskeyState {
		return {
			enabled: enabled && store.mode !== "off",
			mode: store.mode === "off" ? DEFAULT_PASSKEY_MODE : store.mode,
			uv: store.uv,
			credentials: filterPasskeys(store.credentials, filter?.rpId).map((c) =>
				publicPasskey(c, filter?.withKeys === true)
			),
			...(previousProvider === undefined ? {} : { previousProvider }),
		};
	}

	/** A device whose provider is not there: the state is the host store with the authenticator off. */
	async function idle(filter?: { rpId?: string; withKeys?: boolean }): DriverResult<PasskeyState> {
		const credentials = hostStore();
		if (!credentials.success) return credentials;
		return {
			success: true,
			data: view({ mode: "off", uv: DEFAULT_PASSKEY_UV, credentials: credentials.data }, false, filter),
		};
	}

	type Filter = { rpId?: string; withKeys?: boolean };

	async function read(filter: Filter | undefined, installed: boolean): DriverResult<PasskeyState> {
		if (!installed || !(await isEnabled())) return idle(filter);
		const store = await call("list");
		return store.success ? { success: true, data: view(store.data, true, filter) } : store;
	}

	async function off(installed: boolean): DriverResult<PasskeyState> {
		if (!installed) return idle();
		const store = await call("setMode", ["mode:s:off"]);
		return store.success ? { success: true, data: view(store.data, false) } : store;
	}

	async function drop(credentialId: string | undefined, installed: boolean): DriverResult<PasskeyState> {
		if (!installed) return idle();
		const store = credentialId === undefined ? await call("clear") : await call("remove", [], credentialId);
		if (!store.success) return store;
		const mirrored = mirror(store.data.credentials);
		return mirrored.success ? { success: true, data: view(store.data, await isEnabled()) } : mirrored;
	}

	const op: Driver["passkeys"] = async (request) => {
		const api = await sdkOk();
		if (!api.success) return api;
		const installed = (await installedVersion()) !== undefined;
		switch (request.kind) {
			case "status":
				return read(undefined, installed);
			case "list":
				return read(request, installed);
			case "off":
				return off(installed);
			case "remove":
				return drop(request.credentialId, installed);
			case "clear":
				return drop(undefined, installed);
			case "set":
			case "add":
				return apply(request);
		}
	};

	/** The op's change on the provider app, given the store it has now. */
	function change(request: SetOrAdd, current: ProviderStore): DriverResult<ProviderStore> {
		if (request.kind === "add") return call("add", [`b64:s:${b64(JSON.stringify(request.credential))}`]);
		const mode = request.mode ?? (current.mode === "off" ? DEFAULT_PASSKEY_MODE : current.mode);
		return call("setMode", [`mode:s:${mode}`, `uv:s:${request.uv ?? current.uv}`]);
	}

	async function apply(request: SetOrAdd): DriverResult<PasskeyState> {
		const ready = await ensureInstalled();
		if (!ready.success) return ready;
		const enabled = await enable();
		if (!enabled.success) return enabled;
		const current = await call("list");
		if (!current.success) return current;
		const store = await change(request, current.data);
		if (!store.success) return store;
		const mirrored = mirror(store.data.credentials);
		if (!mirrored.success) return mirrored;
		return { success: true, data: view(store.data, true, undefined, enabled.data) };
	}

	async function sheetFor(flat: readonly Element[]): Promise<SheetAction | undefined> {
		const sheet = detectPasskeySheet(flat);
		if (sheet === null) return undefined;
		if (!(await isEnabled())) return undefined;
		const store = await call("list");
		if (!store.success) return undefined;
		const action = sheetAction(sheet, flat, store.data.mode, store.data.credentials);
		return action.do === "tap" ? action : undefined;
	}

	return { op, sheetFor };
}

import { afterAll, setDefaultTimeout } from "bun:test";
import { defaultDriverFactory } from "./driver/open";
import { readEnv } from "./env";
import { E2eError } from "./errors";
import { defaultFixtureFactory } from "./runner/fixtures";
import { BUN_TIMEOUT_MARGIN_MS, onlyWasSeen } from "./runner/scope";
import {
	getSession,
	hasDefaultDriverFactory,
	hasDefaultFixtureFactory,
	setDefaultDriverFactory,
	setDefaultFixtureFactory,
} from "./session";
import { WARDEN_E2E_VERSION, WORKSPACE_VERSION } from "./version";

export { BUN_TIMEOUT_MARGIN_MS };

export type PreloadDeps = {
	env: Readonly<Record<string, string | undefined>>;
	setDefaultTimeout: (ms: number) => void;
	afterAll: (fn: () => Promise<void>) => void;
	createSession: typeof getSession;
	/** this package's version (`WARDEN_E2E_VERSION`) */
	version: string;
	/** whether a `test.only` was collected */
	onlySeen: () => boolean;
	stderr: (text: string) => void;
	exit: (code: number) => void;
};

/**
 * The protocol handshake: `warden e2e` and this package version in lock-step. A mismatch is a warning, not an
 * error (most pairs still work), but the install fix is spelled out. Nothing to compare without `WARDEN_VERSION`
 * (a by-hand run) or from the workspace sources (not a published build).
 */
export function versionMismatch(wardenVersion: string | undefined, e2eVersion: string): string | undefined {
	if (wardenVersion === undefined || wardenVersion === e2eVersion || e2eVersion === WORKSPACE_VERSION) return undefined;
	return `warden e2e: @delacour/warden-e2e ${e2eVersion} does not match warden ${wardenVersion}; install the matching version: bun add -d @delacour/warden-e2e@${wardenVersion}`;
}

/** `CI=1`, `CI=true`, … — anything but empty, `0` and `false`. */
export function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
	const value = env.CI;
	return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/**
 * `bun test --preload`: a no-op without `WARDEN_UDID` (safe in `bunfig.toml`); otherwise validates
 * the env (exit 2 when invalid), raises bun's default timeout above the test timeout, opens the
 * session eagerly and, in `afterAll`, closes it and (under `CI`) fails the run if a `.only` was collected.
 */
export function installPreload(deps: PreloadDeps): void {
	const read = readEnv(deps.env);
	if (!read.success) {
		deps.stderr(`warden e2e: invalid environment\n${read.error}\n`);
		deps.exit(2);
		return;
	}
	if (read.data === undefined) return;
	const warning = versionMismatch(read.data.wardenVersion, deps.version);
	if (warning !== undefined) deps.stderr(`${warning}\n`);
	deps.setDefaultTimeout(read.data.timeoutMs + BUN_TIMEOUT_MARGIN_MS);
	const session = deps.createSession({ env: read.data });
	deps.afterAll(async () => {
		await session.close();
		if (isCi(deps.env) && deps.onlySeen()) {
			throw new E2eError("INVALID_ARGUMENT", "test.only / test(..., { only: true }) is not allowed in CI");
		}
	});
}

if (!hasDefaultDriverFactory()) setDefaultDriverFactory(defaultDriverFactory);
if (!hasDefaultFixtureFactory()) setDefaultFixtureFactory(defaultFixtureFactory);
installPreload({
	env: process.env,
	setDefaultTimeout,
	afterAll,
	createSession: getSession,
	version: WARDEN_E2E_VERSION,
	onlySeen: onlyWasSeen,
	stderr: (text) => {
		process.stderr.write(text);
	},
	exit: (code) => process.exit(code),
});

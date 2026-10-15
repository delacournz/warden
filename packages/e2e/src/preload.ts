import { afterAll, setDefaultTimeout } from "bun:test";
import { defaultDriverFactory } from "./driver/open";
import { readEnv } from "./env";
import { E2eError } from "./errors";
import { defaultFixtureFactory } from "./fixtures";
import { BUN_TIMEOUT_MARGIN_MS, onlyWasSeen } from "./runner/scope";
import {
	getSession,
	hasDefaultDriverFactory,
	hasDefaultFixtureFactory,
	setDefaultDriverFactory,
	setDefaultFixtureFactory,
} from "./session";

export { BUN_TIMEOUT_MARGIN_MS };

export type PreloadDeps = {
	env: Readonly<Record<string, string | undefined>>;
	setDefaultTimeout: (ms: number) => void;
	afterAll: (fn: () => Promise<void>) => void;
	createSession: typeof getSession;
	/** whether a `test.only` was collected */
	onlySeen: () => boolean;
	stderr: (text: string) => void;
	exit: (code: number) => void;
};

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
	onlySeen: onlyWasSeen,
	stderr: (text) => {
		process.stderr.write(text);
	},
	exit: (code) => process.exit(code),
});

import { afterAll, setDefaultTimeout } from "bun:test";
import { readEnv } from "./env";
import { getSession } from "./session";

/** Headroom over the per-test timeout so warden's `AbortSignal` deadline fires before bun's own. */
export const BUN_TIMEOUT_MARGIN_MS = 30_000;

export type PreloadDeps = {
	env: Readonly<Record<string, string | undefined>>;
	setDefaultTimeout: (ms: number) => void;
	afterAll: (fn: () => Promise<void>) => void;
	createSession: typeof getSession;
	stderr: (text: string) => void;
	exit: (code: number) => void;
};

/**
 * `bun test --preload`: a no-op without `WARDEN_UDID` (safe in `bunfig.toml`); otherwise validates
 * the env (exit 2 when invalid), raises bun's default timeout above the test timeout, opens the
 * session eagerly and closes it in `afterAll`.
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
	deps.afterAll(() => session.close());
}

installPreload({
	env: process.env,
	setDefaultTimeout,
	afterAll,
	createSession: getSession,
	stderr: (text) => {
		process.stderr.write(text);
	},
	exit: (code) => process.exit(code),
});

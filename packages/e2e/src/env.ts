import type { Result } from "@delacour/warden-types/result";
import { z } from "zod";

/** The env names `warden e2e` writes and the spec process reads (`apps/cli` imports these). */
export const ENV_NAMES = {
	udid: "WARDEN_UDID",
	deviceName: "WARDEN_DEVICE_NAME",
	platform: "WARDEN_PLATFORM",
	bundleId: "WARDEN_BUNDLE_ID",
	appPath: "WARDEN_APP_PATH",
	metroUrl: "WARDEN_METRO_URL",
	launchArgs: "WARDEN_LAUNCH_ARGS",
	out: "WARDEN_E2E_OUT",
	timeout: "WARDEN_E2E_TIMEOUT",
	actionTimeout: "WARDEN_E2E_ACTION_TIMEOUT",
	assertionTimeout: "WARDEN_E2E_ASSERTION_TIMEOUT",
	flowsDir: "WARDEN_E2E_FLOWS_DIR",
	helperDir: "WARDEN_HELPER_DIR",
	simd: "WARDEN_SIMD",
	simdSocket: "WARDEN_SIMD_SOCKET",
	headless: "WARDEN_HEADLESS",
	logTimestamps: "WARDEN_LOG_TIMESTAMPS",
	worker: "WARDEN_WORKER",
	/** the `warden` that started this process: the preload refuses to run when it is not this package's version */
	version: "WARDEN_VERSION",
} as const;

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
export const DEFAULT_ASSERTION_TIMEOUT_MS = 5_000;

type EnvKey = keyof typeof ENV_NAMES;

const toggle = z.enum(["1", "true", "0", "false"]).transform((v) => v === "1" || v === "true");
const millis = z
	.string()
	.regex(/^\d+$/, "must be a whole number of milliseconds")
	.transform(Number)
	.pipe(z.number().int().positive());

const launchArgs = z.string().transform((raw, ctx): string[] => {
	try {
		const parsed = z.array(z.string()).safeParse(JSON.parse(raw));
		if (parsed.success) return parsed.data;
	} catch {
		// falls through to the issue below
	}
	ctx.addIssue({ code: "custom", message: "must be a JSON array of strings" });
	return z.NEVER;
});

const REQUIRED = "required when WARDEN_UDID is set";

const schema = z.object({
	udid: z.string().min(1),
	deviceName: z.string().optional(),
	platform: z.enum(["ios", "android"]).default("ios"),
	bundleId: z.string({ error: REQUIRED }).min(1, REQUIRED),
	appPath: z.string().optional(),
	metroUrl: z.string().optional(),
	launchArgs: launchArgs.default([]),
	out: z.string().optional(),
	timeout: millis.default(DEFAULT_TIMEOUT_MS),
	actionTimeout: millis.default(DEFAULT_ACTION_TIMEOUT_MS),
	assertionTimeout: millis.default(DEFAULT_ASSERTION_TIMEOUT_MS),
	flowsDir: z.string().optional(),
	helperDir: z.string().optional(),
	simd: z.string().optional(),
	simdSocket: z.string().optional(),
	headless: toggle.default(false),
	logTimestamps: toggle.default(false),
	worker: z.string().optional(),
	version: z.string().optional(),
});

export type E2eEnv = {
	udid: string;
	/** the leased device's name: pins devtools to its own Metro inspector page when several devices share one Metro */
	deviceName?: string;
	platform: "ios" | "android";
	bundleId: string;
	appPath?: string;
	metroUrl?: string;
	launchArgs: string[];
	/** where `results.jsonl` and per-attempt artifacts go (may be relative to cwd) */
	out: string;
	timeoutMs: number;
	actionTimeoutMs: number;
	assertionTimeoutMs: number;
	flowsDir?: string;
	helperDir?: string;
	simd?: string;
	simdSocket?: string;
	/** nothing in this package reads it: kept for specs and helpers that honour a headless run (`guides/headless`) */
	headless: boolean;
	/** warden already stamps the log lines: the spec reporter prints no clock of its own */
	logTimestamps: boolean;
	/** nothing in this package reads it: the 0-based worker index, for specs that shard or name per-worker data (`guides/e2e`) */
	worker?: string;
	/** `WARDEN_VERSION`: the warden that started this run */
	wardenVersion?: string;
};

type Parsed = z.infer<typeof schema>;

/** Drops `undefined` values so optional fields are absent rather than `undefined`. */
function defined<T extends Record<string, string | undefined>>(values: T): Partial<T> {
	return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function toEnv(v: Parsed, now: () => Date): E2eEnv {
	return {
		udid: v.udid,
		platform: v.platform,
		bundleId: v.bundleId,
		launchArgs: v.launchArgs,
		out: v.out ?? `.warden-e2e/${now().toISOString()}`,
		timeoutMs: v.timeout,
		actionTimeoutMs: v.actionTimeout,
		assertionTimeoutMs: v.assertionTimeout,
		headless: v.headless,
		logTimestamps: v.logTimestamps,
		...defined({
			deviceName: v.deviceName,
			appPath: v.appPath,
			metroUrl: v.metroUrl,
			flowsDir: v.flowsDir,
			helperDir: v.helperDir,
			simd: v.simd,
			simdSocket: v.simdSocket,
			worker: v.worker,
			wardenVersion: v.version,
		}),
	};
}

const isEnvKey = (key: unknown): key is EnvKey => typeof key === "string" && key in ENV_NAMES;

/**
 * Reads the spec env contract. `undefined` data = not running under warden (no `WARDEN_UDID`); an
 * error lists every invalid variable by its env name. Empty values count as unset.
 */
export function readEnv(
	env: Readonly<Record<string, string | undefined>>,
	opts: { now?: () => Date } = {}
): Result<E2eEnv | undefined> {
	const udid = env[ENV_NAMES.udid];
	if (udid === undefined || udid === "") return { success: true, data: undefined };

	const raw: Record<string, string | undefined> = {};
	for (const [key, name] of Object.entries(ENV_NAMES)) {
		const value = env[name];
		raw[key] = value === undefined || value === "" ? undefined : value;
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		const lines = parsed.error.issues.map((issue) => {
			const key = issue.path[0];
			return `${isEnvKey(key) ? ENV_NAMES[key] : String(key)}: ${issue.message}`;
		});
		return { success: false, error: lines.join("\n") };
	}
	return { success: true, data: toEnv(parsed.data, opts.now ?? (() => new Date())) };
}

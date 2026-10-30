import { type ConditionsConfig, parseConditionsEnv } from "@delacour/warden-core/conditions/conditions.config";
import type { Result } from "@delacour/warden-types/result";
import { z } from "zod";

/**
 * The env names `warden e2e` writes and the spec process reads (`apps/cli` imports these). `WARDEN_HEADLESS` and
 * `WARDEN_WORKER` are also set for the spec process but are for the spec's own tools (`process.env`): nothing here
 * reads them, so a bad value cannot fail spec-env validation.
 */
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
	specsDir: "WARDEN_E2E_SPECS_DIR",
	helperDir: "WARDEN_HELPER_DIR",
	simd: "WARDEN_SIMD",
	simdSocket: "WARDEN_SIMD_SOCKET",
	logTimestamps: "WARDEN_LOG_TIMESTAMPS",
	/**
	 * JSON argv (`{udid}` is replaced) the session runs after it rebooted the sim following a lost HID connection;
	 * `warden` sets it for non-headless runs so the sim's viewer window comes back (packages/e2e cannot import apps/cli)
	 */
	afterReboot: "WARDEN_AFTER_REBOOT",
	/** the `warden` that started this process: the preload refuses to run when it is not this package's version */
	version: "WARDEN_VERSION",
	/** JSON argv that re-runs the `warden` that started this process (`device.perf` shells out to it) */
	bin: "WARDEN_BIN",
	/** `warden e2e --perf`: the capture flags (`all`, or a comma list like `react,js`) every attempt records */
	perf: "WARDEN_PERF",
	/** JSON of the suite's `perf.budgets`; a breach fails the test with `PERF_BUDGET` */
	perfBudgets: "WARDEN_PERF_BUDGETS",
	/** JSON of the suite's `conditions` (network / location / clock applied before each spec, the rest reported as not applied) */
	conditions: "WARDEN_CONDITIONS",
	/** the id of the lease holding `WARDEN_UDID`: conditions a spec sets are recorded on it and its shaping proxy hangs off it */
	leaseId: "WARDEN_LEASE_ID",
	/** JSON argv that runs the shaping proxy (`warden __netproxy`) when specs run from a compiled `warden`; the JSON argument is appended */
	netproxyCommand: "WARDEN_NETPROXY_COMMAND",
	/** `1` when the suite's devices are biometrics devices: the session enrolls an iOS sim again before the app is installed */
	biometrics: "WARDEN_BIOMETRICS",
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

const conditions = z.string().transform((raw, ctx): ConditionsConfig => {
	const parsed = parseConditionsEnv(raw);
	if (parsed.success) return parsed.data;
	ctx.addIssue({ code: "custom", message: parsed.error });
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
	specsDir: z.string().optional(),
	helperDir: z.string().optional(),
	simd: z.string().optional(),
	simdSocket: z.string().optional(),
	logTimestamps: toggle.default(false),
	afterReboot: launchArgs.optional(),
	version: z.string().optional(),
	bin: z.string().optional(),
	perf: z.string().optional(),
	perfBudgets: z.string().optional(),
	conditions: conditions.optional(),
	leaseId: z.string().min(1).optional(),
	netproxyCommand: launchArgs.pipe(z.array(z.string()).min(1)).optional(),
	biometrics: toggle.optional(),
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
	specsDir?: string;
	helperDir?: string;
	simd?: string;
	simdSocket?: string;
	/** warden already stamps the log lines: the spec reporter prints no clock of its own */
	logTimestamps: boolean;
	/** `WARDEN_AFTER_REBOOT`: argv run after a HID-loss reboot, `{udid}` not yet replaced (see `runAfterReboot`) */
	afterReboot?: string[];
	/** `WARDEN_VERSION`: the warden that started this run */
	wardenVersion?: string;
	/** `WARDEN_BIN`: argv of the `warden` that started this run */
	wardenBin?: string[];
	/** `WARDEN_PERF`: capture names every attempt records (`all`, `react`, `js`…) */
	perf?: string[];
	/** `WARDEN_PERF_BUDGETS`: raw JSON of the suite's budgets */
	perfBudgets?: string;
	/** `WARDEN_CONDITIONS`: what every spec starts from (`conditions/suite-conditions.ts` applies it) */
	conditions?: ConditionsConfig;
	/** `WARDEN_LEASE_ID`: the device's lease; absent under a bare `bun test`, where network shaping is unsupported */
	leaseId?: string;
	/** `WARDEN_NETPROXY_COMMAND`: argv that starts the shaping proxy; absent from source (`bun netproxy.main.ts`) */
	netproxyCommand?: string[];
	/** `WARDEN_BIOMETRICS`: this is a biometrics device (profile `<p>+bio`); iOS enrollment does not survive a reboot or a spec's `unenroll` */
	biometrics?: boolean;
};

type Parsed = z.infer<typeof schema>;

/** Drops `undefined` values so optional fields are absent rather than `undefined`. */
function defined<T extends Record<string, string | undefined>>(values: T): Partial<T> {
	return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** `WARDEN_BIN` is a JSON array; a bare path counts as a one-word command. */
function parseArgv(raw: string): string[] {
	try {
		const parsed = z.array(z.string()).min(1).safeParse(JSON.parse(raw));
		if (parsed.success) return parsed.data;
	} catch {
		// a plain path
	}
	return [raw];
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
		logTimestamps: v.logTimestamps,
		...defined({
			deviceName: v.deviceName,
			appPath: v.appPath,
			metroUrl: v.metroUrl,
			specsDir: v.specsDir,
			helperDir: v.helperDir,
			simd: v.simd,
			simdSocket: v.simdSocket,
			wardenVersion: v.version,
			perfBudgets: v.perfBudgets,
		}),
		...(v.conditions === undefined ? {} : { conditions: v.conditions }),
		...(v.leaseId === undefined ? {} : { leaseId: v.leaseId }),
		...(v.netproxyCommand === undefined ? {} : { netproxyCommand: v.netproxyCommand }),
		...(v.biometrics === true ? { biometrics: true } : {}),
		...(v.afterReboot === undefined ? {} : { afterReboot: v.afterReboot }),
		...(v.bin === undefined ? {} : { wardenBin: parseArgv(v.bin) }),
		...(v.perf === undefined
			? {}
			: {
					perf: v.perf
						.split(",")
						.map((p) => p.trim())
						.filter((p) => p !== ""),
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

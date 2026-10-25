/** Pinned `trace_processor_shell` prebuilts (Perfetto's published artifacts). Bump `TRACE_PROCESSOR_VERSION` and every hash together. */
export const TRACE_PROCESSOR_VERSION = "v58.2";

export const TRACE_PROCESSOR_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;
export type TraceProcessorTarget = (typeof TRACE_PROCESSOR_TARGETS)[number];

export type TraceProcessorPin = {
	/** directory name in Perfetto's artifact bucket */
	artifact: "mac-arm64" | "mac-amd64" | "linux-amd64" | "linux-arm64";
	sha256: string;
	bytes: number;
};

export const TRACE_PROCESSOR_PINS: Record<TraceProcessorTarget, TraceProcessorPin> = {
	"darwin-arm64": {
		artifact: "mac-arm64",
		sha256: "d29864d1ba3b36855527bb1b0ca3aa7f703cdce338b9680bb922c5c151b358fa",
		bytes: 13_597_976,
	},
	"darwin-x64": {
		artifact: "mac-amd64",
		sha256: "3927a2767eadd140db3ff4fe0dfbf1bde35c1f56501149cd367f5cee898bef27",
		bytes: 14_854_504,
	},
	"linux-x64": {
		artifact: "linux-amd64",
		sha256: "58042408e6cc861fb1a731c26bb082dc222285561eaa4e12a48a8b2b90dca7b9",
		bytes: 14_897_560,
	},
	"linux-arm64": {
		artifact: "linux-arm64",
		sha256: "0e6e0c5452c505c8d46fe472fd196a0d17d963460727e2ce2013b02aa1309555",
		bytes: 14_086_160,
	},
};

const BASE_URL = "https://commondatastorage.googleapis.com/perfetto-luci-artifacts";

/** The pin for `platform`/`arch` (Node's `process.platform`/`process.arch` spellings), or undefined when none is published. */
export function traceProcessorPin(
	platform: string,
	arch: string
): { target: TraceProcessorTarget; pin: TraceProcessorPin } | undefined {
	const target = `${platform}-${arch}`;
	if (!(TRACE_PROCESSOR_TARGETS as readonly string[]).includes(target)) return undefined;
	const key = target as TraceProcessorTarget;
	return { target: key, pin: TRACE_PROCESSOR_PINS[key] };
}

export function traceProcessorUrl(pin: TraceProcessorPin): string {
	return `${BASE_URL}/${TRACE_PROCESSOR_VERSION}/${pin.artifact}/trace_processor_shell`;
}

/** File name in `$WARDEN_HOME/tools/`. */
export const traceProcessorFileName = (): string => `trace_processor_shell-${TRACE_PROCESSOR_VERSION}`;

import { z } from "zod";
import { type JsCdp, type JsResult, jsCdpReader, jsResultFactory } from "./js.types";

export const DEFAULT_SAMPLING_INTERVAL_US = 100;

const STOP_TIMEOUT_MS = 60_000;

const callFrameSchema = z.looseObject({
	functionName: z.string().default(""),
	scriptId: z.union([z.string(), z.number()]).optional(),
	url: z.string().default(""),
	lineNumber: z.number().optional(),
	columnNumber: z.number().optional(),
});

const nodeSchema = z.looseObject({
	id: z.number(),
	callFrame: callFrameSchema,
	hitCount: z.number().optional(),
	children: z.array(z.number()).optional(),
});

/** Chrome `.cpuprofile`: opens in Chrome DevTools and speedscope. */
export const cpuProfileSchema = z.looseObject({
	nodes: z.array(nodeSchema).min(1),
	startTime: z.number(),
	endTime: z.number(),
	samples: z.array(z.number()).default([]),
	timeDeltas: z.array(z.number()).default([]),
});

export type CpuProfile = z.infer<typeof cpuProfileSchema>;
export type CpuProfileNode = CpuProfile["nodes"][number];
export type CallFrame = CpuProfileNode["callFrame"];

export type ProfileStart = {
	samplingIntervalUs: number;
	/** the device's `Date.now()` just before `Profiler.start` (alignment anchor) */
	deviceWallMs: number | undefined;
};

const NO_PROFILER_HINT =
	"this Hermes build has no Profiler domain: use a dev client on a recent React Native (Hermes with the Fusebox debugger)";

export class CpuProfileCapture {
	/** The profile inside a `Profiler.stop` reply (`{ profile }`), validated. */
	parseStopReply(reply: unknown): JsResult<CpuProfile> {
		const profile = typeof reply === "object" && reply !== null && "profile" in reply ? reply.profile : reply;
		const parsed = cpuProfileSchema.safeParse(profile);
		if (!parsed.success) {
			return jsResultFactory.err(
				"invalid_profile",
				`Profiler.stop returned no usable cpuprofile: ${parsed.error.issues[0]?.message}`
			);
		}
		return jsResultFactory.ok(parsed.data);
	}

	/**
	 * `Profiler.enable`, `Profiler.setSamplingInterval`, `Profiler.start`. Only `start` has to work: a runtime without
	 * `enable` or `setSamplingInterval` still samples (at its own rate).
	 */
	async startProfile(cdp: JsCdp, options: { samplingIntervalUs?: number } = {}): Promise<JsResult<ProfileStart>> {
		const samplingIntervalUs = options.samplingIntervalUs ?? DEFAULT_SAMPLING_INTERVAL_US;
		await cdp.send("Profiler.enable");
		await cdp.send("Profiler.setSamplingInterval", { interval: samplingIntervalUs });
		const deviceWallMs = await jsCdpReader.readDeviceWallMs(cdp);
		const started = await cdp.send("Profiler.start");
		if (!started.success) {
			return jsCdpReader.isUnsupported(started.error)
				? jsResultFactory.err("unsupported", `Profiler.start: ${started.error.message}`, NO_PROFILER_HINT)
				: jsResultFactory.err("cdp_failed", `Profiler.start: ${started.error.message}`);
		}
		return jsResultFactory.ok({ samplingIntervalUs, deviceWallMs });
	}

	/** `Profiler.stop` and validate the profile. A JS reload since `startProfile` loses the profile (stop then fails). */
	async stopProfile(cdp: JsCdp): Promise<JsResult<CpuProfile>> {
		const stopped = await cdp.send("Profiler.stop", {}, { timeoutMs: STOP_TIMEOUT_MS });
		if (!stopped.success) {
			return jsCdpReader.isUnsupported(stopped.error)
				? jsResultFactory.err("unsupported", `Profiler.stop: ${stopped.error.message}`, NO_PROFILER_HINT)
				: jsResultFactory.err(
						"cdp_failed",
						`Profiler.stop: ${stopped.error.message}`,
						"the app may have reloaded or crashed during the capture; start again"
					);
		}
		await cdp.send("Profiler.disable");
		return this.parseStopReply(stopped.data);
	}
}

export const cpuProfileCapture = new CpuProfileCapture();

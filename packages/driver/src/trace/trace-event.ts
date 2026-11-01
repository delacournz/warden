import { z } from "zod";

const base = { ts: z.number(), kind: z.string(), label: z.string() };

export const traceEventSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("step-start"), ...base }),
	z.object({
		type: z.literal("step-end"),
		...base,
		status: z.enum(["passed", "failed"]),
		ms: z.number(),
		error: z.string().optional(),
	}),
	z.object({ type: z.literal("screenshot"), ...base, path: z.string() }),
	z.object({ type: z.literal("note"), ...base }),
	z.object({
		type: z.literal("span"),
		/** epoch ms the call started; `ts + ms` is when it ended. Written when it ends, so file order is not `ts` order. */
		ts: z.number(),
		/** `<layer>.<call>`: `driver.snapshot`, `device.settle`, `read.isVisible` */
		op: z.string(),
		ms: z.number(),
		ok: z.boolean(),
		/** the error code of a failed call (`E_TIMEOUT`, `TIMEOUT`, …) */
		code: z.string().optional(),
		/** scalars the call left for its span: settle `via`/`reason`, adb time, the dump route */
		detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
	}),
]);

/** One line of `trace.jsonl`; `ts` is epoch ms, `kind` the step family (`app`, `locator`, `expect`, …). */
export type TraceEvent = z.infer<typeof traceEventSchema>;

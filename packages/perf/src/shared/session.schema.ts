import { z } from "zod";

export const SESSION_FILE = "session.json";

const SESSION_ID = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `<yyyymmdd-hhmmss>-<hash6>`, UTC, so ids sort by start time and never depend on the host's zone. */
export function formatSessionId(nowMs: number, hash6: string): string {
	const d = new Date(nowMs);
	const date = `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
	const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
	return `${date}-${time}-${hash6}`;
}

/** Only ids `formatSessionId` makes are accepted, so an id from argv can never walk out of the perf dir. */
export function isSessionId(value: string): boolean {
	return SESSION_ID.test(value);
}

export const CAPTURER_KINDS = ["collector", "metrics", "frames", "logs", "js", "react", "native", "startup"] as const;

const capturerSchema = z.object({
	kind: z.enum(CAPTURER_KINDS),
	pid: z.number().optional(),
	startedAtIso: z.string(),
	out: z.string().optional(),
	state: z.enum(["running", "stopped", "failed"]),
});

const markSchema = z.object({ label: z.string(), wallMs: z.number(), atMs: z.number() });

export const STOP_REASONS = ["user", "max-duration", "stale", "device-released"] as const;

export const sessionSchema = z.object({
	version: z.literal(1),
	id: z.string().regex(SESSION_ID),
	device: z.object({ udid: z.string(), platform: z.enum(["ios", "android"]), name: z.string().optional() }),
	/** who held the device when the session began: what the report says about observe vs mutate */
	target: z.object({ udid: z.string(), holder: z.string().optional(), ownedByCaller: z.boolean() }),
	app: z.object({ id: z.string(), source: z.enum(["flag", "foreground", "config"]) }).optional(),
	/** `wallMs` host clock at start; `deviceWallMs` the device clock read at the same moment (alignment anchor) */
	startedAt: z.object({ wallMs: z.number(), deviceWallMs: z.number().optional() }),
	maxDurationMs: z.number(),
	status: z.enum(["running", "stopped", "aborted"]),
	stoppedAt: z.number().optional(),
	stopReason: z.enum(STOP_REASONS).optional(),
	capturers: z.array(capturerSchema),
	marks: z.array(markSchema),
});

export type PerfSession = z.infer<typeof sessionSchema>;
export type Capturer = PerfSession["capturers"][number];
export type Mark = PerfSession["marks"][number];

export function parseSession(raw: unknown): { success: true; data: PerfSession } | { success: false; error: string } {
	const parsed = sessionSchema.safeParse(raw);
	return parsed.success
		? { success: true, data: parsed.data }
		: { success: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

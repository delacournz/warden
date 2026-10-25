import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../agent-ui/state";
import type { CommandContext } from "../context";
import { sessionDir } from "./paths";

export const PLAN_FILE = "plan.json";

/**
 * What `perf start` asked of a session: the detached collector reads it to know which long-lived captures to host,
 * and `perf stop` to know what to gather and which lease to give back.
 */
export const planSchema = z.object({
	version: z.literal(1),
	app: z.string(),
	cwd: z.string(),
	metrics: z.boolean(),
	frames: z.boolean(),
	logs: z.boolean(),
	js: z.boolean(),
	react: z.boolean(),
	/** `--native[=flavor]`: the recorder `perf start` itself armed (flavor "" = the platform default) */
	native: z.object({ flavor: z.string() }).optional(),
	/** the app was relaunched: JS and React wait for the new process's Metro target */
	relaunch: z.boolean(),
	metroUrl: z.string().optional(),
	/** a lease `perf start` took for the session: `perf stop` gives it back */
	leaseId: z.string().optional(),
});

export type PerfPlan = z.infer<typeof planSchema>;

export function writePlan(ctx: Pick<CommandContext, "env">, id: string, plan: PerfPlan): void {
	const dir = sessionDir(ctx, id);
	mkdirSync(dir, { recursive: true });
	writeFileAtomic(join(dir, PLAN_FILE), `${JSON.stringify(plan, null, 2)}\n`);
}

/** `plan.json` of a session; undefined when missing or malformed. */
export function readPlan(ctx: Pick<CommandContext, "env">, id: string): PerfPlan | undefined {
	try {
		const parsed = planSchema.safeParse(JSON.parse(readFileSync(join(sessionDir(ctx, id), PLAN_FILE), "utf8")));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

/** Rewrite one session's plan (e.g. record the lease taken). */
export function updatePlan(
	ctx: Pick<CommandContext, "env">,
	id: string,
	change: (plan: PerfPlan) => PerfPlan
): PerfPlan | undefined {
	const current = readPlan(ctx, id);
	if (current === undefined) return undefined;
	const next = change(current);
	writePlan(ctx, id, next);
	return next;
}

import type { Command as Commander } from "@commander-js/extra-typings";
import { ok } from "@delacour/warden-types/result";
import { uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { withPerfOptions } from "./options";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";
import { activeSessionFor, updateSession } from "./session";

/** `+3.2s` */
const offset = (ms: number): string => `+${(ms / 1000).toFixed(1)}s`;

/** `warden perf mark <label…>`: annotate the device's active session; commits, hangs and jank are tagged with the last mark before them. */
export function perfMark(
	ctx: CommandContext,
	deps: PerfDeps,
	words: readonly string[],
	opts: PerfOptionValues
): Promise<number> {
	return runPerf(ctx, deps, "mark", "observe", opts, async (target) => {
		const label = words.join(" ").trim();
		if (label === "") return { success: false, error: uiError("usage", "a mark needs a label") };
		const session = activeSessionFor(ctx, deps.session, target.udid);
		if (session === undefined) {
			return {
				success: false,
				error: uiError("session_not_found", `no active perf session on ${target.udid}`, {
					hint: "warden perf start (marks only land in a running session)",
				}),
			};
		}
		const wallMs = ctx.now();
		const atMs = wallMs - session.startedAt.wallMs;
		updateSession(ctx, session.id, (s) => ({ ...s, marks: [...s.marks, { label, wallMs, atMs }] }));
		const info = { udid: target.udid, platform: target.platform, name: target.name };
		return ok({
			device: info,
			result: { sessionId: session.id, label, atMs },
			text: `${ctx.ui.color.green("marked")} "${label}" at ${offset(atMs)} ${ctx.ui.color.dim(session.id)}`,
		});
	});
}

/** Wire `mark` onto `warden perf`. */
export function registerMark(cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void {
	withPerfOptions(
		cmd
			.command("mark")
			.description("annotate the running session's timeline (commits, hangs and jank are tagged with the last mark)")
			.argument("<label...>", "what is about to happen, e.g. scroll feed")
	).action(async (label, opts) => {
		done(await perfMark(ctx, deps, label, opts));
	});
}

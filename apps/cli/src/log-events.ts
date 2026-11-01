import type { WardenLogEvent } from "@delacour/warden-types/host";
import type { CommandContext } from "./context";
import { output } from "./output";

/** The fingerprint banner's rule. */
const RULE = "────────────────────────────────────────────────────────";

/** The `[warden] …` lines of a cache-key announcement (a hash that differs from EAS's never finds a build). */
function fingerprintLines(ctx: CommandContext, event: Extract<WardenLogEvent, { kind: "fingerprint" }>): string[] {
	const { color } = ctx.ui;
	const rule = color.dim(RULE);
	const lines = [rule, `${event.platform} fingerprint: ${color.bold(event.key)}`];
	if (event.js !== undefined && event.native !== undefined) {
		lines.push(color.dim(`  native ${event.native} + js ${event.js} (fingerprint.include native+js)`));
	}
	const variant = event.variant === undefined ? "" : ` variant ${event.variant}`;
	lines.push(`project ${event.project}${variant} (${event.projectKey})`, rule);
	return lines.map((line) => `[warden] ${line}`);
}

/**
 * Render one engine log event on the command's stderr, with the exact text the engine printed before it
 * emitted events. Progress `phase` picks the prefix: `raw` verbatim, `app` `[warden] …`, `golden`
 * `warden …`, anything else `warden: …`. Warnings: scope `lease` is a red command error, `headless`
 * yellow. `debug` and `lease` events are not shown.
 */
export function renderLogEvent(ctx: CommandContext, event: WardenLogEvent): void {
	switch (event.kind) {
		case "progress":
			if (event.phase === "raw") ctx.err(event.message);
			else if (event.phase === "app") ctx.err(`[warden] ${event.message}`);
			else if (event.phase === "golden") ctx.err(`warden ${event.message}`);
			else ctx.err(`warden: ${event.message}`);
			return;
		case "warn":
			if (event.scope === "lease") output.reportError(ctx, "lease", event.message);
			else if (event.scope === "headless") ctx.err(ctx.ui.color.yellow(`warden: ${event.message}`));
			else ctx.err(`warden: ${event.message}`);
			return;
		case "fingerprint":
			for (const line of fingerprintLines(ctx, event)) ctx.err(line);
			return;
		case "debug":
		case "lease":
			return;
	}
}

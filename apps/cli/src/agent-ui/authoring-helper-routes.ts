import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "@delacour/warden-e2e/authoring/journal";
import { z } from "zod";
import type { CommandContext } from "../context";
import { functionSource } from "./authoring-target";
import { helperRoutesFile } from "./paths";

/**
 * The routes a recorded helper visits, kept beside the device state (`$WARDEN_HOME/ui/helper-routes`), so a later
 * `record use` of that helper can merge them into the consuming spec's `entries`. The spec process cannot report the
 * screens a helper drives, but the recording that wrote the helper saw them. The entry is tied to the helper's source
 * (a hash of its function text): edit the function and the entry is stale, ignored until it is recorded again.
 */

const sidecarSchema = z.object({
	module: z.string(),
	fn: z.string(),
	sourceHash: z.string(),
	routes: z.array(z.string().min(1)),
});

const hashOf = (source: string): string => createHash("sha1").update(source).digest("hex");

/** The hash a sidecar is valid for: the helper's function text, else the whole module. */
export function helperSourceHash(moduleSource: string, fn: string): string {
	return hashOf(functionSource(moduleSource, fn) ?? moduleSource);
}

/** Remember the routes the helper recording visited; best effort (a read-only home just means no sidecar). */
export function saveHelperRoutes(
	ctx: Pick<CommandContext, "env">,
	module: string,
	fn: string,
	routes: readonly string[]
): void {
	if (!existsSync(module)) return;
	const file = helperRoutesFile(ctx, module, fn);
	try {
		mkdirSync(dirname(file), { recursive: true });
		const body = { module, fn, sourceHash: helperSourceHash(readFileSync(module, "utf8"), fn), routes: [...routes] };
		writeFileAtomic(file, `${JSON.stringify(body, null, 2)}\n`);
	} catch {
		return;
	}
}

/** The saved routes of `module#fn`, or undefined when none were saved or the helper changed since. */
export function loadHelperRoutes(ctx: Pick<CommandContext, "env">, module: string, fn: string): string[] | undefined {
	const file = helperRoutesFile(ctx, module, fn);
	if (!existsSync(file) || !existsSync(module)) return undefined;
	try {
		const parsed = sidecarSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
		if (!parsed.success) return undefined;
		const fresh = parsed.data.sourceHash === helperSourceHash(readFileSync(module, "utf8"), fn);
		return fresh ? parsed.data.routes : undefined;
	} catch {
		return undefined;
	}
}

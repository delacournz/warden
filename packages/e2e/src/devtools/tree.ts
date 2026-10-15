import { ok } from "@delacour/warden-types/result";
import { z } from "zod";
import {
	type DevtoolsError,
	type DevtoolsResult,
	devtoolsErr,
	type ReactTree,
	type Sleep,
	type TreeComponent,
	type TreeOptions,
} from "./devtools.types";
import { type DevtoolsSession, WARDEN_BINDING } from "./session";
import { type TreeScriptConfig, treeInstallExpression } from "./tree.script";

const DEFAULT_TIMEOUT_MS = 5_000;
const POLL_MS = 50;
const TEXT_WIDTH = 60;

/** What `fetchTree` needs of a session. */
export type TreeSession = Pick<DevtoolsSession, "evaluate" | "evaluateWithBinding" | "bindingAvailable">;

export type FetchTreeDeps = {
	/** injectable for tests; defaults to a timer */
	sleep?: Sleep;
	now?: () => number;
};

const rectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

const componentSchema = z.object({
	id: z.number(),
	name: z.string(),
	testID: z.string().optional(),
	label: z.string().optional(),
	text: z.string().optional(),
	parent: z.number().nullable(),
	rect: rectSchema.optional(),
	inactive: z.literal(true).optional(),
});

const scriptResultSchema = z.union([
	z.object({ error: z.string() }),
	z.object({ screen: z.string().optional(), components: z.array(componentSchema), truncated: z.boolean() }),
]);

const bindingPayloadSchema = z.object({ requestId: z.string(), result: z.unknown() });

const timerSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let requestCounter = 0;

function scriptError(message: string): { success: false; error: DevtoolsError } {
	if (message === "no-hook")
		return devtoolsErr("devtools_unavailable", "React DevTools hook not present (release build?)");
	if (message === "no-roots") return devtoolsErr("devtools_unavailable", "no React root is mounted yet");
	return devtoolsErr("eval_failed", `React tree script failed: ${message}`);
}

const scale = (value: number, ratio: number): number => Math.round(value * ratio * 10) / 10;

function toTree(data: unknown, pixelRatio: number): DevtoolsResult<ReactTree> {
	const parsed = scriptResultSchema.safeParse(data);
	if (!parsed.success) return devtoolsErr("cdp_protocol", `unexpected React tree payload: ${parsed.error.message}`);
	if ("error" in parsed.data) return scriptError(parsed.data.error);
	const { screen, components, truncated } = parsed.data;
	const mapped: TreeComponent[] = components.map(({ rect, ...rest }) => ({
		...rest,
		...(rect
			? {
					rect: {
						x: scale(rect.x, pixelRatio),
						y: scale(rect.y, pixelRatio),
						width: scale(rect.w, pixelRatio),
						height: scale(rect.h, pixelRatio),
					},
				}
			: {}),
	}));
	return ok({ ...(screen === undefined ? {} : { screen }), components: mapped, truncated });
}

/** Reads and removes the answer the script left in the page (a string), or null while there is none. */
const pollExpression = (requestId: string): string =>
	`(function (g) { var s = g.__warden_tree_results; var v = s && s[${JSON.stringify(requestId)}]; ` +
	`if (typeof v !== "string") return null; delete s[${JSON.stringify(requestId)}]; return v; })` +
	`(typeof globalThis !== "undefined" ? globalThis : (typeof global !== "undefined" ? global : this))`;

async function viaPolling(
	session: TreeSession,
	expression: string,
	requestId: string,
	timeoutMs: number,
	deps: Required<FetchTreeDeps>
): Promise<DevtoolsResult<unknown>> {
	const started = deps.now();
	const installed = await session.evaluate(expression, { timeoutMs });
	if (!installed.success) return devtoolsErr(installed.error.code ?? "eval_failed", installed.error.message);
	const poll = pollExpression(requestId);
	for (;;) {
		const reply = await session.evaluate(poll, { timeoutMs });
		if (!reply.success) return devtoolsErr(reply.error.code ?? "eval_failed", reply.error.message);
		if (typeof reply.data === "string") {
			try {
				return ok(JSON.parse(reply.data));
			} catch {
				return devtoolsErr("cdp_protocol", "React tree payload is not JSON");
			}
		}
		if (deps.now() - started >= timeoutMs) {
			return devtoolsErr("cdp_timeout", `the app did not report its React tree within ${timeoutMs} ms`);
		}
		await deps.sleep(POLL_MS);
	}
}

/** The answer through the CDP binding; undefined when the runtime turns out not to have it (poll instead). */
async function viaBinding(
	session: TreeSession,
	expression: string,
	requestId: string,
	timeoutMs: number
): Promise<DevtoolsResult<unknown> | undefined> {
	const reply = await session.evaluateWithBinding(expression, requestId, timeoutMs);
	if (!reply.success) return reply.error.code === "binding_unavailable" ? undefined : reply;
	const tagged = bindingPayloadSchema.safeParse(reply.data);
	return tagged.success ? ok(tagged.data.result) : devtoolsErr("cdp_protocol", "unexpected React tree binding payload");
}

/**
 * The app's React components (testID, label, text, screen) with window rects, read through the DevTools hook.
 * The page script answers through the CDP binding when the runtime has one, else the host polls a page global.
 * `pixelRatio` multiplies rects (Android reports dp, the driver speaks px).
 */
export async function fetchTree(
	session: TreeSession,
	options: TreeOptions = {},
	deps: FetchTreeDeps = {}
): Promise<DevtoolsResult<ReactTree>> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const resolved: Required<FetchTreeDeps> = { sleep: deps.sleep ?? timerSleep, now: deps.now ?? Date.now };
	requestCounter += 1;
	const requestId = `tree-${Date.now().toString(36)}-${requestCounter}`;
	const config: TreeScriptConfig = {
		requestId,
		binding: WARDEN_BINDING,
		...(options.max === undefined ? {} : { max: options.max }),
		...(options.screen === undefined ? {} : { screen: options.screen }),
		...(options.all === undefined ? {} : { all: options.all }),
	};
	const expression = treeInstallExpression(config);

	const bound = session.bindingAvailable ? await viaBinding(session, expression, requestId, timeoutMs) : undefined;
	const payload = bound ?? (await viaPolling(session, expression, requestId, timeoutMs, resolved));
	if (!payload.success) return payload;
	return toTree(payload.data, options.pixelRatio ?? 1);
}

function clip(text: string): string {
	const flat = text.replace(/\s+/g, " ");
	return flat.length > TEXT_WIDTH ? `${flat.slice(0, TEXT_WIDTH - 3)}...` : flat;
}

function describeComponent(component: TreeComponent): string {
	const parts = [component.name];
	if (component.testID !== undefined) parts.push(`testID=${component.testID}`);
	const shown = component.label ?? component.text;
	if (shown !== undefined) parts.push(`"${clip(shown)}"`);
	if (component.rect) {
		const { x, y, width, height } = component.rect;
		parts.push(`(${x},${y} ${width}×${height})`);
	}
	if (component.inactive) parts.push("[inactive]");
	return parts.join(" ");
}

export type FormatTreeOptions = {
	/** include unmeasured and inactive components (inactive ones are marked) */
	all?: boolean;
	/** lines at most; the rest is summarised in a last line */
	max?: number;
};

/** One line per component, indented by nesting: `View testID=save "Save changes" (20,700 350×48)`. */
export function formatTree(tree: ReactTree, options: FormatTreeOptions = {}): string[] {
	const depths = new Map<number, number>();
	for (const component of tree.components) {
		const parentDepth = component.parent === null ? -1 : (depths.get(component.parent) ?? -1);
		depths.set(component.id, parentDepth + 1);
	}
	const lines: string[] = [];
	for (const component of tree.components) {
		if (!options.all && (component.inactive || !component.rect)) continue;
		lines.push(`${"  ".repeat(depths.get(component.id) ?? 0)}${describeComponent(component)}`);
	}
	if (options.max !== undefined && lines.length > options.max) {
		const left = lines.length - options.max;
		return [...lines.slice(0, options.max), `... ${left} more`];
	}
	return lines;
}

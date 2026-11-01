import { resultFactory } from "@delacour/warden-types/result";
import { z } from "zod";
import {
	type DevtoolsError,
	type DevtoolsResult,
	devtoolsErrors,
	type ReactTree,
	type Sleep,
	type TreeComponent,
	type TreeOptions,
} from "./devtools.types";
import { type DevtoolsSession, WARDEN_BINDING } from "./session";
import { timer } from "./timer";
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

/** Reads the app's React tree. Use the shared {@link treeFetcher} singleton. */
export class TreeFetcher {
	private requestCounter = 0;

	/**
	 * The app's React components (testID, label, text, screen) with window rects, read through the DevTools hook.
	 * The page script answers through the CDP binding when the runtime has one, else the host polls a page global.
	 * `pixelRatio` multiplies rects (Android reports dp, the driver speaks px).
	 */
	async fetch(
		session: TreeSession,
		options: TreeOptions = {},
		deps: FetchTreeDeps = {}
	): Promise<DevtoolsResult<ReactTree>> {
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const resolved: Required<FetchTreeDeps> = { sleep: deps.sleep ?? timer.sleep, now: deps.now ?? Date.now };
		this.requestCounter += 1;
		const requestId = `tree-${Date.now().toString(36)}-${this.requestCounter}`;
		const config: TreeScriptConfig = {
			requestId,
			binding: WARDEN_BINDING,
			...(options.max === undefined ? {} : { max: options.max }),
			...(options.screen === undefined ? {} : { screen: options.screen }),
			...(options.all === undefined ? {} : { all: options.all }),
		};
		const expression = treeInstallExpression(config);

		const bound = session.bindingAvailable
			? await this.viaBinding(session, expression, requestId, timeoutMs)
			: undefined;
		const payload = bound ?? (await this.viaPolling(session, expression, requestId, timeoutMs, resolved));
		if (!payload.success) return payload;
		return this.toTree(payload.data, options.pixelRatio ?? 1);
	}

	private scriptError(message: string): { success: false; error: DevtoolsError } {
		if (message === "no-hook")
			return devtoolsErrors.err("devtools_unavailable", "React DevTools hook not present (release build?)");
		if (message === "no-roots") return devtoolsErrors.err("devtools_unavailable", "no React root is mounted yet");
		return devtoolsErrors.err("eval_failed", `React tree script failed: ${message}`);
	}

	private scale(value: number, ratio: number): number {
		return Math.round(value * ratio * 10) / 10;
	}

	private toTree(data: unknown, pixelRatio: number): DevtoolsResult<ReactTree> {
		const parsed = scriptResultSchema.safeParse(data);
		if (!parsed.success) {
			return devtoolsErrors.err("cdp_protocol", `unexpected React tree payload: ${parsed.error.message}`);
		}
		if ("error" in parsed.data) return this.scriptError(parsed.data.error);
		const { screen, components, truncated } = parsed.data;
		const mapped: TreeComponent[] = components.map(({ rect, ...rest }) => ({
			...rest,
			...(rect
				? {
						rect: {
							x: this.scale(rect.x, pixelRatio),
							y: this.scale(rect.y, pixelRatio),
							width: this.scale(rect.w, pixelRatio),
							height: this.scale(rect.h, pixelRatio),
						},
					}
				: {}),
		}));
		return resultFactory.ok({ ...(screen === undefined ? {} : { screen }), components: mapped, truncated });
	}

	/** Reads and removes the answer the script left in the page (a string), or null while there is none. */
	private pollExpression(requestId: string): string {
		return (
			`(function (g) { var s = g.__warden_tree_results; var v = s && s[${JSON.stringify(requestId)}]; ` +
			`if (typeof v !== "string") return null; delete s[${JSON.stringify(requestId)}]; return v; })` +
			`(typeof globalThis !== "undefined" ? globalThis : (typeof global !== "undefined" ? global : this))`
		);
	}

	private async viaPolling(
		session: TreeSession,
		expression: string,
		requestId: string,
		timeoutMs: number,
		deps: Required<FetchTreeDeps>
	): Promise<DevtoolsResult<unknown>> {
		const started = deps.now();
		const installed = await session.evaluate(expression, { timeoutMs });
		if (!installed.success) return devtoolsErrors.err(installed.error.code ?? "eval_failed", installed.error.message);
		const poll = this.pollExpression(requestId);
		for (;;) {
			const reply = await session.evaluate(poll, { timeoutMs });
			if (!reply.success) return devtoolsErrors.err(reply.error.code ?? "eval_failed", reply.error.message);
			if (typeof reply.data === "string") {
				try {
					return resultFactory.ok(JSON.parse(reply.data));
				} catch {
					return devtoolsErrors.err("cdp_protocol", "React tree payload is not JSON");
				}
			}
			if (deps.now() - started >= timeoutMs) {
				return devtoolsErrors.err("cdp_timeout", `the app did not report its React tree within ${timeoutMs} ms`);
			}
			await deps.sleep(POLL_MS);
		}
	}

	/** The answer through the CDP binding; undefined when the runtime turns out not to have it (poll instead). */
	private async viaBinding(
		session: TreeSession,
		expression: string,
		requestId: string,
		timeoutMs: number
	): Promise<DevtoolsResult<unknown> | undefined> {
		const reply = await session.evaluateWithBinding(expression, requestId, timeoutMs);
		if (!reply.success) return reply.error.code === "binding_unavailable" ? undefined : reply;
		const tagged = bindingPayloadSchema.safeParse(reply.data);
		return tagged.success
			? resultFactory.ok(tagged.data.result)
			: devtoolsErrors.err("cdp_protocol", "unexpected React tree binding payload");
	}
}

export const treeFetcher = new TreeFetcher();

export type FormatTreeOptions = {
	/** include unmeasured and inactive components (inactive ones are marked) */
	all?: boolean;
	/** lines at most; the rest is summarised in a last line */
	max?: number;
};

/** Renders a {@link ReactTree} as text. Use the shared {@link treeFormatter} singleton. */
export class TreeFormatter {
	/** One line per component, indented by nesting: `View testID=save "Save changes" (20,700 350×48)`. */
	format(tree: ReactTree, options: FormatTreeOptions = {}): string[] {
		const depths = new Map<number, number>();
		for (const component of tree.components) {
			const parentDepth = component.parent === null ? -1 : (depths.get(component.parent) ?? -1);
			depths.set(component.id, parentDepth + 1);
		}
		const lines: string[] = [];
		for (const component of tree.components) {
			if (!options.all && (component.inactive || !component.rect)) continue;
			lines.push(`${"  ".repeat(depths.get(component.id) ?? 0)}${this.describe(component)}`);
		}
		if (options.max !== undefined && lines.length > options.max) {
			const left = lines.length - options.max;
			return [...lines.slice(0, options.max), `... ${left} more`];
		}
		return lines;
	}

	private clip(text: string): string {
		const flat = text.replace(/\s+/g, " ");
		return flat.length > TEXT_WIDTH ? `${flat.slice(0, TEXT_WIDTH - 3)}...` : flat;
	}

	private describe(component: TreeComponent): string {
		const parts = [component.name];
		if (component.testID !== undefined) parts.push(`testID=${component.testID}`);
		const shown = component.label ?? component.text;
		if (shown !== undefined) parts.push(`"${this.clip(shown)}"`);
		if (component.rect) {
			const { x, y, width, height } = component.rect;
			parts.push(`(${x},${y} ${width}×${height})`);
		}
		if (component.inactive) parts.push("[inactive]");
		return parts.join(" ");
	}
}

export const treeFormatter = new TreeFormatter();

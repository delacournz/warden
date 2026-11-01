import { type JSONValue, type Tool, tool } from "ai";
import type { z } from "zod";
import { createWardenClient } from "../client";
import type { ClientSeams } from "../core";
import { isWardenError, sdkErrors } from "../errors";
import type {
	DeviceRef,
	ElementTarget,
	Lease,
	Platform,
	Session,
	SnapshotElement,
	Target,
	WaitCondition,
	WardenClient,
	WardenClientOptions,
} from "../sdk.types";
import {
	CORE_TOOL_NAMES,
	EXTRA_TOOL_NAMES,
	type ToolInputs,
	type ToolName,
	toolDescriptions,
	toolInputSchemas,
} from "./tools.schema";

/** Failure payload of a tool: returned to the model instead of thrown, so it can recover. */
export type ToolFailure = { ok: false; error: { code: string; message: string; hint?: string } };

/** Result of a tool: `{ok: true, ...}` or a {@link ToolFailure}. */
export type ToolResult = ({ ok: true } & Record<string, unknown>) | ToolFailure;

export type ToolSetName = "core" | "all";

/** Largest PNG (bytes) the `screenshot` tool hands the model as an image; a bigger one is returned as its path only. */
export const DEFAULT_SCREENSHOT_IMAGE_MAX_BYTES = 1_000_000;

export type CreateWardenToolsOptions = {
	/** an existing client; otherwise one is created from `clientOptions` (label `ai-sdk`) and closed by `close()` */
	client?: WardenClient;
	/** an existing session; otherwise a device is claimed and a session opened on the first tool call */
	session?: Session;
	/** platform to claim when no session is given */
	platform: Platform;
	/** app (bundle id / package) the session drives */
	app?: string;
	/** `core` (17 tools) or `all` (adds device, build, and devtools tools) */
	set: ToolSetName;
	/** tools that need a human yes before running; feed `toolApproval` to the agent / `generateText` */
	approval?: Partial<Record<ToolName, "user-approval">>;
	/** PNG size cap for the image the `screenshot` tool shows the model (default 1 MB); above it only the path is returned */
	screenshotImageMaxBytes?: number;
	/** options of the client this factory creates */
	clientOptions?: WardenClientOptions;
	/** test seams of the client this factory creates */
	clientSeams?: ClientSeams;
};

/** Tools the model can call, keyed by tool name. */
export type WardenToolSet = Partial<Record<ToolName, Tool>>;

export type WardenTools = {
	/** pass as `tools` */
	tools: WardenToolSet;
	/** pass as `toolApproval` (v7 `ai`): the `approval` option, narrowed to the tools in this set */
	toolApproval: Partial<Record<ToolName, "user-approval">>;
	client: WardenClient;
	/** the session once it exists (given, or opened by the first tool call) */
	readonly session: Session | undefined;
	/** open the session now instead of at the first tool call */
	getSession(): Promise<Session>;
	/** close what this factory created (session, client); a given client or session is left alone */
	close(): Promise<void>;
};

const STALE_HINT = "refs expire on every snapshot: run snapshot again and use the new @eN refs";
const TARGET_HINT = "pass ref (from the latest snapshot) or selector";

/** The shape `toModelOutput` returns (not re-exported by `ai`). */
type ToolResultOutput = Awaited<ReturnType<NonNullable<Tool["toModelOutput"]>>>;
type ModelContent = Extract<ToolResultOutput, { type: "content" }>["value"];

/** Pure formatting helpers of the tool results. */
class ToolFormat {
	/**
	 * What the model sees for a `screenshot` result: the path/size line plus the PNG as an image part. The base64 lives in
	 * the result's `image` field (so a resumed history still carries it) and is stripped from the text part.
	 */
	screenshotModelOutput(output: ToolResult): ToolResultOutput {
		if (!output.ok) return { type: "json", value: output as unknown as JSONValue };
		const { image, ...rest } = output as Record<string, unknown> & { image?: { mediaType: string; data: string } };
		const text: ModelContent[number] = { type: "text", text: JSON.stringify(rest) };
		if (image === undefined) return { type: "content", value: [text] };
		return {
			type: "content",
			value: [text, { type: "file", mediaType: image.mediaType, data: { type: "data", data: image.data } }],
		};
	}

	/** A caught value as the failure payload; `stale_ref` always tells the model to re-snapshot. */
	toolFailure(error: unknown, signal?: AbortSignal): ToolFailure {
		const e = isWardenError(error) ? error : sdkErrors.fromThrown(error, signal);
		const hint = e.code === "stale_ref" ? STALE_HINT : e.hint;
		return { ok: false, error: { code: e.code, message: e.message, ...(hint !== undefined ? { hint } : {}) } };
	}

	usageFailure(message: string, hint: string): ToolFailure {
		return { ok: false, error: { code: "usage", message, hint } };
	}

	elementTargetOf(input: TargetFields): ElementTarget | undefined {
		if (input.ref !== undefined) return { ref: input.ref as `@e${number}` };
		if (input.selector !== undefined) return { selector: input.selector };
		return undefined;
	}

	brief(element: SnapshotElement): string {
		const parts: string[] = [element.ref, element.role];
		if (element.label !== undefined) parts.push(JSON.stringify(element.label));
		if (element.identifier !== undefined) parts.push(`id=${element.identifier}`);
		if (element.value !== undefined) parts.push(`value=${JSON.stringify(element.value)}`);
		if (!element.enabled) parts.push("disabled");
		return parts.join(" ");
	}

	deviceRefOf(session: Session): DeviceRef {
		return session.platform === "ios" ? { udid: session.deviceId } : { serial: session.deviceId };
	}
}

const toolFormat = new ToolFormat();

type TargetFields = { ref?: string | undefined; selector?: string | undefined };

/**
 * What the model sees for a `screenshot` result: the path/size line plus the PNG as an image part. The base64 lives in
 * the result's `image` field (so a resumed history still carries it) and is stripped from the text part.
 */
export function screenshotModelOutput(output: ToolResult): ToolResultOutput {
	return toolFormat.screenshotModelOutput(output);
}

/** A caught value as the failure payload; `stale_ref` always tells the model to re-snapshot. */
export function toolFailure(error: unknown, signal?: AbortSignal): ToolFailure {
	return toolFormat.toolFailure(error, signal);
}

/**
 * Build the Vercel AI SDK tools that drive a warden session. Every tool returns `{ok: true, ...}` or
 * `{ok: false, error: {code, message, hint}}`; none throws. The session is claimed and opened lazily, on the first
 * tool call, when no `session` is given. Approval is v7 `toolApproval`: spread the returned `toolApproval` into the
 * agent or `generateText` call.
 */
class WardenToolsFactory {
	private readonly ownsClient: boolean;
	private readonly maxImageBytes: number;
	private readonly client: WardenClient;
	private current: Session | undefined;
	private ownsSession = false;
	private pending: Promise<Session> | undefined;
	private readonly done: ToolResult = { ok: true };

	constructor(private readonly options: CreateWardenToolsOptions) {
		this.ownsClient = options.client === undefined;
		this.maxImageBytes = options.screenshotImageMaxBytes ?? DEFAULT_SCREENSHOT_IMAGE_MAX_BYTES;
		this.client =
			options.client ?? createWardenClient({ label: "ai-sdk", ...options.clientOptions }, options.clientSeams ?? {});
		this.current = options.session;
	}

	create(): WardenTools {
		const { options } = this;
		const names: readonly ToolName[] =
			options.set === "all" ? [...CORE_TOOL_NAMES, ...EXTRA_TOOL_NAMES] : CORE_TOOL_NAMES;
		const tools: WardenToolSet = {};
		for (const name of names) tools[name] = this.define(name, this.build[name] as Run<typeof name>);

		const toolApproval: Partial<Record<ToolName, "user-approval">> = {};
		for (const name of names) {
			const policy = options.approval?.[name];
			if (policy) toolApproval[name] = policy;
		}

		const factory = this;
		return {
			tools,
			toolApproval,
			client: this.client,
			get session() {
				return factory.current;
			},
			getSession: () => this.getSession(),
			close: async () => {
				await this.dropSession();
				if (this.ownsClient) await this.client.close();
			},
		};
	}

	private async openOn(platform: Platform, claim?: { profile?: string; runtime?: string }): Promise<Session> {
		const [lease]: Lease[] = await this.client.leases.claim({ platform, ...claim });
		if (!lease) throw new Error("no lease returned");
		const session = await this.client.sessions.open({
			lease,
			...(this.options.app !== undefined ? { app: this.options.app } : {}),
		});
		this.current = session;
		this.ownsSession = true;
		return session;
	}

	private readonly getSession = (): Promise<Session> => {
		if (this.current) return Promise.resolve(this.current);
		this.pending ??= this.openOn(this.options.platform).finally(() => {
			this.pending = undefined;
		});
		return this.pending;
	};

	private async dropSession(): Promise<void> {
		const session = this.current;
		this.current = undefined;
		if (session && this.ownsSession) await session.close();
		this.ownsSession = false;
	}

	private define<K extends ToolName>(name: K, run: Run<K>): Tool {
		const schema: z.ZodType<ToolInputs[K]> = toolInputSchemas[name] as unknown as z.ZodType<ToolInputs[K]>;
		return tool({
			description: toolDescriptions[name],
			inputSchema: schema,
			...(name === "screenshot"
				? { toModelOutput: ({ output }: { output: ToolResult }) => toolFormat.screenshotModelOutput(output) }
				: {}),
			execute: async (input: ToolInputs[K], execOptions: { abortSignal?: AbortSignal }): Promise<ToolResult> => {
				const signal = execOptions.abortSignal;
				try {
					return await run(input, { use: this.getSession, signal });
				} catch (error) {
					return toolFormat.toolFailure(error, signal);
				}
			},
		}) as Tool;
	}

	private readonly build: { [K in ToolName]: Run<K> } = {
		open: async (i, { use, signal }) => {
			const session = await use();
			await session.apps.open(
				{
					...(i.app !== undefined ? { app: i.app } : {}),
					...(i.url !== undefined ? { url: i.url } : {}),
					...(i.relaunch !== undefined ? { relaunch: i.relaunch } : {}),
				},
				{ signal }
			);
			return this.done;
		},
		close: async (i, { use, signal }) => {
			const session = await use();
			await session.apps.close(i.app !== undefined ? { app: i.app } : {}, { signal });
			return this.done;
		},
		snapshot: async (i, { use, signal }) => {
			const session = await use();
			const snap = await session.capture.snapshot(
				{
					...(i.interactiveOnly !== undefined ? { interactiveOnly: i.interactiveOnly } : {}),
					...(i.offscreen !== undefined ? { offscreen: i.offscreen } : {}),
				},
				{ signal }
			);
			return { ok: true, generation: snap.generation, truncated: snap.truncated, screen: snap.text };
		},
		press: async (i, { use, signal }) => {
			const session = await use();
			const target: Target | undefined = toolFormat.elementTargetOf(i) ?? (i.point ? { point: i.point } : undefined);
			if (!target) return toolFormat.usageFailure("press needs a target", `${TARGET_HINT}, or point`);
			await session.interactions.press({ ...target, ...(i.count !== undefined ? { count: i.count } : {}) }, { signal });
			return this.done;
		},
		fill: async (i, { use, signal }) => {
			const session = await use();
			const target = toolFormat.elementTargetOf(i);
			if (!target) return toolFormat.usageFailure("fill needs a target", TARGET_HINT);
			await session.interactions.fill(
				{ ...target, text: i.text, ...(i.clear !== undefined ? { clear: i.clear } : {}) },
				{ signal }
			);
			return this.done;
		},
		type: async (i, { use, signal }) => {
			const session = await use();
			await session.interactions.type({ text: i.text }, { signal });
			return this.done;
		},
		get: async (i, { use, signal }) => {
			const session = await use();
			const target = toolFormat.elementTargetOf(i);
			if (!target) return toolFormat.usageFailure("get needs a target", TARGET_HINT);
			const r = await session.query.get({ ...target, property: i.property }, { signal });
			return { ok: true, property: r.property, value: r.value ?? null };
		},
		is: async (i, { use, signal }) => {
			const session = await use();
			const target = toolFormat.elementTargetOf(i);
			if (!target) return toolFormat.usageFailure("is needs a target", TARGET_HINT);
			return { ok: true, value: await session.query.is({ ...target, state: i.state }, { signal }) };
		},
		find: async (i, { use, signal }) => {
			const session = await use();
			const found = await session.query.find({ selector: i.selector, ...(i.all ? { all: true } : {}) }, { signal });
			return { ok: true, count: found.length, elements: found.map((e) => toolFormat.brief(e)) };
		},
		wait: async (i, { use, signal }) => {
			const session = await use();
			const target = toolFormat.elementTargetOf(i);
			if (!target) return toolFormat.usageFailure("wait needs a target", TARGET_HINT);
			if (i.for === "text" && i.text === undefined)
				return toolFormat.usageFailure("wait for=text needs text", "pass text");
			const condition: WaitCondition = i.for === "text" ? { for: "text", text: i.text ?? "" } : { for: i.for };
			const found = await session.query.wait(
				{ ...target, ...condition, ...(i.timeoutMs !== undefined ? { timeoutMs: i.timeoutMs } : {}) },
				{ signal }
			);
			return found ? { ok: true, element: toolFormat.brief(found) } : this.done;
		},
		back: async (_i, { use, signal }) => {
			const session = await use();
			await session.device.back({ signal });
			return this.done;
		},
		scroll: async (i, { use, signal }) => {
			const session = await use();
			const target = toolFormat.elementTargetOf(i);
			const until = toolFormat.elementTargetOf({ ref: i.untilRef, selector: i.untilSelector });
			await session.interactions.scroll(
				{
					direction: i.direction,
					...(target ? { target } : {}),
					...(i.amount !== undefined ? { amount: i.amount } : {}),
					...(until ? { until } : {}),
				},
				{ signal }
			);
			return this.done;
		},
		swipe: async (i, { use, signal }) => {
			const session = await use();
			await session.interactions.swipe(
				{ from: i.from, to: i.to, ...(i.durationMs !== undefined ? { durationMs: i.durationMs } : {}) },
				{ signal }
			);
			return this.done;
		},
		alert: async (i, { use, signal }) => {
			const session = await use();
			const action =
				i.button !== undefined ? { button: i.button } : i.action === "read" || !i.action ? undefined : i.action;
			const info = await session.device.alert(action ? { action } : undefined, { signal });
			return { ok: true, alert: info ?? null };
		},
		screenshot: async (i, { use, signal }) => {
			const session = await use();
			const shot = await session.capture.screenshot(
				{
					...(i.scale !== undefined ? { scale: i.scale } : {}),
					...(i.path !== undefined ? { path: i.path } : {}),
				},
				{ signal }
			);
			const base = { ok: true as const, path: shot.path ?? null, width: shot.width, height: shot.height };
			if (shot.bytes.length === 0) return base;
			if (shot.bytes.length > this.maxImageBytes) {
				return {
					...base,
					imageOmitted: `${shot.bytes.length} bytes is over the ${this.maxImageBytes} byte cap; pass a smaller scale`,
				};
			}
			return { ...base, image: { mediaType: "image/png", data: Buffer.from(shot.bytes).toString("base64") } };
		},
		logs: async (i, { use, signal }) => {
			const session = await use();
			const entries = await session.devtools.console(
				{
					...(i.since !== undefined ? { since: i.since } : {}),
					...(i.level !== undefined ? { level: i.level } : {}),
					...(i.limit !== undefined ? { limit: i.limit } : {}),
				},
				{ signal }
			);
			return { ok: true, entries: entries.map((e) => `${e.level}: ${e.text}`) };
		},
		claim: async (i) => {
			await this.dropSession();
			const session = await this.openOn(i.platform, {
				...(i.profile !== undefined ? { profile: i.profile } : {}),
				...(i.runtime !== undefined ? { runtime: i.runtime } : {}),
			});
			return { ok: true, deviceId: session.deviceId, platform: session.platform };
		},
		release: async (i, { signal }) => {
			await this.dropSession();
			const r = await this.client.leases.release(
				{
					...(i.leaseIds !== undefined ? { leaseIds: i.leaseIds } : {}),
					...(i.shutdown !== undefined ? { shutdown: i.shutdown } : {}),
				},
				{ signal }
			);
			return { ok: true, released: r.released, shutdown: r.shutdown };
		},
		devices: async (i, { signal }) => {
			const list = await this.client.devices.list(
				{
					...(i.platform !== undefined ? { platform: i.platform } : {}),
					...(i.booted !== undefined ? { booted: i.booted } : {}),
				},
				{ signal }
			);
			return {
				ok: true,
				devices: list.map((d) => `${d.platform} ${d.id} ${d.name} ${d.state}${d.leased ? " leased" : ""}`),
			};
		},
		install: async (i, { use, signal }) => {
			const session = await use();
			await this.client.apps.install({ ...toolFormat.deviceRefOf(session), path: i.path }, { signal });
			return this.done;
		},
		metro: async (i, { signal }) => {
			const project = i.project !== undefined ? { project: i.project } : {};
			if (i.action === "start") {
				const m = await this.client.metro.start(
					{ ...project, ...(i.port !== undefined ? { port: i.port } : {}) },
					{ signal }
				);
				return { ok: true, running: true, url: m.url, port: m.port };
			}
			if (i.action === "stop") {
				await this.client.metro.stop(project, { signal });
				return { ok: true, running: false };
			}
			const status = await this.client.metro.status(project, { signal });
			return { ok: true, ...status };
		},
		eval: async (i, { use, signal }) => {
			const session = await use();
			return { ok: true, value: (await session.devtools.eval({ expression: i.expression }, { signal })) ?? null };
		},
		route: async (_i, { use, signal }) => {
			const session = await use();
			return { ok: true, route: (await session.devtools.route({ signal })) ?? null };
		},
		network: async (i, { use, signal }) => {
			const session = await use();
			const entries = await session.devtools.network(
				{
					...(i.since !== undefined ? { since: i.since } : {}),
					...(i.urlContains !== undefined ? { urlContains: i.urlContains } : {}),
					...(i.limit !== undefined ? { limit: i.limit } : {}),
				},
				{ signal }
			);
			return {
				ok: true,
				requests: entries.map((e) => `${e.method} ${e.url} ${e.failed ? "failed" : (e.status ?? "pending")}`),
			};
		},
		record_start: async (i, { use, signal }) => {
			const session = await use();
			const started = await session.record.start(
				{
					name: i.name,
					...(i.to !== undefined ? { to: i.to } : {}),
					...(i.helper !== undefined ? { helper: i.helper } : {}),
					...(i.suite !== undefined ? { suite: i.suite } : {}),
					...(i.title !== undefined ? { title: i.title } : {}),
					...(i.overwrite !== undefined ? { overwrite: i.overwrite } : {}),
				},
				{ signal }
			);
			return { ok: true, name: started.name, kind: started.kind, target: started.target };
		},
		record_note: async (i, { use, signal }) => {
			const session = await use();
			const noted = await session.record.note(i.text, { signal });
			return { ok: true, step: noted.step };
		},
		record_stop: async (i, { use, signal }) => {
			const session = await use();
			const stopped = await session.record.stop(
				{
					...(i.verify !== undefined ? { verify: i.verify } : {}),
					...(i.overwrite !== undefined ? { overwrite: i.overwrite } : {}),
					...(i.suite !== undefined ? { suite: i.suite } : {}),
				},
				{ signal }
			);
			return {
				ok: true,
				file: stopped.file,
				steps: stopped.steps,
				verified: stopped.verified,
				lints: stopped.lints.map(
					(l) => `${l.level} ${l.code}${l.step === null ? "" : ` (step ${l.step})`}: ${l.message}`
				),
				fixmes: stopped.fixmes,
				configSnippet: stopped.configSnippet,
			};
		},
		record_status: async (_i, { use, signal }) => {
			const session = await use();
			const status = await session.record.status({ signal });
			if (status.outcome === "idle") return { ok: true, recording: false };
			const { recording } = status;
			return {
				ok: true,
				recording: true,
				name: recording.name,
				target: recording.target,
				steps: recording.steps,
				last: recording.last.map((step) => `${step.i} ${step.summary}`),
				lints: recording.lints.map((l) => `${l.level} ${l.code}: ${l.message}`),
			};
		},
		perf_startup: async (i, { use, signal }) => {
			const session = await use();
			const r = await session.perf.startup(
				{
					...(i.app !== undefined ? { app: i.app } : {}),
					...(i.warm === true ? { warm: true } : {}),
					...(i.runs !== undefined ? { runs: i.runs } : {}),
				},
				{ signal }
			);
			return { ok: true, method: r.method, app: r.appId, summary: r.summary, notes: r.notes, findings: r.findings };
		},
		perf_metrics: async (i, { use, signal }) => {
			const session = await use();
			const r = await session.perf.metrics(
				{
					...(i.app !== undefined ? { app: i.app } : {}),
					...(i.duration !== undefined ? { duration: i.duration } : {}),
					...(i.interval !== undefined ? { interval: i.interval } : {}),
				},
				{ signal }
			);
			return { ok: true, app: r.app, intervalMs: r.intervalMs, summary: r.summary, findings: r.findings };
		},
		perf_memory: async (i, { use, signal }) => {
			const session = await use();
			const r = await session.perf.memory(i.app !== undefined ? { app: i.app } : {}, { signal });
			return { ok: true, ...r };
		},
		perf_logs: async (i, { use, signal }) => {
			const session = await use();
			const r = await session.perf.logs(
				{
					...(i.app !== undefined ? { app: i.app } : {}),
					...(i.level !== undefined ? { level: i.level } : {}),
					...(i.grep !== undefined ? { grep: i.grep } : {}),
					...(i.since !== undefined ? { since: i.since } : {}),
					...(i.lines !== undefined ? { lines: i.lines } : {}),
				},
				{ signal }
			);
			return {
				ok: true,
				app: r.app,
				truncated: r.truncated,
				entries: r.entries.map((e) => `${e.ts} ${e.level} ${e.tag}: ${e.msg}`),
			};
		},
		perf_crashes: async (i, { use, signal }) => {
			const session = await use();
			const r = await session.perf.crashes(
				{
					...(i.app !== undefined ? { app: i.app } : {}),
					...(i.since !== undefined ? { since: i.since } : {}),
				},
				{ signal }
			);
			return {
				ok: true,
				app: r.app,
				count: r.count,
				crashes: r.crashes.map(
					(c) => `${c.kind} ${c.process}: ${c.summary}${c.firstAppFrame ? ` at ${c.firstAppFrame}` : ""}`
				),
				findings: r.findings,
				notes: r.notes,
			};
		},
	};
}

type Ctx = { use: () => Promise<Session>; signal: AbortSignal | undefined };
type Run<K extends ToolName> = (input: ToolInputs[K], ctx: Ctx) => Promise<ToolResult>;

/**
 * Build the Vercel AI SDK tools that drive a warden session. Every tool returns `{ok: true, ...}` or
 * `{ok: false, error: {code, message, hint}}`; none throws. The session is claimed and opened lazily, on the first
 * tool call, when no `session` is given. Approval is v7 `toolApproval`: spread the returned `toolApproval` into the
 * agent or `generateText` call.
 */
export async function createWardenTools(options: CreateWardenToolsOptions): Promise<WardenTools> {
	return new WardenToolsFactory(options).create();
}

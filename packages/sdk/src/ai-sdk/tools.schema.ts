import { z } from "zod";

/**
 * Zod input schemas and model-facing descriptions of the warden agent tools. Pure data: no `ai` import and no SDK
 * runtime, so an MCP server (or any other tool host) can reuse them as they are.
 */

const refSchema = z
	.string()
	.regex(/^@e\d+$/, "a ref looks like @e3")
	.describe("element ref from the latest snapshot, e.g. @e3");

const selectorSchema = z.string().min(1).describe("selector expression, e.g. id=email or label=Sign in");

/** `ref` or `selector`: exactly one is needed (checked by the tool, which returns a recoverable error). */
const elementTarget = {
	ref: refSchema.optional(),
	selector: selectorSchema.optional(),
} as const;

const pointSchema = z.object({ x: z.number(), y: z.number() }).describe("screen point in points");

/** Names of the tools in the `core` set. */
export const CORE_TOOL_NAMES = [
	"open",
	"close",
	"snapshot",
	"press",
	"fill",
	"type",
	"get",
	"is",
	"find",
	"wait",
	"back",
	"scroll",
	"swipe",
	"alert",
	"screenshot",
	"logs",
	"route",
] as const;

/** Names the `all` set adds on top of `core`. */
export const EXTRA_TOOL_NAMES = [
	"claim",
	"release",
	"devices",
	"install",
	"metro",
	"eval",
	"network",
	"record_start",
	"record_note",
	"record_stop",
	"record_status",
	"perf_startup",
	"perf_metrics",
	"perf_memory",
	"perf_logs",
	"perf_crashes",
] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];
export type ExtraToolName = (typeof EXTRA_TOOL_NAMES)[number];
export type ToolName = CoreToolName | ExtraToolName;

const platformSchema = z.enum(["ios", "android"]);

/** Input schema per tool. */
export const toolInputSchemas = {
	open: z.object({
		app: z.string().optional().describe("bundle id / package; default: the session's app"),
		url: z.string().optional().describe("deep link to open instead of the launcher"),
		relaunch: z.boolean().optional().describe("restart when already running (default true)"),
	}),
	close: z.object({ app: z.string().optional().describe("default: the session's app") }),
	snapshot: z.object({
		interactiveOnly: z.boolean().optional().describe("only elements a user can act on (smaller output)"),
		offscreen: z.boolean().optional().describe("include elements outside the viewport"),
	}),
	press: z.object({
		...elementTarget,
		point: pointSchema.optional(),
		count: z.number().int().positive().optional().describe("taps (2 = double tap)"),
	}),
	fill: z.object({
		...elementTarget,
		text: z.string(),
		clear: z.boolean().optional().describe("clear the field first (default true)"),
	}),
	type: z.object({ text: z.string().describe("typed into the focused field") }),
	get: z.object({
		...elementTarget,
		property: z.enum(["text", "label", "value", "identifier", "frame", "role"]),
	}),
	is: z.object({
		...elementTarget,
		state: z.enum(["visible", "enabled", "focused", "selected", "checked", "hittable"]),
	}),
	find: z.object({
		selector: selectorSchema,
		all: z.boolean().optional().describe("return every match, not only the first"),
	}),
	wait: z.object({
		...elementTarget,
		for: z.enum(["visible", "hidden", "present", "absent", "text", "stable"]),
		text: z.string().optional().describe("required when for=text"),
		timeoutMs: z.number().int().positive().optional(),
	}),
	back: z.object({}),
	scroll: z.object({
		direction: z.enum(["up", "down", "left", "right"]),
		...elementTarget,
		amount: z.number().positive().optional().describe("screen fractions, default one page"),
		untilRef: refSchema.optional().describe("keep scrolling until this ref is visible"),
		untilSelector: selectorSchema.optional().describe("keep scrolling until this selector is visible"),
	}),
	swipe: z.object({
		from: pointSchema,
		to: pointSchema,
		durationMs: z.number().int().positive().optional(),
	}),
	alert: z.object({
		action: z
			.enum(["accept", "dismiss", "read"])
			.optional()
			.describe("read (default) returns the system alert; accept/dismiss answer it"),
		button: z.string().optional().describe("answer by this button label instead of accept/dismiss"),
	}),
	screenshot: z.object({
		scale: z.number().min(0.05).max(1).optional().describe("0-1 downscale"),
		path: z.string().optional().describe("write here; default: warden's per-device folder"),
	}),
	logs: z.object({
		since: z.number().optional().describe("epoch ms; only newer entries"),
		level: z.enum(["log", "info", "warn", "error", "debug"]).optional(),
		limit: z.number().int().positive().optional(),
	}),
	claim: z.object({
		platform: platformSchema,
		profile: z.string().optional(),
		runtime: z.string().optional(),
	}),
	release: z.object({
		leaseIds: z.array(z.string()).optional().describe("default: every lease this client holds"),
		shutdown: z.boolean().optional(),
	}),
	devices: z.object({ platform: platformSchema.optional(), booted: z.boolean().optional() }),
	install: z.object({ path: z.string().describe("path to an .app / .apk") }),
	metro: z.object({
		action: z.enum(["start", "stop", "status"]),
		project: z.string().optional(),
		port: z.number().int().positive().optional(),
	}),
	eval: z.object({ expression: z.string().describe("JS evaluated in the app's Hermes runtime") }),
	network: z.object({
		since: z.number().optional(),
		urlContains: z.string().optional(),
		limit: z.number().int().positive().optional(),
	}),
	route: z.object({}),
	record_start: z.object({
		name: z.string().min(1).describe("recording name; also the spec file name unless `to` is given"),
		to: z.string().optional().describe("spec file to write"),
		helper: z.string().optional().describe("write an exported function into a helpers module: <module>#<fn>"),
		suite: z.string().optional().describe("e2e suite for the default path and the verify run"),
		title: z.string().optional().describe("title of the generated test"),
		overwrite: z.boolean().optional().describe("replace an existing spec file"),
	}),
	record_note: z.object({ text: z.string().min(1).describe("what the next actions do, e.g. 'enter credentials'") }),
	record_stop: z.object({
		verify: z.boolean().optional().describe("run the written spec once on the device (default true)"),
		overwrite: z.boolean().optional(),
		suite: z.string().optional(),
	}),
	record_status: z.object({}),
	perf_startup: z.object({
		app: z.string().optional().describe("default: the session's app"),
		warm: z.boolean().optional().describe("time warm starts (app sent to the background) instead of cold"),
		runs: z.number().int().min(1).max(20).optional().describe("launches to time (default 5)"),
	}),
	perf_metrics: z.object({
		app: z.string().optional().describe("default: the session's app"),
		duration: z.string().optional().describe("how long to sample, e.g. 10s (default 3s)"),
		interval: z.string().optional().describe("time between samples, e.g. 1s (min 200ms)"),
	}),
	perf_memory: z.object({ app: z.string().optional().describe("default: the session's app") }),
	perf_logs: z.object({
		app: z.string().optional().describe("default: the session's app"),
		level: z.enum(["verbose", "debug", "info", "warn", "error", "fatal"]).optional().describe("minimum level"),
		grep: z.string().optional().describe("keep lines whose tag or message matches this regex"),
		since: z.string().optional().describe("only lines from the last 30s | 5m | 1h"),
		lines: z.number().int().positive().optional().describe("lines to return, newest last (default 200)"),
	}),
	perf_crashes: z.object({
		app: z.string().optional().describe("default: the session's app"),
		since: z.string().optional().describe("only crashes from the last 30s | 5m | 1h"),
	}),
} as const satisfies Record<ToolName, z.ZodType>;

/** What the model reads to pick a tool. */
export const toolDescriptions = {
	open: "Launch the app under test (or a deep link).",
	close: "Terminate the app under test.",
	snapshot:
		"Read the screen as compact text. Each element has a ref like @e3; use refs in press/fill/get/is/wait. Refs expire on the next snapshot.",
	press: "Tap an element by ref or selector, or a screen point.",
	fill: "Focus a text field, replace its content and confirm the value.",
	type: "Type text into the currently focused field.",
	get: "Read one property of an element.",
	is: "Test one state of an element (visible, enabled, ...).",
	find: "List elements matching a selector in a fresh snapshot.",
	wait: "Wait until an element reaches a condition, or fail after the timeout.",
	back: "Navigate back (Android back key, iOS back).",
	scroll: "Scroll the screen or a container in a direction, optionally until an element is visible.",
	swipe: "One-finger swipe between two screen points.",
	alert: "Read the system alert, or accept/dismiss it.",
	screenshot:
		"Capture the screen to a PNG file; returns its path and shows you the image (omitted when over the size cap: pass a smaller scale).",
	logs: "Console messages of the app (needs a dev build with Metro).",
	claim: "Claim a device lease for a platform (a session is opened on it).",
	release: "Release device leases held by this client.",
	devices: "List devices on this machine.",
	install: "Install a prebuilt app on the session's device.",
	metro: "Start, stop or inspect the dev server.",
	eval: "Evaluate JavaScript in the app's Hermes runtime.",
	network: "Network requests the app made.",
	route: "The route (screen) the app is on, e.g. (tabs)/todos (needs a dev build with Metro).",
	record_start:
		"Start recording this session as an e2e spec: later press/fill/scroll/... calls are journalled as steps (needs a dev build or accessible ids to make durable selectors).",
	record_note: "Mark a user-visible step in the recording; it becomes a comment above the next action in the spec.",
	record_stop:
		"Write the recorded spec and, by default, run it once on the device. Returns the file, lint findings, whether it passed and the warden.config.ts snippet.",
	record_status: "The recording in progress: target, step count, the last steps and lint findings.",
	perf_startup:
		"Cold (or warm) app start time: median and p90 over several launches, with findings. Kills and relaunches the app.",
	perf_metrics: "CPU % and memory of the app over a few seconds: min/avg/p95/max, memory growth and findings.",
	perf_memory: "Where the app's memory sits right now (Android meminfo categories, iOS footprint and regions).",
	perf_logs: "The app's recent device logs (secrets redacted), filtered by level, regex or age.",
	perf_crashes: "Crashes and ANRs of the app: process, summary, top frames and findings.",
} as const satisfies Record<ToolName, string>;

export type ToolInputs = { [K in ToolName]: z.infer<(typeof toolInputSchemas)[K]> };

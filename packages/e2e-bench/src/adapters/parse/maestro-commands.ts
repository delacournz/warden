import { err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import type { StepResult } from "../../results/schema";

const metadataSchema = z.object({
	status: z.string(),
	duration: z.number().optional(),
	sequenceNumber: z.number().optional(),
	evaluatedCommand: z.record(z.string(), z.unknown()).optional(),
});

/** `commands.json`: a flat list; nested runFlow / retry children follow their container with a larger `depth`. */
const commandsSchema = z.array(
	z.object({
		command: z.record(z.string(), z.unknown()),
		metadata: metadataSchema.extend({ depth: z.number().optional() }),
	})
);

/** Containers and bookkeeping: their children (or nothing) carry the measurable work. */
const NON_STEPS = new Set([
	"runFlowCommand",
	"retryCommand",
	"repeatCommand",
	"defineVariablesCommand",
	"applyConfigurationCommand",
]);

const KIND: Record<string, string> = {
	launchAppCommand: "launch",
	tapOnElement: "tap",
	tapOnPointV2Command: "tap",
	inputTextCommand: "fill",
	eraseTextCommand: "fill",
	assertConditionCommand: "assert",
	openLinkCommand: "open",
	hideKeyboardCommand: "keyboard",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** `#id "text"` out of a selector-like object (idRegex / textRegex), or undefined. */
function selectorLabel(selector: unknown): string | undefined {
	if (!isRecord(selector)) return undefined;
	const id = str(selector.idRegex);
	const text = str(selector.textRegex);
	const parts = [id !== undefined ? `#${id}` : undefined, text !== undefined ? `"${text}"` : undefined];
	const label = parts.filter((p) => p !== undefined).join(" ");
	return label === "" ? undefined : label;
}

/** `visible` / `notVisible` plus its selector, for an `assertConditionCommand`. */
function conditionLabel(body: Record<string, unknown>): string {
	const condition = body.condition;
	if (!isRecord(condition)) return "assert";
	for (const mode of ["visible", "notVisible"] as const) {
		if (mode in condition)
			return ["assert", mode, selectorLabel(condition[mode])].filter((p) => p !== undefined).join(" ");
	}
	return "assert";
}

/** A readable label for one command, from its evaluated form (variables resolved). */
function labelOf(key: string, body: Record<string, unknown>): string {
	switch (key) {
		case "tapOnElement":
			return ["tap", selectorLabel(body.selector)].filter((p) => p !== undefined).join(" ");
		case "assertConditionCommand":
			return conditionLabel(body);
		case "launchAppCommand":
			return `launchApp ${str(body.appId) ?? ""}`.trim();
		case "openLinkCommand":
			return `openLink ${str(body.link) ?? ""}`.trim();
		case "inputTextCommand":
			return "inputText";
		case "eraseTextCommand":
			return "eraseText";
		default:
			return key.replace(/Command$/, "");
	}
}

const statusOf = (maestro: string): StepResult["status"] => {
	if (maestro === "COMPLETED" || maestro === "WARNED") return "passed";
	if (maestro === "FAILED") return "failed";
	return "skipped";
};

/**
 * Per-action steps from a flow's `commands.json`: every leaf command (tap, assert, input, launch, openLink)
 * with Maestro's own `duration`. Containers (`runFlow`, `retry`) are dropped so the sum is not double counted.
 */
export function parseMaestroCommands(text: string): Result<StepResult[]> {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (e) {
		return err(`maestro commands.json is not JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
	const parsed = commandsSchema.safeParse(json);
	if (!parsed.success) return err(`maestro commands.json: ${parsed.error.issues[0]?.message ?? "bad shape"}`);
	const ordered = [...parsed.data].sort((a, b) => (a.metadata.sequenceNumber ?? 0) - (b.metadata.sequenceNumber ?? 0));
	const steps: StepResult[] = [];
	for (const entry of ordered) {
		const key = Object.keys(entry.command)[0];
		if (key === undefined || NON_STEPS.has(key)) continue;
		const evaluated = entry.metadata.evaluatedCommand?.[key];
		const body = isRecord(evaluated) ? evaluated : {};
		steps.push({
			kind: KIND[key] ?? key.replace(/Command$/, ""),
			label: labelOf(key, body),
			ms: entry.metadata.duration ?? 0,
			status: statusOf(entry.metadata.status),
		});
	}
	return ok(steps);
}

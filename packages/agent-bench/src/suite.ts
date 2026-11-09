import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { type Suite, suiteSchema } from "./suite.schema";

/** `packages/agent-bench/suites`: `bun run bench:agent <name>` resolves `<name>.yml` here. */
export const SUITES_DIR = resolve(import.meta.dir, "..", "suites");

export type LoadedSuite = { suite: Suite; path: string; promptTemplate: string };

/** Names of the committed suites (`suites/*.yml`), sorted. */
export function listSuites(dir: string = SUITES_DIR): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".yml"))
		.map((f) => f.slice(0, -".yml".length))
		.sort();
}

/** A suite name (`login`) or a path to a `.yml` file. */
export function resolveSuitePath(nameOrPath: string, dir: string = SUITES_DIR): string {
	return nameOrPath.endsWith(".yml") ? resolve(nameOrPath) : join(dir, `${nameOrPath}.yml`);
}

/** Parses and validates a suite file and reads its prompt (relative to the suite file). */
export function loadSuite(path: string): Result<LoadedSuite> {
	let raw: unknown;
	try {
		raw = Bun.YAML.parse(readFileSync(path, "utf8"));
	} catch (e) {
		return err(`${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
	const parsed = suiteSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
		return err(`${path}: ${issues}`);
	}
	const promptPath = resolve(dirname(path), parsed.data.prompt);
	if (!existsSync(promptPath)) return err(`${path}: prompt file not found: ${promptPath}`);
	return ok({ suite: parsed.data, path, promptTemplate: readFileSync(promptPath, "utf8") });
}

export type PromptVars = { udid: string; platform: string; bundleId: string };

/** Fills `{{udid}}`, `{{platform}}` and `{{bundleId}}`. */
export function renderPrompt(template: string, vars: PromptVars): string {
	return template.replace(/\{\{(udid|platform|bundleId)\}\}/g, (_m, key: keyof PromptVars) => vars[key]);
}

import { dirname, isAbsolute, relative, resolve } from "node:path";
import { projectConfig } from "@delacour/warden-builds/config";
import type { Exec } from "@delacour/warden-runtime/exec";
import { type GitFactsCache, gitFactsReader } from "@delacour/warden-runtime/git-facts";
import { WardenError } from "../errors";
import { defineProvider, type ProviderPlugin } from "./define-provider";

/** Where a module specifier of `providers` points: relative paths from the config's dir, packages as resolved from it. */
export function resolveProviderModule(specifier: string, configDir: string): string {
	if (specifier.startsWith(".") || isAbsolute(specifier)) return resolve(configDir, specifier);
	try {
		return Bun.resolveSync(specifier, configDir);
	} catch (error) {
		throw new WardenError({
			code: "config_invalid",
			message: `providers: cannot resolve "${specifier}" from ${configDir}: ${String(error)}`,
		});
	}
}

async function importProvider(specifier: string, configDir: string): Promise<ProviderPlugin> {
	const path = resolveProviderModule(specifier, configDir);
	let loaded: { default?: ProviderPlugin };
	try {
		loaded = (await import(path)) as { default?: ProviderPlugin };
	} catch (error) {
		throw new WardenError({
			code: "config_invalid",
			message: `providers: "${specifier}" failed to load: ${String(error)}`,
		});
	}
	if (loaded.default === undefined) {
		throw new WardenError({
			code: "config_invalid",
			message: `providers: "${specifier}" has no default export`,
			hint: "export default defineProvider({ apiVersion: 1, ... })",
		});
	}
	return defineProvider(loaded.default);
}

/**
 * Where the config search from `cwd` stops, as the CLI's does: the repo toplevel, else the home directory when `cwd`
 * is under it, else `cwd` itself (never an unbounded walk to the filesystem root).
 */
export async function configStopAt(
	exec: Exec,
	cwd: string,
	cache: GitFactsCache,
	env: Record<string, string | undefined>
): Promise<string> {
	const toplevel = (await gitFactsReader.read(exec, cwd, cache))?.toplevel;
	if (toplevel !== undefined) return toplevel;
	const home = env.HOME;
	if (home !== undefined && home !== "") {
		const rel = relative(resolve(home), resolve(cwd));
		if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolve(home);
	}
	return resolve(cwd);
}

/**
 * The provider plugins named by `providers` in the `warden.config.*` found from `cwd` up to `stopAt` (none when there
 * is no config or no key). Each module default-exports a {@link defineProvider} result.
 */
export async function loadConfigProviders(
	cwd: string,
	env: Record<string, string | undefined>,
	stopAt?: string
): Promise<ProviderPlugin[]> {
	const found = projectConfig.find(cwd, stopAt ?? resolve(cwd), env);
	if (!found.success) throw new WardenError({ code: "config_invalid", message: found.error });
	const specifiers = found.data?.config.providers ?? [];
	const dir = found.data?.dir ?? dirname(cwd);
	const plugins: ProviderPlugin[] = [];
	for (const specifier of specifiers) plugins.push(await importProvider(specifier, dir));
	return plugins;
}

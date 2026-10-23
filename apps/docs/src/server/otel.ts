/**
 * `@delacournz/otel-start` is an optional dependency: it is published to GitHub Packages, so a
 * clone without a `read:packages` NPM_TOKEN installs without it (bunfig.toml). Railway has the
 * token and gets tracing; everyone else gets the same site, untraced.
 */
export const OTEL_START = "@delacournz/otel-start";

type Handler<Args extends unknown[]> = (request: Request, ...args: Args) => Promise<Response> | Response;

/** The slice of `@delacournz/otel-start`'s `withServerSpan` the server entry uses. */
export type WithServerSpan = <Args extends unknown[]>(
	serviceName: string,
	handler: Handler<Args>
) => (request: Request, ...args: Args) => Promise<Response>;

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

/** `bare` or `@scope/name` out of a specifier with an optional subpath. */
const packageName = (specifier: string): string =>
	specifier
		.split("/")
		.slice(0, specifier.startsWith("@") ? 2 : 1)
		.join("/");

/**
 * True only for Bun's resolve error naming `pkg` itself. A package that is installed but missing
 * one of its own dependencies is a broken install and must not pass as "not installed".
 */
export function isPackageMissing(error: unknown, pkg: string): boolean {
	if (!isObject(error) || !("code" in error) || !("message" in error)) return false;
	return (
		error.code === "ERR_MODULE_NOT_FOUND" &&
		typeof error.message === "string" &&
		error.message.includes(`'${packageName(pkg)}'`)
	);
}

/** `load()`'s module, or undefined when `specifier`'s package is not installed. Other errors rethrow. */
export async function importOptional(specifier: string, load: () => Promise<unknown>): Promise<unknown> {
	try {
		return await load();
	} catch (error) {
		if (isPackageMissing(error, specifier)) return undefined;
		throw error;
	}
}

const hasWithServerSpan = (mod: unknown): mod is { withServerSpan: WithServerSpan } =>
	isObject(mod) && "withServerSpan" in mod && typeof mod.withServerSpan === "function";

/**
 * A non-literal specifier keeps tsc and the Vite/Nitro bundle from resolving the package at build
 * time, so typecheck and `vite build` work without it; Bun resolves it from node_modules at runtime.
 */
const loadOtelStart = (): Promise<unknown> => {
	const specifier: string = OTEL_START;
	return importOptional(specifier, () => import(/* @vite-ignore */ specifier));
};

/** `withServerSpan` from `@delacournz/otel-start`, or undefined when it is not installed. */
export async function loadServerSpan(
	load: () => Promise<unknown> = loadOtelStart
): Promise<WithServerSpan | undefined> {
	const mod = await load();
	if (mod === undefined) return undefined;
	if (!hasWithServerSpan(mod)) throw new Error(`${OTEL_START} loaded without a withServerSpan export`);
	return mod.withServerSpan;
}

/** Railway's (`OTEL_EXPORTER_OTLP_*`) or Dash0's (`DASH0_OTLP_*`) exporter is configured. */
export const otlpConfigured = (env: Record<string, string | undefined>): boolean =>
	Object.entries(env).some(
		([key, value]) =>
			(key.startsWith("OTEL_EXPORTER_OTLP_") || key.startsWith("DASH0_OTLP_")) && value !== undefined && value !== ""
	);

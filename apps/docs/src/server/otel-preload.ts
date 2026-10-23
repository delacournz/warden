import { importOptional, OTEL_START, otlpConfigured } from "./otel";

/**
 * `bun --preload ./src/server/otel-preload.ts` (the `start` script): runs
 * `@delacournz/otel-start/preload` when it is installed. Without it the server starts untraced, and
 * warns if an OTLP exporter was configured, since that deploy expected traces.
 */
const preload: string = `${OTEL_START}/preload`;
const loaded = await importOptional(preload, () => import(/* @vite-ignore */ preload));
if (loaded === undefined && otlpConfigured(process.env)) {
	console.warn(`[warden-docs] ${OTEL_START} is not installed (NPM_TOKEN unset at install?): tracing is off`);
}

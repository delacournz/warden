/**
 * Bun `--preload` for the production server (see the `start` script). Starts the OpenTelemetry SDK
 * before `.output/server/index.mjs` loads, so the tracer provider and W3C propagator are registered
 * before the first request.
 *
 * Bun's `Bun.serve` never touches node `http`, so `auto-instrumentations-node` would patch nothing
 * here. The SERVER span is created explicitly by `src/server/trace.ts`; this file only wires the
 * provider and exporter.
 *
 * Everything is read from the standard env, none of it hardcoded: Railway injects
 * `OTEL_EXPORTER_OTLP_ENDPOINT` / `_PROTOCOL` / `_HEADERS`, `OTEL_SERVICE_NAME` and
 * `OTEL_SERVICE_VERSION`. `OTEL_TRACES_EXPORTER=console` overrides for local verification.
 * With neither an endpoint nor an explicit exporter nothing starts (local dev, CI, `bun test`).
 */
import { NodeSDK } from "@opentelemetry/sdk-node";

const enabled = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) || Boolean(process.env.OTEL_TRACES_EXPORTER);

if (enabled) {
	const sdk = new NodeSDK({ instrumentations: [] });
	sdk.start();

	let stopping = false;
	/** Bun does not run OTel's exit hooks; flush the batch processor so a redeploy keeps its last spans. */
	const shutdown = (signal: NodeJS.Signals): void => {
		if (stopping) return;
		stopping = true;
		sdk
			.shutdown()
			.catch(() => undefined)
			.finally(() => process.exit(signal === "SIGINT" ? 130 : 0));
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

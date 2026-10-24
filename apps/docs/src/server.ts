import handler from "@tanstack/react-start/server-entry";
import { loadServerSpan } from "@/server/otel";

/**
 * Server entry: every SSR / server-fn request runs inside one SERVER span, continuing the caller's
 * W3C `traceparent`. `@delacournz/otel-start`'s root entry only pulls in `@opentelemetry/api`, so
 * loading it never boots the SDK: that is the `start` script's preload (src/server/otel-preload.ts),
 * a no-op unless Railway (`OTEL_EXPORTER_OTLP_*`) or Dash0 (`DASH0_OTLP_*`) is configured. The
 * package is optional (GitHub Packages, see src/server/otel.ts): without it requests are untraced.
 * Nitro middleware (`compress`) and `public/` assets run outside the span.
 */
const withServerSpan = await loadServerSpan();

export default {
	fetch: withServerSpan ? withServerSpan("warden-docs", handler.fetch) : handler.fetch,
};

import { withServerSpan } from "@delacournz/otel-start";
import handler from "@tanstack/react-start/server-entry";

/**
 * Server entry: every SSR / server-fn request runs inside one SERVER span, continuing the caller's
 * W3C `traceparent`. `@delacournz/otel-start`'s root entry only pulls in `@opentelemetry/api`, so the
 * static import never boots the SDK: that is the `start` script's
 * `bun --preload @delacournz/otel-start/preload`, a no-op unless Railway (`OTEL_EXPORTER_OTLP_*`) or
 * Dash0 (`DASH0_OTLP_*`) is configured. Nitro middleware (`compress`) and `public/` assets run
 * outside the span.
 */
export default {
	fetch: withServerSpan("warden-docs", handler.fetch),
};

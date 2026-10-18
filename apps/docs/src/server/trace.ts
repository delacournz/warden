import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("warden-docs");

/**
 * Wraps one request in a SERVER span, continuing the caller's W3C `traceparent` when present.
 * Needed because the production runtime is Bun, whose `Bun.serve` auto-instrumentation cannot patch.
 * `@opentelemetry/api` is a no-op until `scripts/otel-preload.ts` registers a provider, so this is
 * free when tracing is off.
 */
export async function traceRequest(request: Request, next: () => unknown): Promise<unknown> {
	const url = new URL(request.url);
	const parent = propagation.extract(context.active(), Object.fromEntries(request.headers));

	return tracer.startActiveSpan(
		request.method,
		{
			kind: SpanKind.SERVER,
			attributes: {
				"http.request.method": request.method,
				"url.path": url.pathname,
				"url.scheme": url.protocol.replace(":", ""),
				"server.address": url.hostname,
				"user_agent.original": request.headers.get("user-agent") ?? undefined,
			},
		},
		parent,
		async (span) => {
			try {
				const body = await next();
				if (body instanceof Response) {
					span.setAttribute("http.response.status_code", body.status);
					if (body.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
				} else {
					span.setAttribute("http.response.status_code", 200);
				}
				return body;
			} catch (error) {
				span.recordException(error instanceof Error ? error : String(error));
				span.setStatus({ code: SpanStatusCode.ERROR });
				span.setAttribute("http.response.status_code", 500);
				throw error;
			} finally {
				span.end();
			}
		}
	);
}

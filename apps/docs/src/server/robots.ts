import { defineMiddleware } from "nitro/h3";
import { hostRobotsTag } from "@/lib/http-cache";

/** Nitro middleware: `X-Robots-Tag: noindex` on every response from a host other than production (staging). */
export default defineMiddleware(async (event, next) => {
	const tag = hostRobotsTag(event.req);
	if (tag) event.res.headers.set("X-Robots-Tag", tag);
	const body = await next();
	if (!tag || !(body instanceof Response)) return body;
	const headers = new Headers(body.headers);
	headers.set("X-Robots-Tag", tag);
	return new Response(body.body, { status: body.status, statusText: body.statusText, headers });
});

import { defineMiddleware } from "nitro/h3";
import { compressResponse } from "@/lib/http-cache";

/** Nitro middleware: gzip the dynamic text responses the bun preset would otherwise send raw. */
export default defineMiddleware(async (event, next) => {
	const body = await next();
	return body instanceof Response ? compressResponse(event.req, body) : body;
});

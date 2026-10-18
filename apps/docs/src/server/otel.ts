import { defineMiddleware } from "nitro/h3";
import { traceRequest } from "@/server/trace";

/** Nitro middleware: one SERVER span per request. Registered before `compress` so it covers it. */
export default defineMiddleware((event, next) => traceRequest(event.req, next));

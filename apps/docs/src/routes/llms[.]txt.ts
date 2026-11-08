import { createFileRoute } from "@tanstack/react-router";
import { llms } from "fumadocs-core/source";
import { llmsIndex } from "@/lib/llms";
import { source } from "@/lib/source";

export const Route = createFileRoute("/llms.txt")({
	server: {
		handlers: {
			GET() {
				return new Response(llmsIndex(llms(source).index()), {
					headers: { "Content-Type": "text/plain; charset=utf-8" },
				});
			},
		},
	},
});

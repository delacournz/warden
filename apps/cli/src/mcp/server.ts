import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDef, ToolResult } from "./tools";

type Env = Record<string, string | undefined>;

/** An MCP `CallToolResult`: the tool's data (or error) as one JSON text block. */
export type ToolResponse = { content: { type: "text"; text: string }[]; isError?: boolean };

/** A tool's Result as the MCP reply: data as JSON, an error as `{ error }` with `isError`. */
export function toResponse(result: ToolResult): ToolResponse {
	if (result.success) return { content: [{ type: "text", text: JSON.stringify(result.data) }] };
	return { content: [{ type: "text", text: JSON.stringify({ error: result.error }) }], isError: true };
}

/**
 * The `warden mcp` server: every tool of `tools` registered over the SDK, each answering with its function's Result.
 * A throw inside a tool becomes an `internal` error reply, never a dropped connection.
 */
export function createWardenMcp(env: Env, tools: readonly ToolDef[], version: string): McpServer {
	const server = new McpServer({ name: "warden", version });
	for (const def of tools) {
		server.registerTool(def.name, { description: def.description, inputSchema: def.input }, async (args) => {
			try {
				return toResponse(await def.run(env, args));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return toResponse({ success: false, error: { code: "internal", message } });
			}
		});
	}
	return server;
}

/** Serve on `transport` (stdio for `warden mcp`) until it closes. */
export async function serveWardenMcp(server: McpServer, transport: Transport): Promise<void> {
	const closed = new Promise<void>((resolve) => {
		transport.onclose = () => resolve();
	});
	await server.connect(transport);
	await closed;
}

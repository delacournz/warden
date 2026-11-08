import { defineCommand } from "../command";
import type { CommandContext } from "../context";

/**
 * `warden mcp`: an MCP server on stdio for agents that speak MCP rather than shell. Each tool calls the same function
 * as its CLI verb (`warden dev logs`, `warden ui console`, …), so nothing here has behaviour of its own. stdout is the
 * protocol: nothing else may print there.
 */
export async function runMcp(ctx: CommandContext): Promise<number> {
	const [{ StdioServerTransport }, { createWardenMcp, serveWardenMcp }, { wardenTools }, { currentBuild }] =
		await Promise.all([
			import("@modelcontextprotocol/sdk/server/stdio.js"),
			import("../mcp/server"),
			import("../mcp/tools"),
			import("../update/build-info"),
		]);
	const server = createWardenMcp(ctx.env, wardenTools({ now: ctx.now }), currentBuild().version);
	await serveWardenMcp(server, new StdioServerTransport());
	return 0;
}

export const mcpCommand = defineCommand({
	name: "mcp",
	group: "Setup",
	summary: "MCP server on stdio: Metro logs, app console, network, eval, tree, logpoints, profiles of `warden dev`",
	register: (cmd, ctx, done) => {
		cmd.action(async () => done(await runMcp(ctx)));
	},
});

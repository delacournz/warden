import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";

export class McpCommand extends CliCommand {
	override readonly name = "mcp";
	override readonly group = "Setup";
	override readonly summary =
		"MCP server on stdio: Metro logs, app console, network, eval, tree, logpoints, profiles of `warden dev`";

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd.action(async () => done(await this.runMcp(ctx)));
	}

	/**
	 * `warden mcp`: an MCP server on stdio for agents that speak MCP rather than shell. Each tool calls the same function
	 * as its CLI verb (`warden dev logs`, `warden ui console`, …), so nothing here has behaviour of its own. stdout is the
	 * protocol: nothing else may print there.
	 */
	async runMcp(ctx: CommandContext): Promise<number> {
		const [{ StdioServerTransport }, { wardenMcpServer }, { mcpTools }, { currentBuild }] = await Promise.all([
			import("@modelcontextprotocol/sdk/server/stdio.js"),
			import("../mcp/server"),
			import("../mcp/tools"),
			import("../update/build-info"),
		]);
		const server = wardenMcpServer.createWardenMcp(
			ctx.env,
			mcpTools.wardenTools({ now: ctx.now }),
			currentBuild().version
		);
		await wardenMcpServer.serveWardenMcp(server, new StdioServerTransport());
		return 0;
	}
}

export const mcpCli = new McpCommand();
export const mcpCommand = mcpCli.definition();

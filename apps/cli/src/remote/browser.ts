import type { CommandContext } from "../context";

/** `open` on macOS, `start` on Windows, `xdg-open` elsewhere; a failure only means the user opens the link themselves. */
export async function openBrowser(ctx: CommandContext, url: string): Promise<boolean> {
	const os = ctx.os ?? process.platform;
	const cmd = os === "darwin" ? ["open", url] : os === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
	const r = await ctx.exec(cmd, { timeoutMs: 10_000 }).catch(() => undefined);
	return r?.exitCode === 0;
}

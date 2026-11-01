// Run under a PTY by harness.pty.test.ts: `bun tui-script.ts`. A tiny dev session on the real createDevTui.
import { contextBuilder } from "../../context";
import { devTuiTui } from "../tui";

const ui = devTuiTui.createDevTui({ ctx: contextBuilder.defaultContext([]) });

ui.onQuit(() => {
	void ui.close().then(() => process.exit(0));
});

ui.task("claim", "claiming ios").ok("warden-iphone-17-5");
ui.task("app", "building the dev client");
ui.ctx.err("compiling 1/3");
ui.ready({
	platform: "ios",
	deviceId: "8F2A-1C3D",
	deviceName: "warden-iphone-17-5",
	port: 8101,
	metroUrl: "http://localhost:8101",
	leaseIds: ["l1"],
	app: { source: "cache", hash: "abc123" },
	projectName: "example",
});

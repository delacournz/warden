import type { DemoDefinition } from "../../../../scripts/demo/demo.types";

/**
 * The app's network on a leased simulator: online, cut to offline, back on a slow EDGE link, then full speed. The
 * screen probes a real HTTPS endpoint every ~1.5 s; warden shapes the app's traffic in-process (iOS dylib launch in
 * `setup`), so nothing else on the Mac slows down.
 */
export const demo: DemoDefinition = {
	name: "network/offline",
	title: "Pull the plug.",
	subtitle: "warden takes the app offline, then onto a slow link, on a leased simulator.",
	terminalTitle: "warden-example — zsh",
	footer: { left: "warden.co.nz", right: "simulator · iPhone 17 Pro · network" },
	platform: "ios",
	claim: { profile: "iphone-17-pro" },
	app: {
		bundleId: "nz.co.delacour.warden.example",
		kind: "simulator",
		project: "apps/example",
		deepLink: "warden-example://network",
		appearance: "dark",
	},
	setup: [["ui", "network", "set", "online", "--relaunch"]],
	ready: ["id=net-screen", "text=/^Online$/"],
	leadInMs: 2000,
	tailHoldMs: 3500,
	outro: "# real requests · nothing mocked in the app",
	steps: [
		{
			argv: ["ui", "network", "set", "offline"],
			output: { kind: "plain", text: "network offline" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "wait", "text=/^Offline$/", "--timeout", "10000"],
			shown: "warden ui wait 'text=/^Offline$/'",
			output: { kind: "ok", text: "found “Offline”" },
			pauseAfterMs: 1800,
		},
		{
			argv: ["ui", "network", "set", "edge"],
			output: { kind: "plain", text: "network edge" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "wait", "text", "Slow link", "--timeout", "15000"],
			shown: 'warden ui wait text "Slow link"',
			output: { kind: "ok", text: "found “Slow link”" },
			pauseAfterMs: 1800,
		},
		{
			argv: ["ui", "network", "set", "online"],
			output: { kind: "plain", text: "network online" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "wait", "text=/^Online$/", "--timeout", "15000"],
			shown: "warden ui wait 'text=/^Online$/'",
			output: { kind: "ok", text: "found “Online”" },
			pauseAfterMs: 800,
		},
	],
};

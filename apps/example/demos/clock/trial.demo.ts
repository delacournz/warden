import type { DemoDefinition } from "../../../../scripts/demo/demo.types";

/**
 * The app's wall clock on a leased simulator: ten days pass, five more expire the 14-day trial, then real time
 * comes back. The app reads plain `Date.now()`; warden shifts it in-process (iOS dylib launch in `setup`).
 */
export const demo: DemoDefinition = {
	name: "clock/trial",
	title: "Fast-forward the clock.",
	subtitle: "warden moves the app's wall clock on a leased simulator.",
	terminalTitle: "warden-example — zsh",
	footer: { left: "warden.co.nz", right: "simulator · iPhone 17 Pro · clock" },
	platform: "ios",
	claim: { profile: "iphone-17-pro" },
	app: {
		bundleId: "nz.co.delacour.warden.example",
		kind: "simulator",
		project: "apps/example",
		deepLink: "warden-example://clock",
		appearance: "dark",
	},
	setup: [["ui", "network", "set", "online", "--relaunch"]],
	ready: ["id=clk-screen", "id=clk-days"],
	leadInMs: 1500,
	tailHoldMs: 3500,
	outro: "# app code untouched · plain Date.now()",
	steps: [
		{
			argv: ["ui", "clock", "advance", "10d"],
			output: { kind: "plain", text: "clock +10d" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "wait", "text=/^4 days left$/", "--timeout", "8000"],
			shown: "warden ui wait 'text=/^4 days left$/'",
			output: { kind: "ok", text: "found “4 days left”" },
			pauseAfterMs: 1600,
		},
		{
			argv: ["ui", "clock", "advance", "5d"],
			output: { kind: "plain", text: "clock +15d" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "wait", "text", "Trial expired", "--timeout", "8000"],
			shown: 'warden ui wait text "Trial expired"',
			output: { kind: "ok", text: "found “Trial expired”" },
			pauseAfterMs: 1600,
		},
		{
			argv: ["ui", "clock", "reset"],
			output: { kind: "plain", text: "real time" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "wait", "text", "14 days left", "--timeout", "8000"],
			shown: 'warden ui wait text "14 days left"',
			output: { kind: "ok", text: "found “14 days left”" },
			pauseAfterMs: 600,
		},
	],
};

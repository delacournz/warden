import type { DemoDefinition } from "../../../../scripts/demo/demo.types";

/**
 * A server fault on a leased simulator: the link stays up, but warden resets every connection to one host, so the
 * app's requests fail while Wi-Fi still reads connected. Clearing the fault brings it back. Faults reach only an app
 * launched with the iOS dylib (`setup`).
 */
export const demo: DemoDefinition = {
	name: "network/fault",
	title: "Break one host.",
	subtitle: "warden fails the app's requests to a single host; the Wi-Fi stays up.",
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
	outro: "# link still up · only that host fails",
	steps: [
		{
			argv: ["ui", "network", "fault", "speed.cloudflare.com", "reset"],
			output: { kind: "plain", text: "speed.cloudflare.com · reset" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "wait", "text", "Requests failing", "--timeout", "15000"],
			shown: 'warden ui wait text "Requests failing"',
			output: { kind: "ok", text: "found “Requests failing”" },
			pauseAfterMs: 2400,
		},
		{
			argv: ["ui", "network", "fault", "--clear"],
			output: { kind: "plain", text: "faults cleared" },
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

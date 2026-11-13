import type { DemoDefinition } from "../../../../scripts/demo/demo.types";

/**
 * A push notification on a leased simulator: the events screen asked for notification permission off camera, then
 * `warden ui push` delivers a payload and the app's notification handler receives it (the `last` readout fills with
 * the payload's title). No banner is claimed: on a simulator it shows seconds late, if at all.
 */
export const demo: DemoDefinition = {
	name: "events/push",
	title: "Send a push to the app.",
	subtitle: "warden delivers a notification payload to the real app on a leased simulator.",
	terminalTitle: "warden-example — zsh",
	footer: { left: "warden.co.nz", right: "simulator · iPhone 17 Pro · events" },
	platform: "ios",
	claim: { profile: "iphone-17-pro" },
	app: {
		bundleId: "nz.co.delacour.warden.example",
		kind: "simulator",
		project: "apps/example",
		deepLink: "warden-example://events",
		appearance: "dark",
	},
	setup: [
		["ui", "open", "warden-example://events", "--settle"],
		["ui", "press", "id=events-enable", "--settle"],
		{ argv: ["ui", "alert", "accept", "--settle"], optional: true },
	],
	ready: ["id=events-screen", "id=events-enable"],
	leadInMs: 1500,
	tailHoldMs: 4500,
	outro: "# a real notification, handled by the running app",
	steps: [
		{
			argv: ["ui", "push", "demos/events/push.json"],
			output: { kind: "plain", text: "push delivered" },
			pauseAfterMs: 300,
		},
		{
			argv: ["ui", "wait", "text", "Order shipped", "--timeout", "15000"],
			shown: 'warden ui wait text "Order shipped"',
			output: { kind: "ok", text: "last: Order shipped" },
			pauseAfterMs: 2500,
		},
	],
};

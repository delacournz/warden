import type { DemoDefinition } from "../../../../scripts/demo/demo.types";

/**
 * Two-finger gestures on a leased simulator: pinch the canvas to zoom, rotate it, then flip the system
 * appearance. The readouts on screen (Scale, Rotation) are what the captions claim.
 */
export const demo: DemoDefinition = {
	name: "gestures/pinch",
	title: "Two fingers, no hands.",
	subtitle: "warden pinches, rotates and flips the appearance on a leased simulator.",
	terminalTitle: "warden-example — zsh",
	footer: { left: "warden.co.nz", right: "simulator · iPhone 17 Pro · gestures" },
	platform: "ios",
	claim: { profile: "iphone-17-pro" },
	app: {
		bundleId: "nz.co.delacour.warden.example",
		kind: "simulator",
		project: "apps/example",
		deepLink: "warden-example://gestures",
		appearance: "dark",
	},
	ready: ["id=gestures-screen", "id=gestures-canvas"],
	leadInMs: 1500,
	tailHoldMs: 3000,
	outro: "# real multi-touch · not a tap shim",
	steps: [
		{
			argv: ["ui", "gesture", "pinch", "id=gestures-canvas", "1.6"],
			output: { kind: "ok", text: "canvas zoomed in" },
			pauseAfterMs: 1800,
		},
		{
			argv: ["ui", "gesture", "rotate", "id=gestures-canvas", "45"],
			output: { kind: "ok", text: "canvas turned 45°" },
			pauseAfterMs: 1800,
		},
		{
			argv: ["ui", "screen", "appearance", "light"],
			output: { kind: "ok", text: "system went light" },
			pauseAfterMs: 2200,
		},
	],
};

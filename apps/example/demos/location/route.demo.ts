import type { DemoDefinition } from "../../../../scripts/demo/demo.types";

/**
 * GPS on a leased simulator: tracking starts on a fixed point inside the 150 m geofence, then warden plays a route
 * north out of it and the app sees real fixes arrive (`expo-location`, no mock in the app). Permission and the
 * starting point are set off camera in `setup`, before the deep link launches the app.
 */
export const demo: DemoDefinition = {
	name: "location/route",
	title: "Drive the GPS.",
	subtitle: "warden plays a route on a leased simulator; the app gets real location fixes.",
	terminalTitle: "warden-example — zsh",
	footer: { left: "warden.co.nz", right: "simulator · iPhone 17 Pro · location" },
	platform: "ios",
	claim: { profile: "iphone-17-pro" },
	app: {
		bundleId: "nz.co.delacour.warden.example",
		kind: "simulator",
		project: "apps/example",
		deepLink: "warden-example://location",
		appearance: "dark",
	},
	setup: [
		["ui", "permission", "set", "location=granted"],
		["ui", "location", "set", "37.3349,-122.009"],
	],
	ready: ["id=loc-screen", "id=loc-toggle"],
	leadInMs: 1500,
	tailHoldMs: 3500,
	outro: "# app code untouched · plain expo-location",
	steps: [
		{
			argv: ["ui", "press", "id=loc-toggle"],
			output: { kind: "plain", text: "pressed Start tracking" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "wait", "text", "Holding still", "--timeout", "15000"],
			shown: 'warden ui wait text "Holding still"',
			output: { kind: "ok", text: "first fix · inside the geofence" },
			pauseAfterMs: 1200,
		},
		{
			argv: ["ui", "location", "route", "37.3349,-122.009", "37.3398,-122.009", "--speed", "30"],
			output: { kind: "plain", text: "route · 2 points · 30 m/s" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "wait", "text", "Outside", "--timeout", "20000"],
			shown: 'warden ui wait text "Outside"',
			output: { kind: "ok", text: "left the 150 m geofence" },
			pauseAfterMs: 3000,
		},
	],
};

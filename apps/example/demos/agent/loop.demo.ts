import type { DemoDefinition } from "../../../../scripts/demo/demo.types";

/**
 * The agent loop on a leased simulator: read the screen, fill the sign-in form, press submit, wait for the todos
 * screen, add a todo. Each output line is what the phone visibly did (the snapshot has no visible effect, so its
 * line says only what it printed).
 */
export const demo: DemoDefinition = {
	name: "agent/loop",
	title: "An agent drives your app.",
	subtitle: "snapshot, fill, press, wait: the loop on a leased simulator.",
	terminalTitle: "warden-example — zsh",
	footer: { left: "warden.co.nz", right: "simulator · iPhone 17 Pro · warden ui" },
	platform: "ios",
	claim: { profile: "iphone-17-pro" },
	app: {
		bundleId: "nz.co.delacour.warden.example",
		kind: "simulator",
		project: "apps/example",
		deepLink: "warden-example://sign-in",
		appearance: "dark",
	},
	ready: ["id=sign-in-screen", "id=sign-in-email"],
	leadInMs: 1500,
	tailHoldMs: 3500,
	outro: "# any agent, any screen · real taps and keystrokes",
	steps: [
		{
			argv: ["ui", "snapshot", "-i"],
			output: { kind: "plain", text: "listed email, password, submit" },
			pauseAfterMs: 1200,
		},
		{
			argv: ["ui", "fill", "id=sign-in-email", "ada@example.com"],
			output: { kind: "ok", text: "typed the email" },
			pauseAfterMs: 600,
		},
		{
			argv: ["ui", "fill", "id=sign-in-password", "password1"],
			output: { kind: "ok", text: "typed the password" },
			pauseAfterMs: 600,
		},
		{
			argv: ["ui", "press", "id=sign-in-submit"],
			output: { kind: "ok", text: "pressed Sign in" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "wait", "id=todos-screen", "--timeout", "15000"],
			output: { kind: "ok", text: "todos screen is up" },
			pauseAfterMs: 1500,
		},
		{
			argv: ["ui", "fill", "id=todo-input", "Ship the demo", "--via", "paste"],
			output: { kind: "ok", text: "typed a todo" },
			pauseAfterMs: 600,
		},
		{
			argv: ["ui", "press", "id=todo-add"],
			output: { kind: "ok", text: "added it to the list" },
			pauseAfterMs: 2000,
		},
	],
};

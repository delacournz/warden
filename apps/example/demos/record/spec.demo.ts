import type { DemoDefinition } from "../../../../scripts/demo/demo.types";

/**
 * `warden ui record` on a leased simulator: start a recording, drive the sign-in screen by hand, stop it (warden
 * writes `e2e/signin-demo.e2e.ts` and replays it once on the same device). The generated file is deleted after the
 * take unless it is kept as an example spec.
 */
export const demo: DemoDefinition = {
	name: "record/spec",
	title: "Drive it once. Keep it as a test.",
	subtitle: "warden turns a hand-driven session into a spec and replays it on the same simulator.",
	terminalTitle: "warden-example — zsh",
	footer: { left: "warden.co.nz", right: "simulator · iPhone 17 Pro · warden ui record" },
	platform: "ios",
	claim: { profile: "iphone-17-pro" },
	app: {
		bundleId: "nz.co.delacour.warden.example",
		kind: "simulator",
		project: "apps/example",
		appearance: "dark",
	},
	ready: ["id=welcome-screen", "id=welcome-next"],
	leadInMs: 1000,
	tailHoldMs: 4500,
	outro: "# e2e/signin-demo.e2e.ts · replay passed",
	steps: [
		{
			argv: ["ui", "record", "start", "signin-demo", "--title", "signs in", "--suite", "example"],
			shown: "warden ui record start signin-demo",
			output: { kind: "plain", text: "recording" },
			pauseAfterMs: 600,
		},
		{
			argv: ["ui", "open", "nz.co.delacour.warden.example", "--relaunch"],
			output: { kind: "ok", text: "relaunched the app" },
			pauseAfterMs: 300,
		},
		{
			argv: ["ui", "wait", "id=welcome-screen"],
			hidden: true,
			output: { kind: "plain", text: "x" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "press", "id=welcome-next"],
			output: { kind: "ok", text: "next: Plan" },
			pauseAfterMs: 300,
		},
		{
			argv: ["ui", "wait", "text", "Plan"],
			hidden: true,
			output: { kind: "plain", text: "x" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "get", "id=welcome-title", "text"],
			hidden: true,
			output: { kind: "plain", text: "x" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "press", "id=welcome-next"],
			output: { kind: "ok", text: "next: Test" },
			pauseAfterMs: 300,
		},
		{
			argv: ["ui", "wait", "text", "Test"],
			hidden: true,
			output: { kind: "plain", text: "x" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "get", "id=welcome-title", "text"],
			hidden: true,
			output: { kind: "plain", text: "x" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "press", "id=welcome-get-started"],
			output: { kind: "ok", text: "opened sign in" },
			pauseAfterMs: 300,
		},
		{
			argv: ["ui", "wait", "id=sign-in-screen"],
			hidden: true,
			output: { kind: "plain", text: "x" },
			pauseAfterMs: 0,
		},
		{
			argv: ["ui", "fill", "id=sign-in-email", "ada@example.com"],
			output: { kind: "ok", text: "typed the email" },
			pauseAfterMs: 500,
		},
		{
			argv: ["ui", "fill", "id=sign-in-password", "password1"],
			output: { kind: "ok", text: "typed the password" },
			pauseAfterMs: 500,
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
			argv: ["ui", "record", "stop"],
			output: {
				kind: "lines",
				text: [
					'await app.open({ wait: "quiet" });',
					"await screen.getByTestId(ids.welcomeNext).tap();",
					"await screen.getByTestId(ids.signInSubmit).tap();",
				],
			},
			quote: { file: "e2e/signin-demo.e2e.ts" },
			pauseAfterMs: 1000,
		},
	],
};

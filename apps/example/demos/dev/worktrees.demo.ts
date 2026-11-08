import type { LanesDemoDefinition } from "../../../../scripts/demo/demo.types";
import { demo as hero } from "./hero.demo";

/**
 * Two agents, two git worktrees of the same commit, two `warden dev ios` at once. Each claims its own simulator
 * (`--label`) and its own Metro port; neither knows about the other. Once both dev clients are up, `warden ls` runs
 * for real (filtered to the two labels) and lists both device leases and both port leases. Both quit with `q`.
 * The worktrees are made by hand first (`git worktree add --detach <dir>/agent-a HEAD`, same for agent-b, then
 * `bun install` in each); `bun run demo:lanes dev/worktrees --worktrees <dir>`.
 */
export const demo: LanesDemoDefinition = {
	name: "dev/worktrees",
	base: {
		...hero,
		name: "dev/worktrees",
		cols: 100,
		rows: 24,
		beats: [
			{ id: "start", caption: "warden dev ios", timeoutMs: 1000, pauseAfterMs: 0 },
			{
				id: "client",
				caption: "dev client open",
				waitScreen: "✓ dev client",
				waitPhone: ["id=welcome-screen"],
				timeoutMs: 600_000,
				pauseAfterMs: 5000,
			},
			{ id: "quit", caption: "q", keys: "q", stopVideoFirst: true, timeoutMs: 5000, pauseAfterMs: 500 },
		],
	},
	lanes: [
		{ checkout: "agent-a", label: "demo-wt-a", title: "agent-a: warden dev ios" },
		{ checkout: "agent-b", label: "demo-wt-b", title: "agent-b: warden dev ios" },
	],
	staggerMs: 2500,
	meetBeat: "client",
	shell: {
		cols: 200,
		rows: 7,
		title: "shell",
		command: "warden ls | grep -E 'LEASE|demo-wt'",
	},
	captions: [
		{ text: "two worktrees, two agents: warden dev ios in each", at: "start" },
		{ text: "two simulators and two Metro ports, no collision", at: "meet" },
		{ text: "warden ls: both leases", at: "shell" },
	],
	footer: { right: "warden.co.nz · real simulators · not an animation" },
	shellHoldMs: 5000,
	posterAfterShellS: 4.5,
};

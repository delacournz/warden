import type { Exec } from "@delacour/warden-runtime/exec";
import type { GitFactsCache } from "@delacour/warden-runtime/git-facts";
import type { Store } from "@delacour/warden-store/store";

/** The text styles the perf engine's human renderings use. The CLI passes its terminal colours, the SDK none. */
export type PerfColor = {
	dim: (text: string) => string;
	green: (text: string) => string;
	red: (text: string) => string;
	yellow: (text: string) => string;
};

/** Prompts a perf step may raise (a download consent). The SDK never prompts: `interactive` is false. */
export type PerfUi = {
	color: PerfColor;
	interactive: boolean;
	/** a redrawable terminal (progress bars); false for pipes and the SDK */
	rich: boolean;
	confirm: (question: string) => Promise<boolean | undefined>;
};

/**
 * Everything the perf engine needs from the outside world. Structurally a subset of the CLI's `CommandContext`
 * (so the CLI passes its context as is), and what an SDK session builds from its host. Side effects (process
 * execution, the clock, the store) are injected here; tests pass fakes.
 */
export type PerfEnv = {
	env: Record<string, string | undefined>;
	cwd: string;
	now: () => number;
	exec: Exec;
	/** the memo of repo facts (the caller's owner is detected from them) */
	git: GitFactsCache;
	/** the warden store: the cross-process mutex (`transaction`) for session files and lease reads */
	store: () => Store;
};

/** A {@link PerfEnv} that can also style text and ask for consent (the steps that render or download). */
export type PerfUiEnv = PerfEnv & { ui: PerfUi; err: (line: string) => void };

const same = (text: string): string => text;

/** A {@link PerfUi} with no colour and no prompts (SDK callers, tests). */
export const plainUi: PerfUi = {
	color: { dim: same, green: same, red: same, yellow: same },
	interactive: false,
	rich: false,
	confirm: async () => false,
};

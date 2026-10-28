import { removeWorktrees, type WorktreeState } from "@delacour/warden-core/worktrees/audit";
import type { CommandContext } from "./context";

/** `WARDEN_GC_WORKTREES=merged` lets `warden gc` remove clean merged git worktrees. There is no `~/.warden` config file, so env is the one switch. */
export type GcWorktreesMode = "merged";

export function gcWorktreesMode(env: Record<string, string | undefined>): {
	mode: GcWorktreesMode | undefined;
	problems: string[];
} {
	const raw = env.WARDEN_GC_WORKTREES?.trim().toLowerCase();
	if (raw === undefined || raw === "" || raw === "off" || raw === "0") return { mode: undefined, problems: [] };
	if (raw === "merged") return { mode: "merged", problems: [] };
	return { mode: undefined, problems: [`WARDEN_GC_WORKTREES=${env.WARDEN_GC_WORKTREES} must be "merged" — ignored`] };
}

type Listed = { path: string; branch: string; bytes?: number };

/** What gc did (or, for `--dry-run`, would do) with worktrees. */
export type GcWorktrees = {
	removed: Listed[];
	/** merged worktrees git or warden refused to remove, with why */
	kept: { path: string; outcome: string; detail: string }[];
	freed: number;
};

const listed = (e: WorktreeState): Listed => ({
	path: e.path,
	branch: e.branch,
	...(e.bytes !== undefined ? { bytes: e.bytes } : {}),
});

/** Audit (no fetch, sized for merged only) and return the merged entries. Loaded lazily: only gc runs with the opt-in pay for it. */
async function mergedWorktrees(ctx: CommandContext): Promise<{ merged: WorktreeState[]; notes: string[] }> {
	const { summarizeWorktrees } = await import("./commands/worktrees");
	const { audit } = await summarizeWorktrees(ctx);
	return { merged: audit.entries.filter((e) => e.state === "merged"), notes: audit.notes };
}

/** `--dry-run`: the merged worktrees a pass would remove. */
export async function previewWorktrees(ctx: CommandContext): Promise<{ found: Listed[]; total: number }> {
	const { merged } = await mergedWorktrees(ctx);
	return { found: merged.map(listed), total: merged.reduce((sum, e) => sum + (e.bytes ?? 0), 0) };
}

/** Remove the merged worktrees (`git worktree remove`, no force). Never throws: a failed audit is a note. */
export async function sweepWorktrees(ctx: CommandContext): Promise<{ bucket: GcWorktrees; notes: string[] }> {
	const bucket: GcWorktrees = { removed: [], kept: [], freed: 0 };
	try {
		const { merged, notes } = await mergedWorktrees(ctx);
		const { worktreeDeps } = await import("./commands/worktrees");
		for (const r of await removeWorktrees(merged, worktreeDeps(ctx))) {
			if (r.outcome === "removed") bucket.removed.push(listed(r.entry));
			else bucket.kept.push({ path: r.entry.path, outcome: r.outcome, detail: r.detail });
		}
		bucket.freed = bucket.removed.reduce((sum, e) => sum + (e.bytes ?? 0), 0);
		return {
			bucket,
			notes: [...notes, ...bucket.kept.map((k) => `kept worktree ${k.path}: ${k.outcome}, ${k.detail}`)],
		};
	} catch (e) {
		return { bucket, notes: [`worktree sweep failed: ${e instanceof Error ? e.message : String(e)}`] };
	}
}

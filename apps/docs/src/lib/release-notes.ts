/**
 * The release notes page, built from the CLI's changesets: released versions come from
 * `apps/cli/CHANGELOG.md`, and the changesets still waiting in `.changeset/` show as Unreleased
 * (so staging, built from `develop`, previews the next release). `scripts/generate-release-notes.ts`
 * writes the result to `content/docs/release-notes.md`; this module only transforms text.
 */
import { githubUrl } from "./shared";

export type BumpKind = "major" | "minor" | "patch";

export type ReleaseSection = { kind: BumpKind; entries: string[] };

export type Release = { version: string; sections: ReleaseSection[] };

export type PendingChangeset = { kind: BumpKind; body: string };

const KINDS: readonly BumpKind[] = ["major", "minor", "patch"];

const HEADINGS: Record<BumpKind, string> = {
	major: "Breaking changes",
	minor: "Minor changes",
	patch: "Patch changes",
};

/** `- [#74](url) [\`sha\`](url) Thanks [@who](url)! - body`, as `@changesets/changelog-github` writes it. */
const ENTRY =
	/^- (\[#\d+\]\([^)]+\))?\s*(?:\[`[0-9a-f]+`\]\([^)]+\))?\s*(?:Thanks \[@[^\]]+\]\([^)]+\)! )?- ([\s\S]*)$/;

function kindOf(heading: string): BumpKind | undefined {
	return KINDS.find((kind) => heading.toLowerCase().startsWith(kind));
}

/** Split a section body into its top-level list items, each with its indented continuation lines. */
function listItems(lines: readonly string[]): string[] {
	const items: string[][] = [];
	for (const line of lines) {
		if (line.startsWith("- ")) items.push([line]);
		else if (items.length > 0) items[items.length - 1].push(line);
	}
	return items.map((item) => item.join("\n").trimEnd());
}

/** One changelog item as a list item of the page: PR link kept, commit and thanks dropped. */
function cleanEntry(item: string): string | undefined {
	if (item.startsWith("- Updated dependencies")) return undefined;
	const match = ENTRY.exec(item);
	if (!match) return item;

	const [, pr, body] = match;
	if (!pr) return `- ${body}`;
	const bulleted = body.startsWith("- ");
	if (bulleted && /\n {2}- /.test(body)) return `- ${pr}\n  ${body}`;
	return `- ${pr} ${bulleted ? body.slice(2) : body}`;
}

/** The released versions in `apps/cli/CHANGELOG.md`, newest first, without dependency-bump noise. */
export function parseChangelog(changelog: string): Release[] {
	const releases: Release[] = [];
	const lines = changelog.split(/\r?\n/);
	let release: Release | undefined;
	let section: { kind: BumpKind; lines: string[] } | undefined;

	const closeSection = () => {
		if (!release || !section) return;
		const entries = listItems(section.lines).flatMap((item) => cleanEntry(item) ?? []);
		if (entries.length > 0) release.sections.push({ kind: section.kind, entries });
		section = undefined;
	};

	for (const line of lines) {
		const version = /^## (\S+)/.exec(line);
		if (version) {
			closeSection();
			release = { version: version[1], sections: [] };
			releases.push(release);
			continue;
		}
		const heading = /^### (.+)/.exec(line);
		if (heading) {
			closeSection();
			const kind = kindOf(heading[1]);
			if (kind) section = { kind, lines: [] };
			continue;
		}
		section?.lines.push(line);
	}
	closeSection();

	return releases.filter((r) => r.sections.length > 0);
}

/** A `.changeset/*.md` file's `@delacour/warden` bump and body; undefined when it bumps nothing. */
export function parseChangeset(source: string): PendingChangeset | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n?---\r?\n([\s\S]*)$/.exec(source);
	if (!match) return undefined;

	const bump = /["']?@delacour\/warden["']?\s*:\s*(major|minor|patch)/.exec(match[1]);
	if (!bump) return undefined;

	return { kind: bump[1] as BumpKind, body: match[2].trim() };
}

/** A pending changeset's body as list items: bulleted bodies stay as they are. */
function pendingEntry(body: string): string {
	return body.startsWith("- ") ? body : `- ${body.replace(/\n/g, "\n  ")}`;
}

function renderSections(sections: readonly ReleaseSection[]): string[] {
	return KINDS.flatMap((kind) => {
		const entries = sections.filter((s) => s.kind === kind).flatMap((s) => s.entries);
		return entries.length > 0 ? [`### ${HEADINGS[kind]}`, entries.join("\n")] : [];
	});
}

/** The whole page, frontmatter included. */
export function renderReleaseNotes({
	releases,
	pending,
}: {
	releases: readonly Release[];
	pending: readonly PendingChangeset[];
}): string {
	const blocks = [
		"---",
		"title: Release notes",
		"description: What changed in each warden release, from the changesets that shipped it.",
		"icon: ScrollText",
		"---",
		"",
		`Every version of \`@delacour/warden\` (and \`@delacour/warden-e2e\`, which moves in lock-step). Run \`warden update\` to get the latest, see [Updating & releasing](/docs/updating).`,
	].join("\n");

	const parts = [blocks];

	if (pending.length > 0) {
		parts.push(
			"## Unreleased",
			"Merged into `develop`, shipping in the next release.",
			...renderSections(pending.map((p) => ({ kind: p.kind, entries: [pendingEntry(p.body)] })))
		);
	}

	for (const release of releases) {
		parts.push(
			`## ${release.version}`,
			`[GitHub release](${githubUrl}/releases/tag/v${release.version})`,
			...renderSections(release.sections)
		);
	}

	return `${parts.join("\n\n")}\n`;
}

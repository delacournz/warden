import { describe, expect, test } from "bun:test";
import { parseChangelog, parseChangeset, renderReleaseNotes } from "./release-notes";

const CHANGELOG = `# @delacour/warden

## 0.3.1

### Patch Changes

- [#74](https://github.com/delacournz/warden/pull/74) [\`6b3ffea\`](https://github.com/delacournz/warden/commit/6b3ffea) Thanks [@someone](https://github.com/someone)! - - \`bun run release <version>\` asks npm first.
- Updated dependencies []:
  - @delacour/warden-e2e@0.3.1

## 0.3.0

### Minor Changes

- [#72](https://github.com/delacournz/warden/pull/72) [\`b00d1e3\`](https://github.com/delacournz/warden/commit/b00d1e3) Thanks [@someone](https://github.com/someone)! - - \`warden ui record\` journals actions.
  - \`record use\` runs a helper.

### Patch Changes

- Updated dependencies []:
  - @delacour/warden-e2e@0.3.0

## 0.1.2

### Patch Changes

- [#64](https://github.com/delacournz/warden/pull/64) [\`2569b9c\`](https://github.com/delacournz/warden/commit/2569b9c) Thanks [@someone](https://github.com/someone)! - Releases flow through a PR.
`;

describe("parseChangelog", () => {
	test("one release per version, newest first", () => {
		expect(parseChangelog(CHANGELOG).map((r) => r.version)).toEqual(["0.3.1", "0.3.0", "0.1.2"]);
	});

	test("drops dependency bumps and the sections they leave empty", () => {
		const [, minor] = parseChangelog(CHANGELOG);
		expect(minor.sections.map((s) => s.kind)).toEqual(["minor"]);
	});

	test("strips commit and thanks, keeps the PR link, nests a multi-bullet body under it", () => {
		const [patch, minor, plain] = parseChangelog(CHANGELOG);
		expect(patch.sections[0].entries).toEqual([
			"- [#74](https://github.com/delacournz/warden/pull/74) `bun run release <version>` asks npm first.",
		]);
		expect(minor.sections[0].entries).toEqual([
			"- [#72](https://github.com/delacournz/warden/pull/72)\n  - `warden ui record` journals actions.\n  - `record use` runs a helper.",
		]);
		expect(plain.sections[0].entries).toEqual([
			"- [#64](https://github.com/delacournz/warden/pull/64) Releases flow through a PR.",
		]);
	});
});

describe("parseChangeset", () => {
	test("reads the warden bump and body", () => {
		const file = `---\n"@delacour/warden": minor\n---\n\n- New \`warden mcp\`.\n- Logs.\n`;
		expect(parseChangeset(file)).toEqual({ kind: "minor", body: "- New `warden mcp`.\n- Logs." });
	});

	test("a changeset that does not bump warden is skipped", () => {
		expect(parseChangeset(`---\n---\n\nnothing\n`)).toBeUndefined();
	});
});

describe("renderReleaseNotes", () => {
	test("unreleased first, then each version linked to its GitHub release", () => {
		const md = renderReleaseNotes({
			releases: parseChangelog(CHANGELOG),
			pending: [
				{ kind: "patch", body: "Fixes a thing." },
				{ kind: "minor", body: "- New a\n- New b" },
			],
		});
		expect(md).toStartWith("---\ntitle: Release notes\n");
		expect(md.indexOf("## Unreleased")).toBeLessThan(md.indexOf("## 0.3.1"));
		expect(md).toContain("### Minor changes\n\n- New a\n- New b\n\n### Patch changes\n\n- Fixes a thing.");
		expect(md).toContain("[GitHub release](https://github.com/delacournz/warden/releases/tag/v0.3.1)");
		expect(md).not.toContain("Updated dependencies");
		expect(md).not.toContain("Thanks");
	});

	test("no pending changesets, no Unreleased section", () => {
		expect(renderReleaseNotes({ releases: parseChangelog(CHANGELOG), pending: [] })).not.toContain("Unreleased");
	});
});

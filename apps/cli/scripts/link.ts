#!/usr/bin/env bun
/**
 * Puts this checkout's CLI on PATH as `warden`, running from source, and takes it off again.
 *   bun scripts/link.ts link     → ~/.local/bin/warden becomes a shim to this checkout's src/cli.ts
 *   bun scripts/link.ts unlink   → whatever was there before: a binary, another link, or nothing
 *
 * `link` is `warden install --shim`'s binary step with a memory (see `./link/state.ts`): it leaves
 * the hooks, skill and agent config alone, and no build is needed, since the shim runs the source.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { linkPaths, restoreLink, type Snapshot, snapshotLink, writeShim } from "./link/state";

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
const paths = linkPaths(process.env.HOME ?? homedir());

const DESCRIPTION: Record<Snapshot["kind"], string> = {
	absent: "nothing, so it is removed",
	symlink: "the link that was there",
	moved: "the binary that was there",
};

const command = process.argv[2];

if (command === "link") {
	snapshotLink(paths);
	writeShim(paths, cliPath);
	console.log(`linked ${paths.bin} → ${cliPath}\n\`bun run cli:unlink\` restores what was there before.`);
} else if (command === "unlink") {
	const outcome = restoreLink(paths, cliPath);
	if (outcome.kind === "restored") console.log(`restored ${paths.bin} to ${DESCRIPTION[outcome.was]}.`);
	if (outcome.kind === "replaced") console.log(`${paths.bin} has been installed for real since the link; left alone.`);
	if (outcome.kind === "not-linked") console.log(`${paths.bin} is not linked to this checkout; nothing to restore.`);
} else {
	console.error("Usage: bun scripts/link.ts <link|unlink>");
	process.exit(1);
}

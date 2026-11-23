/**
 * What `warden golden export` records about the device tree it archives and `warden golden import` holds a restored
 * archive to. The summary covers names, kinds, sizes and link targets, not file contents: it tells a complete archive
 * from one a cache restored in part, cheaply (a golden is ~2 GB in ~20k entries). It is written beside the tree, so it
 * says nothing about who wrote the archive. The link rule is what keeps an imported device inside its own dirs.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";

export type TreeSummary = { sha256: string; entries: number };

type Kind = "dir" | "file" | "link" | "special";
type Visit = (entry: { path: string; shown: string; kind: Kind; size: number }) => Result<void>;

function kindOf(path: string): { kind: Kind; size: number } {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) return { kind: "link", size: stat.size };
	if (stat.isDirectory()) return { kind: "dir", size: stat.size };
	return { kind: stat.isFile() ? "file" : "special", size: stat.size };
}

/** Every entry under `root`, directories before their contents, names in code-unit order. Symlinks are not followed. */
function walk(root: string, visit: Visit): Result<void> {
	const each = (dir: string): Result<void> => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const { kind, size } = kindOf(path);
			const visited = visit({ path, shown: relative(root, path), kind, size });
			if (!visited.success) return visited;
			const inner = kind === "dir" ? each(path) : visited;
			if (!inner.success) return inner;
		}
		return ok(undefined);
	};
	return each(root);
}

/**
 * sha256 over one line per entry under `root`: `d <path>`, `f <path> <size>`, `l <path> <target>` (paths and targets
 * JSON-quoted, relative to `root`). The same tree gives the same summary on any machine.
 */
export function summarizeTree(root: string): Result<TreeSummary> {
	const hash = createHash("sha256");
	let entries = 0;
	const walked = walk(root, ({ path, shown, kind, size }) => {
		const name = JSON.stringify(shown.split(sep).join("/"));
		if (kind === "special") return err(`${shown} is neither a file, a directory nor a symlink`);
		if (kind === "dir") hash.update(`d ${name}\n`);
		else if (kind === "file") hash.update(`f ${name} ${size}\n`);
		else hash.update(`l ${name} ${JSON.stringify(readlinkSync(path))}\n`);
		entries++;
		return ok(undefined);
	});
	return walked.success ? ok({ sha256: hash.digest("hex"), entries }) : walked;
}

/** Remove sockets, FIFOs and devices under `root` (a shut-down simulator needs none of them); returns their paths. */
export function dropSpecialFiles(root: string): string[] {
	const dropped: string[] = [];
	walk(root, ({ path, shown, kind }) => {
		if (kind === "special") {
			rmSync(path, { force: true });
			dropped.push(shown);
		}
		return ok(undefined);
	});
	return dropped;
}

const DEVICE_DIRS = ["Library/Developer/CoreSimulator/Devices", "Library/Logs/CoreSimulator"];

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** An absolute target is the exporting device's own dir or log dir (or below one), under the exporting home when known. */
function ownsAbsolute(target: string, from: { udid: string; home?: string }): boolean {
	if (target.split("/").includes("..")) return false;
	const home = from.home === undefined ? "/(?:[^/]+/)*?[^/]+" : escapeRegExp(from.home.replace(/\/+$/, ""));
	const dirs = DEVICE_DIRS.map(escapeRegExp).join("|");
	return new RegExp(`^${home}/(?:${dirs})/${escapeRegExp(from.udid)}(?:/|$)`).test(target);
}

/** A relative target climbs first (`../..`), then descends, and never ends up above `root`. */
function staysInside(root: string, link: string, target: string): boolean {
	const parts = target.split("/").filter((part) => part !== "" && part !== ".");
	const firstName = parts.findIndex((part) => part !== "..");
	if (firstName !== -1 && parts.slice(firstName).includes("..")) return false;
	const landed = relative(root, resolve(dirname(link), target));
	return landed !== ".." && !landed.startsWith(`..${sep}`);
}

/**
 * Every symlink under `root` (an archived device dir) stays within the device: a relative one inside the tree, an
 * absolute one inside the exporting device's own CoreSimulator dirs (the ones import re-points at the new device).
 * The first link that goes anywhere else is the error.
 */
export function checkArchiveLinks(root: string, from: { udid: string; home?: string }): Result<void> {
	return walk(root, ({ path, shown, kind }) => {
		if (kind !== "link") return ok(undefined);
		const target = readlinkSync(path);
		const inside = target.startsWith("/") ? ownsAbsolute(target, from) : staysInside(root, path, target);
		return inside ? ok(undefined) : err(`${shown} points outside the device (${target})`);
	});
}

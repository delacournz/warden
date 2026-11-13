import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import { err, ok, type Result } from "@delacour/warden-types/result";

type Env = Record<string, string | undefined>;

/** What a link binds: a directory (and everything below it) or a git remote. */
export type LinkTarget = { kind: "path"; path: string } | { kind: "remote"; remote: string };

/** `warden org link`: a directory or git remote bound to a named account + org. */
export type Link = LinkTarget & {
	account: string;
	organizationId: string;
	orgSlug: string;
	createdAt: number;
};

type LinksFile = { version: 1; links: Link[] };

export function linksPath(env: Env): string {
	return join(wardenHome(env), "links.json");
}

/** Absolute, normalised, no trailing slash (the root stays `/`). Callers pass realpath'd paths. */
export function normalizeLinkPath(p: string): string {
	const resolved = resolve(p);
	return resolved.length > 1 ? resolved.replace(/\/+$/, "") || "/" : resolved;
}

/**
 * `host/owner/repo` for any git remote spelling (scp-like, ssh://, https://, with user / port / `.git` / trailing
 * slash): host lowercased, path case kept. Anything that is not host + at least one path segment is `undefined`.
 */
export function normalizeRemote(url: string): string | undefined {
	const input = url.trim();
	if (!input || /\s/.test(input)) return undefined;
	let host: string;
	let path: string;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
		try {
			const parsed = new URL(input);
			host = parsed.hostname;
			path = parsed.pathname;
		} catch {
			return undefined;
		}
	} else {
		const scp = /^(?:[^@/:]+@)?([^@/:]+):(.*)$/.exec(input);
		if (!scp) return undefined;
		host = scp[1] ?? "";
		path = scp[2] ?? "";
	}
	const cleaned = path
		.replace(/^\/+|\/+$/g, "")
		.replace(/\.git$/i, "")
		.replace(/\/+$/, "");
	if (!host || !cleaned) return undefined;
	return `${host.toLowerCase()}/${cleaned}`;
}

function remoteKey(remote: string): string {
	return normalizeRemote(remote) ?? remote;
}

function sameTarget(a: LinkTarget, b: LinkTarget): boolean {
	if (a.kind === "path" && b.kind === "path") return normalizeLinkPath(a.path) === normalizeLinkPath(b.path);
	if (a.kind === "remote" && b.kind === "remote") return remoteKey(a.remote) === remoteKey(b.remote);
	return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLink(value: unknown): Link | undefined {
	if (!isRecord(value)) return undefined;
	const { kind, account, organizationId, orgSlug, createdAt } = value;
	if (typeof account !== "string" || typeof organizationId !== "string" || typeof orgSlug !== "string")
		return undefined;
	if (typeof createdAt !== "number") return undefined;
	const rest = { account, organizationId, orgSlug, createdAt };
	if (kind === "path" && typeof value.path === "string") return { kind, path: value.path, ...rest };
	if (kind === "remote" && typeof value.remote === "string") return { kind, remote: value.remote, ...rest };
	return undefined;
}

function parseFile(value: unknown): Link[] | undefined {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.links)) return undefined;
	const links: Link[] = [];
	for (const raw of value.links) {
		const link = parseLink(raw);
		if (!link) return undefined;
		links.push(link);
	}
	return links;
}

/** Every saved link; no file is `[]`, a damaged one is an error. */
export function readLinks(env: Env): Result<Link[]> {
	const path = linksPath(env);
	if (!existsSync(path)) return ok([]);
	try {
		const links = parseFile(JSON.parse(readFileSync(path, "utf8")));
		return links ? ok(links) : err(`${path} is not a warden links file; fix or delete it`);
	} catch (e) {
		return err(`${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function writeLinks(env: Env, links: Link[]): Result<Link[]> {
	const path = linksPath(env);
	const tmp = `${path}.${process.pid}.tmp`;
	const file: LinksFile = { version: 1, links };
	try {
		mkdirSync(wardenHome(env), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
		return ok(links);
	} catch (e) {
		rmSync(tmp, { force: true });
		return err(`could not save ${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Add `link`, replacing any link with the same kind + path / remote. Returns the new list. */
export function upsertLink(env: Env, link: Link): Result<Link[]> {
	const current = readLinks(env);
	if (!current.success) return current;
	return writeLinks(env, [...current.data.filter((l) => !sameTarget(l, link)), link]);
}

/** Drop the link for `target`; `removed` says whether there was one. */
export function removeLink(env: Env, target: LinkTarget): Result<{ removed: boolean }> {
	const current = readLinks(env);
	if (!current.success) return current;
	const kept = current.data.filter((l) => !sameTarget(l, target));
	if (kept.length === current.data.length) return ok({ removed: false });
	const written = writeLinks(env, kept);
	return written.success ? ok({ removed: true }) : written;
}

/**
 * The link governing `where`: the longest path link containing `cwd` (segment boundary), else a remote link
 * equal to the normalised `remote`. Path beats remote. Pure; `cwd` should be a realpath.
 */
export function matchLink(links: readonly Link[], where: { cwd: string; remote?: string }): Link | undefined {
	const cwd = normalizeLinkPath(where.cwd);
	let best: Link | undefined;
	let bestLength = -1;
	for (const link of links) {
		if (link.kind !== "path") continue;
		const base = normalizeLinkPath(link.path);
		const prefix = base.endsWith("/") ? base : `${base}/`;
		if ((cwd === base || cwd.startsWith(prefix)) && base.length > bestLength) {
			best = link;
			bestLength = base.length;
		}
	}
	if (best) return best;
	const remote = where.remote === undefined ? undefined : normalizeRemote(where.remote);
	if (remote === undefined) return undefined;
	return links.find((l) => l.kind === "remote" && remoteKey(l.remote) === remote);
}

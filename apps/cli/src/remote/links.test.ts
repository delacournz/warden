import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Link,
	linksPath,
	matchLink,
	normalizeLinkPath,
	normalizeRemote,
	readLinks,
	removeLink,
	upsertLink,
} from "./links";

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function home(): Record<string, string | undefined> {
	dir = mkdtempSync(join(tmpdir(), "warden-links-"));
	return { WARDEN_HOME: dir };
}

function pathLink(path: string, account = "work", extra: Partial<Link> = {}): Link {
	return {
		kind: "path",
		path,
		account,
		organizationId: `org-${account}`,
		orgSlug: account,
		createdAt: 1,
		...extra,
	} as Link;
}

function remoteLink(remote: string, account = "work"): Link {
	return { kind: "remote", remote, account, organizationId: `org-${account}`, orgSlug: account, createdAt: 1 };
}

describe("normalizeRemote", () => {
	const table: Array<[string, string | undefined]> = [
		["git@github.com:a/b.git", "github.com/a/b"],
		["ssh://git@github.com/a/b", "github.com/a/b"],
		["https://github.com/a/b.git", "github.com/a/b"],
		["https://user@github.com/a/b/", "github.com/a/b"],
		["https://GitHub.COM/Acme/Repo.git", "github.com/Acme/Repo"],
		["git@GitHub.com:Acme/Repo", "github.com/Acme/Repo"],
		["ssh://git@github.com:22/a/b.git", "github.com/a/b"],
		["https://gitlab.com/g/sub/proj.git", "gitlab.com/g/sub/proj"],
		["  https://github.com/a/b.git\n", "github.com/a/b"],
		["", undefined],
		["not a url", undefined],
		["https://github.com", undefined],
		["https://github.com/", undefined],
		["git@github.com:", undefined],
	];
	for (const [input, expected] of table) {
		test(JSON.stringify(input), () => {
			expect(normalizeRemote(input)).toBe(expected);
		});
	}
});

describe("normalizeLinkPath", () => {
	test("strips trailing slashes, keeps root", () => {
		expect(normalizeLinkPath("/a/b/")).toBe("/a/b");
		expect(normalizeLinkPath("/a/b///")).toBe("/a/b");
		expect(normalizeLinkPath("/")).toBe("/");
		expect(normalizeLinkPath("/a/./b/../c")).toBe("/a/c");
	});
});

describe("matchLink", () => {
	test("exact and descendant match", () => {
		const l = pathLink("/a/b");
		expect(matchLink([l], { cwd: "/a/b" })).toBe(l);
		expect(matchLink([l], { cwd: "/a/b/c/d" })).toBe(l);
	});

	test("segment boundary: /a/b does not match /a/bc", () => {
		expect(matchLink([pathLink("/a/b")], { cwd: "/a/bc" })).toBeUndefined();
		expect(matchLink([pathLink("/a/b")], { cwd: "/a" })).toBeUndefined();
	});

	test("longest path wins regardless of order", () => {
		const outer = pathLink("/a", "outer");
		const inner = pathLink("/a/b", "inner");
		expect(matchLink([outer, inner], { cwd: "/a/b/c" })?.account).toBe("inner");
		expect(matchLink([inner, outer], { cwd: "/a/b/c" })?.account).toBe("inner");
		expect(matchLink([inner, outer], { cwd: "/a/x" })?.account).toBe("outer");
	});

	test("root link matches everything", () => {
		const root = pathLink("/");
		expect(matchLink([root], { cwd: "/" })).toBe(root);
		expect(matchLink([root], { cwd: "/anything/here" })).toBe(root);
	});

	test("trailing slash on stored path or cwd", () => {
		const l = pathLink("/a/b/");
		expect(matchLink([l], { cwd: "/a/b" })).toBe(l);
		expect(matchLink([l], { cwd: "/a/b/c" })).toBe(l);
		expect(matchLink([pathLink("/a/b")], { cwd: "/a/b/" })).toBeDefined();
	});

	test("remote link matches by normalized remote", () => {
		const l = remoteLink("github.com/a/b");
		expect(matchLink([l], { cwd: "/x", remote: "git@github.com:a/b.git" })).toBe(l);
		expect(matchLink([l], { cwd: "/x", remote: "https://github.com/a/c" })).toBeUndefined();
		expect(matchLink([l], { cwd: "/x" })).toBeUndefined();
		expect(matchLink([l], { cwd: "/x", remote: "garbage" })).toBeUndefined();
	});

	test("path beats remote", () => {
		const p = pathLink("/a", "path");
		const r = remoteLink("github.com/a/b", "remote");
		expect(matchLink([r, p], { cwd: "/a/b", remote: "https://github.com/a/b" })?.account).toBe("path");
		expect(matchLink([r, p], { cwd: "/other", remote: "https://github.com/a/b" })?.account).toBe("remote");
	});

	test("no links", () => {
		expect(matchLink([], { cwd: "/a" })).toBeUndefined();
	});
});

describe("links store", () => {
	test("missing file reads as empty", () => {
		expect(readLinks(home())).toEqual({ success: true, data: [] });
	});

	test("upsert writes, round-trips, file is 0600", () => {
		const env = home();
		const l = pathLink("/a/b");
		expect(upsertLink(env, l)).toEqual({ success: true, data: [l] });
		expect(readLinks(env)).toEqual({ success: true, data: [l] });
		expect(statSync(linksPath(env)).mode & 0o777).toBe(0o600);
	});

	test("upsert replaces same kind+path and same kind+remote, keeps others", () => {
		const env = home();
		upsertLink(env, pathLink("/a/b", "one"));
		upsertLink(env, remoteLink("github.com/a/b", "one"));
		upsertLink(env, pathLink("/c", "keep"));
		upsertLink(env, pathLink("/a/b/", "two"));
		const r = upsertLink(env, remoteLink("github.com/a/b", "two"));
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data.map((l) => `${l.kind}:${l.account}`).sort()).toEqual(["path:keep", "path:two", "remote:two"]);
	});

	test("a path link and remote link with the same text do not collide", () => {
		const env = home();
		upsertLink(env, pathLink("/x"));
		const r = upsertLink(env, remoteLink("/x"));
		expect(r.success && r.data.length).toBe(2);
	});

	test("remove reports whether something was removed", () => {
		const env = home();
		upsertLink(env, pathLink("/a"));
		upsertLink(env, remoteLink("github.com/a/b"));
		expect(removeLink(env, { kind: "path", path: "/a/" })).toEqual({ success: true, data: { removed: true } });
		expect(removeLink(env, { kind: "path", path: "/a" })).toEqual({ success: true, data: { removed: false } });
		expect(removeLink(env, { kind: "remote", remote: "github.com/a/b" })).toEqual({
			success: true,
			data: { removed: true },
		});
		expect(readLinks(env)).toEqual({ success: true, data: [] });
	});

	test("remove on missing file is removed:false", () => {
		expect(removeLink(home(), { kind: "path", path: "/a" })).toEqual({ success: true, data: { removed: false } });
	});

	test("damaged file is an error for read, upsert and remove", () => {
		const env = home();
		writeFileSync(linksPath(env), "{not json");
		expect(readLinks(env).success).toBe(false);
		expect(upsertLink(env, pathLink("/a")).success).toBe(false);
		expect(removeLink(env, { kind: "path", path: "/a" }).success).toBe(false);
		writeFileSync(linksPath(env), JSON.stringify({ version: 2, links: [] }));
		expect(readLinks(env).success).toBe(false);
		writeFileSync(linksPath(env), JSON.stringify({ version: 1, links: [{ kind: "path", path: "/a" }] }));
		expect(readLinks(env).success).toBe(false);
		writeFileSync(
			linksPath(env),
			JSON.stringify({
				version: 1,
				links: [{ kind: "other", account: "a", organizationId: "o", orgSlug: "s", createdAt: 1 }],
			})
		);
		expect(readLinks(env).success).toBe(false);
	});
});

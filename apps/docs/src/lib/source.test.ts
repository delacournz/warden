import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { icons } from "lucide-react";
import { DEVICE_CONTROL } from "./landing.data";

/**
 * `lucideIconsPlugin` looks a page's `icon:` up in lucide's `icons` map, which holds canonical names only: a renamed
 * icon (lucide keeps the old name as an alias export) only warns at build time and the sidebar item renders bare.
 */

const CONTENT = join(import.meta.dirname, "..", "..", "content", "docs");

function mdxUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return mdxUnder(path);
		return path.endsWith(".mdx") ? [path] : [];
	});
}

describe("docs page icons", () => {
	test("every frontmatter icon is a canonical lucide icon", () => {
		const unknown = mdxUnder(CONTENT).flatMap((file) => {
			const icon = readFileSync(file, "utf-8").match(/^icon: (\S+)$/m)?.[1];
			return icon && !(icon in icons) ? [`${file.slice(CONTENT.length + 1)}: ${icon}`] : [];
		});
		expect(unknown).toEqual([]);
	});

	test("the release notes page icon is canonical", () => {
		const icon = readFileSync(join(import.meta.dirname, "release-notes.ts"), "utf-8").match(/"icon: (\w+)"/)?.[1];
		expect(icon && icon in icons).toBe(true);
	});
});

describe("docs demo clips", () => {
	const pages = mdxUnder(CONTENT).map((file) => ({
		file: file.slice(CONTENT.length + 1),
		text: readFileSync(file, "utf-8"),
	}));

	test("pages embed demos with <DemoClip> or <DemoReel> (autoplay, reduced motion), never a raw <video>", () => {
		expect(pages.filter((page) => page.text.includes("<video")).map((page) => page.file)).toEqual([]);
	});

	test("every <DemoClip> has its mp4 and poster in public/", () => {
		const srcs = pages.flatMap((page) =>
			[...page.text.matchAll(/<DemoClip[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1] as string)
		);
		expect(srcs.length).toBeGreaterThan(0);
		const pub = join(CONTENT, "..", "..", "public");
		const missing = srcs.flatMap((src) => [`${src}.mp4`, `${src}.jpg`]).filter((file) => !existsSync(join(pub, file)));
		expect(missing).toEqual([]);
	});

	test("every <DemoReel> has its webm, mp4 and poster in public/", () => {
		const srcs = pages.flatMap((page) =>
			[...page.text.matchAll(/<DemoReel[^>]*?\ssrc="([^"]+)"/g)].map((m) => m[1] as string)
		);
		expect(srcs.length).toBeGreaterThan(0);
		const pub = join(CONTENT, "..", "..", "public");
		const missing = srcs
			.flatMap((src) => [`${src}.webm`, `${src}.mp4`, `${src}.jpg`])
			.filter((file) => !existsSync(join(pub, file)));
		expect(missing).toEqual([]);
	});

	test("every <DemoTabs> id is a device-control clip (the landing's, same videos and captions)", () => {
		const known = new Set(DEVICE_CONTROL.clips.map((clip) => clip.id));
		const ids = pages.flatMap((page) =>
			[...page.text.matchAll(/<DemoTabs\s+ids=\{\[([^\]]*)\]\}/g)].flatMap((m) =>
				[...(m[1] as string).matchAll(/"([^"]+)"/g)].map((id) => id[1] as string)
			)
		);
		expect([...new Set(ids)].sort()).toEqual([...known].sort());
		expect(ids.filter((id) => !known.has(id))).toEqual([]);
	});

	test("a page's demo sits right under the page header, before any prose", () => {
		const late = pages.filter(({ text }) => {
			const body = text.replace(/^---[\s\S]*?---\s*/, "").replace(/^(import [^\n]*\n\s*)+/, "");
			return /<Demo(Clip|Tabs|Reel)/.test(body) && !/^<Demo(Clip|Tabs|Reel)/.test(body);
		});
		expect(late.map((page) => page.file)).toEqual([]);
	});
});

/** The content file a `/docs/<slugs>` path renders, or `undefined` when there is no page. */
function pageFor(slugs: string): string | undefined {
	const base = join(CONTENT, slugs);
	const candidates = [`${base}.mdx`, `${base}.md`, join(base, "index.mdx"), join(base, "index.md")];
	return candidates.find((path) => existsSync(path));
}

function metaUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return metaUnder(path);
		return name === "meta.json" ? [path] : [];
	});
}

describe("docs tabs", () => {
	const tabs = metaUnder(CONTENT)
		.map((file) => ({ file: file.slice(CONTENT.length + 1), meta: JSON.parse(readFileSync(file, "utf-8")) }))
		.filter(({ meta }) => meta.root === true);

	test("the five top tabs exist, in order, each with a landing page", () => {
		const root = JSON.parse(readFileSync(join(CONTENT, "meta.json"), "utf-8"));
		expect(root.pages).toEqual(["getting-started", "sims", "e2e", "reference", "releases"]);
		expect(tabs.map(({ file }) => file.split("/")[0]).sort()).toEqual([...root.pages].sort());
	});

	test("every tab icon is a canonical lucide icon", () => {
		const unknown = tabs.flatMap(({ file, meta }) => (meta.icon in icons ? [] : [`${file}: ${meta.icon}`]));
		expect(unknown).toEqual([]);
	});
});

describe("docs links", () => {
	test("every /docs link in a page resolves to a page", () => {
		const dead = mdxUnder(CONTENT).flatMap((file) => {
			const text = readFileSync(file, "utf-8");
			return [...text.matchAll(/(?<![a-z0-9.])\/docs\/([a-z0-9][a-z0-9/-]*?)(?:\.md)?(?=[)#"'\s`])/g)]
				.map((m) => m[1])
				.filter((slugs): slugs is string => slugs !== undefined && pageFor(slugs) === undefined)
				.map((slugs) => `${file.slice(CONTENT.length + 1)}: /docs/${slugs}`);
		});
		expect(dead).toEqual([]);
	});

	test("every landing link into the docs resolves to a page", () => {
		const text = readFileSync(join(import.meta.dirname, "landing.data.ts"), "utf-8");
		const dead = [...text.matchAll(/(?:href|to): "([a-z][a-z0-9/-]*)"/g)]
			.map((m) => m[1])
			.filter((slugs): slugs is string => slugs !== undefined && pageFor(slugs) === undefined);
		expect(dead).toEqual([]);
	});
});

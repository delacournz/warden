/**
 * Build-time OpenGraph image generation. Renders the landing page's 1200×630 PNG plus one card per
 * docs page (`public/og/docs/<slugs>.png`, the path `ogImagePath` hands to the page's `og:image`),
 * via satori (JSX → SVG) + @resvg/resvg-wasm (SVG → PNG). Run by `bun run seo:assets`, which
 * `build` runs first (see package.json). The images are gitignored.
 *
 * A docs card is the page's own: its sidebar section (`meta.json`), title and description, and its
 * first code block or outline (`cardProof` in `src/og/pages.ts`) — so a link to `warden ui`
 * previews as `warden ui` commands, not as one more title on the same card.
 *
 *     bun run og:cards                    # every card, plus a contact sheet to look at them all
 *     bun run og:cards -- --only agents   # only pages whose path contains "agents"
 *
 * The sheet goes to `<repo>/node_modules/.temp/og/index.html`, never under `public/`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import type { ReactElement } from "react";
import satori from "satori";
import { defaultOgImage, docsRoute, ogImagePath, siteUrl } from "../src/lib/shared";
import { cardProof, type Meta, parseFrontmatter, sectionOf, slugsForFile } from "../src/og/pages";
import { renderDefaultCard, renderDocsCard } from "../src/og/template";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "../public");
const CONTENT = join(HERE, "../content/docs");
const HOST = new URL(siteUrl).host;
/** The landing headline already says the first half of `appDescription`; the card carries the rest. */
const PITCH =
	"Simulators, emulators, ports and app builds, leased across every worktree on your Mac, so parallel agents never collide.";

const SHEET = join(HERE, "../../../node_modules/.temp/og/index.html");

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const sheet = args.includes("--sheet") || only !== undefined;

/** Every `meta.json` under the docs, keyed by its folder (`""` for the root). */
function readMetas(files: string[]): Record<string, Meta> {
	const metas: Record<string, Meta> = {};
	for (const file of files.filter((name) => name.endsWith("meta.json"))) {
		metas[dirname(file) === "." ? "" : dirname(file)] = JSON.parse(readFileSync(join(CONTENT, file), "utf8"));
	}
	return metas;
}

/** One page that lays every card out at half size, for looking at them together. */
function writeSheet(paths: string[]) {
	const figures = paths
		.map(
			(path) =>
				`<figure><img src="file://${join(PUBLIC, path)}" width="600" height="315"><figcaption>${path}</figcaption></figure>`
		)
		.join("\n");
	mkdirSync(dirname(SHEET), { recursive: true });
	writeFileSync(
		SHEET,
		`<!doctype html><meta charset="utf-8"><title>warden cards</title><style>body{margin:24px;background:#0f0f0e;color:#9c998f;font:13px ui-monospace,monospace}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(600px,1fr));gap:24px}figure{margin:0}img{display:block;width:100%;height:auto}figcaption{padding-top:8px}</style><main>${figures}</main>`
	);
	console.log(`og: sheet ${SHEET}`);
}

async function main() {
	// resvg runs as WASM (portable under bun; no native addon).
	await initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));

	// Static cuts of the site's two faces: the site ships them as variable fonts, which crash
	// satori's opentype parser, and satori reads WOFF but not WOFF2.
	const font = (name: string, pkg: string, weight: 400 | 500 | 600 | 800) => ({
		name,
		data: readFileSync(require.resolve(`@fontsource/${pkg}/files/${pkg}-latin-${weight}-normal.woff`)),
		weight,
		style: "normal" as const,
	});
	const fonts = [
		font("Mona Sans", "mona-sans", 400),
		font("Mona Sans", "mona-sans", 500),
		font("Mona Sans", "mona-sans", 600),
		font("Mona Sans", "mona-sans", 800),
		font("Martian Mono", "martian-mono", 400),
	];

	async function write(path: string, element: ReactElement) {
		const svg = await satori(element, { width: 1200, height: 630, fonts });
		const file = join(PUBLIC, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng());
		console.log(`og: ${path}`);
	}

	const written: string[] = [];
	if (!only) {
		await write(defaultOgImage, renderDefaultCard({ host: HOST, pitch: PITCH }));
		written.push(defaultOgImage);
	}

	const all = readdirSync(CONTENT, { recursive: true, encoding: "utf8" }).sort();
	const metas = readMetas(all);
	for (const file of all.filter((name) => /\.mdx?$/.test(name))) {
		const slugs = slugsForFile(file);
		const path = ogImagePath(slugs);
		if (only && !path.includes(only)) continue;

		const source = readFileSync(join(CONTENT, file), "utf8");
		const { title, description } = parseFrontmatter(source);
		if (!title) throw new Error(`og: ${file} has no frontmatter title`);
		await write(
			path,
			renderDocsCard({
				title,
				description,
				section: sectionOf(slugs, metas),
				proof: cardProof(source),
				url: [HOST + docsRoute, ...slugs].join("/"),
			})
		);
		written.push(path);
	}

	if (sheet) writeSheet(written.filter((path) => existsSync(join(PUBLIC, path))));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

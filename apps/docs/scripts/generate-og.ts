/**
 * Build-time OpenGraph image generation. Renders the landing page's 1200×630 PNG plus one card per
 * docs page (`public/og/docs/<slugs>.png`, the path `ogImagePath` hands to the page's `og:image`),
 * via satori (JSX → SVG) + @resvg/resvg-wasm (SVG → PNG). Run by `bun run seo:assets`, which
 * `build` runs first (see package.json). The images are gitignored.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import type { ReactElement } from "react";
import satori from "satori";
import { defaultOgImage, docsRoute, ogImagePath, siteUrl } from "../src/lib/shared";
import { parseFrontmatter, slugsForFile } from "../src/og/pages";
import { renderDefaultCard, renderDocsCard } from "../src/og/template";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "../public");
const CONTENT = join(HERE, "../content/docs");
const HOST = new URL(siteUrl).host;
/** The landing headline already says the first half of `appDescription`; the card carries the rest. */
const PITCH =
	"warden leases every simulator, emulator and port to one owner at a time and fans your e2e specs across them.";

const require = createRequire(import.meta.url);

async function main() {
	// resvg runs as WASM (portable under bun; no native addon).
	await initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));

	// Static cuts of the site's two faces: the site ships them as variable fonts, which crash
	// satori's opentype parser, and satori reads WOFF but not WOFF2.
	const font = (name: string, pkg: string, weight: 400 | 500 | 600) => ({
		name,
		data: readFileSync(require.resolve(`@fontsource/${pkg}/files/${pkg}-latin-${weight}-normal.woff`)),
		weight,
		style: "normal" as const,
	});
	const fonts = [
		font("Onest", "onest", 400),
		font("Onest", "onest", 500),
		font("Onest", "onest", 600),
		font("Red Hat Mono", "red-hat-mono", 400),
	];

	async function write(path: string, element: ReactElement) {
		const svg = await satori(element, { width: 1200, height: 630, fonts });
		const file = join(PUBLIC, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng());
		console.log(`og: ${path}`);
	}

	await write(defaultOgImage, renderDefaultCard({ host: HOST, pitch: PITCH }));

	const files = readdirSync(CONTENT, { recursive: true, encoding: "utf8" })
		.filter((file) => /\.mdx?$/.test(file))
		.sort();
	for (const file of files) {
		const { title, description } = parseFrontmatter(readFileSync(join(CONTENT, file), "utf8"));
		if (!title) throw new Error(`og: ${file} has no frontmatter title`);
		const slugs = slugsForFile(file);
		await write(
			ogImagePath(slugs),
			renderDocsCard({ title, description, url: [HOST + docsRoute, ...slugs].join("/") })
		);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

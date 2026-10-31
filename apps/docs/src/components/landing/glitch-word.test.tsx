import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { GlitchWord } from "./glitch-word";

const css = readFileSync(new URL("../../styles/app.css", import.meta.url), "utf8");

/** The text a screen reader reaches: everything outside `aria-hidden` subtrees. */
function readable(html: string): string {
	return html
		.replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, "")
		.replace(/<[^>]+>/g, "")
		.trim();
}

describe("GlitchWord", () => {
	const html = renderToStaticMarkup(<GlitchWord>simulator.</GlitchWord>);

	test("the word is read once", () => {
		expect(readable(html)).toBe("simulator.");
	});

	test("two hidden channel layers carry the same word", () => {
		const layers = html.match(/<span[^>]*aria-hidden="true"[^>]*>simulator\.<\/span>/g) ?? [];
		expect(layers).toHaveLength(2);
	});

	test("reduced motion stops the burst and hides the layers", () => {
		const block = css.slice(css.indexOf("/* glitch */"));
		expect(block).toContain("@media (prefers-reduced-motion: reduce)");
		expect(block).toMatch(/\.glitch-layer\s*\{[^}]*display:\s*none/);
		expect(block).toMatch(/animation:\s*none/);
	});

	test("an offset word runs on its own period, so two words drift instead of taking turns", () => {
		const block = css.slice(css.indexOf("/* glitch */"));
		const base = Number(block.match(/\.glitch\s*\{[^}]*--glitch-period:\s*([\d.]+)s/)?.[1]);
		const offset = Number(block.match(/\.glitch-offset\s*\{[^}]*--glitch-period:\s*([\d.]+)s/)?.[1]);
		expect(base).toBeGreaterThan(0);
		expect(offset).toBeGreaterThan(base);
		expect(Number.isInteger((offset * 10) / (base * 10))).toBe(false);
		const html = renderToStaticMarkup(<GlitchWord offset>agent</GlitchWord>);
		expect(html).toContain("glitch-offset");
		expect(readable(html)).toBe("agent");
	});

	test("keyframes animate transform and clip-path only", () => {
		const block = css.slice(css.indexOf("/* glitch */"));
		const frames = [...block.matchAll(/@keyframes glitch[\w-]*\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1] ?? "");
		expect(frames.length).toBeGreaterThan(0);
		const props = new Set(frames.flatMap((f) => [...f.matchAll(/([a-z-]+):/g)].map((m) => m[1])));
		expect([...props].sort()).toEqual(["clip-path", "transform"]);
	});
});

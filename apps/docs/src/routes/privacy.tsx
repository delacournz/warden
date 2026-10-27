import { createFileRoute } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactElement } from "react";
import { RichText } from "@/components/rich-text";
import { baseOptions } from "@/lib/layout.shared";
import { type Disclosure, PRIVACY, PRIVACY_SECTIONS, type PrivacySection } from "@/lib/privacy";
import { canonicalLink } from "@/lib/seo";
import { appName, privacyRoute } from "@/lib/shared";

/**
 * `/privacy`: the policy the cookie banner and the footer link to.
 *
 * Every word is read from `src/lib/privacy.ts`, where `privacy.test.ts` holds
 * the claims to the code they describe; nothing is written in this file. It is
 * a document, so it is drawn quieter than the landing page: one display
 * heading, then section headings a step down, prose on the reading measure,
 * and the disclosure tables on flat sheets. Nothing on the page carries colour
 * beyond the accent on a hovered link.
 *
 * The date is formatted in UTC so the server and the browser print the same
 * day, whatever time zone either is in.
 */
export const Route = createFileRoute("/privacy")({
	component: Privacy,
	head: () => ({
		meta: [
			{ title: `${PRIVACY.title} — ${appName}` },
			{ name: "description", content: PRIVACY.description },
			{ property: "og:title", content: `${PRIVACY.title} — ${appName}` },
			{ property: "og:description", content: PRIVACY.description },
			{ property: "og:url", content: canonicalLink(privacyRoute).href },
		],
		links: [canonicalLink(privacyRoute)],
	}),
});

const UPDATED = new Date(`${PRIVACY.updated}T00:00:00Z`).toLocaleDateString("en-NZ", {
	day: "numeric",
	month: "long",
	year: "numeric",
	timeZone: "UTC",
});

const COLUMN = "mx-auto w-full max-w-3xl px-4 sm:px-6";
const DISPLAY = "tracking-[-0.035em] [font-variation-settings:'wdth'_125,'wght'_800]";
const HEADING =
	"scroll-mt-24 text-[1.4rem] text-ink leading-tight tracking-[-0.02em] [font-variation-settings:'wdth'_120,'wght'_720]";

function Privacy(): ReactElement {
	return (
		<HomeLayout {...baseOptions()} className="bg-ground">
			<main className={`${COLUMN} flex flex-1 flex-col gap-14 pt-16 pb-24 sm:pt-24`}>
				<header className="flex flex-col gap-4">
					<p className="font-mono text-[11px] text-ink-2">
						Last updated <time dateTime={PRIVACY.updated}>{UPDATED}</time>
					</p>
					<h1 className={`text-[clamp(2.2rem,5vw,3.6rem)] text-ink leading-[0.98] ${DISPLAY}`}>{PRIVACY.title}</h1>
					<p className="text-ink-2 text-lg leading-relaxed">{PRIVACY.lede}</p>
				</header>
				<Glance />
				{PRIVACY_SECTIONS.map((section) => (
					<Section key={section.id} section={section} />
				))}
			</main>
		</HomeLayout>
	);
}

/** The five sentences a reader who stops here should leave with. */
function Glance(): ReactElement {
	return (
		<section aria-labelledby="at-a-glance" className="flex flex-col gap-4">
			<h2 className={HEADING} id="at-a-glance">
				At a glance
			</h2>
			<ul className="flex flex-col border-hairline border-t">
				{PRIVACY.glance.map((line) => (
					<li className="border-hairline border-b py-3 text-ink-2 leading-relaxed" key={line}>
						<RichText text={line} />
					</li>
				))}
			</ul>
		</section>
	);
}

function Section({ section }: { section: PrivacySection }): ReactElement {
	return (
		<section aria-labelledby={section.id} className="flex flex-col gap-4">
			<h2 className={HEADING} id={section.id}>
				{section.title}
			</h2>
			<Prose paragraphs={section.body} />
			{section.disclosures ? <DisclosureTable rows={section.disclosures} /> : null}
			{section.after ? <Prose paragraphs={section.after} /> : null}
		</section>
	);
}

function Prose({ paragraphs }: { paragraphs: readonly string[] }): ReactElement {
	return (
		<div className="flex flex-col gap-4">
			{paragraphs.map((paragraph) => (
				<p className="text-ink-2 leading-relaxed" key={paragraph}>
					<RichText text={paragraph} />
				</p>
			))}
		</div>
	);
}

const COLUMNS = "md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.4fr)]";

const HEADINGS = ["What", "Goes to", "Why"] as const;

/**
 * What, to whom, why: three columns from `md`, and a stack of labelled cells
 * below it, where three columns of sentences would be a word wide each.
 *
 * Each row is a description list rather than a `<table>` row: a table whose
 * rows turn into grids at phone width loses its table semantics in Safari, and
 * a `<dl>` says "What: …, Goes to: …, Why: …" at every width. The header strip
 * above the rows is therefore decoration, and hidden from assistive tech; each
 * cell's own `<dt>` carries its label, drawn only where the strip is not.
 */
function DisclosureTable({ rows }: { rows: readonly Disclosure[] }): ReactElement {
	return (
		<div className="overflow-hidden rounded-[var(--radius-group)] border border-hairline bg-surface">
			<div aria-hidden className={`hidden border-hairline border-b md:grid ${COLUMNS}`}>
				{HEADINGS.map((heading) => (
					<p className="px-4 py-3 font-mono text-[11px] text-ink-2" key={heading}>
						{heading}
					</p>
				))}
			</div>

			{rows.map((row) => (
				<dl className={`grid border-hairline border-b last:border-b-0 ${COLUMNS}`} key={row.what}>
					<Cell heading="What" text={row.what} />
					<Cell heading="Goes to" text={row.to} />
					<Cell heading="Why" text={row.why} />
				</dl>
			))}
		</div>
	);
}

function Cell({ heading, text }: { heading: (typeof HEADINGS)[number]; text: string }): ReactElement {
	return (
		<div className="flex min-w-0 flex-col gap-1 px-4 py-4 text-sm">
			<dt className="font-mono text-[11px] text-ink-2 md:sr-only">{heading}</dt>
			<dd className="text-ink-2 leading-relaxed">
				<RichText text={text} />
			</dd>
		</div>
	);
}

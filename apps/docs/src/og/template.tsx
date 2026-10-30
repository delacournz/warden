import type { ReactElement, ReactNode } from "react";
import { type CardProof, clamp } from "./pages";

/**
 * Satori templates for the 1200×630 OpenGraph cards. Satori renders a flexbox subset with INLINE
 * styles only — every element with more than one child must set `display: "flex"`. Consumed by
 * `scripts/generate-og.ts` (build time), not by the app.
 *
 * The cards are the site's grammar (DESIGN.md) in its dark tokens: one sheet on the
 * ground, a hairline above the footer, Mona Sans for sentences, Martian Mono for what a machine
 * prints (the URL), and the accent on the mark's lamp and the headline's last words.
 */

const GROUND = "#0f0f0e";
const SURFACE = "#171715";
const INK = "#f3f1ea";
const INK_2 = "#9c998f";
const HAIRLINE = "#302f2a";
const LAMP = "#ff6a3d";

const SANS = "Mona Sans";
const MONO = "Martian Mono";

const root = {
	width: "1200px",
	height: "630px",
	display: "flex",
	padding: "28px",
	backgroundColor: GROUND,
	color: INK,
	fontFamily: SANS,
};

const group = {
	flex: 1,
	display: "flex",
	flexDirection: "column" as const,
	justifyContent: "space-between",
	padding: "52px 60px 44px",
	borderRadius: 12,
	backgroundColor: SURFACE,
};

/** The warden mark (`components/warden-icon.tsx`): a device outline with its lease lamp lit. */
function Mark({ size }: { size: number }): ReactElement {
	return (
		<svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size}>
			<rect height="20" rx="4.5" stroke={INK} strokeWidth="2" width="13" x="3" y="2" />
			<circle cx="18" cy="6" fill={LAMP} r="4" />
		</svg>
	);
}

/** The shared frame: mark and name on top, the card's own copy, then its URL under a hairline. */
function Card({ url, children }: { url: string; children: ReactNode }): ReactElement {
	return (
		<div style={root}>
			<div style={group}>
				<div style={{ display: "flex", alignItems: "center", gap: 16 }}>
					<Mark size={44} />
					<div style={{ fontWeight: 600, fontSize: 34, letterSpacing: "-0.02em" }}>warden</div>
				</div>
				<div style={{ display: "flex", flexDirection: "column", gap: 24 }}>{children}</div>
				<div
					style={{
						display: "flex",
						paddingTop: 26,
						borderTop: `1px solid ${HAIRLINE}`,
						fontFamily: MONO,
						fontSize: 24,
						color: INK_2,
					}}
				>
					{url}
				</div>
			</div>
		</div>
	);
}

function lede(text: string): ReactElement {
	return <div style={{ fontSize: 31, lineHeight: 1.4, color: INK_2, maxWidth: "940px" }}>{clamp(text, 150)}</div>;
}

/** Landing card: the hero headline in the display voice, "own simulator." in the accent, over the one-sentence pitch. */
export function renderDefaultCard({ host, pitch }: { host: string; pitch: string }): ReactElement {
	return (
		<Card url={host}>
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					fontWeight: 800,
					fontSize: 96,
					lineHeight: 0.98,
					letterSpacing: "-0.04em",
				}}
			>
				<span>Every agent gets its</span>
				<span style={{ color: LAMP }}>own simulator.</span>
			</div>
			{lede(pitch)}
		</Card>
	);
}

/** The proof column's code size: Martian Mono at this size fits ~40 characters across the pane. */
const CODE_SIZE = 17;

const codeLine = {
	display: "flex",
	whiteSpace: "pre" as const,
	overflow: "hidden",
	textOverflow: "ellipsis",
	lineHeight: 1.75,
};

/**
 * One line of the proof: a gutter mark (a prompt, `#`, or nothing) then the text, cut with an
 * ellipsis. A marked line's leading spaces indent the mark with it, so a subheading's `#` steps in.
 */
function ProofLine({ mark, text }: { mark?: string; text: string }): ReactElement {
	const indent = mark ? (/^ */.exec(text)?.[0] ?? "") : "";
	return (
		<div style={codeLine}>
			{mark ? <span style={{ color: LAMP, marginRight: 14 }}>{`${indent}${mark}`}</span> : null}
			<span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{text.slice(indent.length) || " "}</span>
		</div>
	);
}

/**
 * The page's own evidence, set as the site sets code: a ground-coloured pane under a hairline tab
 * naming what it is (`shell`, the block's language, or `on this page`), cropped by the card's
 * hairline rather than scrolled.
 */
function Proof({ proof }: { proof: CardProof }): ReactElement {
	const label = proof.kind === "shell" ? "shell" : proof.kind === "code" ? proof.lang || "code" : "on this page";
	const lines =
		proof.kind === "shell"
			? proof.lines.map((text) => ({ mark: "$", text }))
			: proof.kind === "code"
				? proof.lines.map((text) => ({ mark: undefined, text }))
				: proof.headings.map((text) => ({ mark: "#", text }));

	return (
		<div
			style={{
				width: 480,
				display: "flex",
				flexDirection: "column",
				borderRadius: 10,
				border: `1px solid ${HAIRLINE}`,
				backgroundColor: GROUND,
				overflow: "hidden",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 10,
					padding: "14px 22px",
					borderBottom: `1px solid ${HAIRLINE}`,
					fontFamily: MONO,
					fontSize: 15,
					color: INK_2,
				}}
			>
				<div style={{ width: 9, height: 9, borderRadius: 9, backgroundColor: LAMP }} />
				<span>{label}</span>
			</div>
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					padding: "18px 22px",
					fontFamily: MONO,
					fontSize: CODE_SIZE,
					color: INK,
				}}
			>
				{lines.map((line, i) => (
					<ProofLine key={`${i}-${line.text}`} mark={line.mark} text={line.text} />
				))}
			</div>
		</div>
	);
}

/**
 * One docs page, in two columns like Delacour UI's cards: the words on the left (the sidebar
 * section it sits in, its title and description), the page's own first code block (or outline)
 * on the right, and the page's URL under the hairline so a shared link names itself.
 */
export function renderDocsCard({
	title,
	description,
	section,
	proof,
	url,
}: {
	title: string;
	description?: string;
	section?: string;
	proof: CardProof;
	url: string;
}): ReactElement {
	const size = title.length > 20 ? 52 : title.length > 12 ? 60 : 72;
	return (
		<Card url={url}>
			<div style={{ display: "flex", gap: 44, alignItems: "center" }}>
				<div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20 }}>
					{section ? (
						<div style={{ fontFamily: MONO, fontSize: 17, color: LAMP, letterSpacing: "0.02em" }}>{section}</div>
					) : null}
					<div style={{ fontWeight: 600, fontSize: size, lineHeight: 1.04, letterSpacing: "-0.035em" }}>{title}</div>
					{description ? (
						<div style={{ fontSize: 24, lineHeight: 1.4, color: INK_2 }}>{clamp(description, 130)}</div>
					) : null}
				</div>
				<Proof proof={proof} />
			</div>
		</Card>
	);
}

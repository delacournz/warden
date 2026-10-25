import type { ReactElement, ReactNode } from "react";
import { clamp } from "./pages";

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

/** Landing card: the hero headline in the display voice, "coding agents." in the accent, over the one-sentence pitch. */
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
				<span>Mobile testing for</span>
				<span style={{ color: LAMP }}>coding agents.</span>
			</div>
			{lede(pitch)}
		</Card>
	);
}

/** One docs page: its title and description, with the page's own URL so a shared link names itself. */
export function renderDocsCard({
	title,
	description,
	url,
}: {
	title: string;
	description?: string;
	url: string;
}): ReactElement {
	const size = title.length > 22 ? 64 : title.length > 14 ? 78 : 92;
	return (
		<Card url={url}>
			<div style={{ fontWeight: 600, fontSize: size, lineHeight: 1.04, letterSpacing: "-0.035em", maxWidth: "1000px" }}>
				{title}
			</div>
			{description ? lede(description) : null}
		</Card>
	);
}

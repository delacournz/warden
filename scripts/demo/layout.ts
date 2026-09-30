/**
 * Canvas geometry and the two static RGBA layers the compositor sandwiches the
 * moving video between: an underlay (ground, phone bezels, terminal card) and a
 * top layer that re-draws the bezel over each phone's square corners so the
 * screens read as rounded. Colours are the docs site's dark-mode tokens
 * (apps/docs/src/styles/app.css).
 */

export const palette = {
	ground: "000000",
	surface: "1c1c1e",
	fill: "2c2c2e",
	ink: "f5f5f7",
	ink2: "98989f",
	lease: "30d158",
	fail: "ff453a",
} as const;

export type Rect = { x: number; y: number; w: number; h: number };

export type PhoneSlot = {
	/** The screen itself: where the scaled recording is overlaid. */
	screen: Rect;
	/** Screen grown by the bezel, rounded with `radius + bezel`. */
	bezel: Rect;
	radius: number;
	labelX: number;
	nameY: number;
	jobY: number;
};

export type Layout = {
	width: number;
	height: number;
	margin: number;
	headerY: number;
	headerSize: number;
	nameSize: number;
	jobSize: number;
	phones: PhoneSlot[];
	card: Rect;
	cardRadius: number;
	terminal: Rect;
};

export type LayoutOptions = {
	width: number;
	phones: number;
	/** Recording width / height. */
	phoneAspect: number;
	/** Terminal gif width / height. */
	terminalAspect: number;
};

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Phones in one row, labels under each, terminal pane full-width underneath. */
export function computeLayout(opts: LayoutOptions): Layout {
	const width = even(opts.width);
	const u = width / 1920;
	const margin = Math.round(48 * u);
	const gap = Math.round(32 * u);
	const headerSize = Math.round(30 * u);
	const nameSize = Math.round(20 * u);
	const jobSize = Math.round(24 * u);
	const headerY = margin;
	const phonesTop = headerY + headerSize + Math.round(32 * u);

	const slotW = Math.floor((width - 2 * margin - (opts.phones - 1) * gap) / opts.phones);
	const bezelW = Math.max(4, Math.round(slotW * 0.035));
	const screenW = Math.floor((slotW - 2 * bezelW) / 2) * 2;
	const screenH = even(screenW / opts.phoneAspect);
	const radius = Math.round(screenW * 0.12);
	const rowW = opts.phones * slotW + (opts.phones - 1) * gap;
	const rowX = Math.round((width - rowW) / 2);

	const labelTop = phonesTop + screenH + 2 * bezelW + Math.round(20 * u);
	const phones: PhoneSlot[] = Array.from({ length: opts.phones }, (_, i) => {
		const bx = rowX + i * (slotW + gap);
		const screen = { x: bx + bezelW, y: phonesTop + bezelW, w: screenW, h: screenH };
		return {
			screen,
			bezel: { x: bx, y: phonesTop, w: screenW + 2 * bezelW, h: screenH + 2 * bezelW },
			radius,
			labelX: bx + Math.round((screenW + 2 * bezelW) / 2),
			nameY: labelTop,
			jobY: labelTop + nameSize + Math.round(10 * u),
		};
	});

	const cardTop = labelTop + nameSize + jobSize + Math.round(44 * u);
	const pad = Math.round(24 * u);
	const cardW = width - 2 * margin;
	const maxTermH = Math.round(360 * u);
	let termW = even(cardW - 2 * pad);
	let termH = even(termW / opts.terminalAspect);
	if (termH > maxTermH) {
		termH = even(maxTermH);
		termW = even(termH * opts.terminalAspect);
	}
	const cardH = termH + 2 * pad;
	const card = { x: margin, y: cardTop, w: cardW, h: cardH };
	const terminal = { x: margin + Math.round((cardW - termW) / 2), y: cardTop + pad, w: termW, h: termH };

	return {
		width,
		height: even(cardTop + cardH + margin),
		margin,
		headerY,
		headerSize,
		nameSize,
		jobSize,
		phones,
		card,
		cardRadius: Math.round(14 * u),
		terminal,
	};
}

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
	return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

/** Signed distance from (px,py) to a rounded rect; negative inside. */
export function roundedRectDistance(px: number, py: number, r: Rect, radius: number): number {
	const hw = r.w / 2;
	const hh = r.h / 2;
	const qx = Math.abs(px - (r.x + hw)) - (hw - radius);
	const qy = Math.abs(py - (r.y + hh)) - (hh - radius);
	const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
	return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Anti-aliased coverage in [0,1] of the pixel centred at (px+.5, py+.5). */
export function coverage(px: number, py: number, r: Rect, radius: number): number {
	return Math.min(1, Math.max(0, 0.5 - roundedRectDistance(px + 0.5, py + 0.5, r, radius)));
}

type Shape = { rect: Rect; radius: number; color: string; hole?: { rect: Rect; radius: number } };

/** Paint shapes (source-over) onto an RGBA buffer, optionally over an opaque ground. */
function paint(width: number, height: number, shapes: Shape[], ground?: string): Uint8Array {
	const buf = new Uint8Array(width * height * 4);
	if (ground) {
		const [r, g, b] = rgb(ground);
		for (let i = 0; i < buf.length; i += 4) buf.set([r, g, b, 255], i);
	}
	for (const s of shapes) {
		const [r, g, b] = rgb(s.color);
		const x0 = Math.max(0, Math.floor(s.rect.x));
		const y0 = Math.max(0, Math.floor(s.rect.y));
		const x1 = Math.min(width, Math.ceil(s.rect.x + s.rect.w));
		const y1 = Math.min(height, Math.ceil(s.rect.y + s.rect.h));
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				let a = coverage(x, y, s.rect, s.radius);
				if (s.hole) a *= 1 - coverage(x, y, s.hole.rect, s.hole.radius);
				if (a <= 0) continue;
				const i = (y * width + x) * 4;
				const da = (buf[i + 3] ?? 0) / 255;
				const oa = a + da * (1 - a);
				const mix = (src: number, dst: number) => Math.round((src * a + dst * da * (1 - a)) / oa);
				buf[i] = mix(r, buf[i] ?? 0);
				buf[i + 1] = mix(g, buf[i + 1] ?? 0);
				buf[i + 2] = mix(b, buf[i + 2] ?? 0);
				buf[i + 3] = Math.round(oa * 255);
			}
		}
	}
	return buf;
}

/** Opaque ground with bezel slabs and the terminal card. */
export function renderUnderlay(layout: Layout): Uint8Array {
	const shapes: Shape[] = [
		...layout.phones.map((p) => ({
			rect: p.bezel,
			radius: p.radius + (p.bezel.w - p.screen.w) / 2,
			color: palette.fill,
		})),
		{ rect: layout.card, radius: layout.cardRadius, color: palette.surface },
	];
	return paint(layout.width, layout.height, shapes, palette.ground);
}

/** Transparent except for each bezel ring, which masks the screen's square corners. */
export function renderTopLayer(layout: Layout): Uint8Array {
	const shapes: Shape[] = layout.phones.map((p) => ({
		rect: p.bezel,
		radius: p.radius + (p.bezel.w - p.screen.w) / 2,
		color: palette.fill,
		hole: { rect: p.screen, radius: p.radius },
	}));
	return paint(layout.width, layout.height, shapes);
}

import { type RefObject, useEffect, useState } from "react";
import { demoUnit, orbCentre, rotated } from "./demo-device.ts";
import type { VideoSize } from "./use-whep.ts";
import type { StreamError, StreamStatus } from "./whep-session.ts";

const TILE_COLOURS = ["#ef7470", "#f8d85b", "#84ca7f", "#5b93f8", "#b97ef8", "#f0a240"];

/** A glowing white orb at (x, y) whose size and glow breathe with `pulse` (0..1). */
function drawOrb(ctx: CanvasRenderingContext2D, x: number, y: number, unit: number, pulse: number) {
	const core = (2.5 + 1 * pulse) * unit;
	const glow = core * (2.5 + 1.5 * pulse);
	const halo = ctx.createRadialGradient(x, y, 0, x, y, glow);
	halo.addColorStop(0, `rgba(255, 255, 255, ${0.55 + 0.35 * pulse})`);
	halo.addColorStop(0.35, `rgba(255, 255, 255, ${0.15 + 0.2 * pulse})`);
	halo.addColorStop(1, "rgba(255, 255, 255, 0)");
	ctx.fillStyle = halo;
	ctx.beginPath();
	ctx.arc(x, y, glow, 0, Math.PI * 2);
	ctx.fill();
	ctx.fillStyle = "#ffffff";
	ctx.beginPath();
	ctx.arc(x, y, core, 0, Math.PI * 2);
	ctx.fill();
}

function draw(ctx: CanvasRenderingContext2D, size: VideoSize, t: number) {
	const { width: w, height: h } = size;
	const bg = ctx.createLinearGradient(0, 0, w, h);
	bg.addColorStop(0, "#3c3150");
	bg.addColorStop(0.5, "#b2a491");
	bg.addColorStop(1, "#252a3a");
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, w, h);

	const unit = demoUnit(size);
	const cols = w > h ? 8 : 4;
	const tile = 66 * unit;
	const gap = (w - cols * tile) / (cols + 1);
	TILE_COLOURS.concat(TILE_COLOURS, TILE_COLOURS).forEach((colour, i) => {
		const x = gap + (i % cols) * (tile + gap);
		const y = 120 * unit + Math.floor(i / cols) * (tile + gap);
		if (y + tile > h - 80 * unit) return;
		ctx.fillStyle = colour;
		ctx.beginPath();
		ctx.roundRect(x, y, tile, tile, 16 * unit);
		ctx.fill();
	});

	ctx.strokeStyle = "#ff2d55";
	ctx.lineWidth = 4 * unit;
	ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);

	const orb = orbCentre(size);
	drawOrb(ctx, orb.x, orb.y, unit, (Math.sin(t / 500) + 1) / 2);

	ctx.fillStyle = "#ffffff";
	ctx.font = `600 ${16 * unit}px ui-monospace, monospace`;
	ctx.textAlign = "center";
	ctx.fillText(`DEMO ${w}×${h} · press R to rotate`, w / 2, 60 * unit);
}

/**
 * Dev-only stand-in for a device stream: paints an animated test pattern at `device` pixels into
 * `canvasRef`, with a red edge so any letterboxing shows. R toggles portrait/landscape, so the
 * rotation refit can be tried too. Same shape as `useNativeStream`.
 */
export function useDemoStream(
	canvasRef: RefObject<HTMLCanvasElement | null>,
	enabled: boolean,
	device: VideoSize
): { status: StreamStatus; size: VideoSize | null; error: StreamError | null } {
	const [size, setSize] = useState<VideoSize>(device);

	useEffect(() => {
		if (!enabled) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() === "r" && !event.metaKey && !event.ctrlKey) setSize(rotated);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [enabled]);

	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx || !enabled) return;
		canvas.width = size.width;
		canvas.height = size.height;
		let frame = requestAnimationFrame(function tick(t) {
			draw(ctx, size, t);
			frame = requestAnimationFrame(tick);
		});
		return () => cancelAnimationFrame(frame);
	}, [canvasRef, enabled, size]);

	return { status: enabled ? "streaming" : "connecting", size: enabled ? size : null, error: null };
}

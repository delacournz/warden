import { randomBytes } from "node:crypto";
import type { Driver, DriverError } from "@delacour/warden-e2e/driver/driver.types";
import type { Result } from "@delacour/warden-types/result";
import {
	allowedRequest,
	parseViewInput,
	pngSize,
	type Size,
	toDevicePoint,
	type ViewInput,
	viewPageHtml,
} from "./view-page";

/** What the view needs from the host's driver. */
export type ViewDriver = Pick<Driver, "screenshot" | "snapshot" | "tap" | "swipe" | "typeText" | "key" | "pressButton">;

export type HostView = { url: string; port: number; stop: () => void };

export type ServeViewOptions = {
	driver: ViewDriver;
	title: string;
	/** read-only: input is refused */
	watch: boolean;
	/** frame scale passed to `screenshot` (default 0.5: a quarter of the pixels over the link) */
	scale?: number;
};

const ROTATED =
	"the device is rotated: drive it in portrait (watching works either way); warden ui works in any orientation";

type Frame = { ok: true; png: Uint8Array } | { ok: false; message: string };

const isLandscape = (s: Size) => s.width > s.height;

/** Serve the page on 127.0.0.1 (a free port, a random token path) until `stop`. */
export function serveHostView(o: ServeViewOptions): HostView {
	const token = randomBytes(24).toString("base64url");
	let inflight: Promise<Frame> | undefined;
	let frame: Size | undefined;
	let screen: Size | undefined;

	const takeFrame = async (): Promise<Frame> => {
		const shot = await o.driver.screenshot({ scale: o.scale ?? 0.5 });
		if (!shot.success) return { ok: false, message: shot.error.message };
		const png = shot.data.png;
		if (png === undefined) return { ok: false, message: "the driver gave no frame" };
		frame = pngSize(png) ?? frame;
		return { ok: true, png };
	};
	/** one screenshot at a time: a request that arrives while one is taken gets the same frame */
	const sharedFrame = async (): Promise<Response> => {
		inflight ??= takeFrame().finally(() => {
			inflight = undefined;
		});
		const f = await inflight;
		return f.ok
			? new Response(f.png, { headers: { "content-type": "image/png", "cache-control": "no-store" } })
			: new Response(f.message, { status: 502 });
	};
	const screenSize = async (): Promise<Size | undefined> => {
		if (screen === undefined) {
			const snap = await o.driver.snapshot({ interactiveOnly: true });
			if (snap.success) screen = { width: snap.data.screen.width, height: snap.data.screen.height };
		}
		return screen;
	};
	const apply = async (input: ViewInput): Promise<Result<void, DriverError> | Response> => {
		if (input.kind === "type") return o.driver.typeText(input.text);
		if (input.kind === "key") return o.driver.key(input.key);
		if (input.kind === "home") return o.driver.pressButton("home");
		const size = await screenSize();
		if (size === undefined) return new Response("could not read the screen size", { status: 502 });
		if (frame !== undefined && isLandscape(frame) !== isLandscape(size)) return new Response(ROTATED, { status: 409 });
		if (input.kind === "tap") return o.driver.tap(toDevicePoint(input, size));
		return o.driver.swipe(toDevicePoint(input.from, size), toDevicePoint(input.to, size), {
			durationMs: input.durationMs,
		});
	};
	const onInput = async (req: Request): Promise<Response> => {
		if (o.watch) return new Response("watch only (warden view --watch)", { status: 403 });
		const input = parseViewInput(await req.json().catch(() => undefined));
		if (input === undefined) return new Response("bad input", { status: 400 });
		const done = await apply(input);
		if (done instanceof Response) return done;
		return done.success ? new Response(null, { status: 204 }) : new Response(done.error.message, { status: 502 });
	};

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req) => {
			const route = allowedRequest(req, { token, port: server.port ?? 0 });
			if (route === "page") {
				return new Response(viewPageHtml({ title: o.title, watch: o.watch }), {
					headers: {
						"content-type": "text/html; charset=utf-8",
						"content-security-policy":
							"default-src 'none'; img-src blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
						"referrer-policy": "no-referrer",
					},
				});
			}
			if (route === "frame") return sharedFrame();
			if (route === "input") return onInput(req);
			return new Response("not found", { status: 404 });
		},
	});
	const port = server.port ?? 0;
	return { url: `http://127.0.0.1:${port}/${token}/`, port, stop: () => server.stop(true) };
}

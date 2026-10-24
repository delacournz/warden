import { z } from "zod";

const headerSchema = z.object({
	app_name: z.string().optional(),
	name: z.string().optional(),
	bundleID: z.string().optional(),
	timestamp: z.string().optional(),
	incident_id: z.string().optional(),
	app_version: z.string().optional(),
});

const frameSchema = z.object({
	imageOffset: z.number(),
	imageIndex: z.number().optional(),
	symbol: z.string().optional(),
	symbolLocation: z.number().optional(),
});

const bodySchema = z.object({
	pid: z.number().optional(),
	procName: z.string().optional(),
	procPath: z.string().optional(),
	exception: z
		.object({ type: z.string().optional(), signal: z.string().optional(), subtype: z.string().optional() })
		.optional(),
	termination: z.object({ indicator: z.string().optional(), namespace: z.string().optional() }).optional(),
	faultingThread: z.number().optional(),
	threads: z
		.array(
			z.object({
				triggered: z.boolean().optional(),
				name: z.string().optional(),
				frames: z.array(frameSchema).default([]),
			})
		)
		.default([]),
	usedImages: z
		.array(
			z.object({
				base: z.number(),
				uuid: z.string().optional(),
				path: z.string().optional(),
				name: z.string().optional(),
				arch: z.string().optional(),
			})
		)
		.default([]),
});

export type IpsFrame = {
	image: string;
	symbol?: string;
	imageOffset: number;
	symbolLocation?: number;
	/** the frame sits in the app's own bundle (its executable or an embedded framework) */
	app: boolean;
	imageUuid?: string;
	imageBase?: number;
	arch?: string;
};

export type IpsCrash = {
	incidentId?: string;
	appName: string;
	bundleId?: string;
	processName: string;
	pid?: number;
	/** epoch ms from the header's `timestamp` (it carries a zone offset) */
	atMs?: number;
	exceptionType?: string;
	signal?: string;
	subtype?: string;
	termination?: string;
	crashedThread?: string;
	/** top 10 frames of the crashed thread */
	frames: IpsFrame[];
	firstAppFrame?: IpsFrame;
};

/** `2026-10-24 10:02:11.00 +1300` → epoch ms. */
export function parseIpsTimestamp(raw: string): number | undefined {
	const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?) ([+-])(\d\d)(\d\d)$/.exec(raw.trim());
	if (!m) return undefined;
	const ms = Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`);
	return Number.isNaN(ms) ? undefined : ms;
}

const MAX_FRAMES = 10;

/** `ShopApp +4521772` / `objc_msgSend +32 (libobjc.A.dylib)` — one frame as a line. */
export function formatFrame(f: IpsFrame): string {
	return f.symbol === undefined ? `${f.image} +${f.imageOffset}` : `${f.symbol} +${f.symbolLocation ?? 0} (${f.image})`;
}

function leaf(path: string | undefined, fallback: string): string {
	return path?.split("/").pop() || fallback;
}

/** An `.ips` crash report: line 1 is a JSON header, the rest the JSON body. */
export function parseIps(text: string): { success: true; data: IpsCrash } | { success: false; error: string } {
	const newline = text.indexOf("\n");
	if (newline < 0) return { success: false, error: "not an .ips report (no body)" };
	let header: z.infer<typeof headerSchema>;
	let body: z.infer<typeof bodySchema>;
	try {
		header = headerSchema.parse(JSON.parse(text.slice(0, newline)));
		body = bodySchema.parse(JSON.parse(text.slice(newline + 1)));
	} catch (error) {
		return { success: false, error: `not an .ips report: ${error instanceof Error ? error.message : String(error)}` };
	}
	const thread = body.threads[body.faultingThread ?? -1] ?? body.threads.find((t) => t.triggered === true);
	const frames: IpsFrame[] = (thread?.frames ?? []).map((f) => {
		const image = f.imageIndex === undefined ? undefined : body.usedImages[f.imageIndex];
		const path = image?.path ?? "";
		return {
			image: image?.name ?? leaf(image?.path, "?"),
			...(f.symbol !== undefined ? { symbol: f.symbol } : {}),
			imageOffset: f.imageOffset,
			...(f.symbolLocation !== undefined ? { symbolLocation: f.symbolLocation } : {}),
			app: path.includes(".app/"),
			...(image?.uuid !== undefined ? { imageUuid: image.uuid } : {}),
			...(image !== undefined ? { imageBase: image.base } : {}),
			...(image?.arch !== undefined ? { arch: image.arch } : {}),
		};
	});
	const processName = body.procName ?? header.app_name ?? header.name ?? "?";
	const atMs = header.timestamp === undefined ? undefined : parseIpsTimestamp(header.timestamp);
	const firstApp = frames.find((f) => f.app);
	return {
		success: true,
		data: {
			...(header.incident_id !== undefined ? { incidentId: header.incident_id } : {}),
			appName: header.app_name ?? header.name ?? processName,
			...(header.bundleID !== undefined ? { bundleId: header.bundleID } : {}),
			processName,
			...(body.pid !== undefined ? { pid: body.pid } : {}),
			...(atMs !== undefined ? { atMs } : {}),
			...(body.exception?.type !== undefined ? { exceptionType: body.exception.type } : {}),
			...(body.exception?.signal !== undefined ? { signal: body.exception.signal } : {}),
			...(body.exception?.subtype ? { subtype: body.exception.subtype } : {}),
			...(body.termination?.indicator !== undefined ? { termination: body.termination.indicator } : {}),
			...(thread?.name !== undefined ? { crashedThread: thread.name } : {}),
			frames: frames.slice(0, MAX_FRAMES),
			...(firstApp !== undefined ? { firstAppFrame: firstApp } : {}),
		},
	};
}

export type IpsQuery = { bundleId: string; executable?: string; udid?: string; sinceMs?: number };

/** Does this report belong to the app (bundle id or executable), on this simulator, within the window? `text` is the raw file. */
export function ipsMatches(crash: IpsCrash, text: string, q: IpsQuery): boolean {
	const app = crash.bundleId === q.bundleId || (q.executable !== undefined && crash.processName === q.executable);
	if (!app) return false;
	if (q.udid !== undefined && !text.toLowerCase().includes(q.udid.toLowerCase())) return false;
	if (q.sinceMs !== undefined && crash.atMs !== undefined && crash.atMs < q.sinceMs) return false;
	return true;
}

/** Full-body frame list for symbolication: every app-image frame of the crashed thread (not just the top 10), with load addresses. */
export function appFrameAddresses(text: string): Array<{ uuid: string; arch: string; base: number; address: number }> {
	const newline = text.indexOf("\n");
	if (newline < 0) return [];
	try {
		const body = bodySchema.parse(JSON.parse(text.slice(newline + 1)));
		const thread = body.threads[body.faultingThread ?? -1] ?? body.threads.find((t) => t.triggered === true);
		return (thread?.frames ?? []).flatMap((f) => {
			const image = f.imageIndex === undefined ? undefined : body.usedImages[f.imageIndex];
			if (image === undefined || image.uuid === undefined || !(image.path ?? "").includes(".app/")) return [];
			return [{ uuid: image.uuid, arch: image.arch ?? "arm64", base: image.base, address: image.base + f.imageOffset }];
		});
	} catch {
		return [];
	}
}

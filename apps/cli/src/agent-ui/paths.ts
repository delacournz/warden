import { createHash } from "node:crypto";
import { join } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import type { CommandContext } from "../context";

/** `$WARDEN_HOME/ui`: one dir per device, holding what `warden ui` remembers between invocations. */
export function uiRoot(ctx: Pick<CommandContext, "env">): string {
	return join(wardenHome(ctx.env), "ui");
}

/**
 * A device id as one path segment. Simulator UUIDs, `XXXXXXXX-XXXXXXXXXXXXXXXX` UDIDs and `emulator-5554` are
 * unchanged (existing state dirs stay put); a phone's `192.168.1.20:5555` or `adb-…._adb-tls-connect._tcp`
 * gets `:` and other odd characters replaced and a hash of the original, so two ids never share a directory.
 */
export function fsSafeId(id: string): string {
	const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
	if (safe === id && id !== "." && id !== "..") return id;
	return `${safe}-${Bun.hash(id).toString(36).slice(0, 8)}`;
}

/** `$WARDEN_HOME/ui/<udid>`: everything `warden ui` remembers about one device between invocations. */
export function uiDir(ctx: Pick<CommandContext, "env">, udid: string): string {
	return join(uiRoot(ctx), fsSafeId(udid));
}

/** `$WARDEN_HOME/simd`: the resident `warden-simd` helpers' sockets and logs. */
export function simdDir(host: Pick<CommandContext, "env">): string {
	return join(wardenHome(host.env), "simd");
}

/** `$WARDEN_HOME/ui/<udid>/recording.json`: the journal of the recording in progress (`warden ui record`). */
export function recordingFile(ctx: Pick<CommandContext, "env">, udid: string): string {
	return join(uiDir(ctx, udid), "recording.json");
}

/** `$WARDEN_HOME/ui/helper-routes/<hash>.json`: the routes a recorded helper visited, one file per `module#fn` (kept out of the app repo). */
export function helperRoutesFile(ctx: Pick<CommandContext, "env">, module: string, fn: string): string {
	return join(
		uiRoot(ctx),
		"helper-routes",
		`${createHash("sha1").update(`${module}#${fn}`).digest("hex").slice(0, 16)}.json`
	);
}

/** `$WARDEN_HOME/android-host`: the resident `warden __android-host` processes' sockets and logs. */
export function androidHostDir(host: Pick<CommandContext, "env">): string {
	return join(wardenHome(host.env), "android-host");
}

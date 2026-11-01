import { join } from "node:path";

export class UiPaths {
	/** `<home>/ui`: one dir per device, holding what the ops remember between calls. */
	uiRoot(home: string): string {
		return join(home, "ui");
	}

	/**
	 * A device id as one path segment. Simulator UUIDs, `XXXXXXXX-XXXXXXXXXXXXXXXX` UDIDs and `emulator-5554` are
	 * unchanged (existing state dirs stay put); a phone's `192.168.1.20:5555` or `adb-…._adb-tls-connect._tcp`
	 * gets `:` and other odd characters replaced and a hash of the original, so two ids never share a directory.
	 */
	fsSafeId(id: string): string {
		const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
		if (safe === id && id !== "." && id !== "..") return id;
		return `${safe}-${Bun.hash(id).toString(36).slice(0, 8)}`;
	}

	/** `<home>/ui/<udid>`: everything the ops remember about one device between calls. */
	uiDir(home: string, udid: string): string {
		return join(this.uiRoot(home), this.fsSafeId(udid));
	}

	/** `<home>/ui/<udid>/recording.json`: the journal of the spec recording in progress. */
	recordingFile(home: string, udid: string): string {
		return join(this.uiDir(home, udid), "recording.json");
	}
}

export const uiPaths = new UiPaths();

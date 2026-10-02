import type { DeviceRecord } from "./store";
import type { InventoryDevice } from "./types";

const WARDEN_NAME = /^warden-(.+)-\d+$/;

/** `warden-<profile>-N`: a pool device warden created (goldens are `warden-golden-…`, checked first by callers). */
export function wardenNameProfile(name: string): string | undefined {
	return WARDEN_NAME.exec(name)?.[1];
}

/** Mark devices warden created (store record, or a `warden-` name) and attach their profile. */
export function markWardenDevices<T extends InventoryDevice>(inventory: T[], records: DeviceRecord[]): T[] {
	const byId = new Map(records.map((r) => [`${r.platform}:${r.id}`, r]));
	return inventory.map((device) => {
		if (device.golden) return device;
		const record = byId.get(`${device.platform}:${device.id}`);
		if (record) {
			const marked: T = { ...device, wardenCreated: true };
			if (record.profile !== undefined) marked.profile = record.profile;
			return marked;
		}
		const profile = wardenNameProfile(device.name);
		if (profile !== undefined) return { ...device, wardenCreated: true, profile };
		return device;
	});
}

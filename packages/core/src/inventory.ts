import type { DeviceRecord } from "./store";
import type { InventoryDevice } from "./types";

/** Mark devices warden created (store record, or a `warden-` name) and attach their profile. */
export function markWardenDevices(inventory: InventoryDevice[], records: DeviceRecord[]): InventoryDevice[] {
	const byId = new Map(records.map((r) => [`${r.platform}:${r.id}`, r]));
	return inventory.map((device) => {
		if (device.golden) return device;
		const record = byId.get(`${device.platform}:${device.id}`);
		if (record) {
			const marked: InventoryDevice = { ...device, wardenCreated: true };
			if (record.profile !== undefined) marked.profile = record.profile;
			return marked;
		}
		const match = /^warden-(.+)-\d+$/.exec(device.name);
		if (match?.[1]) return { ...device, wardenCreated: true, profile: match[1] };
		return device;
	});
}

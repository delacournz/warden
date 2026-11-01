import type { DeviceRecord } from "@delacour/warden-store/store";
import type { InventoryDevice } from "@delacour/warden-store/types";

const WARDEN_NAME = /^warden-(.+)-\d+$/;

export class InventoryMarker {
	/** `warden-<profile>-N`: a pool device warden created (goldens are `warden-golden-…`, checked first by callers). */
	profileOf(name: string): string | undefined {
		return WARDEN_NAME.exec(name)?.[1];
	}

	/** Mark devices warden created (store record, or a `warden-` name) and attach their profile. */
	mark<T extends InventoryDevice>(inventory: T[], records: DeviceRecord[]): T[] {
		const byId = new Map(records.map((r) => [`${r.platform}:${r.id}`, r]));
		return inventory.map((device) => {
			if (device.golden || device.physical) return device;
			const record = byId.get(`${device.platform}:${device.id}`);
			if (record) {
				const marked: T = { ...device, wardenCreated: true };
				if (record.profile !== undefined) marked.profile = record.profile;
				if (record.quarantinedAt !== undefined) marked.quarantined = true;
				return marked;
			}
			const profile = this.profileOf(device.name);
			if (profile !== undefined) return { ...device, wardenCreated: true, profile };
			return device;
		});
	}
}

export const inventoryMarker = new InventoryMarker();

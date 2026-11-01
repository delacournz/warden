import { z } from "zod";
import { platformSchema } from "./primitives.schema";

/** One row of `warden devices --json`. */
export const deviceRowSchema = z.object({
	platform: platformSchema,
	/** a real phone or tablet, or a simulator / emulator */
	kind: z.enum(["virtual", "physical"]),
	name: z.string(),
	/** udid / serial; absent for an Android AVD that isn't running */
	id: z.string().optional(),
	state: z.enum(["booted", "booting", "shutdown", "avd"]),
	runtime: z.string().optional(),
	warden: z.boolean(),
	golden: z.literal(true).optional(),
	quarantined: z.object({ reason: z.string().optional() }).optional(),
	slimmed: z.literal(true).optional(),
	physical: z.literal(true).optional(),
	/** how a physical device is connected (`usb`, `wifi`, `wired`, `localNetwork`) */
	transport: z.string().optional(),
	/** why a physical device is unusable right now */
	hint: z.string().optional(),
	/** resident memory of a booted iOS sim, with `--mem` */
	footprintMb: z.number().optional(),
	lease: z.object({ id: z.string(), owner: z.string(), where: z.string().optional() }).optional(),
});
export type DeviceRowJson = z.infer<typeof deviceRowSchema>;

/** `warden devices --json`. */
export const devicesJsonSchema = z.array(deviceRowSchema);
export type DevicesJson = z.infer<typeof devicesJsonSchema>;
